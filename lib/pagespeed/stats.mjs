// Dependency-free pieces shared by the measurement job, the matrix aggregator and the history publisher.

export const LIGHTHOUSE_VERSION = '13.6.0';

// The one measurement: Lighthouse's own mobile preset (Moto G Power emulation, "Slow 4G") with real DevTools
// throttling, so the load itself is throttled and the trace, the metrics and the audits describe the same load.
// Lighthouse's default mobile CPU slowdown is 4; change it here only (profile, key and verification follow).
export const CPU_SLOWDOWN_MULTIPLIER = 4;

export const EXPECTED = {
  lighthouseVersion: LIGHTHOUSE_VERSION,
  formFactor: 'mobile',
  throttlingMethod: 'devtools',
  rttMs: 150,
  throughputKbps: 1638.4,
  requestLatencyMs: 562.5, // 150 x 3.75
  downloadThroughputKbps: 1474.56, // 1638.4 x 0.9
  uploadThroughputKbps: 675, // 750 x 0.9
  cpuSlowdownMultiplier: CPU_SLOWDOWN_MULTIPLIER,
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

// Compatibility key of the complete Lighthouse preset (throttling method, network, CPU, viewport, mobile). Results
// measured with the former simulated (Lantern) throttling have a different key and are never mixed with these.
// Location is intentionally not part of this key: local and Actions measurements must still be treated as incomparable.
// Chrome build and CPU benchmark index stay separate, per-pair metadata: runners are not identical hardware.
export const profileKey = (p) => (p
  ? `lh${p.lighthouseVersion}-${p.formFactor}-${p.throttlingMethod}-rtt${p.rttMs}-tput${p.throughputKbps}-lat${p.requestLatencyMs}-down${p.downloadThroughputKbps}-up${p.uploadThroughputKbps}-cpu${p.cpuSlowdownMultiplier}-${p.width}x${p.height}@${p.deviceScaleFactor}-${p.mobile ? 'mobile' : 'desktop'}`
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
