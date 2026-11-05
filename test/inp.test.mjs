// INP support: declarative interaction steps, their validation and scenario key, the metric key set, experiment/CLI
// plumbing, aggregation, publication and the dashboard model. The real Chrome + Lighthouse flow is covered by
// test/pagespeed-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AUTO_SCENARIO, MAX_STEPS, canonicalSteps, interactionCount, interactionsKey, parseInteractions, plansFrom, resolveInteractions, runInteractions,
  stepLabel, targetsKey, validateInteractions,
} from '../lib/pagespeed/interactions.mjs';
import { AUTO_KINDS, DENY, selectTargets, withSignatures } from '../lib/pagespeed/auto-interactions.mjs';
import { ALL_METRIC_KEYS, EXPECTED, METRIC_KEYS, hasMetrics, metricDelta, metricKeys, pairStats } from '../lib/pagespeed/stats.mjs';
import { extractMetrics } from '../lib/pagespeed/job.mjs';
import { breakdown, interactionGroups } from '../lib/pagespeed/inp.mjs';
import { decodeSpec, encodeSpec, validateSpec } from '../lib/pagespeed/spec.mjs';
import { loadExperiment } from '../lib/pagespeed/experiment.mjs';
import { aggregatePairs, interactionTargetWarnings } from '../lib/pagespeed/aggregate.mjs';
import { mergeHistory, normalizeResult, summaryFromDetail } from '../lib/pagespeed/history.mjs';
import { buildSpec } from '../bin/perf-ab.mjs';
import * as dashboard from '../site/dashboard-core.mjs';

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'perf-ab.mjs');
const run = promisify(execFile);
const URL_ = 'https://www.adobe.com/acrobat/plans.html';
const steps = () => [
  { action: 'waitFor', selector: 'merch-card' },
  { action: 'tap', selector: 'button.cta', label: 'Buy' },
  { action: 'press', key: 'Escape', ms: 250 },
];
const m = (LCP, INP, performance = 60) => ({ performance, FCP: 900, LCP, SI: 1500, TBT: 80, CLS: 0.01, ...(INP == null ? {} : { INP }) });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------- steps ----------

test('interactions: every documented action validates; bad shapes name the offending step', () => {
  const all = [
    { action: 'tap', selector: 'button' }, { action: 'click', selector: 'a', ms: 0 }, { action: 'type', selector: 'input', text: 'hello', ms: 200 },
    { action: 'press', key: 'Enter' }, { action: 'press', key: 'ArrowDown', selector: 'ul' }, { action: 'press', key: '/' },
    { action: 'waitFor', selector: '.modal', ms: 60000 }, { action: 'scroll' }, { action: 'scroll', selector: 'footer' }, { action: 'pause', ms: 10000, label: 'let it settle' },
  ];
  assert.equal(validateInteractions(all), all);
  const bad = (step, pattern) => assert.throws(() => validateInteractions([{ action: 'tap', selector: 'b' }, step]), pattern, JSON.stringify(step));
  bad({ action: 'drag', selector: 'x' }, /\[1\] action must be one of/);
  bad({ action: 'tap' }, /\[1\] \(tap\) needs selector/);
  bad({ action: 'tap', selector: 'x', text: 'no' }, /\[1\] \(tap\) does not accept: text/);
  bad({ action: 'tap', selector: 'x', code: 'alert(1)' }, /unknown field\(s\): code/);
  bad({ action: 'type', selector: 'x' }, /needs text/);
  bad({ action: 'type', selector: 'x', text: 'a'.repeat(201) }, /longer than 200/);
  bad({ action: 'press' }, /needs key/);
  bad({ action: 'press', key: 'Enter Enter' }, /key must be a key name/);
  bad({ action: 'pause' }, /needs ms/);
  bad({ action: 'pause', ms: 10001 }, /ms must be between 1 and 10000/);
  bad({ action: 'pause', ms: 0 }, /ms must be between 1 and 10000/);
  bad({ action: 'waitFor', selector: 'x', ms: 60001 }, /between 1 and 60000/);
  bad({ action: 'tap', selector: 'x', ms: 1.5 }, /ms must be an integer/);
  bad({ action: 'tap', selector: 'x', ms: -1 }, /between 0 and 10000/);
  bad({ action: 'tap', selector: 'a'.repeat(301) }, /longer than 300/);
  bad({ action: 'tap', selector: 'a\nb' }, /control characters/);
  bad({ action: 'tap', selector: '   ' }, /non-empty string/);
  bad({ action: 'tap', selector: 'x', label: 'l'.repeat(81) }, /label is longer than 80/);
  bad(null, /\[1\] must be an object/);
  assert.throws(() => validateInteractions('tap'), /must be an array/);
  assert.throws(() => validateInteractions([]), /at least one step/);
  assert.throws(() => validateInteractions(Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'tap', selector: 'x' }))), /at most 20/);
  assert.throws(() => validateInteractions([{ action: 'waitFor', selector: 'x' }, { action: 'pause', ms: 5 }, { action: 'scroll' }]), /at least one interaction step/);
});

test('interactions: the scenario key follows behaviour only (not labels, key order or defaults of other fields)', () => {
  const a = [{ action: 'tap', selector: 'b', label: 'Buy' }, { action: 'press', key: 'Enter' }];
  const same = [{ label: 'Pay', selector: 'b', action: 'tap' }, { key: 'Enter', action: 'press' }];
  assert.match(interactionsKey(a), /^[a-f0-9]{64}$/);
  assert.equal(interactionsKey(a), interactionsKey(same));
  assert.deepEqual(canonicalSteps(a), [{ action: 'tap', selector: 'b' }, { action: 'press', key: 'Enter' }]);
  for (const other of [
    [{ action: 'tap', selector: 'c' }, { action: 'press', key: 'Enter' }],
    [{ action: 'click', selector: 'b' }, { action: 'press', key: 'Enter' }],
    [{ action: 'tap', selector: 'b', ms: 100 }, { action: 'press', key: 'Enter' }],
    [{ action: 'press', key: 'Enter' }, { action: 'tap', selector: 'b' }],
    [{ action: 'tap', selector: 'b' }],
  ]) assert.notEqual(interactionsKey(other), interactionsKey(a));
  assert.deepEqual(a.map(stepLabel), ['Buy', 'press Enter']);
  assert.deepEqual([{ action: 'tap', selector: 'x' }, { action: 'type', selector: 'x', text: 'héllo' }, { action: 'press', key: 'a' }, { action: 'pause', ms: 1 }].map(interactionCount), [1, 5, 1, 0]);
});

