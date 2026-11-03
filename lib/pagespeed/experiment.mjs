// Versioned experiment configs (experiments/*.json): a reviewed, repeatable perf-ab request that both the CLI
// (--config) and the Actions "Run workflow" form (config input) turn into the same validated spec.
//
// {
//   "schema": "perf-ab/experiment-v1", "name": "acrobat-plans-latest", "url": "https://www.adobe.com/...", "runs": 3,
//   "expect": { "title": "Acrobat plans", "counts": { "main h1": 1 } },
//   "before": { "query": "" },                 // optional; before is always the unchanged page (+ optional query)
//   "after": {
//     "query": "", "headInject": "dir/head.html", "priorities": { "/libs/utils/utils.js": "high" },
//     "patches": ["dir/patch.json"], "sources": { "/libs/x.js": "https://..." },
//     "pullRequests": [{ "repo": "adobecom/milo", "number": 123 }]
//   }
// }
// File references are relative to the config file and must stay inside its directory.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, EXPERIMENT_NAME, validateSpec } from './spec.mjs';
import { isExperienceEdge } from './transforms.mjs';

export const EXPERIMENT_SCHEMA = 'perf-ab/experiment-v1';
export { CONFIG_PATH };
const fail = (file, m) => { throw new Error(`experiment ${file}: ${m}`); };
const ALLOWED = { top: ['schema', 'name', 'description', 'url', 'runs', 'expect', 'before', 'after'], before: ['query'], after: ['query', 'headInject', 'priorities', 'patches', 'sources', 'pullRequests'] };

function inside(file, rel, baseDir) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) fail(file, `file reference ${JSON.stringify(rel)} must be a relative path`);
  const abs = path.resolve(baseDir, rel);
  const r = path.relative(baseDir, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) fail(file, `file reference ${rel} leaves the config directory`);
  return abs;
}

function withQuery(url, qs) {
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(qs || '')) u.searchParams.set(k, v);
  return u.href;
}

export function loadExperiment(file, { runs, config, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let cfg;
  try { cfg = JSON.parse(readFile(file)); } catch (e) { fail(file, `cannot read JSON (${e.message})`); }
  if (cfg?.schema !== EXPERIMENT_SCHEMA) fail(file, `schema must be "${EXPERIMENT_SCHEMA}"`);
  for (const [k, keys] of [['top', ALLOWED.top], ['before', ALLOWED.before], ['after', ALLOWED.after]]) {
    const obj = k === 'top' ? cfg : cfg[k] ?? {};
    const extra = Object.keys(obj).filter((x) => !keys.includes(x));
    if (extra.length) fail(file, `unknown ${k === 'top' ? '' : `${k}.`}field(s): ${extra.join(', ')}`);
  }
  if (!EXPERIMENT_NAME.test(cfg.name ?? '')) fail(file, 'name must be lowercase letters, digits and dashes');
  const baseDir = path.dirname(path.resolve(file));
  const a = cfg.after ?? {};
  const after = { url: withQuery(cfg.url, a.query) };
  const before = { url: withQuery(cfg.url, cfg.before?.query) };
  if (a.headInject != null) {
    after.headInject = readFile(inside(file, a.headInject, baseDir));
    for (const m of after.headInject.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
      let u;
      try { u = new URL(m[1].replace(/&amp;/g, '&'), cfg.url); } catch { continue; }
      if (isExperienceEdge(u)) fail(file, `${a.headInject} hints /experienceedge (${u.pathname}); those requests are never preloaded`);
    }
  }
  if (a.priorities != null) {
    if (typeof a.priorities !== 'object' || Array.isArray(a.priorities)) fail(file, 'after.priorities must be an object {"/path": "high|low|auto"}');
    after.priorities = Object.entries(a.priorities).map(([p, priority]) => ({ path: p, priority }));
  }
  if (a.patches != null) {
    if (!Array.isArray(a.patches)) fail(file, 'after.patches must be an array of patch files');
    after.patches = a.patches.flatMap((rel) => {
      let p;
      try { p = JSON.parse(readFile(inside(file, rel, baseDir))); } catch (e) { if (/experiment /.test(e.message)) throw e; fail(file, `${rel}: ${e.message}`); }
      if (!Array.isArray(p.replacements) || !p.replacements.length) fail(file, `${rel}: expected {"replacements":[{path,find,replace}]}`);
      return p.replacements.map(({ path: p2, find, replace }) => ({ path: p2, find, replace }));
    });
  }
  if (a.sources != null) after.sources = a.sources;
  if (a.pullRequests != null) after.pullRequests = a.pullRequests;
  const changed = !!(cfg.before?.query || a.query || after.headInject != null || after.priorities?.length || after.patches?.length
    || (after.sources && Object.keys(after.sources).length) || after.pullRequests?.length);
  const expect = {};
  if (cfg.expect?.title != null) expect.title = cfg.expect.title;
  if (cfg.expect?.counts) expect.counts = Object.entries(cfg.expect.counts).map(([selector, count]) => ({ selector, count }));
  const n = runs ?? cfg.runs ?? 3;
  try {
    return validateSpec({
      version: 1, runs: Number(n), names: changed ? ['before', 'after'] : ['after'], variants: changed ? { before, after } : { after }, expect,
      meta: { name: cfg.name, ...(config ? { config } : {}) },
    });
  } catch (e) {
    return fail(file, e.message);
  }
}
