// The measurement request sent from the perf-ab CLI to the GitHub Actions job: JSON, gzipped and base64-encoded
// into a single workflow_dispatch input (GitHub caps one input at 65535 characters).
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertTargetUrl } from '../target.mjs';
import { PR_REPOSITORIES } from './pr-sources.mjs';
import { validateInteractions } from './interactions.mjs';

export const MAX_SPEC_CHARS = 60000;
export const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
export const EXPERIMENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Repository-relative experiment config path (experiments/**.json), as accepted from the Actions form.
export const CONFIG_PATH = /^experiments\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/;
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
const SHA = /^[a-f0-9]{40}$/i;
const safeSourcePath = (value) => typeof value === 'string'
  && /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)
  && !value.split('/').some((part) => part === '.' || part === '..');

function validatePrRequests(requests, name) {
  if (!Array.isArray(requests)) fail(`${name}.pullRequests must be an array`);
  const seen = new Set();
  for (const request of requests) {
    if (!request || !Object.hasOwn(PR_REPOSITORIES, request.repo)) fail(`${name}.pullRequests repository is not allowed`);
    if (!Number.isInteger(request.number) || request.number < 1 || request.number > 999999) fail(`${name}.pullRequests has an invalid PR number`);
    if (seen.has(request.repo)) fail(`${name}.pullRequests may contain only one PR per repository`);
    seen.add(request.repo);
    if (Object.keys(request).some((key) => !['repo', 'number'].includes(key))) fail(`${name}.pullRequests entries accept only repo and number`);
  }
}

function validateResolvedPrSources(variant, name) {
  if (variant.localSources != null) {
    if (!variant.localSources || typeof variant.localSources !== 'object' || Array.isArray(variant.localSources)) fail(`${name}.localSources must be an object`);
    for (const [pathname, source] of Object.entries(variant.localSources)) {
      if (!pathname.startsWith('/') || pathname.split('/').some((part) => part === '.' || part === '..')) fail(`${name}.localSources has an unsafe path`);
      if (!source || !Object.hasOwn(PR_REPOSITORIES, source.repo) || !Number.isInteger(source.number)
        || source.number < 1 || !SHA.test(source.headSha ?? '') || !SHA.test(source.mergeBaseSha ?? '')
        || typeof source.deleted !== 'boolean') fail(`${name}.localSources ${pathname} has invalid PR provenance`);
      const mapping = PR_REPOSITORIES[source.repo];
      if (!safeSourcePath(source.filePath) || !source.filePath.startsWith(mapping.from)
        || `${mapping.to}/${source.filePath.slice(mapping.from.length)}` !== pathname) {
        fail(`${name}.localSources ${pathname} does not match the repository path mapping`);
      }
      if (source.baseFilePath != null && (!safeSourcePath(source.baseFilePath) || !source.baseFilePath.startsWith(mapping.from))) {
        fail(`${name}.localSources ${pathname} has an invalid merge-base path`);
      }
      if (!source.deleted) {
        if (!SHA.test(source.blobSha ?? '')) {
          fail(`${name}.localSources ${pathname} has an invalid mapped file`);
        }
      }
    }
  }
  if (variant.sourcePrs != null) {
    if (!Array.isArray(variant.sourcePrs)) fail(`${name}.sourcePrs must be an array`);
    for (const pr of variant.sourcePrs) {
      if (!pr || !Object.hasOwn(PR_REPOSITORIES, pr.repo) || !Number.isInteger(pr.number) || pr.number < 1
        || !SHA.test(pr.baseSha ?? '') || !SHA.test(pr.headSha ?? '') || !SHA.test(pr.mergeBaseSha ?? '')
        || !Array.isArray(pr.files)) fail(`${name}.sourcePrs contains invalid pinned PR metadata`);
      if (Object.keys(pr).some((key) => !['repo', 'number', 'baseRef', 'headRef', 'baseSha', 'headSha', 'mergeBaseSha', 'files'].includes(key))) {
        fail(`${name}.sourcePrs contains unsupported metadata`);
      }
      for (const ref of [pr.baseRef, pr.headRef]) {
        if (typeof ref !== 'string' || ref.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
          fail(`${name}.sourcePrs contains an invalid branch name`);
        }
      }
      const mapping = PR_REPOSITORIES[pr.repo];
      for (const file of pr.files) {
        if (!file || !['added', 'modified', 'removed', 'renamed'].includes(file.status)
          || Object.keys(file).some((key) => !['status', 'path', 'previousPath', 'blobSha'].includes(key))) {
          fail(`${name}.sourcePrs contains an invalid mapped file record`);
        }
        for (const pathname of [file.path, file.previousPath].filter(Boolean)) {
          if (!pathname.startsWith(`${mapping.to}/`) || !safeSourcePath(pathname.slice(mapping.to.length + 1))) {
            fail(`${name}.sourcePrs contains a path outside its repository mapping`);
          }
        }
        if (file.blobSha != null && !SHA.test(file.blobSha)) fail(`${name}.sourcePrs contains an invalid file SHA`);
      }
    }
  }
}

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
    if (v.pullRequests != null) validatePrRequests(v.pullRequests, n);
    validateResolvedPrSources(v, n);
    for (const p of v.patches ?? []) if (!/^\//.test(p.path) || typeof p.find !== 'string' || !p.find || typeof p.replace !== 'string') fail(`${n}.patches entry for ${p.path}`);
    for (const [k, u] of Object.entries(v.sources ?? {})) if (!/^\//.test(k) || !isHttps(u)) fail(`${n}.sources ${k}`);
    for (const pathname of Object.keys(v.localSources ?? {})) {
      if (Object.hasOwn(v.sources ?? {}, pathname) || (v.patches ?? []).some((p) => p.path === pathname)) {
        fail(`${n} has conflicting source overrides for ${pathname}`);
      }
    }
  }
  if (hosts.size !== 1) fail('all variants must load the same host');
  if (spec.meta != null) {
    const extra = typeof spec.meta === 'object' ? Object.keys(spec.meta).filter((k) => !['name', 'config'].includes(k)) : ['meta'];
    if (extra.length) fail(`unknown meta field(s): ${extra.join(', ')}`);
    if (spec.meta.name != null && !EXPERIMENT_NAME.test(spec.meta.name)) fail('meta.name must be lowercase letters, digits and dashes');
    if (spec.meta.config != null && !CONFIG_PATH.test(spec.meta.config)) fail('meta.config must be an experiments/**.json path');
  }
  if (spec.interactions != null) {
    try { validateInteractions(spec.interactions); } catch (e) { fail(e.message); }
  }
  if (spec.expect?.title != null) new RegExp(spec.expect.title);
  for (const c of spec.expect?.counts ?? []) if (typeof c.selector !== 'string' || !Number.isInteger(c.count)) fail(`expect count ${JSON.stringify(c)}`);
  return spec;
}
