// Pure-logic tests for the read-only history dashboard (site/dashboard-core.mjs): schema parsing, filters and URL
// state, formatting, link safety and the direction verdicts. Fixtures are synthetic and live only under test/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../site/dashboard-core.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dashboard');
const readFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
const MINUS = '\u2212';
const NBSP = '\u00a0';

const history = () => core.parseHistory(readFixture('index.json'));
const detail = (id) => core.parseRun(readFixture(`runs/${id}.json`), id);
const pairsOf = (deltas, key = 'LCP') => deltas.map((d, i) => ({ index: i + 1, complete: true, delta: { [key]: d } }));
const okRun = (key, medianDelta) => ({ status: 'ok', us: true, medians: { delta: { [key]: medianDelta } } });

test('parseHistory accepts history-v1, skips invalid entries and sorts newest first', () => {
  const h = history();
  assert.equal(h.runs.length, 13);
  assert.equal(h.skipped.length, 2);
  assert.match(h.skipped[0], /not-a-run-id/);
  assert.match(h.skipped[1], /createdAt/);
  assert.equal(h.updatedAt, Date.parse('2026-11-02T18:00:00Z'));
  for (let i = 1; i < h.runs.length; i += 1) assert.ok(h.runs[i - 1].createdAt >= h.runs[i].createdAt);
  assert.equal(h.runs[0].id, '41631000001-1');
});

test('parseHistory rejects other schemas and shapes, and skips duplicate ids', () => {
  assert.throws(() => core.parseHistory(null), core.SchemaError);
  assert.throws(() => core.parseHistory([]), core.SchemaError);
  assert.throws(() => core.parseHistory({ schema: 'perf-ab/history-v2', runs: [] }), /history-v2.*history-v1/);
  assert.throws(() => core.parseHistory({ schema: core.HISTORY_SCHEMA }), /no runs array/);
  const empty = core.parseHistory({ schema: core.HISTORY_SCHEMA, updatedAt: '2026-11-01T00:00:00Z', runs: [] });
  assert.deepEqual([empty.runs.length, empty.skipped.length], [0, 0]);
  const run = { id: '1-1', createdAt: '2026-11-01T00:00:00Z', status: 'ok' };
  const dup = core.parseHistory({ schema: core.HISTORY_SCHEMA, runs: [run, run, 'x'] });
  assert.equal(dup.runs.length, 1);
  assert.equal(dup.skipped.length, 2);
  assert.match(dup.skipped[0], /^duplicate run id 1-1/);
  assert.match(dup.skipped[1], /not an object/);
});

test('normalizeSummary flags smoke, single-URL, US verification and unknown status', () => {
  const byId = Object.fromEntries(history().runs.map((r) => [r.id, r]));
  const smoke = byId['41631000001-1'];
  assert.equal(smoke.smoke, true);
  assert.equal(smoke.us, true);
  assert.deepEqual(smoke.samples, { requested: 1, before: 1, after: 1, pairs: 1, rejected: 0 });
  assert.equal(smoke.medians.delta.TBT, -1812);
  assert.equal(smoke.medians.delta.performance, 32);

  const nonUs = byId['41700000007-1'];
  assert.equal(nonUs.us, false);
  assert.deepEqual(nonUs.egress, { country: 'DE', verified: false, documentGeo: 'non-US' });

  const single = byId['41700000008-1'];
  assert.equal(single.single, true);
  assert.equal(single.medians.before, null);
  assert.equal(single.medians.delta, null);

  const unknown = byId['41700000013-1'];
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.rawStatus, 'queued');

  const base = { id: '1-1', createdAt: '2026-11-01T00:00:00Z', status: 'ok' };
  const us = (egress) => core.normalizeSummary({ ...base, egress }).us;
  assert.equal(us({ country: 'US', verified: true }), true);
  assert.equal(us({ country: 'us', verified: true, documentGeo: 'US' }), true);
  assert.equal(us({ country: 'US', verified: true, documentGeo: 'unavailable' }), true);
  assert.equal(us({ country: 'US', verified: true, documentGeo: 'non-US' }), false);
  assert.equal(us({ country: 'US', verified: true, documentGeo: 'DE' }), false);
  assert.equal(us({ country: 'US', verified: 'true' }), false);
  assert.equal(us({ country: 'US' }), false);
  assert.equal(us(undefined), false);
  const local = core.normalizeSummary({ ...base, where: 'local', egress: { country: 'US', verified: true, where: 'local' } });
  assert.equal(local.where, 'local');
  assert.equal(local.egress.country, 'US');
  assert.equal(local.us, false, 'local runs must never be treated as US-comparable');
});

