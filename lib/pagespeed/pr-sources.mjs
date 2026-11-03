import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PR_REPOSITORIES = {
  'adobecom/milo': { from: 'libs/', to: '/libs' },
  'adobecom/mas': { from: 'web-components/dist/', to: '/mas/libs' },
};

const SHA = /^[a-f0-9]{40}$/i;
const safeSourcePath = (value) => typeof value === 'string'
  && /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)
  && !value.split('/').some((part) => part === '.' || part === '..');

function assertRequest(request) {
  if (!request || !Object.hasOwn(PR_REPOSITORIES, request.repo)) {
    throw new Error(`PR source repository must be one of ${Object.keys(PR_REPOSITORIES).join(', ')}`);
  }
  if (!Number.isInteger(request.number) || request.number < 1 || request.number > 999999) {
    throw new Error(`invalid ${request.repo} pull request number`);
  }
}

async function getJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`${label}: GitHub returned HTTP ${response.status}`);
  return response.json();
}

function mappedPath(repo, filename) {
  const mapping = PR_REPOSITORIES[repo];
  if (!filename.startsWith(mapping.from)) return null;
  const rel = filename.slice(mapping.from.length);
  if (!safeSourcePath(rel)) throw new Error(`${repo}: unsafe mapped PR path ${JSON.stringify(filename)}`);
  return `${mapping.to}/${rel}`;
}

