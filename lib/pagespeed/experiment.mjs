// Versioned experiment configs (experiments/*.json): a reviewed, repeatable perf-ab request that both the CLI
// (--config) and the Actions "Run workflow" form (config input) turn into the same validated spec.
//
// {
//   "schema": "perf-ab/experiment-v1", "name": "acrobat-plans", "url": "https://www.adobe.com/...", "runs": 3,
//   "expect": { "title": "Acrobat plans", "counts": { "main h1": 1 } },
//   "after": {
//     "headInject": "dir/head.html",
//     "patches": ["dir/patch.json"], "sources": { "/libs/x.js": "https://..." },
//     "pullRequests": [{ "repo": "adobecom/milo", "number": 123 }]
//   },
//   "interactions": [{ "action": "tap", "selector": "button.cta" }]   // or "dir/interactions.json", or "auto": adds INP
// }
// File references are relative to the config file and must stay inside its directory. "interactions" (inline steps or a
// JSON file of steps, see lib/pagespeed/interactions.mjs) applies to before and after alike and is not itself a change.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, EXPERIMENT_NAME, validateSpec } from './spec.mjs';
import { isExperienceEdge } from './transforms.mjs';
import { resolveInteractions } from './interactions.mjs';

export const EXPERIMENT_SCHEMA = 'perf-ab/experiment-v1';
export { CONFIG_PATH };
const fail = (file, m) => { throw new Error(`experiment ${file}: ${m}`); };
const ALLOWED = { top: ['schema', 'name', 'description', 'url', 'runs', 'expect', 'after', 'interactions'], after: ['headInject', 'patches', 'sources', 'pullRequests'] };

function inside(file, rel, baseDir) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) fail(file, `file reference ${JSON.stringify(rel)} must be a relative path`);
  const abs = path.resolve(baseDir, rel);
  const r = path.relative(baseDir, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) fail(file, `file reference ${rel} leaves the config directory`);
  return abs;
}

export function loadExperiment(file, { runs, config, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let cfg;
  try { cfg = JSON.parse(readFile(file)); } catch (e) { fail(file, `cannot read JSON (${e.message})`); }
  if (cfg?.schema !== EXPERIMENT_SCHEMA) fail(file, `schema must be "${EXPERIMENT_SCHEMA}"`);
  for (const [k, keys] of [['top', ALLOWED.top], ['after', ALLOWED.after]]) {
    const obj = k === 'top' ? cfg : cfg[k] ?? {};
    const extra = Object.keys(obj).filter((x) => !keys.includes(x));
    if (extra.length) fail(file, `unknown ${k === 'top' ? '' : `${k}.`}field(s): ${extra.join(', ')}`);
  }
  if (!EXPERIMENT_NAME.test(cfg.name ?? '')) fail(file, 'name must be lowercase letters, digits and dashes');
  const baseDir = path.dirname(path.resolve(file));
  const a = cfg.after ?? {};
  const after = { url: cfg.url };
  const before = { url: cfg.url };
  if (a.headInject != null) {
    after.headInject = readFile(inside(file, a.headInject, baseDir));
    for (const m of after.headInject.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
      let u;
      try { u = new URL(m[1].replace(/&amp;/g, '&'), cfg.url); } catch { continue; }
      if (isExperienceEdge(u)) fail(file, `${a.headInject} hints /experienceedge (${u.pathname}); those requests are never preloaded`);
    }
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
  let interactions;
  if (typeof cfg.interactions === 'string') {
    try {
      interactions = resolveInteractions(cfg.interactions === 'auto' ? 'auto' : inside(file, cfg.interactions, baseDir), readFile, cfg.interactions);
    } catch (e) {
      if (/^experiment /.test(e.message)) throw e;
      fail(file, e.message);
    }
  } else if (cfg.interactions != null) {
    interactions = cfg.interactions;
  }
  const changed = !!(after.headInject != null || after.patches?.length
    || (after.sources && Object.keys(after.sources).length) || after.pullRequests?.length);
  const expect = {};
  if (cfg.expect?.title != null) expect.title = cfg.expect.title;
  if (cfg.expect?.counts) expect.counts = Object.entries(cfg.expect.counts).map(([selector, count]) => ({ selector, count }));
  const n = runs ?? cfg.runs ?? 3;
  try {
    return validateSpec({
      version: 1, runs: Number(n), names: changed ? ['before', 'after'] : ['after'], variants: changed ? { before, after } : { after }, expect,
      ...(interactions ? { interactions } : {}),
      meta: { name: cfg.name, ...(config ? { config } : {}) },
    });
  } catch (e) {
    return fail(file, e.message);
  }
}
