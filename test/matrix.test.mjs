// Paired matrix: shared stats, the aggregator, versioned experiment configs, the workflow prepare step and the
// CLI --config dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXPECTED, EXPECTED_PROFILE_KEY, profileKey, median, pairStats, metricDelta, hasMetrics } from '../lib/pagespeed/stats.mjs';
import { aggregatePairs, findPairResults } from '../lib/pagespeed/aggregate.mjs';
import { loadExperiment } from '../lib/pagespeed/experiment.mjs';
import { prepare } from '../lib/pagespeed/prepare.mjs';
import { decodeSpec, encodeSpec, validateSpec } from '../lib/pagespeed/spec.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';
import { runJob } from '../lib/pagespeed/job.mjs';
import { resolveConfig, assertConfigPublished } from '../bin/perf-ab.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ACROBAT = path.join(ROOT, 'experiments', 'acrobat-plans.json');
const run = promisify(execFile);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const m = (performance, LCP) => ({ performance, FCP: 1000, LCP, SI: 2000, TBT: 100, CLS: 0.01 });

// ---------- stats ----------

test('stats: profile key covers the whole compared preset, including viewport and mobile', () => {
  assert.equal(EXPECTED_PROFILE_KEY, 'lh13.6.0-mobile-devtools-rtt150-tput1638.4-lat562.5-down1474.56-up675-cpu4-load120000-412x823@1.75-mobile');
  for (const [k, v] of [['width', 360], ['height', 640], ['deviceScaleFactor', 2.625], ['mobile', false], ['cpuSlowdownMultiplier', 1.2], ['rttMs', 40], ['throttlingMethod', 'simulate'], ['requestLatencyMs', 150], ['downloadThroughputKbps', 1638.4], ['uploadThroughputKbps', 750], ['maxWaitForLoad', 45000]]) {
    assert.notEqual(profileKey({ ...EXPECTED, [k]: v }), EXPECTED_PROFILE_KEY, k);
  }
  assert.equal(profileKey(null), null);
});

test('stats: medians and the median per-pair delta use complete pairs only', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.throws(() => median([1, null]), /non-finite/);
  assert.ok(!hasMetrics({ ...m(50, 4000), TBT: null }));
  const pairs = [
    { before: m(50, 4000), after: m(80, 3000) },
    { before: m(60, 5000), after: m(70, 3500) },
    { before: m(40, 4500), after: m(90, 2000) },
    { before: null, after: m(10, 9000) }, // incomplete: never counted
  ];
  const s = pairStats(pairs, ['before', 'after']);
  assert.equal(s.complete, 3);
  assert.equal(s.medians.before.performance, 50);
  assert.equal(s.medians.after.performance, 80);
  assert.equal(s.medians.delta.performance, 30, 'median of per-pair deltas (30, 10, 50), not a difference of medians');
  assert.equal(s.medians.delta.LCP, -1500, 'median of (-1000, -1500, -2500)');
  assert.deepEqual(metricDelta(m(50, 4000), m(80, 3000)).LCP, -1000);
  const single = pairStats([{ before: null, after: m(70, 3000) }], ['after']);
  assert.deepEqual([single.complete, single.medians.before, single.medians.delta, single.medians.after.performance], [1, null, null, 70]);
});

// ---------- aggregate ----------

