import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function chromeCandidates({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    ];
  }
  if (platform === 'linux') {
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
  }
  return [];
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChromePath({ preferred = process.env.CHROME_PATH, platform = process.platform, home = os.homedir(), isExecutable = executable } = {}) {
  if (preferred) {
    if (!isExecutable(preferred)) throw new Error(`CHROME_PATH does not point to an executable Chrome: ${preferred}`);
    return path.resolve(preferred);
  }
  return chromeCandidates({ platform, home }).find(isExecutable) ?? null;
}

export function requireChromePath(options) {
  const chromePath = findChromePath(options);
  if (!chromePath) {
    throw new Error('Chrome was not found. Set CHROME_PATH to a Chrome executable (for example /Applications/Google Chrome.app/Contents/MacOS/Google Chrome).');
  }
  return chromePath;
}
