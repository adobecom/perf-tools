import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { checkoutPrSources, resolvePullRequests } from '../lib/pagespeed/pr-sources.mjs';
import { makeCert } from '../lib/pagespeed/job.mjs';
import { startProxy } from '../lib/pagespeed/proxy.mjs';

const REPO = 'adobecom/milo';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const write = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-pr-fixture-'));
  git(root, 'init', '--initial-branch=stage');
  git(root, 'config', 'user.email', 'perf-test@example.invalid');
  git(root, 'config', 'user.name', 'perf source test');
  write(root, 'libs/utils/utils.js', 'export const version = "production";\n');
  write(root, 'libs/removed.js', 'export const removeMe = true;\n');
  write(root, 'libs/old-name.js', 'export const renamed = true;\n');
  write(root, 'docs/guide.md', 'production docs\n');
  write(root, 'test/regression.test.js', 'production test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  write(root, 'libs/utils/utils.js', 'export const version = "pinned-pr-head";\n');
  fs.rmSync(path.join(root, 'libs/removed.js'));
  fs.renameSync(path.join(root, 'libs/old-name.js'), path.join(root, 'libs/new-name.js'));
  write(root, 'libs/new.js', 'export const added = true;\n');
  write(root, 'docs/guide.md', 'changed docs\n');
  write(root, 'test/regression.test.js', 'changed test\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'PR head');
  const headSha = git(root, 'rev-parse', 'HEAD');
  const blobs = Object.fromEntries(['libs/utils/utils.js', 'libs/new-name.js', 'libs/new.js'].map((file) => [file, git(root, 'rev-parse', `${headSha}:${file}`)]));
  const files = [
    { filename: 'libs/utils/utils.js', status: 'modified', sha: blobs['libs/utils/utils.js'] },
    { filename: 'libs/removed.js', status: 'removed', sha: '0'.repeat(40) },
    { filename: 'libs/new-name.js', previous_filename: 'libs/old-name.js', status: 'renamed', sha: blobs['libs/new-name.js'] },
    { filename: 'libs/new.js', status: 'added', sha: blobs['libs/new.js'] },
    { filename: 'docs/guide.md', status: 'modified', sha: '1'.repeat(40) },
    { filename: 'test/regression.test.js', status: 'modified', sha: '2'.repeat(40) },
  ];
  return { root, baseSha, headSha, blobs, files };
}

function apiFor(f, overrides = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === `/repos/${REPO}/pulls/7095`) {
      const body = overrides.pull ?? {
        number: 7095,
        base: { ref: 'stage', sha: f.baseSha, repo: { full_name: REPO } },
        head: { ref: 'MWPW-213916', sha: f.headSha, repo: { full_name: REPO } },
      };
      return Response.json(body);
    }
    if (u.pathname === `/repos/${REPO}/compare/${f.baseSha}...${f.headSha}`) {
      return Response.json(overrides.compare ?? { merge_base_commit: { sha: f.baseSha }, files: f.files });
    }
    return new Response('not found', { status: 404 });
  };
}

test('PR resolution freezes the same-repo head/base/merge-base and maps only source files', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const resolved = await resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: apiFor(f) });
  const pr = resolved.sourcePrs[0];
  assert.deepEqual([pr.baseRef, pr.headRef, pr.baseSha, pr.headSha, pr.mergeBaseSha],
    ['stage', 'MWPW-213916', f.baseSha, f.headSha, f.baseSha]);
  assert.deepEqual(Object.keys(resolved.localSources).sort(),
    ['/libs/new-name.js', '/libs/new.js', '/libs/old-name.js', '/libs/removed.js', '/libs/utils/utils.js']);
  assert.ok(!JSON.stringify(resolved).includes('docs/guide.md'));
  assert.ok(!JSON.stringify(resolved).includes('test/regression.test.js'));
  assert.equal(resolved.localSources['/libs/old-name.js'].deleted, true);
  assert.equal(resolved.localSources['/libs/removed.js'].deleted, true);
  assert.equal(resolved.localSources['/libs/new-name.js'].filePath, 'libs/new-name.js');
});

test('local source checkout reads only pinned blobs after the source branch moves, and rejects unsafe or missing files', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const resolved = await resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: apiFor(f) });
  write(f.root, 'libs/utils/utils.js', 'export const version = "later-branch-push";\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'later push');
  const checkout = checkoutPrSources(resolved.localSources, {
    repositoryUrl: () => `file://${f.root}`,
    allowFileProtocol: true,
  });
  t.after(checkout.cleanup);
  assert.equal(checkout.contents.get('/libs/utils/utils.js').body.toString(), 'export const version = "pinned-pr-head";\n');
  assert.equal(checkout.contents.get('/libs/removed.js').deleted, true);
  assert.equal(checkout.contents.get('/libs/old-name.js').deleted, true);
  assert.equal(checkout.contents.get('/libs/new.js').body.toString(), 'export const added = true;\n');
  assert.equal(checkout.baselineContentHashes.get('/libs/utils/utils.js'), createHash('sha256').update('export const version = "production";\n').digest('hex'));
  assert.throws(() => checkoutPrSources({ '/../escape.js': { ...resolved.localSources['/libs/utils/utils.js'] } }), /unsafe local PR source path/);
  const bad = { ...resolved.localSources, '/libs/utils/utils.js': { ...resolved.localSources['/libs/utils/utils.js'], blobSha: '0'.repeat(40) } };
  assert.throws(() => checkoutPrSources(bad, { repositoryUrl: () => `file://${f.root}`, allowFileProtocol: true }), /blob does not match/);
});

