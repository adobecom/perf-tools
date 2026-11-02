import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureCold, isLegacyWarmup } from '../lib/cold-runs.mjs';

function fakeBrowsers() {
  const log = [];
  let next = 1;
  const launch = async () => {
    const browser = { id: next, closed: false, close: async () => { browser.closed = true; log.push(['close', browser.id]); } };
    next += 1;
    log.push(['launch', browser.id]);
    return browser;
  };
  return { log, launch, launched: () => next - 1 };
}

test('A/B: exactly runs x variants measured navigations, alternating, each in its own browser, no warm-up', async () => {
  const { log, launch, launched } = fakeBrowsers();
  const navs = [];
  const results = await measureCold({
    names: ['before', 'after'],
    runs: 3,
    launch,
    measure: async (browser, name, i, attempt) => {
      assert.equal(browser.closed, false);
      navs.push({ name, i, attempt, browser: browser.id });
      return { name, i };
    },
  });
  assert.deepEqual(navs.map((n) => `${n.name}${n.i}`), ['before1', 'after1', 'before2', 'after2', 'before3', 'after3']);
  assert.ok(navs.every((n) => n.i >= 1 && n.attempt === 1), 'no run index 0 (warm-up)');
  assert.equal(launched(), 6, 'one browser per measured run');
  assert.equal(new Set(navs.map((n) => n.browser)).size, 6);
  // Each browser is closed before the next one is launched.
  assert.deepEqual(log, navs.flatMap((n) => [['launch', n.browser], ['close', n.browser]]));
  assert.equal(results.before.length, 3);
  assert.equal(results.after.length, 3);
});

test('single URL: one variant, runs measured navigations', async () => {
  const { launch, launched } = fakeBrowsers();
  const navs = [];
  const results = await measureCold({ names: ['after'], runs: 2, launch, measure: async (b, name, i) => { navs.push(`${name}${i}`); return i; } });
  assert.deepEqual(navs, ['after1', 'after2']);
  assert.equal(launched(), 2);
  assert.deepEqual(results, { after: [1, 2] });
});

test('retries get a fresh browser and failed browsers are closed', async () => {
  const { log, launch } = fakeBrowsers();
  const seen = [];
  const retries = [];
  const results = await measureCold({
    names: ['before', 'after'],
    runs: 1,
    launch,
    measure: async (browser, name, i, attempt) => {
      seen.push([name, attempt, browser.id]);
      if (name === 'after' && attempt < 3) throw new Error(`boom ${attempt}`);
      return attempt;
    },
    onRetry: (name, i, attempt, e) => retries.push([name, i, attempt, e.message]),
  });
  assert.deepEqual(seen, [['before', 1, 1], ['after', 1, 2], ['after', 2, 3], ['after', 3, 4]]);
  assert.deepEqual(retries, [['after', 1, 1, 'boom 1'], ['after', 1, 2, 'boom 2']]);
  assert.deepEqual(log.filter(([k]) => k === 'close').map(([, id]) => id), [1, 2, 3, 4]);
  assert.deepEqual(results, { before: [1], after: [3] });
});

test('gives up after the last attempt and still closes every browser', async () => {
  const { log, launch } = fakeBrowsers();
  await assert.rejects(
    measureCold({ names: ['after'], runs: 2, attempts: 3, launch, measure: async () => { throw new Error('down'); } }),
    /down/,
  );
  assert.deepEqual(log, [['launch', 1], ['close', 1], ['launch', 2], ['close', 2], ['launch', 3], ['close', 3]]);
});

test('a browser that fails to close aborts the measurement (no further runs, no retry)', async () => {
  for (const fail of [false, true]) {
    let launches = 0;
    const launch = async () => {
      launches += 1;
      return { close: async () => { throw new Error('close hung'); } };
    };
    const measureErr = new Error('measure failed');
    const err = await measureCold({
      names: ['before', 'after'],
      runs: 3,
      launch,
      measure: async () => { if (fail) throw measureErr; return 1; },
      onRetry: () => assert.fail('must not retry after a failed close'),
      onResult: () => assert.fail('must not report a result whose browser was not cleaned up'),
    }).then(() => assert.fail('expected rejection'), (e) => e);
    assert.match(err.message, /before run 1 attempt 1: closing the browser failed: close hung/);
    if (fail) assert.equal(err.cause, measureErr);
    assert.equal(launches, 1);
  }
});

test('legacy warm-up trace names', () => {
  for (const f of ['after0.json', 'before0.json', '/tmp/traces/after0.json']) assert.ok(isLegacyWarmup(f), f);
  for (const f of ['after1.json', 'after10.json', 'Trace-0.json', 'xafter0.json']) assert.ok(!isLegacyWarmup(f), f);
});