function pairJob(dir, i, { requestId = 'req-matrix-1', status = 'ok', pair = i, egress = { ok: true, country: 'US', checks: [] }, profile = EXPECTED, before = m(50 + i, 4000), after = m(80 + i, 3000), artifactName = `perf-ab-req-matrix-1-pair${i}`, bench = [1500 + i, 1520 + i] } = {}) {
  const d = path.join(dir, artifactName);
  fs.mkdirSync(path.join(d, `before${i}`), { recursive: true });
  fs.mkdirSync(path.join(d, `after${i}`), { recursive: true });
  fs.writeFileSync(path.join(d, `after${i}`, 'report.html'), '<html>Lighthouse Report</html>');
  const r = {
    schema: 'perf-ab/pagespeed-v1', requestId, status, mode: 'pagespeed-us', pair, names: ['before', 'after'], url: 'https://www.adobe.com/acrobat/plans.html',
    experiment: { name: 'acrobat-plans-latest', config: 'experiments/acrobat-plans.json' }, egress, profile, chromeVersion: `HeadlessChrome/14${i}.0`,
    github: { runAttempt: 1, runner: `runner-${i}`, os: 'linux-x64', cpus: 4 }, cold: { warmups: 0 },
    runs: [
      ...(before ? [{ variant: 'before', run: i, attempt: 1, dir: `before${i}`, metrics: before, benchmarkIndex: bench[0] }] : []),
      ...(after ? [{ variant: 'after', run: i, attempt: 1, dir: `after${i}`, metrics: after, benchmarkIndex: bench[1] }] : []),
    ],
    rejected: status === 'ok' ? [] : [{ variant: 'after', run: i, attempt: 1, reason: 'render check failed', dir: `rejected/after${i}-attempt1` }],
    documentGeo: [{ variant: 'before', run: i, status: 'US' }],
    hints: { requestedLinks: 57, usedLinks: 57, contextual: [], dropped: [] },
    ...(status === 'ok' ? {} : { error: 'after: rejected after 3 attempt(s)', errorKind: 'rejected-after-retries' }),
  };
  fs.writeFileSync(path.join(d, 'results.json'), JSON.stringify(r));
  return d;
}

