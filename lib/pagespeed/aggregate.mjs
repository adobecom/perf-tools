// Combines the paired matrix jobs of one perf-ab request into a single results.json.
// Each pair job measured one cold before/after pair. Actions pairs require verified-US egress; local pairs must carry
// an explicit local marker and known egress country. Both require the expected Lighthouse profile. Medians use only
// complete pairs; missing or failed pairs are retained as diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXPECTED, hasMetrics, metricDelta, pairStats, profileKey } from './stats.mjs';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function profileMismatch(p) {
  if (!p) return 'no verified Lighthouse profile';
  const bad = Object.keys(EXPECTED).filter((k) => p[k] !== EXPECTED[k]);
  return bad.length ? `profile mismatch: ${bad.map((k) => `${k}=${p[k]}`).join(', ')}${bad.includes('throttlingMethod') ? ' (results with another throttling method, such as the former simulated one, are never mixed in)' : ''}` : null;
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

// Runner CPU speed varies between VMs and even between the two loads of one pair. The CPU slowdown is applied on
// top of the real runner CPU, so a large spread makes deltas environment-sensitive. Surfaced, never hidden or retried.
export const BENCHMARK_SPREAD_WARN = 1.2;

export function environmentWarnings(pairs) {
  const complete = pairs.filter((p) => p.after && p.job?.benchmarkIndexes);
  const values = complete.flatMap((p) => Object.values(p.job.benchmarkIndexes)).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const within = complete.map((p) => {
    const v = Object.values(p.job.benchmarkIndexes).filter((x) => Number.isFinite(x) && x > 0);
    return { pair: p.index, ...p.job.benchmarkIndexes, ratio: v.length > 1 ? Math.max(...v) / Math.min(...v) : 1 };
  });
  const unstable = within.filter((w) => w.ratio >= BENCHMARK_SPREAD_WARN);
  if (max / min < BENCHMARK_SPREAD_WARN && !unstable.length) return [];
  const fmt = (w) => `pair${w.pair} ${Object.entries(w).filter(([k]) => !['pair', 'ratio'].includes(k)).map(([k, v]) => `${k} ${v ?? '?'}`).join('/')}`;
  return [{
    kind: 'environment-variability',
    message: `runner CPU benchmark varied ${Math.round(min)}-${Math.round(max)} (x${(max / min).toFixed(2)})${unstable.length ? `; within pair: ${unstable.map(fmt).join(', ')}` : ''}. Deltas are environment-sensitive; treat them as indicative, not a confirmed gain.`,
    benchmark: { min, max, ratio: Number((max / min).toFixed(3)), threshold: BENCHMARK_SPREAD_WARN },
    pairs: within.map((w) => ({ ...w, ratio: Number(w.ratio.toFixed(3)) })),
  }];
}

export function aggregatePairs({ pairsDir, expected, requestId, out, github = {}, where = 'actions' }) {
  if (!['actions', 'local'].includes(where)) throw new Error(`invalid aggregate location ${where}`);
  if (!Number.isInteger(expected) || expected < 1) throw new Error(`invalid expected pair count ${expected}`);
  const found = findPairResults(pairsDir);
  fs.mkdirSync(out, { recursive: true });
  const agg = {
    schema: 'perf-ab/pagespeed-v1', requestId, status: 'running', mode: where === 'local' ? 'pagespeed-local-paired' : 'pagespeed-us-paired', where,
    startedAt: null, finishedAt: null, github: { ...github }, cold: null, lighthouseVersion: EXPECTED.lighthouseVersion,
    names: null, runsPerVariant: expected, url: null, experiment: null, variants: null, profile: null, profileKey: null, chromeVersion: null, egress: null,
    pairs: [], runs: [], rejected: [], documentGeo: [], hints: null, edits: null, jobs: [],
    sourcePrs: null, sourceDrift: [], sourceWarnings: [],
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
      chromeVersion: r.chromeVersion ?? null, egressCountry: r.egress?.country ?? null, where: r.where ?? r.egress?.where ?? null,
      // Lighthouse CPU benchmark of every accepted run in the pair (the VM can change speed between the two loads).
      benchmarkIndexes: Object.fromEntries((r.names ?? ['before', 'after']).map((n) => [n, r.runs?.find((x) => x.variant === n && x.run === i)?.benchmarkIndex ?? null])),
      status: r.status ?? null,
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
    if (agg.sourcePrs && JSON.stringify(agg.sourcePrs) !== JSON.stringify(r.sourcePrs ?? [])) {
      pair.error = 'pair job used different pinned PR source metadata';
      continue;
    }
    agg.sourcePrs ??= r.sourcePrs ?? [];
    for (const drift of r.sourceDrift ?? []) agg.sourceDrift.push({ ...drift, pair: i });
    for (const warning of r.warnings ?? []) agg.sourceWarnings.push({ ...warning, pair: i });
    agg.startedAt = [agg.startedAt, r.startedAt].filter(Boolean).sort()[0] ?? null;
    if (r.hints) {
      agg.hints ??= { ...r.hints, perPair: [] };
      agg.hints.perPair.push({ pair: i, usedLinks: r.hints.usedLinks ?? null, contextual: r.hints.contextual?.length ?? 0, dropped: r.hints.dropped?.length ?? 0, linkHeaderStripped: r.hints.linkHeaderStripped ?? 0 });
    }
    if (r.status !== 'ok') { pair.error = `pair job ${r.status}${r.error ? `: ${r.error}` : ''}`; continue; }
    if (r.pair !== i) { pair.error = `pair job measured pair ${r.pair}, expected ${i}`; continue; }
    const validEgress = where === 'local'
      ? r.where === 'local' && r.egress?.where === 'local' && typeof r.egress?.country === 'string' && r.egress.country.length > 0
      : r.where !== 'local' && r.egress?.where !== 'local' && r.egress?.ok === true && r.egress?.country === 'US';
    if (!validEgress) { pair.error = where === 'local' ? 'local egress marker or country missing' : 'egress not verified US'; continue; }
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
  agg.warnings = [
    ...environmentWarnings(agg.pairs),
    ...(where === 'local' ? [{
      kind: 'local-results-not-comparable',
      message: `measured locally from ${agg.egress?.country ?? 'an unknown country'}; local results are not comparable with Actions results, even when profileKey matches`,
      country: agg.egress?.country ?? null,
    }] : []),
    ...agg.sourceWarnings,
  ];
  delete agg.sourceWarnings;
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
  for (const w of agg.warnings ?? []) console.warn(`WARNING (${w.kind}): ${w.message}`);
  if (agg.status !== 'ok') { console.error(`perf-ab aggregate ${agg.status}: ${agg.error}`); process.exit(1); }
}