test('normalizeSummary keeps unsafe links unlinked and caps text', () => {
  const byId = Object.fromEntries(history().runs.map((r) => [r.id, r]));
  const bad = byId['41700000012-1'];
  assert.equal(bad.github.runUrl, null);
  assert.equal(bad.github.sha, null);
  const xss = byId['41700000006-1'];
  assert.match(xss.name, /^<img/);
  assert.equal(xss.errorKindLabel.toLowerCase(), 'rejected after retries');
  assert.equal(xss.errorCode, 'lighthouse-failed');
  assert.equal(xss.conclusion, 'failure');
  assert.equal(byId['41700000007-1'].errorCodeLabel, 'Egress was not verified as US');
  const code = (errorCode) => core.normalizeSummary({ id: '1-1', createdAt: '2026-11-01T00:00:00Z', errorCode });
  assert.equal(code('profile-mismatch').errorCodeLabel, 'Lighthouse profile did not match the expected profile');
  assert.equal(code('new-code').errorCodeLabel, 'new-code');
  assert.equal(code('<b>x</b>').errorCode, null);
  assert.equal(code(42).errorCode, null);
  const long = core.normalizeSummary({ id: '1-1', createdAt: '2026-11-01T00:00:00Z', error: 'x'.repeat(1000), detailPath: '../secrets.json' });
  assert.equal(long.error.length, 300);
  assert.equal(long.detailPath, null);
  assert.equal(long.status, 'unknown');
});

