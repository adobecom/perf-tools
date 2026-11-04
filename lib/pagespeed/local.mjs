import fs from 'node:fs';
import path from 'node:path';
import { aggregatePairs } from './aggregate.mjs';
import { decodeSpec, encodeSpec } from './spec.mjs';
import { prepare } from './prepare.mjs';
import { runJob } from './job.mjs';
import { resolvePullRequests } from './pr-sources.mjs';
import { findGithubToken } from './github-token.mjs';

// perf-ab --local: the same prepare() -> runJob() -> aggregatePairs() pipeline as Actions, run on this machine with
// the pairs one after another. Nothing here changes the measurement; only the location marker differs.
export function newLocalRequestId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runLocal({
  spec, out, requestId = newLocalRequestId(), root = process.cwd(), prepareRun = prepare, measurePair = runJob,
  aggregate = aggregatePairs, resolvePrs = resolvePullRequests, findToken = findGithubToken, log = console.log, warn = console.warn,
}) {
  // PR resolution calls the GitHub API from this machine: authenticate it when a token is available.
  const token = spec.variants.after.pullRequests?.length ? findToken() : null;
  const prepared = await prepareRun({ SPEC: encodeSpec(spec), REQUEST_ID: requestId }, { root, resolvePrs: (requests) => resolvePrs(requests, { token }) });
  const resolvedSpec = decodeSpec(prepared.spec);
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    if (entry.name === 'results.json' || /^pair\d+$/.test(entry.name) || entry.name === 'rejected') {
      fs.rmSync(path.join(out, entry.name), { recursive: true, force: true });
    }
  }
  const pairRoot = fs.mkdtempSync(path.join(out, '.pair-jobs-'));
  try {
    log(`running ${resolvedSpec.runs} Lighthouse pair(s) locally and sequentially`);
    for (const pair of prepared.pairs) {
      const result = await measurePair({
        spec: resolvedSpec, requestId, out: path.join(pairRoot, `pair${pair}`), pair, where: 'local',
      });
      if (result.status !== 'ok') warn(`local pair${pair} failed (${result.errorKind}): ${result.error}`);
    }
    const results = aggregate({
      pairsDir: pairRoot, expected: prepared.runs, requestId, out, where: 'local',
      github: { sha: process.env.GITHUB_SHA ?? null },
    });
    if (results.status !== 'ok') warn(`perf-ab local aggregate ${results.status}: ${results.error}`);
    return results;
  } finally {
    fs.rmSync(pairRoot, { recursive: true, force: true });
  }
}
