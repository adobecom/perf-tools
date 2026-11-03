#!/usr/bin/env node
// Imports completed perf-ab artifacts from trusted main-branch workflow runs, publishes whitelisted JSON and
// commits the static history on main. Artifact contents are parsed as data only and never executed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeHistory, missingArtifactDocument, normalizeResult, resultAttemptMatches, safeArtifact } from './history.mjs';

const REPO = 'adobecom/perf-tools';
const WORKFLOW = 'perf-ab.yml';
// Start at the reviewed US smoke run; earlier Actions and local trials are not public history.
const FIRST_PUBLIC_RUN_ID = 41631057972;
const HISTORY_POLICY_SCHEMA = 'perf-ab/history-policy-v1';
const ARTIFACT_REPAIR_RUN = '41633898462-1';
const ARTIFACT_REPAIR_REQUEST = 'mw0nfld0-cebtakma';
const ARTIFACT_LIMIT = 128 * 1024 * 1024;
const JSON_LIMIT = 16 * 1024 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class ArtifactContentError extends Error {}

export function isTrustedCompletedRun(run, workflowId) {
  if (!run || run.status !== 'completed' || !Number.isSafeInteger(run.id) || run.id < 1 || run.workflow_id !== workflowId
    || run.id < FIRST_PUBLIC_RUN_ID || run.head_branch !== 'main' || run.event !== 'workflow_dispatch') return false;
  return true;
}

async function apiRequest(apiUrl, token, endpoint) {
  const response = await fetch(new URL(endpoint, `${apiUrl.replace(/\/+$/, '')}/`), {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return response;
}

async function apiJson(apiUrl, token, endpoint) {
  return apiRequest(apiUrl, token, endpoint).then((response) => response.json());
}

async function listCompletedRuns(apiUrl, token, workflowId) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const result = await apiJson(apiUrl, token, `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=100&page=${page}`);
    const batch = result.workflow_runs ?? [];
    runs.push(...batch.filter((run) => isTrustedCompletedRun(run, workflowId)));
    if (batch.length < 100) break;
  }
  return runs;
}