test('parseRun validates schema and id, derives deltas and counts incomplete pairs', () => {
  const run = detail('41700000005-1');
  assert.equal(run.status, 'partial');
  assert.equal(run.pairs.length, 5);
  assert.deepEqual(run.pairs.map((p) => p.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(run.pairs.map((p) => p.complete), [true, true, true, false, false]);
  assert.equal(run.incompletePairs, 2);
  assert.equal(run.rejectedAttempts.length, 2);
  assert.deepEqual(run.rejectedAttempts[0], { variant: 'after', run: 4, attempt: 1, reason: 'Lighthouse runtime error NO_FCP on https://www.adobe.com/products/photoshop.html' });
  assert.equal(run.pairs[4].job, null);

  const raw = readFixture('runs/41700000001-1.json');
  assert.throws(() => core.parseRun(raw, '41700000002-1'), /expected 41700000002-1/);
  assert.throws(() => core.parseRun({ ...raw, schema: 'perf-ab/run-v0' }), /run-v0/);
  assert.throws(() => core.parseRun(readFixture('runs/41700000012-1.json'), '41700000012-1'), core.SchemaError);

  const noDelta = core.parseRun({ ...raw, pairs: [{ index: 3, before: { LCP: 1000 }, after: { LCP: 800 } }] });
  assert.equal(noDelta.pairs[0].delta.LCP, -200);
  assert.equal(noDelta.pairs[0].index, 3);
  const noIndex = core.parseRun({ ...raw, pairs: [{ before: { LCP: 1 }, after: { LCP: 1 } }, { before: { LCP: 1 } }] });
  assert.deepEqual(noIndex.pairs.map((p) => [p.index, p.complete]), [[1, true], [2, false]]);

  const single = detail('41700000008-1');
  assert.equal(single.incompletePairs, 0);
  assert.equal(single.single, true);

  const reRun = detail('41700000003-2');
  assert.deepEqual([...new Set(reRun.pairs.map((p) => p.job.runAttempt))], [1, 2]);
  assert.equal(reRun.pairs[0].job.benchmarkIndex, 1790);
  assert.deepEqual(reRun.changes.patchPaths, ['libs/styles/styles.css']);
});

test('artifactState: missing, expired by flag or date, unlinked, available', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  assert.equal(core.artifactState(null, now), 'missing');
  assert.equal(core.artifactState(detail('41700000006-1').artifact, now), 'missing');
  assert.equal(core.artifactState(detail('41700000003-2').artifact, now), 'expired');
  assert.equal(core.artifactState(detail('41500000009-1').artifact, now), 'expired');
  assert.equal(core.artifactState(detail('41700000001-1').artifact, now), 'available');
  assert.equal(core.artifactState({ name: 'x', url: null, expiresAt: null, expired: false }, now), 'unlinked');
  const artifact = core.parseRun({ ...readFixture('runs/41700000001-1.json'), artifact: { name: 'a', url: 'https://evil.example/a.zip', expiresAt: '2099-01-01T00:00:00Z' } }).artifact;
  assert.equal(artifact.url, null);
  assert.equal(core.artifactState(artifact, now), 'unlinked');
});

test('safeExternalUrl allows https links to trusted repos and adobe.com', () => {
  const ok = [
    'https://github.com/adobecom/perf-tools/actions/runs/41631057972',
    'https://github.com/adobecom/perf-tools',
    'https://github.com/adobecom/milo/pull/7095',
    'https://github.com/adobecom/mas/pull/1487',
    'https://www.adobe.com/acrobat/pricing.html?x=1',
    'https://adobe.com/',
  ];
  for (const u of ok) assert.equal(core.safeExternalUrl(u), new URL(u).href, u);
  const bad = [
    'javascript:alert(1)', 'data:text/html,x', 'http://www.adobe.com/', 'https://user:pw@www.adobe.com/', 'https://www.adobe.com:8443/',
    'https://evil-adobe.com/', 'https://www.adobe.com.evil.net/', 'https://github.com/adobecom/perf-tools-evil/x',
    'https://github.com/adobecom/milo/issues/1', 'https://github.com/evil/repo',
    'https://gist.github.com/adobecom/perf-tools', '//www.adobe.com/', 'https://www.adobe.com/' + 'a'.repeat(2100), 42, null,
  ];
  for (const u of bad) assert.equal(core.safeExternalUrl(u), null, String(u).slice(0, 60));
});

test('detail paths, shas, repo paths and blob links are strictly validated', () => {
  assert.equal(core.safeDetailPath('data/runs/41631057972-1.json'), 'data/runs/41631057972-1.json');
  for (const p of ['/data/runs/1-1.json', 'data/runs/../index.json', 'https://x/data/runs/1-1.json', 'data/runs/1-1.json?x', 'data/runs/a-1.json']) {
    assert.equal(core.safeDetailPath(p), null, p);
  }
  assert.equal(core.safeSha('A3F1C9E'), 'a3f1c9e');
  assert.equal(core.safeSha('a3f1c9'), null);
  assert.equal(core.safeSha('zzzzzzzz'), null);
  assert.equal(core.commitUrl('not-a-sha'), null);
  assert.equal(core.safeRepoPath('experiments/a b.json'), null);
  assert.equal(core.safeRepoPath('../etc/passwd'), null);
  assert.equal(core.safeRepoPath('/etc/passwd'), null);
  assert.equal(core.safeRepoPath('experiments/./x.json'), null);
  assert.equal(core.blobUrl('a3f1c9e27b', 'experiments/acrobat-plans-latest.json'), 'https://github.com/adobecom/perf-tools/blob/a3f1c9e27b/experiments/acrobat-plans-latest.json');
  assert.equal(core.blobUrl('nope', 'experiments/x.json'), null);
  assert.deepEqual(core.splitRunId('41631057972-2'), { runId: '41631057972', attempt: 2 });
  assert.equal(core.displayUrl('https://www.adobe.com/'), 'www.adobe.com');
  assert.equal(core.displayUrl('https://www.adobe.com/a.html?x=1'), 'www.adobe.com/a.html?x=1');
});

test('filters parse from and serialize to the URL, dropping invalid values', () => {
  const f = core.parseFilters('?q=%20photoshop%20&status=partial&profile=lh13&from=2026-10-01&to=2026-10-31&run=41631057972-1');
  assert.deepEqual(f, { q: 'photoshop', status: 'partial', profile: 'lh13', from: '2026-10-01', to: '2026-10-31', run: '41631057972-1' });
  assert.equal(core.serializeState(f), '?q=photoshop&status=partial&profile=lh13&from=2026-10-01&to=2026-10-31&run=41631057972-1');
  assert.deepEqual(core.parseFilters(core.serializeState(f)), f);
  const junk = core.parseFilters('?status=running&from=yesterday&to=2026-13-45&run=../../x');
  assert.deepEqual(junk, { q: '', status: '', profile: '', from: '', to: '', run: '' });
  assert.equal(core.serializeState({}), '');
  assert.equal(core.hasFilters(core.EMPTY_FILTERS), false);
  assert.equal(core.hasFilters({ ...core.EMPTY_FILTERS, to: '2026-01-01' }), true);
});

test('applyFilters matches text, status and inclusive browser-local dates', () => {
  const { runs } = history();
  const ids = (f) => core.applyFilters(runs, { ...core.EMPTY_FILTERS, ...f }).map((r) => r.id).sort();
  assert.deepEqual(ids({ q: 'ACROBAT' }), ['41631000001-1']);
  assert.deepEqual(ids({ q: 'tiny-change' }), ['41700000002-1']);
  assert.deepEqual(ids({ q: '41700000003' }), ['41700000003-2']);
  assert.deepEqual(ids({ status: 'partial' }), ['41700000005-1']);
  assert.deepEqual(ids({ status: 'failed' }), ['41700000006-1', '41700000007-1']);
  const oldKey = runs.find((r) => r.id === '41400000010-1').profileKey;
  assert.deepEqual(ids({ profile: oldKey }), ['41400000010-1']);
  assert.deepEqual(ids({ from: '2026-10-31', to: '2026-10-31' }), ['41700000006-1']);
  assert.deepEqual(ids({ from: '2026-11-01' }), ['41631000001-1']);
  assert.deepEqual(ids({ to: '2026-08-01' }), ['41400000010-1', '41500000009-1']);
  assert.deepEqual(ids({ q: 'no such page' }), []);
  const opts = core.profileOptions(runs);
  assert.ok(opts.length >= 2);
  assert.ok(opts.some((o) => o.value === oldKey && /Lighthouse 13\.5\.0/.test(o.label)));
});

test('local date filters handle UTC midnight and daylight-saving transitions', () => {
  const runs = [
    { id: 'before-midnight', createdAt: Date.parse('2026-03-08T07:59:00Z') },
    { id: 'after-midnight', createdAt: Date.parse('2026-03-08T08:01:00Z') },
    { id: 'after-dst-jump', createdAt: Date.parse('2026-03-08T10:30:00Z') },
  ];
  const filter = (from, to, timeZone) => core.applyFilters(runs, { from, to }, timeZone).map((run) => run.id);
  assert.deepEqual(filter('2026-03-07', '2026-03-07', 'America/Los_Angeles'), ['before-midnight']);
  assert.deepEqual(filter('2026-03-08', '2026-03-08', 'America/Los_Angeles'), ['after-midnight', 'after-dst-jump']);
  assert.deepEqual(filter('2026-03-08', '2026-03-08', 'Asia/Tokyo'), ['before-midnight', 'after-midnight', 'after-dst-jump']);
});

test('comparableRuns never mixes profiles, regions or failed runs', () => {
  const { runs } = history();
  const run = runs.find((r) => r.id === '41700000001-1');
  const { comparable, excluded } = core.comparableRuns(runs, run);
  const ids = comparable.map((r) => r.id).sort();
  assert.deepEqual(ids, ['41500000009-1', '41700000002-1', '41700000003-2', '41700000005-1']);
  assert.ok(!ids.includes('41400000010-1'), 'older Lighthouse profile is excluded');
  assert.ok(!ids.includes('41700000007-1'), 'non-US run is excluded');
  assert.ok(!ids.includes('41700000006-1'), 'failed run is excluded');
  assert.equal(excluded, 3);
});

test('formatting: units, U+2212 minus, display resolution, local timestamps and percentages', () => {
  assert.equal(core.formatMetric('LCP', 2512), `2.51${NBSP}s`);
  assert.equal(core.formatMetric('TBT', 1836), `1,836${NBSP}ms`);
  assert.equal(core.formatMetric('performance', 58), '58');
  assert.equal(core.formatMetric('CLS', 0.0041), '0.004');
  assert.equal(core.formatMetric('LCP', null), '—');
  assert.equal(core.formatMetric('LCP', 2512, false), '2.51');
  assert.equal(core.formatDelta('LCP', -40), `${MINUS}0.04${NBSP}s`);
  assert.equal(core.formatDelta('LCP', 4), `±0${NBSP}s`);
  assert.equal(core.formatDelta('TBT', -1812), `${MINUS}1,812${NBSP}ms`);
  assert.equal(core.formatDelta('performance', 32), '+32');
  assert.equal(core.formatDelta('CLS', 0), '±0');
  assert.equal(core.formatDelta('FCP', null), '—');
  assert.equal(core.formatPercent('LCP', -400, 5000), `${MINUS}8.0%`);
  assert.equal(core.formatPercent('performance', 5, 50), '');
  assert.equal(core.formatPercent('CLS', 0.01, 0.1), '');
  assert.equal(core.formatPercent('LCP', 1, 100000), '±0.0%');
  assert.equal(core.formatNoise('LCP'), `100${NBSP}ms`);
  assert.equal(core.formatNoise('performance'), '3 points');
  assert.equal(core.formatNoise('CLS'), '0.01');
  assert.equal(core.columnUnit('performance'), '0–100');
  const timestamp = Date.parse('2026-11-02T18:00:00Z');
  assert.equal(core.formatDateTime(timestamp, 'America/Los_Angeles'), '2026-11-02 10:00 PST');
  assert.equal(core.formatDateTime(timestamp, 'Asia/Tokyo'), '2026-11-03 03:00 GMT+9');
  assert.equal(core.formatLocalDay(timestamp, 'America/Los_Angeles'), '2026-11-02');
  assert.equal(core.formatLocalDay(timestamp, 'Asia/Tokyo'), '2026-11-03');
  assert.equal(core.formatRelativeDays(Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-03T00:00:00Z')), 'in 2 days');
  assert.equal(core.formatRelativeDays(Date.parse('2026-11-02T00:00:00Z'), Date.parse('2026-11-03T00:00:00Z')), '1 day ago');
  assert.equal(core.formatDuration(21 * 60000), '21 min');
  assert.equal(core.formatDuration(125 * 60000), '2 h 5 min');
  assert.equal(core.formatThroughput(1638.4), '1,638.4 kb/s');
  assert.equal(core.sampleSummary({ samples: { requested: 1, pairs: 1 } }), '1/1 pair');
  assert.equal(core.sampleSummary({ samples: { requested: 5, pairs: 3 } }), '3/5 pairs');
  assert.equal(core.median([3, null, 1, 2, NaN]), 2);
  assert.equal(core.median([4, 1, 2, 3]), 2.5);
});

test('plot helpers span the data and clamp to valid ranges', () => {
  const { ticks, step } = core.niceTicks(0, 100, 4);
  assert.equal(step, 25);
  assert.deepEqual(ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(core.niceTicks(5, 5), { ticks: [5], step: 0 });
  assert.deepEqual(core.niceTicks(5, 1), { ticks: [], step: 0 });
  const [lo, hi] = core.plotDomain('performance', [58, 90]);
  assert.ok(lo >= 0 && lo < 58 && hi > 90 && hi <= 100);
  assert.equal(core.plotDomain('TBT', [24, 1836])[0], 0);
  assert.equal(core.plotDomain('LCP', [null]), null);
});

// ---------------------------------------------------------------- verdict regressions

test('regression: tiny unanimous deltas are Within noise, not consistently better', () => {
  // Display resolution (5 ms for FCP/LCP) must never be the verdict threshold.
  assert.equal(core.classify('LCP', -40, pairsOf([-40, -40, -40, -40, -40])).verdict, 'noise');
  assert.equal(core.classify('FCP', -50, pairsOf([-20, -50, -80], 'FCP')).verdict, 'noise');
  assert.equal(core.classify('LCP', -99, pairsOf([-99, -99, -99, -99, -99])).verdict, 'noise');
  assert.equal(core.classify('TBT', -20, pairsOf([-20, -10, -30, -25, -15], 'TBT')).verdict, 'noise');
  assert.equal(core.classify('performance', 1, pairsOf([1, 1, 2, 1, 1], 'performance')).verdict, 'noise');
  assert.equal(core.classify('CLS', 0.005, pairsOf([0.005, 0.005, 0.004], 'CLS')).verdict, 'noise');
  assert.equal(core.pairDirection('LCP', -40), 'flat');
  assert.equal(core.pairDirection('LCP', -80), 'flat');
  assert.equal(core.pairDirection('LCP', -150), 'better');
  assert.equal(core.pairDirection('TBT', 60), 'worse');
  assert.equal(core.pairDirection('performance', 2), 'flat');
  assert.equal(core.pairDirection('performance', -4), 'worse');

  const run = detail('41700000002-1');
  for (const key of core.METRIC_KEYS) {
    const v = core.runVerdict(run, key, run.pairs).verdict;
    assert.ok(v === 'noise', `${key} of the tiny-change fixture reads ${v}`);
  }
});

test('regression: a one-pair smoke run is inconclusive for every metric, even with a huge delta', () => {
  const run = detail('41631000001-1');
  assert.equal(run.smoke, true);
  assert.equal(run.pairs.length, 1);
  for (const key of core.METRIC_KEYS) {
    if (run.medians.delta[key] === 0) continue;
    const c = core.runVerdict(run, key, run.pairs);
    assert.equal(c.verdict, 'inconclusive', key);
    assert.equal(c.total, 1, key);
  }
  assert.equal(core.classify('TBT', -1812, run.pairs).verdict, 'inconclusive');
  assert.equal(core.classify('performance', 32, run.pairs).verdict, 'inconclusive');
  // Two pairs are still below the minimum.
  assert.equal(core.classify('LCP', -500, pairsOf([-500, -500])).verdict, 'inconclusive');
});

test('verdicts: consistent large deltas name a direction; mixed signs stay inconclusive', () => {
  assert.equal(core.classify('LCP', -150, pairsOf([-150, -150, -150, -150, -150])).verdict, 'better');
  assert.equal(core.classify('LCP', 300, pairsOf([310, 280, 350, 240, 400])).verdict, 'worse');
  assert.equal(core.classify('performance', 5, pairsOf([5, 4, 6, 5, 3], 'performance')).verdict, 'better');
  const mixed = core.classify('LCP', -300, pairsOf([-400, -300, 250, -350, 200]));
  assert.deepEqual(mixed, { verdict: 'inconclusive', agree: 3, total: 5 });
  // 4 of 5 on the median's side meets the 80% descriptive agreement rule.
  assert.equal(core.classify('LCP', -300, pairsOf([-400, -300, 250, -350, -200])).verdict, 'better');
  assert.equal(core.classify('LCP', null, pairsOf([-400])).verdict, 'none');
  // Incomplete pairs never count.
  const withIncomplete = [...pairsOf([-400, -300]), { index: 3, complete: false, delta: null }, { index: 4, complete: false, delta: { LCP: -500 } }];
  assert.equal(core.classify('LCP', -350, withIncomplete).total, 2);
  assert.equal(core.classify('LCP', -350, withIncomplete).verdict, 'inconclusive');

  const run1 = detail('41700000001-1');
  assert.equal(core.runVerdict(run1, 'LCP', run1.pairs).verdict, 'better');
  assert.equal(core.runVerdict(run1, 'performance', run1.pairs).verdict, 'better');
  assert.equal(core.runVerdict(run1, 'TBT', run1.pairs).verdict, 'noise');
  assert.equal(core.runVerdict(run1, 'FCP', run1.pairs).verdict, 'noise');
  const run3 = detail('41700000003-2');
  assert.equal(core.runVerdict(run3, 'LCP', run3.pairs).verdict, 'worse');
});

test('runVerdict never names a direction for failed, unknown-status or non-US runs', () => {
  const pairs = pairsOf([-500, -500, -500, -500, -500]);
  assert.equal(core.runVerdict(okRun('LCP', -500), 'LCP', pairs).verdict, 'better');
  const cases = [
    [{ ...okRun('LCP', -500), status: 'failed' }, 'failed run'],
    [{ ...okRun('LCP', -500), status: 'unknown' }, 'unrecognized status'],
    [{ ...okRun('LCP', -500), us: false }, 'not US-verified'],
  ];
  for (const [run, why] of cases) assert.deepEqual(core.runVerdict(run, 'LCP', pairs), { verdict: 'inconclusive', agree: 5, total: 5, excluded: why });
  assert.equal(core.runVerdict({ ...okRun('LCP', null), status: 'failed' }, 'LCP', pairs).verdict, 'none');
  assert.equal(core.runVerdict({ ...okRun('LCP', -500), status: 'partial' }, 'LCP', pairs).verdict, 'better');
});

test('verdict labels never claim statistical significance', () => {
  for (const label of Object.values(core.VERDICT_LABEL)) assert.doesNotMatch(label, /signific|confiden|p[- ]?value/i);
  assert.equal(core.VERDICT_LABEL.noise, 'Within noise');
  assert.ok(core.NOISE.LCP >= 100 && core.NOISE.FCP >= 100, 'FCP/LCP changes under ~100 ms stay neutral');
  for (const key of core.METRIC_KEYS) assert.ok(core.NOISE[key] > core.METRICS[key].step / 2, `${key} noise threshold exceeds display resolution`);
});

test('fixtures are test-only synthetic data and not published under site/data', () => {
  const publishedRuns = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data', 'runs');
  if (!fs.existsSync(publishedRuns)) return;
  const published = fs.readdirSync(publishedRuns, { withFileTypes: true }).map((d) => d.name);
  for (const f of fs.readdirSync(path.join(FIXTURES, 'runs'))) assert.ok(!published.includes(f), `fixture ${f} leaked into site/data/runs`);
});