test('aggregate: keeps both per-variant CPU benchmarks per pair and warns on runner variability without dropping runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-bench-'));
  try {
    // Actual benchmarkIndex values of run 41633898462 (before/after per pair).
    const bench = [[2368.5, 3103], [2368.5, 2913.5], [1050, 2969]];
    for (const i of [1, 2, 3]) pairJob(dir, i, { bench: bench[i - 1] });
    const a = aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-matrix-1', out: path.join(dir, 'out') });
    assert.equal(a.status, 'ok');
    assert.equal(a.samples.pairs, 3);
    assert.deepEqual(a.pairs.map((p) => p.job.benchmarkIndexes), bench.map(([before, after]) => ({ before, after })));
    assert.equal(a.warnings.length, 1);
    const [w] = a.warnings;
    assert.equal(w.kind, 'environment-variability');
    assert.deepEqual([w.benchmark.min, w.benchmark.max], [1050, 3103]);
    assert.match(w.message, /1050-3103/);
    assert.match(w.message, /pair1 before 2368\.5\/after 3103/);
    assert.match(w.message, /pair3 before 1050\/after 2969/);
    assert.match(w.message, /not a confirmed gain/);
    assert.deepEqual(w.pairs.map((p) => p.pair), [1, 2, 3]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'results.json'), 'utf8'));
    assert.deepEqual(saved.warnings, a.warnings);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate: three complete pairs give ok paired medians, per-pair job metadata and pair<i>/ diagnostics', () => {
  const dir = tmp('perf-ab-agg-in-');
  const out = tmp('perf-ab-agg-out-');
  try {
    for (const i of [1, 2, 3]) pairJob(dir, i);
    assert.deepEqual([...findPairResults(dir).keys()].sort(), [1, 2, 3]);
    const a = aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-matrix-1', out, github: { runId: 5, runAttempt: 2 } });
    assert.equal(a.status, 'ok');
    assert.equal(a.mode, 'pagespeed-us-paired');
    assert.deepEqual(a.samples, { requested: 3, pairs: 3, before: 3, after: 3, rejected: 0 });
    assert.equal(a.medians.before.performance, 52);
    assert.equal(a.medians.after.performance, 82);
    assert.equal(a.medians.delta.performance, 30);
    assert.equal(a.profileKey, EXPECTED_PROFILE_KEY);
    assert.deepEqual(a.experiment, { name: 'acrobat-plans-latest', config: 'experiments/acrobat-plans.json' });
    assert.deepEqual(a.pairs.map((p) => [p.index, p.job.chromeVersion, p.job.runner, p.job.benchmarkIndexes]), [[1, 'HeadlessChrome/141.0', 'runner-1', { before: 1501, after: 1521 }], [2, 'HeadlessChrome/142.0', 'runner-2', { before: 1502, after: 1522 }], [3, 'HeadlessChrome/143.0', 'runner-3', { before: 1503, after: 1523 }]]);
    assert.deepEqual(a.warnings, []);
    assert.deepEqual(a.github, { runId: 5, runAttempt: 2 });
    assert.deepEqual(a.runs.map((r) => r.dir), ['pair1/before1', 'pair1/after1', 'pair2/before2', 'pair2/after2', 'pair3/before3', 'pair3/after3']);
    assert.ok(fs.existsSync(path.join(out, 'pair2', 'after2', 'report.html')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).status, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('aggregate: missing, failed, foreign, non-US, wrong-profile and mislabelled pairs never count; result is partial/failed', () => {
  const dir = tmp('perf-ab-agg-in-');
  const out = tmp('perf-ab-agg-out-');
  try {
    pairJob(dir, 1);
    pairJob(dir, 2, { status: 'failed', after: null });
    pairJob(dir, 4, { requestId: 'someone-else-1' });
    pairJob(dir, 5, { egress: { ok: false, country: null } });
    pairJob(dir, 6, { profile: { ...EXPECTED, width: 360 } });
    pairJob(dir, 7, { pair: 1 });
    pairJob(dir, 8, { after: { ...m(1, 1), TBT: null } });
    pairJob(dir, 9, { profile: { ...EXPECTED, throttlingMethod: 'simulate', requestLatencyMs: undefined, cpuSlowdownMultiplier: 1.2 } });
    // pair 3 has no artifact at all
    const a = aggregatePairs({ pairsDir: dir, expected: 9, requestId: 'req-matrix-1', out });
    assert.equal(a.status, 'partial');
    assert.equal(a.errorKind, 'rejected-after-retries');
    assert.deepEqual(a.samples, { requested: 9, pairs: 1, before: 1, after: 1, rejected: 1 });
    assert.equal(a.medians.delta.performance, 30, 'only pair 1 contributes');
    const err = Object.fromEntries(a.pairs.map((p) => [p.index, p.error ?? null]));
    assert.equal(err[1], null);
    assert.match(err[2], /pair job failed: after: rejected/);
    assert.match(err[3], /artifact missing/);
    assert.match(err[4], /belong to request someone-else-1/);
    assert.match(err[5], /egress not verified US/);
    assert.match(err[6], /profile mismatch: width=360/);
    assert.match(err[7], /measured pair 1, expected 7/);
    assert.match(err[8], /missing accepted metrics/);
    assert.match(err[9], /profile mismatch: throttlingMethod=simulate.*never mixed in/, 'former simulated results are refused');
    assert.ok(a.pairs.slice(1).every((p) => p.before === null && p.after === null && p.delta === null));
    assert.ok(fs.existsSync(path.join(out, 'pair2', 'results.json')), 'failed pair diagnostics are kept');
    assert.match(a.error, /pair3: .*artifact missing/);

    const none = aggregatePairs({ pairsDir: path.join(dir, 'nothing'), expected: 2, requestId: 'req-matrix-1', out: path.join(out, 'none') });
    assert.equal(none.status, 'failed');
    assert.equal(none.errorKind, 'infrastructure');
    assert.deepEqual(none.medians, { before: null, after: null, delta: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('aggregate: local and Actions pairs are never mixed; a local aggregate carries its marker and warning', () => {
  const dir = tmp('perf-ab-agg-in-');
  const out = tmp('perf-ab-agg-out-');
  try {
    pairJob(dir, 1, { egress: { ok: false, country: 'CH', where: 'local', checks: [] }, artifactName: 'pair1' });
    const resultsFile = path.join(dir, 'pair1', 'results.json');
    fs.writeFileSync(resultsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(resultsFile, 'utf8')), where: 'local', mode: 'pagespeed-local' }));
    const local = aggregatePairs({ pairsDir: dir, expected: 1, requestId: 'req-matrix-1', out, where: 'local' });
    assert.equal(local.status, 'ok');
    assert.equal(local.where, 'local');
    assert.equal(local.egress.country, 'CH');
    assert.equal(local.profileKey, EXPECTED_PROFILE_KEY);
    assert.equal(local.pairs[0].job.where, 'local');
    assert.deepEqual(local.warnings.map((w) => w.kind), ['local-results-not-comparable']);
    assert.match(local.warnings[0].message, /not comparable with Actions results, even when profileKey matches/);
    const asActions = aggregatePairs({ pairsDir: dir, expected: 1, requestId: 'req-matrix-1', out: path.join(out, 'a') });
    assert.equal(asActions.status, 'failed');
    assert.match(asActions.pairs[0].error, /egress not verified US/);
    pairJob(dir, 2, { artifactName: 'pair2' });
    const asLocal = aggregatePairs({ pairsDir: dir, expected: 2, requestId: 'req-matrix-1', out: path.join(out, 'b'), where: 'local' });
    assert.equal(asLocal.status, 'partial');
    assert.match(asLocal.pairs[1].error, /local egress marker or country missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('aggregate CLI exits 1 unless every pair is complete', async () => {
  const dir = tmp('perf-ab-agg-in-');
  const out = tmp('perf-ab-agg-out-');
  try {
    pairJob(dir, 1);
    const cli = path.join(ROOT, 'lib', 'pagespeed', 'aggregate.mjs');
    const ok = await run(process.execPath, [cli, '--pairs-dir', dir, '--expected', '1', '--request-id', 'req-matrix-1', '--out', out]);
    assert.match(ok.stdout, /ok, 1\/1 complete pair/);
    await assert.rejects(run(process.execPath, [cli, '--pairs-dir', dir, '--expected', '2', '--request-id', 'req-matrix-1', '--out', out]), (e) => e.code === 1 && /partial/.test(e.stderr));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- experiment configs ----------

test('experiment: the Acrobat config uses the pinned Milo PR source (57 US hints and priorities)', () => {
  const s = loadExperiment(ACROBAT, { config: 'experiments/acrobat-plans.json' });
  assert.deepEqual(validateSpec(s), s);
  assert.equal(s.runs, 3);
  assert.deepEqual(s.names, ['before', 'after']);
  assert.deepEqual(s.variants.before, { url: 'https://www.adobe.com/acrobat/plans.html' });
  assert.deepEqual(s.meta, { name: 'acrobat-plans-latest', config: 'experiments/acrobat-plans.json' });
  const links = s.variants.after.headInject.match(/<link\b/g);
  assert.equal(links.length, 57);
  assert.doesNotMatch(s.variants.after.headInject, /country=CH|\/experienceedge/);
  assert.deepEqual(s.variants.after.priorities.filter((p) => p.priority === 'high').map((p) => p.path).sort(),
    ['/acrobat/scripts/scripts.js', '/acrobat/styles/styles.css', '/libs/c2/styles/styles.css', '/libs/martech/helpers.js', '/libs/utils/utils.js']);
  assert.deepEqual(s.variants.after.pullRequests, [{ repo: 'adobecom/milo', number: 7095 }]);
  assert.equal(s.variants.after.patches, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'experiments', 'acrobat-plans', 'market-config.patch.json')), false);
  assert.deepEqual(s.expect, { title: 'Acrobat plans', counts: [{ selector: 'body:has(merch-card)', count: 1 }, { selector: 'main h1', count: 1 }] });
  assert.equal(loadExperiment(ACROBAT, { runs: '1' }).runs, 1);
  assert.equal(decodeSpec(encodeSpec(s)).variants.after.headInject, s.variants.after.headInject, 'fits the dispatch input');
});

test('experiment: unknown fields, traversal, absolute files, /experienceedge hints and bad names are rejected', () => {
  const dir = tmp('perf-ab-exp-');
  try {
    const write = (name, cfg, files = {}) => {
      for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ schema: 'perf-ab/experiment-v1', name: 'x-test', url: 'https://www.adobe.com/x.html', ...cfg }));
      return path.join(dir, name);
    };
    const plain = loadExperiment(write('plain.json', {}));
    assert.deepEqual([plain.names, plain.runs], [['after'], 3]);
    assert.throws(() => loadExperiment(write('a.json', { extra: 1 })), /unknown field\(s\): extra/);
    assert.throws(() => loadExperiment(write('b.json', { after: { script: 'x' } })), /unknown after\.field\(s\): script/);
    assert.throws(() => loadExperiment(write('c.json', { after: { headInject: '../secret.html' } })), /leaves the config directory/);
    assert.throws(() => loadExperiment(write('d.json', { after: { headInject: '/etc/hosts' } })), /must be a relative path/);
    assert.throws(() => loadExperiment(write('e.json', { after: { headInject: 'h.html' } }, { 'h.html': '<link rel="preload" href="https://edge.adobe.com/experienceedge/v1/interact" as="fetch">' })), /experienceedge/);
    assert.throws(() => loadExperiment(write('f.json', { name: 'Bad Name' })), /name must be/);
    assert.throws(() => loadExperiment(write('g.json', { schema: 'other' })), /schema must be/);
    assert.throws(() => loadExperiment(write('h.json', { url: 'https://adobe.com.evil.example/' })), /adobe\.com/);
    assert.throws(() => loadExperiment(write('i.json', { after: { patches: ['p.json'] } }, { 'p.json': '{"replacements":[]}' })), /expected \{"replacements"/);
    assert.throws(() => loadExperiment(write('j.json', { runs: 11 })), /runs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- workflow prepare ----------

const PR_HEAD = 'a'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const PR_MERGE = 'c'.repeat(40);
const PR_BLOB = 'd'.repeat(40);
const resolveTestPrs = async (requests) => ({
  localSources: Object.fromEntries(requests.map((pr) => ['/libs/utils/utils.js', {
    repo: pr.repo, number: pr.number, headSha: PR_HEAD, mergeBaseSha: PR_MERGE,
    filePath: 'libs/utils/utils.js', baseFilePath: 'libs/utils/utils.js', blobSha: PR_BLOB, deleted: false,
  }])),
  sourcePrs: requests.map((pr) => ({
    ...pr, baseRef: 'stage', headRef: 'MWPW-213916', baseSha: PR_BASE, headSha: PR_HEAD, mergeBaseSha: PR_MERGE,
    files: [{ status: 'modified', path: '/libs/utils/utils.js', blobSha: PR_BLOB }],
  })),
});

test('prepare: exactly one of spec/config/url, bounded runs and repository PR inputs', async () => {
  const options = { root: ROOT, resolvePrs: resolveTestPrs };
  const p = await prepare({ CONFIG: 'experiments/acrobat-plans.json', RUNS: '1', REQUEST_ID: 'mw0-req-1' }, options);
  assert.deepEqual([p.requestId, p.runs, p.pairs, p.names], ['mw0-req-1', 1, [1], ['before', 'after']]);
  assert.equal(decodeSpec(p.spec).meta.config, 'experiments/acrobat-plans.json');
  assert.equal(decodeSpec(p.spec).variants.after.sourcePrs[0].headSha, PR_HEAD);
  assert.deepEqual(Object.keys(decodeSpec(p.spec).variants.after.localSources), ['/libs/utils/utils.js']);
  const full = await prepare({ CONFIG: 'experiments/acrobat-plans.json' }, { ...options, runId: 123 });
  assert.deepEqual([full.requestId, full.pairs], ['gh-run-123', [1, 2, 3]]);
  const url = await prepare({ URL: 'https://www.adobe.com/acrobat/plans.html', RUNS: '2' }, { ...options, runId: 9 });
  assert.deepEqual([url.names, url.pairs], [['after'], [1, 2]]);
  const actionUrl = await prepare({ URL: 'https://www.adobe.com/acrobat/plans.html', MILO_PR: '7095', RUNS: '1' }, options);
  assert.deepEqual(actionUrl.names, ['before', 'after']);
  assert.equal(decodeSpec(actionUrl.spec).variants.after.sourcePrs[0].number, 7095);
  let override;
  await prepare({ CONFIG: 'experiments/acrobat-plans.json', MILO_PR: '7100' }, {
    ...options, resolvePrs: async (reqs) => { override = reqs; return resolveTestPrs(reqs); },
  });
  assert.deepEqual(override, [{ repo: 'adobecom/milo', number: 7100 }], 'workflow input overrides the config PR for that repo');
  const enc = encodeSpec(validateSpec({ version: 1, runs: 2, names: ['after'], variants: { after: { url: 'https://www.adobe.com/' } }, expect: {} }));
  assert.equal((await prepare({ SPEC: enc, REQUEST_ID: 'cli-req-1' }, options)).spec, enc);

  await assert.rejects(prepare({}, options), /exactly one of spec, config or url is required \(got none\)/);
  await assert.rejects(prepare({ CONFIG: 'experiments/acrobat-plans.json', URL: 'https://www.adobe.com/' }, options), /got config, url/);
  for (const RUNS of ['0', '11', '2.5', 'x']) await assert.rejects(prepare({ URL: 'https://www.adobe.com/', RUNS }, options), /runs must be an integer 1\.\.10/);
  await assert.rejects(prepare({ SPEC: enc, RUNS: '3' }, options), /cannot override/);
  await assert.rejects(prepare({ SPEC: enc, MILO_PR: '7095' }, options), /cannot be combined with spec/);
  for (const MILO_PR of ['0', '-1', '12x', '1000000']) await assert.rejects(prepare({ URL: 'https://www.adobe.com/', MILO_PR }, options), /positive PR number/);
  for (const CONFIG of ['../etc/x.json', 'experiments/../package.json', '/abs/experiments/x.json', 'package.json', 'experiments/x.js']) {
    await assert.rejects(prepare({ CONFIG }, options), /experiments\/<name>\.json/, CONFIG);
  }
  await assert.rejects(prepare({ URL: 'https://evil.example/' }, { ...options, runId: 1 }), /adobe\.com/);
  await assert.rejects(prepare({ URL: 'https://www.adobe.com/', REQUEST_ID: 'x;rm' }, options), /invalid request id/);
});

test('prepare CLI writes the step outputs; the workflow passes inputs through env only', async () => {
  const outFile = path.join(tmp('perf-ab-prep-'), 'out');
  try {
    await run(process.execPath, [path.join(ROOT, 'lib', 'pagespeed', 'prepare.mjs')], { cwd: ROOT, env: { ...process.env, CONFIG: '', RUNS: '1', REQUEST_ID: 'mw0-req-2', GITHUB_OUTPUT: outFile, SPEC: '', URL: 'https://www.adobe.com/' } });
    const o = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.deepEqual([o.request_id, o.runs, o.pairs], ['mw0-req-2', '1', '[1]']);
    assert.equal(decodeSpec(o.spec).runs, 1);
  } finally {
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'perf-ab.yml'), 'utf8');
  assert.doesNotMatch(wf.replace(/^run-name:.*$/m, ''), /run:[^\n]*\$\{\{\s*inputs\./, 'no inputs interpolated into shell');
  assert.match(wf, /permissions:\s*\n\s*contents: read/);
  assert.match(wf, /milo_pr:\s*\n\s*description: Optional adobecom\/milo PR number/);
  assert.match(wf, /mas_pr:\s*\n\s*description: Optional adobecom\/mas PR number/);
  assert.match(wf, /MILO_PR: \$\{\{ inputs\.milo_pr \}\}/);
  assert.match(wf, /MAS_PR: \$\{\{ inputs\.mas_pr \}\}/);
  assert.match(wf, /fail-fast: false/);
  assert.match(wf, /matrix:\s*\n\s*pair: \$\{\{ fromJSON\(needs\.prepare\.outputs\.pairs\) \}\}/);
  assert.doesNotMatch(wf, /schedule:|pull_request|contents: write|pages: write|id-token/);
});

// ---------- job + remote + CLI ----------

test('job: an out-of-range pair is fatal before anything is launched', async () => {
  const out = tmp('perf-ab-pair-');
  let launched = 0;
  try {
    const r = await runJob({ spec: { version: 1, runs: 2, names: ['after'], variants: { after: { url: 'https://www.adobe.com/x' } }, expect: {} }, requestId: 'pair-test-1', out, pair: 3, fetchJson: async () => ({ country: 'US' }), launchBrowser: async () => { launched += 1; }, log: () => {}, warn: () => {} });
    assert.equal(r.status, 'failed');
    assert.equal(r.errorKind, 'fatal');
    assert.match(r.error, /invalid pair 3 for 2/);
    assert.equal(launched, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

function fakeGh(results, files = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (key === 'workflow run') gh.rid = args.find((a) => a.startsWith('request_id=')).split('=')[1];
    if (key === 'run list') return JSON.stringify([{ databaseId: 42, displayTitle: `perf-ab ${gh.rid}`, status: 'completed', conclusion: results.status === 'ok' ? 'success' : 'failure', url: 'https://github.com/x/runs/42' }]);
    if (key === 'run view') return args.includes('--log-failed') ? 'aggregate partial' : JSON.stringify({ status: 'completed', conclusion: results.status === 'ok' ? 'success' : 'failure' });
    if (key === 'run download') {
      const dir = args[args.indexOf('-D') + 1];
      fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...results, requestId: gh.rid }));
      for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
    }
    return '';
  };
  gh.calls = calls;
  return gh;
}

test('remote: --config dispatches config + runs inputs, downloads pair<i>/ dirs and clears stale ones; partial fails', async () => {
  const out = tmp('perf-ab-remote-cfg-');
  try {
    fs.mkdirSync(path.join(out, 'pair4'));
    fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
    const s = loadExperiment(ACROBAT, { runs: 1, config: 'experiments/acrobat-plans.json' });
    const ok = { status: 'ok', profile: EXPECTED, egress: { country: 'US' }, medians: {}, rejected: [], samples: { requested: 1, pairs: 1 } };
    const gh = fakeGh(ok, { 'pair1/after1/report.html': '<html>' });
    const opts = { spec: s, config: 'experiments/acrobat-plans.json', out, gh, pollMs: 1, wait: async () => {}, log: () => {} };
    await runRemote(opts);
    const dispatch = gh.calls.find((c) => c[0] === 'workflow');
    assert.ok(dispatch.includes('config=experiments/acrobat-plans.json'));
    assert.ok(dispatch.includes('runs=1'));
    assert.ok(!dispatch.some((a) => a.startsWith('spec=')));
    assert.deepEqual(fs.readdirSync(out).sort(), ['keep.txt', 'pair1', 'results.json']);
    await assert.rejects(runRemote({ ...opts, gh: fakeGh({ ...ok, status: 'partial', error: 'pair2: pair job produced no results', samples: { requested: 3, pairs: 2 } }) }),
      (e) => /partial \(2\/3 complete pair\(s\)\)/.test(e.message) && /pair2: pair job produced no results/.test(e.message) && e.results.status === 'partial');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('CLI --config: repository experiments/*.json only, no URL/change flags, must match the pushed ref', async () => {
  assert.deepEqual(resolveConfig('experiments/acrobat-plans.json', { cwd: os.tmpdir() }).rel, 'experiments/acrobat-plans.json');
  assert.throws(() => resolveConfig('package.json', { cwd: ROOT }), /must be an experiments/);
  assert.throws(() => resolveConfig('experiments/nope.json', { cwd: ROOT }), /not found/);
  assert.doesNotThrow(() => assertConfigPublished('experiments/acrobat-plans.json', 'main', { git: () => '' }));
  assert.throws(() => assertConfigPublished('experiments/acrobat-plans.json', 'main', { git: (a) => (a[0] === 'diff' ? 'experiments/acrobat-plans/head.html\n' : '') }), /differ from origin\/main.*commit and push first/);
  const cli = path.join(ROOT, 'bin', 'perf-ab.mjs');
  const cfg = 'experiments/acrobat-plans.json';
  for (const extra of [['https://www.adobe.com/x.html'], ['--head-inject', 'x.html'], ['--expect-count', 'a=1'], ['-n', '11']]) {
    await assert.rejects(run(process.execPath, [cli, '--config', cfg, ...extra], { cwd: ROOT, env: { ...process.env, GH_TOKEN: '' } }), (e) => e.code === 1 && /--config defines|--runs must/.test(e.stderr), extra.join(' '));
  }
  const { stdout } = await run(process.execPath, [cli, '--help']);
  assert.match(stdout, /--config <file>/);
  assert.match(stdout, /ONE complete cold before\/after pair/);
});