test('source checkout bytes pass through the existing HTTP/2 proxy; production response remains byte-identical', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const resolved = await resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: apiFor(f) });
  const checkout = checkoutPrSources(resolved.localSources, {
    repositoryUrl: () => `file://${f.root}`,
    allowFileProtocol: true,
  });
  t.after(checkout.cleanup);
  const host = 'pr-source-test.adobe.com';
  const cert = makeCert(host);
  t.after(cert.cleanup);
  const sourceBytes = checkout.contents.get('/libs/utils/utils.js').body;
  const productionBytes = Buffer.from('export const version = "production";\n');
  const compress = (body) => brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert });
  server.on('stream', (stream, headers) => {
    const body = headers[':path'] === '/libs/utils/utils.js' ? productionBytes : Buffer.from('control');
    stream.respond({ ':status': 200, 'content-type': 'text/javascript', 'content-encoding': 'br', 'content-length': compress(body).length });
    stream.end(compress(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const proxy = await startProxy({
    host, key: cert.key, cert: cert.cert,
    upstreamOrigin: `https://127.0.0.1:${server.address().port}`,
    upstreamOptions: { rejectUnauthorized: false },
    allowLocalTargets: true,
    select: (requestPath) => ['/control.js', '/libs/utils/utils.js'].includes(new URL(requestPath, `https://${host}`).pathname) ? 'asset' : null,
    transform: async ({ path: requestPath, status, headers, body }) => {
      if (new URL(requestPath, `https://${host}`).pathname !== '/libs/utils/utils.js') return { status, headers, body };
      return { status: 200, body: sourceBytes, headers, encoding: headers['content-encoding'] };
    },
  });
  t.after(() => proxy.close());

  const request = async (requestPath) => {
    const socket = net.connect(proxy.port, '127.0.0.1');
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    const responseHeader = await new Promise((resolve, reject) => {
      const chunks = [];
      const read = (chunk) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        const end = all.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', read);
        if (all.length > end + 4) socket.unshift(all.subarray(end + 4));
        resolve(all.subarray(0, end).toString());
      };
      socket.on('data', read);
      socket.once('error', reject);
    });
    assert.match(responseHeader, /200 Connection Established/);
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false, ALPNProtocols: ['h2'] });
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    const client = http2.connect(`https://${host}`, { createConnection: () => secure });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const stream = client.request({ ':path': requestPath, ':method': 'GET', ':scheme': 'https', ':authority': host, 'sec-fetch-dest': 'script' });
    const chunks = [];
    const headers = await new Promise((resolve, reject) => {
      stream.on('response', resolve);
      stream.on('error', reject);
    });
    const body = await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
    client.close();
    return { headers, body };
  };

  const control = await request('/control.js');
  assert.equal(brotliDecompressSync(control.body).toString(), 'control');
  const overridden = await request('/libs/utils/utils.js');
  assert.equal(overridden.headers[':status'], 200);
  assert.equal(brotliDecompressSync(overridden.body).toString(), sourceBytes.toString());
  assert.equal(proxy.requests.find((row) => row.path === '/control.js').edited, false);
  assert.equal(proxy.requests.find((row) => row.path === '/libs/utils/utils.js').edited, true);
});

test('PR resolution rejects forks, unsafe mapped paths, and inaccessible PRs with explicit errors', async () => {
  const f = fixture();
  try {
    await assert.rejects(resolvePullRequests([{ repo: REPO, number: 7095 }], {
      fetchImpl: apiFor(f, { pull: { number: 7095, head: { sha: f.headSha, repo: { full_name: 'attacker/milo' } }, base: { sha: f.baseSha, repo: { full_name: REPO } } } }),
    }), /both its base and head/);
    await assert.rejects(resolvePullRequests([{ repo: REPO, number: 7095 }], {
      fetchImpl: apiFor(f, { compare: { merge_base_commit: { sha: f.baseSha }, files: [{ filename: 'libs/../outside.js', status: 'added', sha: '3'.repeat(40) }] } }),
    }), /unsafe mapped PR path/);
    await assert.rejects(resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: async () => new Response('{}', { status: 404 }) }), /HTTP 404/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('resolvePullRequests: an optional token authenticates the API reads only; the 403 hint never contains it', async () => {
  const f = fixture();
  const seen = [];
  const spy = (inner) => async (url, init) => { seen.push({ url, auth: init.headers.Authorization ?? null }); return inner(url, init); };
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  await resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: spy(apiFor(f)), token });
  assert.ok(seen.length >= 2 && seen.every((s) => s.auth === `Bearer ${token}` && s.url.startsWith('https://api.github.com/')));
  seen.length = 0;
  await resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: spy(apiFor(f)) });
  assert.ok(seen.every((s) => s.auth === null), 'no Authorization header without a token');
  const limited = async () => new Response('{}', { status: 403 });
  await assert.rejects(resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: limited }), /HTTP 403; unauthenticated GitHub API requests are rate limited.*GITHUB_TOKEN or GH_TOKEN.*gh auth login/);
  await assert.rejects(resolvePullRequests([{ repo: REPO, number: 7095 }], { fetchImpl: limited, token }), (e) => /HTTP 403; the GitHub token was rejected or is rate limited/.test(e.message) && !e.message.includes(token));
});
