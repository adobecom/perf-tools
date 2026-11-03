// Combines the paired matrix jobs of one perf-ab request into a single results.json.
// Each matrix job measured exactly one cold before/after pair on its own runner (PAIR=i). Only pairs whose job
// finished ok, for this request, with verified US egress and the expected Lighthouse profile are complete; medians
// and the median per-pair delta use complete pairs only. Missing or failed pairs are kept as diagnostics and make
// the aggregate `partial` (some complete) or `failed` (none).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXPECTED, hasMetrics, metricDelta, pairStats, profileKey } from './stats.mjs';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function profileMismatch(p) {
  if (!p) return 'no verified Lighthouse profile';
  const bad = Object.keys(EXPECTED).filter((k) => p[k] !== EXPECTED[k]);
  return bad.length ? `profile mismatch: ${bad.map((k) => `${k}=${p[k]}`).join(', ')}` : null;
}

// Pair job outputs are found as <dir>/<anything>-pair<i>/results.json (download-artifact without merging) or
// <dir>/pair<i>/results.json.
export function findPairResults(dir) {
  const found = new Map();
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const m = entry.isDirectory() && /(?:^|-)pair(\d+)$/.exec(entry.name);
    if (!m) continue;
    const file = path.join(dir, entry.name, 'results.json');
    if (fs.existsSync(file)) found.set(Number(m[1]), path.join(dir, entry.name));
  }
  return found;
}