test('interactions: scenario files are an array or {"interactions": [...]} and errors name the file', () => {
  assert.deepEqual(parseInteractions(JSON.stringify(steps())), steps());
  assert.deepEqual(parseInteractions(JSON.stringify({ interactions: steps() })), steps());
  assert.throws(() => parseInteractions('{', 'scenario.json'), /scenario\.json: cannot read JSON/);
  assert.throws(() => parseInteractions('{"steps": []}', 'scenario.json'), /scenario\.json: expected an array of steps/);
  assert.throws(() => parseInteractions('[{"action":"tap"}]', 'scenario.json'), /scenario\.json: interactions: \[0\] \(tap\) needs selector/);
});

function fakePage({ missing = new Set(), invalid = new Set() } = {}) {
  const calls = [];
  const handle = (selector) => ({
    tap: async () => calls.push(['tap', selector]),
    click: async () => calls.push(['click', selector]),
    type: async (text, o) => calls.push(['type', selector, text, o.delay]),
    focus: async () => calls.push(['focus', selector]),
    evaluate: async () => calls.push(['scrollIntoView', selector]),
    dispose: async () => {},
  });
  return {
    calls,
    waitForSelector: async (selector, o) => {
      calls.push(['waitForSelector', selector, o.visible, o.timeout]);
      if (invalid.has(selector)) throw new Error(`"${selector}" is not a valid selector`);
      if (missing.has(selector)) throw Object.assign(new Error('Waiting failed'), { name: 'TimeoutError' });
      return handle(selector);
    },
    evaluate: async () => calls.push(['scrollBy']),
    keyboard: { press: async (key) => calls.push(['press', key]) },
  };
}

test('interactions runner: waits for visibility, performs each action and settles after interactions', async () => {
  const page = fakePage();
  const waits = [];
  let t = 0;
  const executed = await runInteractions(page, [
    { action: 'waitFor', selector: '.card', ms: 5000 },
    { action: 'scroll', selector: 'footer' },
    { action: 'scroll' },
    { action: 'tap', selector: '#a', label: 'Open' },
    { action: 'click', selector: '#b', ms: 0 },
    { action: 'type', selector: '#q', text: 'abc', ms: 100 },
    { action: 'press', key: 'Enter', selector: '#q' },
    { action: 'press', key: 'Tab', ms: 20 },
    { action: 'pause', ms: 700 },
  ], { wait: async (ms) => waits.push(ms), now: () => (t += 5) });
  assert.deepEqual(page.calls, [
    ['waitForSelector', '.card', true, 5000],
    ['waitForSelector', 'footer', true, 30000], ['scrollIntoView', 'footer'], ['scrollBy'],
    ['waitForSelector', '#a', true, 30000], ['tap', '#a'],
    ['waitForSelector', '#b', true, 30000], ['click', '#b'],
    ['waitForSelector', '#q', true, 30000], ['type', '#q', 'abc', 50],
    ['waitForSelector', '#q', true, 30000], ['focus', '#q'], ['press', 'Enter'],
    ['press', 'Tab'],
  ]);
  assert.deepEqual(waits, [500, 500, 1000, 0, 100, 1000, 20, 700], 'default settle 1000 ms after interactions, 500 ms after scrolls, explicit ms respected');
  assert.deepEqual(executed.map((s) => [s.index, s.action, s.label]), [
    [0, 'waitFor', 'waitFor .card'], [1, 'scroll', 'scroll footer'], [2, 'scroll', 'scroll'], [3, 'tap', 'Open'], [4, 'click', 'click #b'],
    [5, 'type', 'type #q'], [6, 'press', 'press Enter'], [7, 'press', 'press Tab'], [8, 'pause', 'pause'],
  ]);
});

test('interactions runner: a selector that never shows up is rejected (retryable); invalid selector syntax is fatal', async () => {
  const noWait = { wait: async () => {} };
  await assert.rejects(runInteractions(fakePage({ missing: new Set(['#nope']) }), [{ action: 'tap', selector: '#nope', label: 'CTA' }], { ...noWait, waitMs: 1234 }),
    (e) => e.rejected === true && !e.fatal && /interactions\[0\] CTA: selector did not become visible within 1234 ms/.test(e.message) && e.executed.length === 0);
  await assert.rejects(runInteractions(fakePage({ missing: new Set(['#nope']) }), [{ action: 'tap', selector: '#ok' }, { action: 'tap', selector: '#nope' }], noWait),
    (e) => e.rejected === true && e.executed.map((s) => s.index).join() === '0', 'steps that ran before the failure are kept for diagnostics');
  await assert.rejects(runInteractions(fakePage({ invalid: new Set(['>>']) }), [{ action: 'click', selector: '>>' }], noWait),
    (e) => e.fatal === true && /interactions\[0\] click >>: invalid selector/.test(e.message));
  await assert.rejects(runInteractions({ waitForSelector: async () => { throw new Error('Target closed'); } }, [{ action: 'tap', selector: 'x' }], noWait),
    (e) => !e.rejected && !e.fatal && /Target closed/.test(e.message));
});

// ---------- metrics ----------

