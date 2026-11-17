// Timing events of one page load, read from its Lighthouse/DevTools trace: the page's own performance.mark /
// performance.measure entries and console timestamps, plus the browser's navigation and paint milestones. Times are
// milliseconds since the main frame's navigation start (the same origin Lighthouse uses), so they are comparable
// between loads.

export const MAX_EVENTS = 500;
const MAX_NAME = 200;

const NAVIGATION = new Set([
  'fetchStart', 'responseEnd', 'commitNavigationEnd', 'domLoading', 'domInteractive', 'domContentLoadedEventStart',
  'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd',
]);
// Browser-generated navigation timing names: kept as navigation milestones of the main frame only, never as page marks.
const BUILTIN = new Set([...NAVIGATION, 'navigationStart', 'unloadEventStart', 'unloadEventEnd', 'redirectStart', 'redirectEnd']);
const PAINT = new Set([
  'firstPaint', 'firstContentfulPaint', 'firstImagePaint', 'firstMeaningfulPaint', 'firstMeaningfulPaintCandidate',
  'largestContentfulPaint::Candidate', 'LargestImagePaint::Candidate', 'LargestTextPaint::Candidate',
]);
// The last candidate wins: it is the element the page finally painted largest.
const LAST_WINS = new Set(['largestContentfulPaint::Candidate', 'LargestImagePaint::Candidate', 'LargestTextPaint::Candidate']);

const round = (us) => Math.round(us / 100) / 10;

export function extractTraceEvents(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) return [];
  const started = events.find((e) => e.name === 'TracingStartedInBrowser')?.args?.data?.frames ?? [];
  const mainFrame = started.find((f) => f.isInPrimaryMainFrame)?.frame
    ?? events.find((e) => e.name === 'markAsMainFrame')?.args?.frame;
  const navs = events.filter((e) => e.name === 'navigationStart' && /^https?:/.test(e.args?.data?.documentLoaderURL ?? '')
    && (!mainFrame || e.args?.frame === mainFrame));
  const nav = navs[navs.length - 1];
  if (!nav) return [];
  const t0 = nav.ts;
  const sameProcess = (e) => e.pid === nav.pid && e.ts >= t0;

  const found = new Map();
  const record = (kind, name, ms, dur) => {
    if (typeof name !== 'string' || !name || !Number.isFinite(ms) || ms < 0) return;
    const key = `${kind}\u0000${name.slice(0, MAX_NAME)}`;
    const entry = found.get(key);
    if (!entry) {
      found.set(key, { name: name.slice(0, MAX_NAME), kind, ms, ...(dur != null ? { dur } : {}), count: 1 });
      return;
    }
    entry.count += 1;
    // The initial about:blank document of the navigation reports its own early milestones: the last report is the page's.
    if (kind === 'navigation' || LAST_WINS.has(name)) { entry.ms = ms; if (dur != null) entry.dur = dur; }
  };

  const open = new Map();
  for (const e of events) {
    if (!sameProcess(e)) continue;
    const cat = e.cat ?? '';
    const name = e.name;
    if (e === nav) { record('navigation', 'navigationStart', 0); continue; }
    if (cat.includes('blink.user_timing')) {
      if (BUILTIN.has(name)) {
        if (NAVIGATION.has(name) && (!mainFrame || e.args?.frame === mainFrame)) record('navigation', name, round(e.ts - t0));
      } else if (e.ph === 'R' || e.ph === 'I' || e.ph === 'i') {
        record('mark', name, round(e.ts - t0));
      } else if (e.ph === 'b') {
        open.set(`${name}\u0000${e.id ?? e.id2?.local ?? e.id2?.global ?? ''}`, e.ts);
      } else if (e.ph === 'e') {
        const k = `${name}\u0000${e.id ?? e.id2?.local ?? e.id2?.global ?? ''}`;
        const begin = open.get(k);
        if (begin != null) { record('measure', name, round(begin - t0), round(e.ts - begin)); open.delete(k); }
      }
    } else if (PAINT.has(name) && (e.ph === 'R' || e.ph === 'I') && (!mainFrame || e.args?.frame === mainFrame)) {
      record('paint', name, round(e.ts - t0));
    } else if (name === 'TimeStamp' && typeof e.args?.data?.message === 'string') {
      record('timestamp', e.args.data.message, round(e.ts - t0));
    } else if (cat.includes('blink.console') && e.ph === 'b') {
      open.set(`console\u0000${name}\u0000${e.id ?? ''}`, e.ts);
    } else if (cat.includes('blink.console') && e.ph === 'e') {
      const k = `console\u0000${name}\u0000${e.id ?? ''}`;
      const begin = open.get(k);
      if (begin != null) { record('console', name, round(begin - t0), round(e.ts - begin)); open.delete(k); }
    }
  }
  return [...found.values()].sort((a, b) => a.ms - b.ms || a.name.localeCompare(b.name)).slice(0, MAX_EVENTS);
}
