// The measurement request sent from the perf-ab CLI to the GitHub Actions job: JSON, gzipped and base64-encoded
// into a single workflow_dispatch input (GitHub caps one input at 65535 characters).
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertTargetUrl } from '../target.mjs';

export const MAX_SPEC_CHARS = 60000;
export const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const fail = (m) => { throw Object.assign(new Error(`invalid perf-ab spec: ${m}`), { fatal: true }); };

export function encodeSpec(spec) {
  validateSpec(spec);
  const encoded = gzipSync(Buffer.from(JSON.stringify(spec))).toString('base64');
  if (encoded.length > MAX_SPEC_CHARS) {
    throw new Error(`perf-ab request is too large for a workflow input (${encoded.length} > ${MAX_SPEC_CHARS} base64 chars after gzip); shrink --head-inject/--patch`);
  }
  return encoded;
}

export function decodeSpec(encoded) {
  let spec;
  try {
    spec = JSON.parse(gunzipSync(Buffer.from(String(encoded), 'base64')).toString('utf8'));
  } catch (e) {
    fail(`cannot decode (${e.message})`);
  }
  return validateSpec(spec);
}

const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

export function validateSpec(spec) {
  if (!spec || spec.version !== 1) fail('version must be 1');
  if (!Number.isInteger(spec.runs) || spec.runs < 1 || spec.runs > 10) fail('runs must be an integer 1..10');
  const names = spec.names;
  if (!(JSON.stringify(names) === '["after"]' || JSON.stringify(names) === '["before","after"]')) fail('names must be ["after"] or ["before","after"]');
  const hosts = new Set();
  for (const n of names) {
    const v = spec.variants?.[n];
    if (!v || !isHttps(v.url)) fail(`variant ${n} needs an https url`);
    try { assertTargetUrl(v.url, { label: `${n} page URL` }); } catch (e) { fail(e.message); }
    hosts.add(new URL(v.url).host);
    if (v.headInject != null && typeof v.headInject !== 'string') fail(`${n}.headInject must be a string`);
    for (const p of v.priorities ?? []) if (!/^\//.test(p.path) || !['high', 'low', 'auto'].includes(p.priority)) fail(`${n}.priorities entry ${JSON.stringify(p)}`);
    for (const p of v.patches ?? []) if (!/^\//.test(p.path) || typeof p.find !== 'string' || !p.find || typeof p.replace !== 'string') fail(`${n}.patches entry for ${p.path}`);
    for (const [k, u] of Object.entries(v.sources ?? {})) if (!/^\//.test(k) || !isHttps(u)) fail(`${n}.sources ${k}`);
  }
  if (hosts.size !== 1) fail('all variants must load the same host');
  if (spec.expect?.title != null) new RegExp(spec.expect.title);
  for (const c of spec.expect?.counts ?? []) if (typeof c.selector !== 'string' || !Number.isInteger(c.count)) fail(`expect count ${JSON.stringify(c)}`);
  return spec;
}