test('metric keys: INP is required only for runs with interactions', () => {
  const REQUIRED = ['FCP', 'LCP', 'SI', 'CLS'];
  assert.deepEqual(metricKeys(), REQUIRED);
  assert.deepEqual(metricKeys({ interactions: null }), REQUIRED);
  assert.deepEqual(metricKeys({ interactions: [] }), REQUIRED);
  assert.deepEqual(metricKeys({ interactions: steps() }), [...REQUIRED, 'INP']);
  assert.deepEqual(metricKeys({ interactions: true }), [...REQUIRED, 'INP']);
  const keys = metricKeys({ interactions: steps() });
  assert.ok(hasMetrics(m(1000, 200)), 'INP is ignored without interactions');
  assert.ok(hasMetrics(m(1000, 200), keys));
  assert.ok(!hasMetrics(m(1000), keys));
  assert.ok(!hasMetrics({ ...m(1000, 200), INP: NaN }, keys));
  assert.deepEqual(metricDelta(m(1000, 400), m(900, 150), keys).INP, -250);
  assert.ok(!('INP' in metricDelta(m(1000, 400), m(900, 150))));
});

test('pair statistics: INP medians and the median paired INP delta come from complete pairs only', () => {
  const keys = metricKeys({ interactions: steps() });
  const pairs = [
    { before: m(4000, 600), after: m(3900, 300) },
    { before: m(4100, 500), after: m(4000, 350) },
    { before: m(4200, 800), after: m(4100, 200) },
    { before: m(4300, null), after: m(4200, 100) }, // no INP on the before side: incomplete, never counted
  ];
  const s = pairStats(pairs, ['before', 'after'], keys);
  assert.equal(s.complete, 3);
  assert.equal(s.medians.before.INP, 600);
  assert.equal(s.medians.after.INP, 300);
  assert.equal(s.medians.delta.INP, -300, 'median of (-300, -150, -600)');
  assert.equal(pairStats(pairs, ['before', 'after']).complete, 4, 'without interactions INP is not required');
  const single = pairStats([{ before: null, after: m(4000, 320) }], ['after'], keys);
  assert.deepEqual([single.complete, single.medians.after.INP, single.medians.delta], [1, 320, null]);
});

test('extractMetrics: INP comes from the timespan audit; a run with no registered interaction is rejected', () => {
  const nav = {
    categories: { performance: { score: 0.61 } },
    audits: {
      'first-contentful-paint': { numericValue: 900 }, 'largest-contentful-paint': { numericValue: 1800 }, 'speed-index': { numericValue: 1500 },
      'total-blocking-time': { numericValue: 80 }, 'cumulative-layout-shift': { numericValue: 0.01 },
    },
  };
  assert.ok(!('INP' in extractMetrics(nav)));
  const span = (audit) => ({ audits: { 'interaction-to-next-paint': audit } });
  assert.deepEqual(extractMetrics(nav, span({ numericValue: 312.4, scoreDisplayMode: 'numeric' })), { performance: 61, FCP: 900, LCP: 1800, SI: 1500, TBT: 80, CLS: 0.01, INP: 312.4 });
  assert.throws(() => extractMetrics(nav, span({ scoreDisplayMode: 'notApplicable' })),
    (e) => e.rejected && !e.fatal && /INP \(Chrome registered no interaction\)/.test(e.message) && e.metrics.INP === null && e.metrics.LCP === 1800);
  assert.throws(() => extractMetrics(nav, span({ errorMessage: 'boom', scoreDisplayMode: 'error' })), /INP \(boom\)/);
  assert.throws(() => extractMetrics(nav, { audits: {} }), /INP/);
});

test('inp diagnostics: groups EventTiming by interaction and breaks the slowest down like web-vitals attribution', () => {
  const ev = (ts, d) => ({ name: 'EventTiming', ph: 'b', ts, args: { data: d } });
  const trace = {
    traceEvents: [
      ev(30, { interactionId: 0, type: 'mousedown', duration: 322, timeStamp: 100, processingStart: 116, processingEnd: 116 }),
      ev(31, { interactionId: 1657, type: 'click', duration: 322, timeStamp: 100, processingStart: 116, processingEnd: 417 }),
      ev(10, { interactionId: 1650, type: 'pointerdown', duration: 40, timeStamp: 10, processingStart: 11, processingEnd: 12 }),
      ev(12, { interactionId: 1650, type: 'click', duration: 32, timeStamp: 15, processingStart: 20, processingEnd: 30 }),
      { name: 'EventTiming', ph: 'e', ts: 99, args: {} },
      { name: 'Other', ph: 'b', ts: 1, args: { data: { interactionId: 9 } } },
    ],
  };
  const groups = interactionGroups(trace);
  assert.deepEqual(groups.map((g) => g.interactionId), [1650, 1657], 'ordered by when each interaction started; id 0 and non-EventTiming events ignored');
  assert.deepEqual(breakdown(groups[1]), { interactionId: 1657, eventType: 'click', duration: 322, inputDelay: 16, processingTime: 301, presentationDelay: 5 });
  assert.deepEqual(breakdown(groups[0]), { interactionId: 1650, eventType: 'pointerdown', duration: 40, inputDelay: 1, processingTime: 19, presentationDelay: 20 });
  assert.deepEqual(interactionGroups({}), []);
});

// ---------- spec, experiment, CLI ----------

test('spec: interactions are validated, survive the gzip+base64 round trip and are not a change on their own', () => {
  const spec = { version: 1, runs: 3, names: ['after'], variants: { after: { url: URL_ } }, expect: {}, interactions: steps() };
  assert.deepEqual(decodeSpec(encodeSpec(spec)).interactions, steps());
  assert.throws(() => validateSpec({ ...spec, interactions: [{ action: 'waitFor', selector: 'x' }] }), /invalid perf-ab spec: interactions: needs at least one interaction/);
  assert.throws(() => validateSpec({ ...spec, interactions: [{ action: 'tap', selector: 'x', fn: 'y' }] }), /unknown field\(s\): fn/);
  assert.throws(() => validateSpec({ ...spec, interactions: {} }), /must be an array/);
  validateSpec({ ...spec, interactions: undefined });
  validateSpec({ ...spec, interactions: null });
});

