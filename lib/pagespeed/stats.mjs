// Dependency-free pieces shared by the measurement job, the matrix aggregator and the history publisher.

export const LIGHTHOUSE_VERSION = '13.6.0';

// PageSpeed Insights mobile: Lighthouse's lr-mobile preset as resolved by Lighthouse 13.6.0.
export const EXPECTED = {
  lighthouseVersion: LIGHTHOUSE_VERSION,
  formFactor: 'mobile',
  throttlingMethod: 'simulate',
  rttMs: 150,
  throughputKbps: 1638.4,
  cpuSlowdownMultiplier: 1.2,
  width: 412,
  height: 823,
  deviceScaleFactor: 1.75,
  mobile: true,
};

// performance is the 0-100 Lighthouse score, CLS is unitless, the others are milliseconds.
export const METRIC_KEYS = ['performance', 'FCP', 'LCP', 'SI', 'TBT', 'CLS'];

export const median = (xs) => {
  if (xs.some((x) => !Number.isFinite(x))) throw new Error(`median over a non-finite value: ${JSON.stringify(xs)}`);
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Compatibility key of the complete compared preset (Lighthouse, form factor, network, CPU, viewport, mobile).
// Runs with different keys are never merged in history/trends. Chrome build and CPU benchmark index stay separate,
// per-pair metadata: runners are not identical hardware.
export const profileKey = (p) => (p
  ? `lh${p.lighthouseVersion}-${p.formFactor}-${p.throttlingMethod}-rtt${p.rttMs}-tput${p.throughputKbps}-cpu${p.cpuSlowdownMultiplier}-${p.width}x${p.height}@${p.deviceScaleFactor}-${p.mobile ? 'mobile' : 'desktop'}`
  : null);
export const EXPECTED_PROFILE_KEY = profileKey(EXPECTED);

export const hasMetrics = (m) => !!m && METRIC_KEYS.every((k) => Number.isFinite(m[k]));
export const metricDelta = (before, after) => Object.fromEntries(METRIC_KEYS.map((k) => [k, after[k] - before[k]]));

// Paired statistics over complete pairs only: each variant's median and the median of the per-pair deltas.
// Incomplete pairs never contribute to any number. Single-URL runs (no before) only report `after`.
export function pairStats(pairs, names) {
  const paired = names.includes('before');
  const complete = pairs.filter((p) => hasMetrics(p.after) && (!paired || hasMetrics(p.before)));
  const med = (pick) => (complete.length ? Object.fromEntries(METRIC_KEYS.map((k) => [k, median(complete.map((p) => pick(p)[k]))])) : null);
  return {
    complete: complete.length,
    medians: {
      before: paired ? med((p) => p.before) : null,
      after: med((p) => p.after),
      delta: paired ? med((p) => metricDelta(p.before, p.after)) : null,
    },
  };
}
