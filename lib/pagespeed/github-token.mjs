import { execFileSync } from 'node:child_process';

const TOKEN = /^[A-Za-z0-9_.-]{20,255}$/;

function ghAuthToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// Token for GitHub API reads of local runs (PR resolution): GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`.
// Returns null when none is available or the value does not look like a token; the value is never logged.
export function findGithubToken({ env = process.env, authToken = ghAuthToken } = {}) {
  for (const candidate of [env.GITHUB_TOKEN, env.GH_TOKEN]) {
    const t = String(candidate ?? '').trim();
    if (TOKEN.test(t)) return t;
  }
  let t = '';
  try { t = String(authToken() ?? '').trim(); } catch { /* no gh: unauthenticated */ }
  return TOKEN.test(t) ? t : null;
}