export function aggregatePairs({ pairsDir, expected, requestId, out, github = {} }) {
  if (!Number.isInteger(expected) || expected < 1) throw new Error(`invalid expected pair count ${expected}`);
  const found = findPairResults(pairsDir);
  fs.mkdirSync(out, { recursive: true });
  const agg = {
    schema: 'perf-ab/pagespeed-v1', requestId, status: 'running', mode: 'pagespeed-us-paired',
    startedAt: null, finishedAt: null, github: { ...github }, cold: null, lighthouseVersion: EXPECTED.lighthouseVersion,
    names: null, runsPerVariant: expected, url: null, experiment: null, variants: null, profile: null, profileKey: null, chromeVersion: null, egress: null,
    pairs: [], runs: [], rejected: [], documentGeo: [], hints: null, edits: null, jobs: [],
  };
  for (let i = 1; i <= expected; i += 1) {
    const dir = found.get(i);
    const pair = { index: i, before: null, after: null, delta: null, job: null };
    agg.pairs.push(pair);
    if (!dir) { pair.error = 'pair job produced no results (artifact missing)'; continue; }
    let r;
    try { r = readJson(path.join(dir, 'results.json')); } catch (e) { pair.error = `unreadable results.json: ${e.message}`; continue; }
    pair.job = {
      runAttempt: r.github?.runAttempt ?? null, runner: r.github?.runner ?? null, os: r.github?.os ?? null, cpus: r.github?.cpus ?? null,
      chromeVersion: r.chromeVersion ?? null, egressCountry: r.egress?.country ?? null,
      benchmarkIndex: r.runs?.find((x) => x.run === i)?.benchmarkIndex ?? null, status: r.status ?? null,
    };
    agg.jobs.push({ pair: i, ...pair.job, egress: r.egress ?? null, profile: r.profile ?? null, error: r.error ?? null, errorKind: r.errorKind ?? null });
    // Diagnostics of every pair job are kept, complete or not (unique directory names per pair).
    const prefix = `pair${i}`;
    for (const run of r.runs ?? []) {
      agg.runs.push({ ...run, pair: i, dir: run.dir ? path.posix.join(prefix, run.dir) : null });
    }
    for (const rej of r.rejected ?? []) agg.rejected.push({ ...rej, pair: i, dir: rej.dir ? path.posix.join(prefix, rej.dir) : null });
    for (const g of r.documentGeo ?? []) agg.documentGeo.push({ ...g, pair: i });
    fs.cpSync(dir, path.join(out, prefix), { recursive: true });
    if (r.requestId !== requestId) { pair.error = `results belong to request ${r.requestId}`; continue; }
    agg.names ??= r.names;
    agg.url ??= r.url;
    agg.experiment ??= r.experiment ?? null;
    agg.variants ??= r.variants;
    agg.cold ??= r.cold;
    agg.edits ??= r.edits;
    agg.startedAt = [agg.startedAt, r.startedAt].filter(Boolean).sort()[0] ?? null;
    if (r.hints) {
      agg.hints ??= { ...r.hints, perPair: [] };
      agg.hints.perPair.push({ pair: i, usedLinks: r.hints.usedLinks ?? null, contextual: r.hints.contextual?.length ?? 0, dropped: r.hints.dropped?.length ?? 0 });
    }
    if (r.status !== 'ok') { pair.error = `pair job ${r.status}${r.error ? `: ${r.error}` : ''}`; continue; }
    if (r.pair !== i) { pair.error = `pair job measured pair ${r.pair}, expected ${i}`; continue; }
    if (r.egress?.ok !== true || r.egress?.country !== 'US') { pair.error = 'egress not verified US'; continue; }
    const pm = profileMismatch(r.profile);
    if (pm) { pair.error = pm; continue; }
    const pick = (n) => r.runs?.find((x) => x.variant === n && x.run === i)?.metrics ?? null;
    const paired = r.names.includes('before');
    pair.after = pick('after');
    pair.before = paired ? pick('before') : null;
    if (!hasMetrics(pair.after) || (paired && !hasMetrics(pair.before))) { pair.error = 'pair job is missing accepted metrics'; pair.before = null; pair.after = null; continue; }
    pair.delta = paired ? metricDelta(pair.before, pair.after) : null;
    agg.profile ??= r.profile;
    agg.profileKey ??= profileKey(r.profile);
    agg.chromeVersion ??= r.chromeVersion;
    agg.egress ??= r.egress;
  }
  const names = agg.names ?? ['before', 'after'];
  const stats = pairStats(agg.pairs, names);
  agg.medians = stats.medians;
  agg.samples = {
    requested: expected,
    pairs: stats.complete,
    before: names.includes('before') ? agg.pairs.filter((p) => p.before).length : 0,
    after: agg.pairs.filter((p) => p.after).length,
    rejected: agg.rejected.length,
  };
  // A job may report a different Chrome build than the first; the record is per pair (pairs[].job.chromeVersion).
  agg.status = stats.complete === expected ? 'ok' : stats.complete > 0 ? 'partial' : 'failed';
  if (agg.status !== 'ok') {
    agg.error = agg.pairs.filter((p) => p.error).map((p) => `pair${p.index}: ${p.error}`).join('; ').slice(0, 2000);
    const kinds = agg.jobs.map((j) => j.errorKind).filter(Boolean);
    agg.errorKind = kinds.includes('fatal') ? 'fatal' : kinds.includes('rejected-after-retries') ? 'rejected-after-retries' : 'infrastructure';
  }
  agg.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(agg, null, 2)}\n`);
  return agg;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { 'pairs-dir': { type: 'string' }, expected: { type: 'string' }, 'request-id': { type: 'string' }, out: { type: 'string' } } });
  if (!values['pairs-dir'] || !values.expected || !values['request-id'] || !values.out) {
    console.error('usage: node lib/pagespeed/aggregate.mjs --pairs-dir <dir> --expected <n> --request-id <id> --out <dir>');
    process.exit(2);
  }
  const env = process.env;
  const github = {
    sha: env.GITHUB_SHA ?? null,
    runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
  };
  const agg = aggregatePairs({ pairsDir: values['pairs-dir'], expected: Number(values.expected), requestId: values['request-id'], out: values.out, github });
  console.log(`perf-ab aggregate: ${agg.status}, ${agg.samples.pairs}/${agg.samples.requested} complete pair(s)`);
  console.log(JSON.stringify(agg.medians));
  if (agg.status !== 'ok') { console.error(`perf-ab aggregate ${agg.status}: ${agg.error}`); process.exit(1); }
}
