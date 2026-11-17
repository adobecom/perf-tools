// The measurement profile: Lighthouse 13.6.0's default mobile configuration (Moto G Power emulation, mobile Slow 4G
// network preset) with real DevTools throttling instead of Lantern simulation. The browser itself applies the network
// and CPU throttling (before the measuring proxy), so trace.json, the metrics and the audits describe one throttled load.
// Only output formats and a cold storage reset are set on top; nothing is locally calibrated.
import { throttling, screenEmulationMetrics, userAgents } from 'lighthouse/core/config/constants.js';

import { EXPECTED, EXPECTED_DESKTOP, LIGHTHOUSE_VERSION, CPU_SLOWDOWN_MULTIPLIER } from './stats.mjs';

export { EXPECTED, EXPECTED_DESKTOP, LIGHTHOUSE_VERSION };
export { profileKey } from './stats.mjs';

// Lighthouse derives 1474.56 as 1638.4 * 0.9 in floating point (1474.5600000000002).
const norm = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

// See EXPECTED_DESKTOP in stats.mjs: desktopDense4G with its DevTools values derived like mobileSlow4G's.
const desktopThrottling = () => {
  const d = throttling.desktopDense4G;
  return {
    ...d,
    requestLatencyMs: d.rttMs * throttling.DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    downloadThroughputKbps: d.throughputKbps * throttling.DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
    uploadThroughputKbps: d.throughputKbps * throttling.DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  };
};

// Lighthouse's default configuration with only the settings below; categories and every standard audit are untouched.
// device "desktop" applies Lighthouse's own desktop preset (screen, user agent, throttling) instead of mobile.
export function lighthouseConfig(device = 'mobile') {
  const deviceSettings = device === 'desktop'
    ? { formFactor: 'desktop', screenEmulation: screenEmulationMetrics.desktop, emulatedUserAgent: userAgents.desktop, throttling: desktopThrottling() }
    : { formFactor: 'mobile', throttling: { ...throttling.mobileSlow4G, cpuSlowdownMultiplier: CPU_SLOWDOWN_MULTIPLIER } };
  return {
    extends: 'lighthouse:default',
    settings: {
      ...deviceSettings,
      throttlingMethod: 'devtools',
      output: ['html', 'json'],
      disableStorageReset: false,
    },
  };
}

// Records the settings Lighthouse actually resolved (lhr.configSettings); nothing is checked against an expected profile.
export function resolvedProfile(lhr) {
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
  return {
    name: s.formFactor === 'desktop'
      ? 'Lighthouse desktop, DevTools throttling (Dense 4G, 1350x940)'
      : 'Lighthouse mobile, DevTools throttling (Slow 4G, Moto G Power)',
    ...actual,
    emulatedUserAgent: s.emulatedUserAgent,
    maxWaitForFcp: s.maxWaitForFcp,
    disableStorageReset: s.disableStorageReset,
  };
}