export async function resolvePullRequests(requests, { fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  if (!Array.isArray(requests)) throw new Error('pullRequests must be an array');
  const byRepo = new Map();
  for (const request of requests) {
    assertRequest(request);
    if (byRepo.has(request.repo)) throw new Error(`only one PR per repository can be used in a campaign (${request.repo})`);
    byRepo.set(request.repo, request);
  }

  const localSources = {};
  const sourcePrs = [];
  const assignSource = (pathname, source, repo, number) => {
    if (Object.hasOwn(localSources, pathname)) throw new Error(`${repo}#${number}: overlapping PR source mapping for ${pathname}`);
    localSources[pathname] = source;
  };
  for (const { repo, number } of byRepo.values()) {
    const pull = await getJson(fetchImpl, `${apiBase}/repos/${repo}/pulls/${number}`, `${repo}#${number}`);
    if (pull.number !== number || pull.base?.repo?.full_name !== repo || pull.head?.repo?.full_name !== repo) {
      throw new Error(`${repo}#${number}: PR must have both its base and head in ${repo}`);
    }
    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;
    if (!SHA.test(headSha ?? '') || !SHA.test(baseSha ?? '')) throw new Error(`${repo}#${number}: GitHub returned an invalid head or base commit`);
    const files = [];
    for (let page = 1; ; page += 1) {
      const compare = await getJson(fetchImpl,
        `${apiBase}/repos/${repo}/compare/${baseSha}...${headSha}?per_page=100&page=${page}`,
        `${repo}#${number} diff`);
      if (page === 1 && !SHA.test(compare.merge_base_commit?.sha ?? '')) {
        throw new Error(`${repo}#${number}: GitHub did not provide a valid merge-base commit`);
      }
      files.push(...(compare.files ?? []));
      if (files.length >= 300) {
        throw new Error(`${repo}#${number}: PR diff reached GitHub's 300-file comparison limit; refusing an incomplete source map`);
      }
      if ((compare.files ?? []).length < 100) {
        const mergeBaseSha = compare.merge_base_commit.sha;
        const mapped = [];
        for (const file of files) {
          if (!['added', 'modified', 'removed', 'renamed'].includes(file.status)) {
            throw new Error(`${repo}#${number}: unsupported diff status ${JSON.stringify(file.status)}`);
          }
          const currentPath = mappedPath(repo, file.filename);
          const previousPath = file.previous_filename ? mappedPath(repo, file.previous_filename) : null;
          if (!currentPath && !previousPath) continue;
          const row = {
            status: file.status, path: currentPath, previousPath, sha: file.sha ?? null,
            filePath: file.filename,
            baseFilePath: file.status === 'added' || (file.previous_filename && !previousPath)
              ? null : file.previous_filename ?? file.filename,
            mergeBaseSha,
          };
          mapped.push(row);
          if (file.status === 'removed' || (file.status === 'renamed' && previousPath && previousPath !== currentPath)) {
            assignSource(previousPath ?? currentPath, {
              repo, number, headSha, mergeBaseSha,
              filePath: file.status === 'renamed' ? file.previous_filename : file.filename,
              baseFilePath: file.status === 'renamed' ? file.previous_filename : file.filename,
              deleted: true,
            }, repo, number);
          }
          if (file.status !== 'removed' && currentPath) {
            if (!SHA.test(file.sha ?? '')) throw new Error(`${repo}#${number}: missing blob SHA for ${file.filename}`);
            assignSource(currentPath, {
              repo, number, headSha, mergeBaseSha, filePath: file.filename,
              baseFilePath: row.baseFilePath, blobSha: file.sha, deleted: false,
            }, repo, number);
          }
        }
        sourcePrs.push({
          repo, number,
          baseRef: pull.base.ref,
          headRef: pull.head.ref,
          baseSha: baseSha.toLowerCase(),
          headSha: headSha.toLowerCase(),
          mergeBaseSha: mergeBaseSha.toLowerCase(),
          files: mapped.map((f) => ({
            status: f.status,
            ...(f.path ? { path: f.path } : {}),
            ...(f.previousPath ? { previousPath: f.previousPath } : {}),
            ...(f.sha ? { blobSha: f.sha.toLowerCase() } : {}),
          })),
        });
        break;
      }
    }
  }
  return { localSources, sourcePrs };
}

function git(repoDir, args, allowFileProtocol = false) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'perf-ab-no-global-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: allowFileProtocol ? 'https:file' : 'https',
  };
  return execFileSync('git', ['-C', repoDir, '-c', 'safe.bareRepository=all', '-c', 'core.hooksPath=/dev/null', '-c', `protocol.file.allow=${allowFileProtocol ? 'always' : 'never'}`, ...args], {
    encoding: 'buffer', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
}

export function checkoutPrSources(localSources, {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-pr-sources-')),
  repositoryUrl = (repo) => `https://github.com/${repo}.git`,
  allowFileProtocol = false,
} = {}) {
  const repositories = new Map();
  const contents = new Map();
  const baselineContentHashes = new Map();
  const fetchedCommits = new Set();
  try {
    for (const [pathname, source] of Object.entries(localSources ?? {})) {
      if (!pathname.startsWith('/') || pathname.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error(`unsafe local PR source path ${JSON.stringify(pathname)}`);
      }
      assertRequest(source);
      if (!SHA.test(source.headSha ?? '')) throw new Error(`${source.repo}#${source.number}: invalid pinned commit SHA`);
      if (!SHA.test(source.mergeBaseSha ?? '')) throw new Error(`${source.repo}#${source.number}: invalid pinned merge-base SHA`);
      const mapping = PR_REPOSITORIES[source.repo];
      if (!source.filePath?.startsWith(mapping.from) || !safeSourcePath(source.filePath)
        || (!source.deleted && !SHA.test(source.blobSha ?? ''))) {
        throw new Error(`${source.repo}#${source.number}: invalid mapped source descriptor for ${pathname}`);
      }
      const key = `${source.repo}@${source.headSha}`;
      let repoDir = repositories.get(key);
      if (!repoDir) {
        repoDir = path.join(tempDir, `${source.repo.split('/')[1]}-${source.headSha}`);
        fs.mkdirSync(repoDir, { recursive: true });
        execFileSync('git', ['init', '--quiet', '--template=/dev/null', repoDir], { stdio: 'ignore' });
        git(repoDir, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', repositoryUrl(source.repo), source.headSha], allowFileProtocol);
        const fetched = git(repoDir, ['rev-parse', 'FETCH_HEAD^{commit}']).toString('utf8').trim();
        if (fetched.toLowerCase() !== source.headSha.toLowerCase()) {
          throw new Error(`${source.repo}#${source.number}: fetched commit ${fetched} does not match pinned ${source.headSha}`);
        }
        git(repoDir, ['checkout', '--quiet', '--detach', source.headSha]);
        repositories.set(key, repoDir);
      }
      const baseKey = `${source.repo}@${source.mergeBaseSha}`;
      if (!fetchedCommits.has(baseKey)) {
        git(repoDir, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', repositoryUrl(source.repo), source.mergeBaseSha], allowFileProtocol);
        const fetchedBase = git(repoDir, ['rev-parse', 'FETCH_HEAD^{commit}']).toString('utf8').trim();
        if (fetchedBase.toLowerCase() !== source.mergeBaseSha.toLowerCase()) {
          throw new Error(`${source.repo}#${source.number}: fetched merge base ${fetchedBase} does not match pinned ${source.mergeBaseSha}`);
        }
        fetchedCommits.add(baseKey);
      }
      if (source.baseFilePath) {
        if (!safeSourcePath(source.baseFilePath) || !source.baseFilePath.startsWith(mapping.from)) {
          throw new Error(`${source.repo}#${source.number}: invalid merge-base source path`);
        }
        const baseTree = git(repoDir, ['ls-tree', '-z', source.mergeBaseSha, '--', source.baseFilePath]).toString('utf8').split('\0').filter(Boolean);
        const baseItem = baseTree.map((line) => {
          const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/i.exec(line);
          return m && { mode: m[1], type: m[2], sha: m[3].toLowerCase(), file: m[4] };
        }).find((entry) => entry?.file === source.baseFilePath);
        if (baseItem && (baseItem.type !== 'blob' || !['100644', '100755'].includes(baseItem.mode))) {
          throw new Error(`${source.repo}#${source.number}: merge-base ${source.baseFilePath} is not a regular file`);
        }
        baselineContentHashes.set(pathname, baseItem
          ? createHash('sha256').update(git(repoDir, ['cat-file', 'blob', baseItem.sha])).digest('hex') : null);
      } else {
        baselineContentHashes.set(pathname, null);
      }
      if (source.deleted) {
        const headTree = git(repoDir, ['ls-tree', '-z', source.headSha, '--', source.filePath]).toString('utf8').split('\0').filter(Boolean);
        if (headTree.length) throw new Error(`${source.repo}#${source.number}: diff marks ${source.filePath} deleted but it exists at the pinned head`);
        contents.set(pathname, { deleted: true });
        continue;
      }
      const tree = git(repoDir, ['ls-tree', '-z', source.headSha, '--', source.filePath]).toString('utf8').split('\0').filter(Boolean);
      const item = tree.map((line) => {
        const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/i.exec(line);
        return m && { mode: m[1], type: m[2], sha: m[3].toLowerCase(), file: m[4] };
      }).find((entry) => entry?.file === source.filePath);
      if (!item || item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) {
        throw new Error(`${source.repo}#${source.number}: ${source.filePath} is missing, a symlink, or not a regular file at the pinned commit`);
      }
      if (item.sha !== source.blobSha.toLowerCase()) {
        throw new Error(`${source.repo}#${source.number}: ${source.filePath} blob does not match the resolved PR diff`);
      }
      contents.set(pathname, { body: git(repoDir, ['cat-file', 'blob', item.sha]), deleted: false });
    }
    return { contents, baselineContentHashes, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
