// perf-ab Actions client (the default location): dispatches the measurement to the perf-ab GitHub Actions workflow
// (verified-US runner, Lighthouse 13.6.0 mobile, DevTools throttling), waits for it, and downloads its artifact. It never falls
// back to a local run by itself: any GitHub, egress, render or infrastructure failure is reported and the CLI exits non-zero.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeSpec } from './spec.mjs';

export const WORKFLOW = 'perf-ab.yml';
const run = promisify(execFile);

export const defaultGh = async (args) => {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 1 << 28 });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('perf-ab needs the GitHub CLI (gh) to dispatch the US Lighthouse workflow; install it and run `gh auth login`');
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(e.stderr || e.message).trim()}`);
  }
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
export const newRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Either `spec` alone (encoded and dispatched as the spec input) or `config` (repository experiments/**.json path,
// dispatched as config + runs inputs; the workflow reads that file from --ref) with the locally loaded `spec`.
export async function runRemote({
  spec, config = null, out, repo = 'adobecom/perf-tools', ref = 'main', requestId = newRequestId(), gh = defaultGh,
  timeoutMs = 75 * 60 * 1000, pollMs = 15000, log = console.log, now = Date.now, wait = sleep,
}) {
  const inputs = config
    ? ['-f', `config=${config}`, '-f', `runs=${spec.runs}`]
    : ['-f', `spec=${encodeSpec(spec)}`];
  try {
    await gh(['auth', 'status', '--hostname', 'github.com']);
  } catch (e) {
    throw new Error(`GitHub CLI is not authenticated (${e.message}); run \`gh auth login\` with access to ${repo}`);
  }
  log(`dispatching ${WORKFLOW} on ${repo}@${ref} (request ${requestId}${config ? `, ${config}` : ''}, ${spec.runs} parallel pair job(s) x ${spec.names.join('/')})`);
  try {
    await gh(['workflow', 'run', WORKFLOW, '-R', repo, '--ref', ref, '-f', `request_id=${requestId}`, ...inputs]);
  } catch (e) {
    throw new Error(`cannot dispatch ${WORKFLOW} on ${repo} (needs Actions write permission on the repository): ${e.message}`);
  }
  const deadline = now() + timeoutMs;
  const title = `perf-ab ${requestId}`;
  let runInfo;
  while (!runInfo) {
    if (now() > deadline) throw new Error(`timed out waiting for the ${WORKFLOW} run for request ${requestId} to appear`);
    await wait(Math.min(pollMs, 5000));
    const list = JSON.parse(await gh(['run', 'list', '-R', repo, '-w', WORKFLOW, '-e', 'workflow_dispatch', '-L', '30', '--json', 'databaseId,displayTitle,status,conclusion,url']));
    runInfo = list.find((r) => r.displayTitle === title);
  }
  log(`run: ${runInfo.url}`);
  let status = runInfo;
  while (status.status !== 'completed') {
    if (now() > deadline) throw new Error(`timed out waiting for ${runInfo.url}; it may still be running`);
    await wait(pollMs);
    status = JSON.parse(await gh(['run', 'view', String(runInfo.databaseId), '-R', repo, '--json', 'status,conclusion']));
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-dl-'));
  let results = null;
  let downloadError = null;
  try {
    try {
      await gh(['run', 'download', String(runInfo.databaseId), '-R', repo, '-n', `perf-ab-${requestId}`, '-D', tmp]);
      results = JSON.parse(fs.readFileSync(path.join(tmp, 'results.json'), 'utf8'));
    } catch (e) {
      downloadError = e.message;
    }
    fs.mkdirSync(out, { recursive: true });
    // Never leave results of an earlier request next to this one (e.g. after3/ from a longer campaign).
    for (const f of fs.readdirSync(out)) if (/^(?:results\.json|rejected|pair\d+|(?:before|after)\d+(?:\.json)?)$/.test(f)) fs.rmSync(path.join(out, f), { recursive: true, force: true });
    if (results) fs.cpSync(tmp, out, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // A downloaded non-ok aggregate explains the failed run best (partial: how many pairs completed).
  const failure = results && results.status !== 'ok' ? `job reported ${results.status}${results.samples ? ` (${results.samples.pairs}/${results.samples.requested} complete pair(s))` : ''}`
    : status.conclusion !== 'success' ? `workflow run ${status.conclusion}`
      : !results ? `artifact download failed: ${downloadError}`
        : results.requestId !== requestId ? `artifact belongs to request ${results.requestId}, expected ${requestId}`
          : !results.profile || results.egress?.country !== 'US' ? 'artifact is missing the verified profile or US egress record' : null;
  if (failure) {
    let logTail = '';
    try { logTail = (await gh(['run', 'view', String(runInfo.databaseId), '-R', repo, '--log-failed'])).split('\n').slice(-40).join('\n'); } catch { /* best effort */ }
    const err = new Error(`perf-ab failed: ${failure}${results?.error ? `: ${results.error}` : ''}\n  run: ${runInfo.url}${results ? `\n  diagnostics: ${out}` : ''}${logTail ? `\n--- failed step log (tail) ---\n${logTail}` : ''}`);
    err.results = results;
    throw err;
  }
  return { results, runUrl: runInfo.url, requestId };
}