function writeConfig(files) {
  const dir = tmp('perf-ab-inp-config-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const config = (extra = {}) => ({ schema: 'perf-ab/experiment-v1', name: 'inp-demo', url: URL_, runs: 3, ...extra });

test('experiment config: inline or file interactions; with no other change the URL is measured as-is (after only)', () => {
  const dir = writeConfig({
    'inline.json': config({ interactions: steps() }),
    'file.json': config({ interactions: 'inp/steps.json' }),
    'inp/steps.json': { interactions: steps() },
    'changed.json': config({ interactions: steps(), after: { patches: ['p.json'] } }),
    'p.json': { replacements: [{ path: '/libs/a.js', find: 'a', replace: 'b' }] },
    'badfile.json': config({ interactions: 'inp/bad.json' }),
    'inp/bad.json': '[{"action":"tap"}]',
    'escape.json': config({ interactions: '../steps.json' }),
    'badinline.json': config({ interactions: [{ action: 'tap', selector: 'x', ms: 99999 }] }),
  });
  try {
    for (const name of ['inline.json', 'file.json']) {
      const spec = loadExperiment(path.join(dir, name));
      assert.deepEqual(spec.names, ['after'], `${name}: interactions alone are not a before/after change`);
      assert.deepEqual(spec.interactions, steps());
    }
    const changed = loadExperiment(path.join(dir, 'changed.json'));
    assert.deepEqual(changed.names, ['before', 'after']);
    assert.deepEqual(changed.interactions, steps(), 'one scenario for both variants');
    assert.equal(loadExperiment(path.join(dir, 'inline.json')).meta.name, 'inp-demo');
    assert.ok(!('interactions' in loadExperiment(writeConfigPath(dir, 'plain.json', config()))));
    assert.throws(() => loadExperiment(path.join(dir, 'badfile.json')), /inp\/bad\.json: interactions: \[0\] \(tap\) needs selector/);
    assert.throws(() => loadExperiment(path.join(dir, 'escape.json')), /leaves the config directory/);
    assert.throws(() => loadExperiment(path.join(dir, 'badinline.json')), /ms must be between 0 and 10000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function writeConfigPath(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  return path.join(dir, name);
}

test('CLI: --interactions adds the scenario to an as-is or changed request; it cannot be mixed with --config', async () => {
  const o = { runs: '3', param: 'milolibs', suffix: '--milo--adobecom', 'expect-count': [], interactions: 'steps.json' };
  const files = { 'steps.json': JSON.stringify(steps()) };
  const readFile = (f) => files[f] ?? fs.readFileSync(f, 'utf8');
  const asIs = buildSpec(o, URL_, { readFile });
  assert.deepEqual(asIs.names, ['after']);
  assert.deepEqual(asIs.interactions, steps());
  const branch = buildSpec({ ...o, before: 'stage', after: 'MWPW-1' }, URL_, { readFile });
  assert.deepEqual(branch.names, ['before', 'after']);
  assert.deepEqual(branch.interactions, steps());
  assert.ok(!('interactions' in buildSpec({ ...o, interactions: undefined }, URL_, { readFile })));
  assert.throws(() => buildSpec({ ...o, interactions: 'steps.json' }, URL_, { readFile: () => '[]' }), /--interactions steps\.json: interactions: needs at least one step/);
  await assert.rejects(run(process.execPath, [BIN, '--config', 'experiments/x.json', '--interactions', 'steps.json']),
    (e) => /--config defines the URL and changes; remove --interactions/.test(e.stderr));
  const help = (await run(process.execPath, [BIN, '--help'])).stdout;
  assert.match(help, /--interactions <file\.json\|auto>\s+adds INP/);
  const auto = buildSpec({ ...o, interactions: 'auto' }, URL_, { readFile: () => { throw new Error('auto must not read a file'); } });
  assert.deepEqual(auto.interactions, [{ action: 'auto' }]);
  assert.deepEqual(auto.names, ['after']);
});

// ---------- aggregation ----------

function pairJob(dir, i, { interactions = steps(), before = m(4000, 600), after = m(3900, 300), key } = {}) {
  const d = path.join(dir, `perf-ab-req-inp-pair${i}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'results.json'), JSON.stringify({
    schema: 'perf-ab/pagespeed-v1', requestId: 'req-inp', status: 'ok', pair: i, names: ['before', 'after'], url: URL_, egress: { ok: true, country: 'US', checks: [] },
    profile: EXPECTED, chromeVersion: 'HeadlessChrome/142', github: {}, cold: {}, rejected: [], documentGeo: [],
    interactions, interactionsKey: key === undefined ? (interactions ? interactionsKey(interactions) : null) : key,
    runs: [
      { variant: 'before', run: i, attempt: 1, dir: `before${i}`, metrics: before },
      { variant: 'after', run: i, attempt: 1, dir: `after${i}`, metrics: after },
    ],
  }));
}

test('aggregate: INP medians and paired deltas; a pair without INP or with another scenario is never combined', () => {
  const dir = tmp('perf-ab-inp-agg-');
  try {
    pairJob(dir, 1, { before: m(4000, 600), after: m(3900, 300) });
    pairJob(dir, 2, { before: m(4100, 500), after: m(4000, 350) });
    pairJob(dir, 3, { before: m(4200, 800), after: m(4100, 200) });
    const ok = aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-inp', out: path.join(dir, 'out') });
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.interactions, steps());
    assert.equal(ok.interactionsKey, interactionsKey(steps()));
    assert.equal(ok.medians.before.INP, 600);
    assert.equal(ok.medians.after.INP, 300);
    assert.equal(ok.medians.delta.INP, -300);
    assert.deepEqual(ok.pairs.map((p) => p.delta.INP), [-300, -150, -600]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'results.json'), 'utf8')).interactionsKey, ok.interactionsKey);

    fs.rmSync(path.join(dir, 'perf-ab-req-inp-pair3'), { recursive: true });
    pairJob(dir, 3, { before: m(4200, null), after: m(4100, 200) });
    const missing = aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-inp', out: path.join(dir, 'out2') });
    assert.equal(missing.status, 'partial');
    assert.match(missing.pairs[2].error, /missing accepted metrics \(INP is required for interaction runs\)/);
    assert.equal(missing.medians.delta.INP, -225, 'median of (-300, -150): the incomplete pair never counts');

    fs.rmSync(path.join(dir, 'perf-ab-req-inp-pair3'), { recursive: true });
    pairJob(dir, 3, { interactions: [{ action: 'click', selector: 'a' }] });
    const other = aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-inp', out: path.join(dir, 'out3') });
    assert.equal(other.status, 'partial');
    assert.match(other.pairs[2].error, /replayed different interaction steps/);

    fs.rmSync(path.join(dir, 'perf-ab-req-inp-pair3'), { recursive: true });
    pairJob(dir, 3, { key: 'f'.repeat(64) });
    assert.match(aggregatePairs({ pairsDir: dir, expected: 3, requestId: 'req-inp', out: path.join(dir, 'out4') }).pairs[2].error, /interactionsKey does not match/);

    // Without interactions nothing changes: no INP key anywhere.
    const plain = tmp('perf-ab-plain-agg-');
    try {
      pairJob(plain, 1, { interactions: null, before: m(4000), after: m(3900) });
      const p = aggregatePairs({ pairsDir: plain, expected: 1, requestId: 'req-inp', out: path.join(plain, 'out') });
      assert.equal(p.status, 'ok');
      assert.deepEqual([p.interactions, p.interactionsKey, 'INP' in p.medians.after], [null, null, false]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- history and dashboard model ----------

const profile = {
  name: 'Lighthouse mobile, DevTools throttling (Slow 4G, Moto G Power)', lighthouseVersion: '13.6.0', chromeVersion: '142.0.7444.59', formFactor: 'mobile',
  throttlingMethod: 'devtools', rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675,
  cpuSlowdownMultiplier: 4, maxWaitForLoad: 120000, width: 412, height: 823, deviceScaleFactor: 1.75,
};
const ghRun = (id = 41700000100) => ({ id, run_attempt: 1, created_at: '2026-11-02T12:00:00Z', updated_at: '2026-11-02T12:30:00Z', conclusion: 'success', head_sha: 'faa7259b9ce33463c387752efcd0d3d0169291' });
const rawInp = (over = {}) => ({
  schema: 'perf-ab/pagespeed-v1', requestId: 'request-inp', status: 'ok', names: ['before', 'after'], runsPerVariant: 3, url: URL_, variants: {},
  profile, egress: { ok: true, country: 'US' }, documentGeo: [],
  interactions: [
    { action: 'waitFor', selector: '.private-selector' },
    { action: 'tap', selector: 'button.private', label: 'Buy' },
    { action: 'type', selector: 'input#q', text: 'private text' },
    { action: 'press', key: 'Enter' },
  ],
  pairs: [
    { index: 1, before: m(4000, 600), after: m(3900, 300) },
    { index: 2, before: m(4100, 500), after: m(4000, 350) },
    { index: 3, before: m(4200, 800), after: m(4100, 200) },
  ],
  ...over,
});

test('history: an INP run publishes INP medians, the scenario key and step labels only; INP-less pairs are incomplete', () => {
  const detail = normalizeResult(rawInp(), ghRun(), null, Date.parse('2026-11-03T00:00:00Z'));
  assert.equal(detail.status, 'ok');
  assert.equal(detail.medians.before.INP, 600);
  assert.equal(detail.medians.after.INP, 300);
  assert.equal(detail.medians.delta.INP, -300);
  assert.deepEqual(detail.pairs.map((p) => p.delta.INP), [-300, -150, -600]);
  assert.deepEqual(detail.samples, { requested: 3, before: 3, after: 3, pairs: 3, rejected: null });
  assert.equal(detail.interactionsKey, interactionsKey(rawInp().interactions));
  assert.deepEqual(detail.interactions, [
    { action: 'waitFor', label: null }, { action: 'tap', label: 'Buy' }, { action: 'type', label: null }, { action: 'press', label: null },
  ]);
  const published = JSON.stringify(detail);
  for (const secret of ['private-selector', 'button.private', 'input#q', 'private text', 'Enter']) assert.ok(!published.includes(secret), `${secret} must stay private`);

  const summary = summaryFromDetail(detail);
  assert.equal(summary.interactionsKey, detail.interactionsKey);
  assert.ok(!('interactions' in summary), 'the index stays light');
  const merged = mergeHistory(null, [detail], Date.parse('2026-11-03T00:00:00Z'));
  assert.equal(merged.index.runs[0].interactionsKey, detail.interactionsKey);
  assert.equal(merged.index.runs[0].medians.delta.INP, -300);
  // Existing published runs keep their scenario on later merges (sanitized, whitelist only).
  const again = mergeHistory(merged.index, [], Date.parse('2026-11-04T00:00:00Z'), { [detail.id]: JSON.parse(JSON.stringify(detail)) });
  assert.equal(again.index.runs[0].interactionsKey, detail.interactionsKey);
  assert.deepEqual(again.details.get(detail.id).interactions, detail.interactions);

  const partial = normalizeResult(rawInp({ pairs: [...rawInp().pairs.slice(0, 2), { index: 3, before: m(4200), after: m(4100, 200) }] }), ghRun(), null);
  assert.equal(partial.samples.pairs, 2, 'a pair without INP is incomplete for an interactions run');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.medians.delta.INP, -225);

  const bogus = normalizeResult(rawInp({ interactions: [{ action: 'eval', selector: 'x' }] }), ghRun(), null);
  assert.ok(!('interactionsKey' in bogus) && !('interactions' in bogus), 'a malformed scenario is dropped, not repaired');
});

test('history: runs without interactions are published exactly as before (no INP, no scenario fields)', () => {
  const raw = rawInp({ interactions: undefined, pairs: rawInp().pairs.map((p) => ({ ...p, before: m(4000), after: m(3900) })) });
  const detail = normalizeResult(raw, ghRun(), null);
  assert.equal(detail.status, 'ok');
  assert.ok(!('INP' in detail.medians.after));
  assert.ok(!('interactionsKey' in detail) && !('interactions' in detail));
  assert.ok(!('interactionsKey' in summaryFromDetail(detail)));
});

test('dashboard model: INP is an ms metric shown only for runs with a scenario, with its own noise threshold', () => {
  assert.deepEqual(dashboard.METRICS.INP, { key: 'INP', short: 'INP', label: 'Interaction to Next Paint', unit: 'ms', better: 'lower', step: 1 });
  assert.equal(dashboard.NOISE.INP, 40);
  assert.ok(dashboard.NOISE.INP > dashboard.METRICS.INP.step / 2);
  assert.equal(dashboard.formatNoise('INP'), '40\u00a0ms');
  assert.equal(dashboard.formatMetric('INP', 312.4), '312\u00a0ms');
  assert.equal(dashboard.formatDelta('INP', -271.7), '\u2212272\u00a0ms');
  assert.equal(dashboard.columnUnit('INP'), 'ms');
  assert.deepEqual(dashboard.METRIC_KEYS, ['performance', 'FCP', 'LCP', 'SI', 'TBT', 'CLS'], 'the base keys are unchanged');

  const detail = normalizeResult(rawInp(), ghRun(), null);
  const run = dashboard.parseRun(detail, detail.id);
  assert.equal(run.medians.delta.INP, -300);
  assert.equal(run.interactionsKey, detail.interactionsKey);
  assert.deepEqual(run.interactions.map((s) => s.action), ['waitFor', 'tap', 'type', 'press']);
  assert.deepEqual(run.pairs.map((p) => p.delta.INP), [-300, -150, -600]);
  assert.deepEqual(dashboard.metricKeysFor(run), dashboard.ALL_METRIC_KEYS);
  assert.equal(dashboard.runVerdict(run, 'INP', run.pairs).verdict, 'better');
  assert.equal(dashboard.classify('INP', -30, run.pairs.map((p) => ({ ...p, delta: { INP: -30 } }))).verdict, 'noise');

  const plain = dashboard.parseRun(normalizeResult(rawInp({ interactions: undefined, pairs: rawInp().pairs.map((p) => ({ ...p, before: m(4000), after: m(3900) })) }), ghRun(41700000101), null), '41700000101-1');
  assert.deepEqual(dashboard.metricKeysFor(plain), dashboard.METRIC_KEYS);
  assert.equal(plain.interactionsKey, null);
  assert.ok(!('INP' in plain.medians.after));
  assert.deepEqual(dashboard.metricKeysFor([plain, plain]), dashboard.METRIC_KEYS);
  assert.deepEqual(dashboard.metricKeysFor([plain, run]), dashboard.ALL_METRIC_KEYS, 'a list shows the column when any run has INP');

  const base = dashboard.normalizeSummary({ ...summaryFromDetail(normalizeResult(rawInp(), ghRun(41700000100), null)) });
  const noKey = dashboard.normalizeSummary({ ...summaryFromDetail(normalizeResult(rawInp({ interactions: undefined, pairs: rawInp().pairs.map((p) => ({ ...p, before: m(4000), after: m(3900) })) }), ghRun(41700000104), null)) });
  assert.equal(dashboard.hasInp(base), true);
  assert.equal(dashboard.hasInp(noKey), false);
});

// ---------- pass-partout (auto) ----------

test('auto step: validated like the others, counts as an interaction and needs no selector', () => {
  assert.deepEqual(validateInteractions(AUTO_SCENARIO), AUTO_SCENARIO);
  validateInteractions([{ action: 'waitFor', selector: 'main' }, { action: 'auto', max: 10, kinds: ['tab', 'popup'], exclude: ['.promo', '#chat'], scope: 'main', ms: 500, label: 'Explore' }]);
  const bad = (step, pattern) => assert.throws(() => validateInteractions([step]), pattern, JSON.stringify(step));
  bad({ action: 'auto', max: 0 }, /max must be an integer between 1 and 10/);
  bad({ action: 'auto', max: 11 }, /max must be an integer between 1 and 10/);
  bad({ action: 'auto', max: 2.5 }, /max must be an integer/);
  bad({ action: 'auto', kinds: [] }, /kinds must be a non-empty list/);
  bad({ action: 'auto', kinds: ['tab', 'tab'] }, /without repeats/);
  bad({ action: 'auto', kinds: ['link'] }, /kinds must be a non-empty list/);
  bad({ action: 'auto', exclude: 'x' }, /exclude must be a list/);
  bad({ action: 'auto', exclude: Array.from({ length: 11 }, () => 'x') }, /at most 10 selectors/);
  bad({ action: 'auto', exclude: ['a\nb'] }, /control characters/);
  bad({ action: 'auto', selector: 'button' }, /does not accept: selector/);
  bad({ action: 'tap', selector: 'x', max: 3 }, /does not accept: max/);
  assert.deepEqual(AUTO_KINDS, ['tab', 'expandable', 'button', 'popup']);
  assert.deepEqual(resolveInteractions('auto', () => { throw new Error('no file'); }), [{ action: 'auto' }]);
  assert.deepEqual(resolveInteractions(' auto ', () => ''), [{ action: 'auto' }]);
  assert.deepEqual(resolveInteractions('steps.json', () => JSON.stringify(steps())), steps());
  const copy = resolveInteractions('auto', () => '');
  copy[0].max = 9;
  assert.deepEqual(AUTO_SCENARIO, [{ action: 'auto' }], 'the shared scenario is never mutated');
});

test('auto step: the key follows behaviour (defaults filled in, discovery version) and differs from explicit steps', () => {
  const key = interactionsKey([{ action: 'auto' }]);
  assert.equal(key, interactionsKey([{ action: 'auto', max: 4, kinds: AUTO_KINDS, exclude: [], label: 'Anything' }]));
  assert.notEqual(key, interactionsKey([{ action: 'auto', max: 5 }]));
  assert.notEqual(key, interactionsKey([{ action: 'auto', kinds: ['tab'] }]));
  assert.notEqual(key, interactionsKey([{ action: 'auto', exclude: ['.promo'] }]));
  assert.notEqual(key, interactionsKey([{ action: 'auto', scope: 'main' }]));
  assert.notEqual(key, interactionsKey([{ action: 'tap', selector: 'button' }]));
  assert.equal(canonicalSteps([{ action: 'auto' }])[0].autoVersion, 1);
  assert.equal(interactionCount({ action: 'auto' }), 0, 'counted through the taps it resolved to');
});

const cand = (kind, name, extra = {}) => ({ kind, tag: 'button', role: kind === 'tab' ? 'tab' : null, name, ...extra });

test('auto selection: kind order, per-kind caps, one popup, safe names only', () => {
  const found = withSignatures([
    cand('button', 'Show more'), cand('tab', 'Individuals'), cand('tab', 'Business'), cand('tab', 'Students'), cand('expandable', 'Details'),
    cand('expandable', 'FAQ'), cand('expandable', 'Terms'), cand('popup', 'Gallery'), cand('popup', 'Video'), cand('button', 'Buy now'),
    cand('button', 'Sign in'), cand('button', 'Download the app'), cand('button', ''), cand('button', 'Next'),
  ]);
  const names = (list) => list.map((c) => c.name);
  assert.deepEqual(names(selectTargets(found)), ['Individuals', 'Details', 'Show more', 'Gallery'], 'default max 4: one of each kind, the modal opener last');
  assert.deepEqual(names(selectTargets(found, { max: 6 })), ['Individuals', 'Business', 'Details', 'FAQ', 'Show more', 'Gallery'], 'at most ceil(6/4) per kind, one popup, last');
  assert.deepEqual(names(selectTargets(found, { max: 10 })), ['Individuals', 'Business', 'Students', 'Details', 'FAQ', 'Terms', 'Show more', 'Next', 'Gallery'],
    'topped up in kind order; Buy now, Sign in, Download and the nameless button are never chosen');
  assert.deepEqual(names(selectTargets(found, { max: 3, kinds: ['expandable', 'popup'] })), ['Details', 'FAQ', 'Gallery']);
  assert.deepEqual(names(selectTargets(found, { max: 1 })), ['Individuals']);
  assert.deepEqual(selectTargets([], {}), []);
  for (const name of ['Buy now', 'Add to cart', 'Checkout', 'Sign in', 'Log out', 'Subscribe', 'Submit', 'Download', 'Contact us', 'Accept all', 'Delete', 'Order today', 'Start chat']) {
    assert.ok(DENY.test(name), `${name} is denied`);
  }
  for (const name of ['Individuals', 'Show more', 'Students & Teachers', 'Compare plans', 'Next', 'Open the gallery', 'Features']) assert.ok(!DENY.test(name), `${name} is allowed`);
});

test('auto signatures identify an element across loads, with an occurrence number for identical ones', () => {
  const sigs = withSignatures([cand('button', 'More'), cand('tab', 'More'), cand('button', 'More'), cand('button', 'More')]).map((c) => c.signature);
  assert.deepEqual(sigs, ['button|button||More', 'tab|button|tab|More', 'button|button||More#2', 'button|button||More#3']);
});

function autoPage(names) {
  const taps = [];
  const found = withSignatures(names.map(([kind, name]) => ({ ...cand(kind, name), handle: { isVisible: async () => true, tap: async () => taps.push(`${kind}:${name}`), dispose: async () => {} } })));
  return { taps, discover: async () => found };
}

test('auto runner: taps what it selected, labels it, and hands exactly those targets to the after load', async () => {
  const wait = async () => {};
  const before = autoPage([['tab', 'One'], ['tab', 'Two'], ['expandable', 'FAQ'], ['button', 'Buy now'], ['button', 'More']]);
  const executed = await runInteractions({}, [{ action: 'auto', max: 3, ms: 300 }], { wait, discover: before.discover });
  assert.deepEqual(before.taps, ['tab:One', 'expandable:FAQ', 'button:More']);
  assert.deepEqual(executed.map((s) => [s.index, s.action, s.auto, s.label]), [[0, 'tap', true, 'tab: One'], [0, 'tap', true, 'expandable: FAQ'], [0, 'tap', true, 'button: More']]);
  const plans = plansFrom(executed);
  assert.deepEqual([...plans], [[0, ['tab|button|tab|One', 'expandable|button||FAQ', 'button|button||More']]]);
  assert.match(targetsKey(executed), /^[a-f0-9]{64}$/);
  assert.equal(targetsKey([{ index: 0, action: 'waitFor' }]), null);

  // The after page has extra and re-ordered elements: it still exercises the same three, in the same order.
  const after = autoPage([['button', 'Promo'], ['expandable', 'FAQ'], ['button', 'More'], ['tab', 'Two'], ['tab', 'One'], ['tab', 'Three']]);
  const again = await runInteractions({}, [{ action: 'auto', max: 3 }], { wait, discover: after.discover, plans });
  assert.deepEqual(after.taps, ['tab:One', 'expandable:FAQ', 'button:More']);
  assert.equal(targetsKey(again), targetsKey(executed));

  // A target the before page exposed that the after page lacks rejects the run (retryable) instead of comparing other elements.
  const lacking = autoPage([['tab', 'One'], ['expandable', 'FAQ']]);
  await assert.rejects(runInteractions({}, [{ action: 'auto', max: 3 }], { wait, discover: lacking.discover, plans }),
    (e) => e.rejected === true && /the target the before page tapped is missing here: button\|button\|\|More/.test(e.message));
  assert.deepEqual(lacking.taps, ['tab:One', 'expandable:FAQ'], 'what exists is tapped in order; the missing one rejects the run');
});

test('auto runner: no safe target is a rejected run, a mixed scenario keeps its explicit steps', async () => {
  const wait = async () => {};
  const none = autoPage([['button', 'Buy now'], ['button', 'Sign in']]);
  await assert.rejects(runInteractions({}, [{ action: 'auto' }], { wait, discover: none.discover }),
    (e) => e.rejected === true && /found no safe in-page interaction targets/.test(e.message));
  assert.deepEqual(none.taps, []);

  const mixed = autoPage([['tab', 'Two']]);
  const executed = await runInteractions(fakePage(), [{ action: 'waitFor', selector: 'main' }, { action: 'auto' }, { action: 'press', key: 'Escape' }], { wait, discover: mixed.discover });
  assert.deepEqual(executed.map((s) => [s.index, s.action]), [[0, 'waitFor'], [1, 'tap'], [2, 'press']]);
  assert.deepEqual(plansFrom(executed).get(1), ['tab|button|tab|Two']);
});

test('auto runner: discovers again before every tap, so targets that appear or vanish with earlier taps are followed', async () => {
  const wait = async () => {};
  const taps = [];
  let state = 'panel1';
  // Tapping tab Two switches to panel 2: the toggle of panel 1 disappears and the toggle of panel 2 appears.
  const discover = async () => withSignatures([
    cand('tab', 'One'), cand('tab', 'Two'),
    ...(state === 'panel1' ? [cand('expandable', 'Toggle of panel 1')] : [cand('expandable', 'Toggle of panel 2')]),
  ].map((c) => ({ ...c, handle: { tap: async () => { taps.push(c.name); if (c.name === 'Two') state = 'panel2'; }, dispose: async () => {} } })));
  const executed = await runInteractions({}, [{ action: 'auto', max: 2, kinds: ['tab', 'expandable'] }], { wait, discover });
  assert.deepEqual(taps, ['One', 'Toggle of panel 1'], 'default order: one of each kind first');
  state = 'panel1';
  taps.length = 0;
  const switching = await runInteractions({}, [{ action: 'auto', max: 3, kinds: ['tab'] }], { wait, discover });
  assert.deepEqual(taps, ['One', 'Two'], 'a tapped element is never tapped twice');
  assert.equal(switching.length, 2, 'fewer targets than max is fine as long as one was tapped');
  assert.equal(executed.length, 2);

  // The after load follows the before load's sequence, waiting for a target that shows up late.
  state = 'panel1';
  let calls = 0;
  const late = async () => (calls++ < 3 ? [] : discover());
  const plan = plansFrom(switching);
  const replayed = await runInteractions({}, [{ action: 'auto', max: 3, kinds: ['tab'] }], { wait, discover: late, plans: plan });
  assert.deepEqual(replayed.map((s) => s.label), ['tab: One', 'tab: Two']);
  assert.ok(calls > 3);
  // ...and rejects the run when it never does.
  await assert.rejects(runInteractions({}, [{ action: 'auto' }], { wait, discover: async () => [], plans: plan }),
    (e) => e.rejected === true && /the target the before page tapped is missing here: tab\|button\|tab\|One/.test(e.message));
});

test('experiment config: "interactions": "auto" is the pass-partout scenario', () => {
  const dir = writeConfig({ 'auto.json': config({ interactions: 'auto' }), 'mixed.json': config({ interactions: [{ action: 'waitFor', selector: 'main' }, { action: 'auto', max: 2 }] }) });
  try {
    const spec = loadExperiment(path.join(dir, 'auto.json'));
    assert.deepEqual(spec.interactions, [{ action: 'auto' }]);
    assert.deepEqual(spec.names, ['after']);
    assert.equal(loadExperiment(path.join(dir, 'mixed.json')).interactions[1].max, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate: pairs that resolved different auto targets are surfaced as a warning, never silently mixed', () => {
  const run = (pair, key) => ({ pair, variant: 'after', interaction: { targetsKey: key } });
  assert.deepEqual(interactionTargetWarnings([run(1, 'a'.repeat(64)), run(2, 'a'.repeat(64)), { pair: 3, interaction: {} }]), []);
  assert.deepEqual(interactionTargetWarnings([]), []);
  const [w] = interactionTargetWarnings([run(1, 'a'.repeat(64)), run(2, 'b'.repeat(64)), run(2, 'b'.repeat(64))]);
  assert.equal(w.kind, 'interaction-targets-differ');
  assert.match(w.message, /pair1 aaaaaaaa, pair2 bbbbbbbb/);
  assert.deepEqual(w.pairs.map((p) => p.pair), [1, 2]);
});

test('history: an auto scenario publishes its key and an "auto" step, never what it discovered or its selectors', () => {
  const raw = rawInp({ interactions: [{ action: 'auto', max: 3, exclude: ['.private-promo'], scope: 'main.private' }] });
  const detail = normalizeResult(raw, ghRun(41700000150), null);
  assert.equal(detail.interactionsKey, interactionsKey(raw.interactions));
  assert.deepEqual(detail.interactions, [{ action: 'auto', label: null }]);
  assert.equal(detail.status, 'ok');
  const published = JSON.stringify(detail);
  for (const secret of ['private-promo', 'main.private']) assert.ok(!published.includes(secret), `${secret} must stay private`);
  assert.deepEqual(dashboard.parseRun(detail, detail.id).interactions, [{ action: 'auto', label: null }]);
});
