import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTraceEvents } from '../lib/pagespeed/trace-events.mjs';

const MAIN = 'MAIN';
const PID = 10;
const ev = (name, ts, extra = {}) => ({ name, ts, pid: PID, tid: 1, ...extra });
const trace = { traceEvents: [
  ev('TracingStartedInBrowser', 0, { args: { data: { frames: [{ frame: MAIN, isInPrimaryMainFrame: true }] } } }),
  ev('navigationStart', 500, { cat: 'blink.user_timing', ph: 'R', args: { frame: MAIN, data: { documentLoaderURL: 'about:blank' } } }),
  ev('navigationStart', 1000, { cat: 'blink.user_timing', ph: 'R', args: { frame: MAIN, data: { documentLoaderURL: 'https://www.adobe.com/x' } } }),
  // The initial document of the navigation reports early milestones before the real ones.
  ev('domInteractive', 1500, { cat: 'blink.user_timing,rail', ph: 'R', args: { frame: MAIN } }),
  ev('domInteractive', 601000, { cat: 'blink.user_timing,rail', ph: 'R', args: { frame: MAIN } }),
  ev('domInteractive', 700000, { cat: 'blink.user_timing,rail', ph: 'R', args: { frame: 'IFRAME' } }),
  ev('firstContentfulPaint', 2001000, { cat: 'loading,rail,devtools.timeline', ph: 'R', args: { frame: MAIN } }),
  ev('largestContentfulPaint::Candidate', 2001000, { cat: 'loading,rail,devtools.timeline', ph: 'R', args: { frame: MAIN } }),
  ev('largestContentfulPaint::Candidate', 3001000, { cat: 'loading,rail,devtools.timeline', ph: 'R', args: { frame: MAIN } }),
  ev('Gnav-Start', 301000, { cat: 'blink.user_timing', ph: 'I' }),
  ev('before-nav', 100, { cat: 'blink.user_timing', ph: 'I' }),
  ev('other-process', 301000, { cat: 'blink.user_timing', ph: 'I', pid: 99 }),
  ev('merch:duration', 401000, { cat: 'blink.user_timing', ph: 'b', id: '0x1' }),
  ev('merch:duration', 651000, { cat: 'blink.user_timing', ph: 'e', id: '0x1' }),
  ev('TimeStamp', 801000, { cat: 'devtools.timeline', ph: 'I', args: { data: { message: 'app ready' } } }),
  ev('RunTask', 801000, { cat: 'disabled-by-default-devtools.timeline', ph: 'X', dur: 5 }),
] };

test('trace events: main-frame navigation, paint, marks, measures and timestamps relative to navigation start', () => {
  const events = extractTraceEvents(trace);
  const by = (kind, name) => events.find((e) => e.kind === kind && e.name === name);
  assert.deepEqual(by('navigation', 'navigationStart'), { name: 'navigationStart', kind: 'navigation', ms: 0, count: 1 });
  assert.equal(by('navigation', 'domInteractive').ms, 600, 'the last report of the main frame wins; other frames are ignored');
  assert.equal(by('paint', 'firstContentfulPaint').ms, 2000);
  assert.equal(by('paint', 'largestContentfulPaint::Candidate').ms, 3000, 'the last LCP candidate wins');
  assert.equal(by('mark', 'Gnav-Start').ms, 300);
  assert.deepEqual(by('measure', 'merch:duration'), { name: 'merch:duration', kind: 'measure', ms: 400, dur: 250, count: 1 });
  assert.equal(by('timestamp', 'app ready').ms, 800);
  assert.equal(by('mark', 'before-nav'), undefined, 'marks before the navigation start are not part of the load');
  assert.equal(by('mark', 'other-process'), undefined);
  assert.equal(events.some((e) => e.name === 'RunTask'), false);
  assert.deepEqual(events.map((e) => e.ms), [...events.map((e) => e.ms)].sort((a, b) => a - b));
});

test('trace events: no main-frame navigation or a malformed trace yields no events', () => {
  assert.deepEqual(extractTraceEvents({ traceEvents: [] }), []);
  assert.deepEqual(extractTraceEvents(null), []);
  assert.deepEqual(extractTraceEvents({ traceEvents: [ev('navigationStart', 1, { args: { data: { documentLoaderURL: 'about:blank' } } })] }), []);
});
