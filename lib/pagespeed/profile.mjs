// PageSpeed Insights mobile profile: Lighthouse's own Lightrider (lr-mobile) preset, the config PSI runs.
// Simulated throttling (Moto G Power, 150 ms RTT, 1638.4 kb/s); lr-mobile pins the CPU multiplier to 1.2.
// Only output formats and a cold storage reset are set on top of it; nothing is locally calibrated.
import lrMobileConfig from 'lighthouse/core/config/lr-mobile-config.js';

export const LIGHTHOUSE_VERSION = '13.6.0';

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

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

export function lighthouseConfig() {
  return {
    ...lrMobileConfig,
    settings: { ...lrMobileConfig.settings, output: ['html', 'json'], disableStorageReset: false },
  };
}

// Reads the settings Lighthouse actually resolved (lhr.configSettings) and fails on any drift from the profile.
export function verifyProfile(lhr) {
  const s = lhr.configSettings ?? {};
  const actual = {
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor: s.formFactor,
    throttlingMethod: s.throttlingMethod,
    rttMs: s.throttling?.rttMs,
    throughputKbps: s.throttling?.throughputKbps,
    cpuSlowdownMultiplier: s.throttling?.cpuSlowdownMultiplier,
    width: s.screenEmulation?.width,
    height: s.screenEmulation?.height,
    deviceScaleFactor: s.screenEmulation?.deviceScaleFactor,
    mobile: s.screenEmulation?.mobile,
  };
  const diff = Object.keys(EXPECTED).filter((k) => actual[k] !== EXPECTED[k]);
  if (diff.length) throw fatal(`Lighthouse profile mismatch: ${diff.map((k) => `${k}=${actual[k]} (expected ${EXPECTED[k]})`).join(', ')}`);
  if (s.disableStorageReset) throw fatal('Lighthouse storage reset is disabled; runs would not be cold');
  return {
    name: 'PageSpeed Insights mobile (Lighthouse lr-mobile preset)',
    ...actual,
    emulatedUserAgent: s.emulatedUserAgent,
    maxWaitForFcp: s.maxWaitForFcp,
    maxWaitForLoad: s.maxWaitForLoad,
    disableStorageReset: s.disableStorageReset,
  };
}
