// The measurement profile: Lighthouse 13.6.0's default mobile configuration (Moto G Power emulation, mobile Slow 4G
// network preset) with real DevTools throttling instead of Lantern simulation. The browser itself applies the network
// and CPU throttling (before the measuring proxy), so trace.json, the metrics and the audits describe one throttled load.
// Only output formats and a cold storage reset are set on top; nothing is locally calibrated.
import { throttling } from 'lighthouse/core/config/constants.js';

import { EXPECTED, LIGHTHOUSE_VERSION, CPU_SLOWDOWN_MULTIPLIER } from './stats.mjs';
import { renderGuardConfig } from './render-guard.mjs';

export { EXPECTED, LIGHTHOUSE_VERSION };
export { profileKey } from './stats.mjs';

const fatal = (message) => Object.assign(new Error(message), { fatal: true });
// Lighthouse derives 1474.56 as 1638.4 * 0.9 in floating point (1474.5600000000002).
const norm = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

// `expect` is the spec's render guard. The only addition to lighthouse:default is the measured-render artifact and its
// informative audit (lib/pagespeed/render-guard.mjs); settings, categories and every standard audit are untouched.
export function lighthouseConfig({ expect = {} } = {}) {
  return {
    extends: 'lighthouse:default',
    ...renderGuardConfig(expect),
    settings: {
      formFactor: 'mobile',
      throttlingMethod: 'devtools',
      throttling: { ...throttling.mobileSlow4G, cpuSlowdownMultiplier: CPU_SLOWDOWN_MULTIPLIER },
      output: ['html', 'json'],
      disableStorageReset: false,
    },
  };
}

// Reads the settings Lighthouse actually resolved (lhr.configSettings) and fails on any drift from the profile.
export function verifyProfile(lhr) {
  const s = lhr.configSettings ?? {};
  const actual = {
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor: s.formFactor,
    throttlingMethod: s.throttlingMethod,
    rttMs: norm(s.throttling?.rttMs),
    throughputKbps: norm(s.throttling?.throughputKbps),
    requestLatencyMs: norm(s.throttling?.requestLatencyMs),
    downloadThroughputKbps: norm(s.throttling?.downloadThroughputKbps),
    uploadThroughputKbps: norm(s.throttling?.uploadThroughputKbps),
    cpuSlowdownMultiplier: norm(s.throttling?.cpuSlowdownMultiplier),
    width: s.screenEmulation?.width,
    height: s.screenEmulation?.height,
    deviceScaleFactor: norm(s.screenEmulation?.deviceScaleFactor),
    mobile: s.screenEmulation?.mobile,
  };
  const diff = Object.keys(EXPECTED).filter((k) => actual[k] !== EXPECTED[k]);
  if (diff.length) throw fatal(`Lighthouse profile mismatch: ${diff.map((k) => `${k}=${actual[k]} (expected ${EXPECTED[k]})`).join(', ')}`);
  if (s.disableStorageReset) throw fatal('Lighthouse storage reset is disabled; runs would not be cold');
  return {
    name: 'Lighthouse mobile, DevTools throttling (Slow 4G, Moto G Power)',
    ...actual,
    emulatedUserAgent: s.emulatedUserAgent,
    maxWaitForFcp: s.maxWaitForFcp,
    disableStorageReset: s.disableStorageReset,
  };
}