async function listArtifacts(apiUrl, token, runId) {
  const artifacts = [];
  for (let page = 1; ; page += 1) {
    const result = await apiJson(apiUrl, token, `/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    const batch = result.artifacts ?? [];
    artifacts.push(...batch);
    if (batch.length < 100) break;
  }
  return artifacts;
}

export function selectResultsArtifacts(artifacts) {
  const active = artifacts.filter((a) => !a.expired && /^perf-ab-[a-zA-Z0-9-]+(?:-results)?$/.test(a.name ?? ''));
  return active.filter((a) => a.name.endsWith('-results')).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function selectFullArtifact(artifacts, requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return null;
  return artifacts.find((a) => !a.expired && a.name === `perf-ab-${requestId}`) ?? null;
}

export function fullArtifactForResults(artifacts, resultArtifact, requestId) {
  if (!resultArtifact || resultArtifact.name !== `perf-ab-${requestId}-results`) return null;
  return selectFullArtifact(artifacts, requestId);
}

export function selectFullArtifacts(artifacts) {
  return artifacts.filter((a) => !a.expired && /^perf-ab-[a-zA-Z0-9-]+$/.test(a.name ?? '')
    && !/-pair\d+$/.test(a.name) && !a.name.endsWith('-results'))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function safeResultsEntry(entries) {
  return entries.includes('results.json') ? 'results.json' : null;
}

async function downloadArtifactResults(apiUrl, token, artifactId) {
  const response = await apiRequest(apiUrl, token, `/repos/${REPO}/actions/artifacts/${artifactId}/zip`);
  if (!response.body) throw new Error(`artifact ${artifactId} returned an empty download`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-import-'));
  const archive = path.join(dir, 'artifact.zip');
  try {
    const handle = await fs.promises.open(archive, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > ARTIFACT_LIMIT) throw new Error(`artifact ${artifactId} exceeds the import size limit`);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    let entries;
    try {
      entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
        .split(/\r?\n/).filter((line) => line && /^[A-Za-z0-9._/-]+$/.test(line)
          && !line.split('/').some((part) => part === '.' || part === '..'));
    } catch {
      throw new ArtifactContentError(`artifact ${artifactId} is not a readable ZIP archive`);
    }
    const resultEntry = safeResultsEntry(entries);
    if (!resultEntry) throw new ArtifactContentError(`artifact ${artifactId} does not contain a root results.json`);
    let output;
    try {
      output = execFileSync('unzip', ['-p', archive, resultEntry], { encoding: 'buffer', maxBuffer: JSON_LIMIT });
    } catch {
      throw new ArtifactContentError(`artifact ${artifactId} results could not be read`);
    }
    if (output.length > JSON_LIMIT) throw new ArtifactContentError(`artifact ${artifactId} results exceed the import size limit`);
    try {
      return JSON.parse(output.toString('utf8'));
    } catch {
      throw new ArtifactContentError(`artifact ${artifactId} results are not valid JSON`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadExisting(root) {
  const indexPath = path.join(root, 'site/data/index.json');
  if (!fs.existsSync(indexPath)) return { index: null, details: {} };
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const details = {};
  for (const summary of index.runs ?? []) {
    if (typeof summary?.id !== 'string' || !/^data\/runs\/[0-9]{1,20}-[0-9]{1,6}\.json$/.test(summary.detailPath ?? '')) continue;
    const file = path.join(root, 'site', summary.detailPath);
    if (fs.existsSync(file)) details[summary.id] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return { index, details };
}

function loadHistoryPolicy(root) {
  const file = path.join(root, 'site/data/history-policy.json');
  if (!fs.existsSync(file)) return null;
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`history policy is not valid JSON: ${error.message}`);
  }
  const cutoff = policy?.cutoff;
  const cutoffTime = typeof cutoff === 'string' ? Date.parse(cutoff) : NaN;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.schema !== HISTORY_POLICY_SCHEMA
    || !Number.isFinite(cutoffTime) || new Date(cutoffTime).toISOString() !== cutoff) {
    throw new Error(`history policy must use ${HISTORY_POLICY_SCHEMA} with a canonical UTC cutoff`);
  }
  return { cutoff, cutoffTime };
}

function filterExistingHistory(existing, cutoffTime) {
  if (!existing.index || cutoffTime == null) return { ...existing, excluded: 0 };
  let excluded = 0;
  const runs = existing.index.runs.filter((summary) => {
    const createdAt = typeof summary?.createdAt === 'string' ? Date.parse(summary.createdAt) : NaN;
    if (!Number.isFinite(createdAt) || createdAt < cutoffTime) {
      excluded += 1;
      return false;
    }
    return true;
  });
  return {
    ...existing,
    index: { ...existing.index, runs },
    excluded,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export async function publishRuns({ root = ROOT, apiUrl = 'https://api.github.com', token, runIds = [], sweep = false, now = Date.now() }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const policy = loadHistoryPolicy(root);
  const workflow = await apiJson(apiUrl, token, `/repos/${REPO}/actions/workflows/${WORKFLOW}`);
  const workflowId = workflow.id;
  if (!Number.isSafeInteger(workflowId)) throw new Error('perf-ab workflow was not found');
  const existing = filterExistingHistory(await loadExisting(root), policy?.cutoffTime);
  const existingIds = new Set((existing.index?.runs ?? []).map((r) => r?.id).filter(Boolean));
  let candidates;
  if (runIds.length) {
    const ids = [...new Set(runIds.map((id) => String(id)))];
    if (ids.some((id) => !/^[1-9][0-9]{0,19}$/.test(id))) throw new Error('run IDs must be positive decimal integers');
    candidates = await Promise.all(ids.map((id) => apiJson(apiUrl, token, `/repos/${REPO}/actions/runs/${id}`)));
  } else if (sweep) {
    candidates = await listCompletedRuns(apiUrl, token, workflowId);
  } else {
    throw new Error('provide run IDs or enable the completed-run sweep');
  }

  const imported = [];
  const excludedRunIds = [];
  const changedDetails = new Set();
  const artifactRepairs = new Set();
  for (const run of candidates) {
    if (!isTrustedCompletedRun(run, workflowId)) continue;
    if (policy) {
      const createdAt = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
      if (!Number.isFinite(createdAt)) throw new Error(`run ${run.id} has an invalid created_at timestamp`);
      if (createdAt < policy.cutoffTime) {
        excludedRunIds.push(String(run.id));
        continue;
      }
    }
    const id = `${run.id}-${run.run_attempt ?? 1}`;
    if (existingIds.has(id)) {
      if (id === ARTIFACT_REPAIR_RUN) {
        const detail = existing.details[id];
        if (detail) {
          const artifacts = await listArtifacts(apiUrl, token, run.id);
          const fullArtifact = selectFullArtifact(artifacts, ARTIFACT_REPAIR_REQUEST);
          const replacement = fullArtifact ? safeArtifact(fullArtifact, run.id) : null;
          existing.details[id] = { ...detail, artifact: replacement };
          changedDetails.add(id);
          artifactRepairs.add(id);
        }
      }
      continue;
    }
    const artifacts = await listArtifacts(apiUrl, token, run.id);
    const resultArtifacts = selectResultsArtifacts(artifacts);
    const fullArtifacts = selectFullArtifacts(artifacts);
    if (!resultArtifacts.length && !fullArtifacts.length) {
      imported.push(missingArtifactDocument(run, now));
      continue;
    }
    const attempt = run.run_attempt ?? 1;
    let importedDocument = null;
    let invalidArtifact = false;
    let metricArtifact = null;
    for (const artifact of [...resultArtifacts, ...fullArtifacts]) {
      let raw;
      try {
        raw = await downloadArtifactResults(apiUrl, token, artifact.id);
      } catch (error) {
        if (!(error instanceof ArtifactContentError)) throw error;
        invalidArtifact = true;
        continue;
      }
      if (!resultAttemptMatches(raw, attempt)) continue;
      const requestId = typeof raw?.requestId === 'string' ? raw.requestId : null;
      const fullArtifact = fullArtifactForResults(artifacts, artifact, requestId);
      metricArtifact = artifact.name.endsWith('-results') ? fullArtifact : artifact;
      try {
        importedDocument = normalizeResult(raw, run, metricArtifact, now);
        break;
      } catch {
        invalidArtifact = true;
      }
    }
    if (importedDocument) {
      imported.push(importedDocument);
      changedDetails.add(id);
    }
    else {
      const doc = missingArtifactDocument(run, now);
      if (invalidArtifact || resultArtifacts.length || fullArtifacts.length) doc.errorCode = 'artifact-invalid';
      imported.push(doc);
      console.warn(`run ${id}: no matching valid result artifact for this workflow attempt`);
    }
  }

  const merged = mergeHistory(existing.index, imported, now, existing.details);
  for (const id of artifactRepairs) merged.details.set(id, existing.details[id]);
  writeJson(path.join(root, 'site/data/index.json'), merged.index);
  for (const [id, detail] of merged.details) {
    if (detail && changedDetails.has(id)) writeJson(path.join(root, 'site', 'data', 'runs', `${id}.json`), detail);
  }
  return {
    imported: imported.length,
    total: merged.index.runs.length,
    ids: imported.map((r) => r.id),
    cutoff: policy?.cutoff ?? null,
    excludedExisting: existing.excluded,
    excludedRunIds,
  };
}

function main() {
  const token = process.env.GITHUB_TOKEN;
  const runIds = (process.env.RUN_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const sweep = process.env.SWEEP === 'true';
  return publishRuns({ token, runIds, sweep }).then(({ imported, total, ids, cutoff, excludedExisting, excludedRunIds }) => {
    console.log(`perf-ab history: imported ${imported} run(s); ${total} total`);
    if (cutoff) console.log(`history cutoff ${cutoff}: excluded ${excludedExisting} saved run(s) and ${excludedRunIds.length} candidate run(s)`);
    for (const id of excludedRunIds) console.log(`excluded ${id}: run was created before the history cutoff`);
    for (const id of ids) console.log(`published ${id}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`perf-ab history publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}
