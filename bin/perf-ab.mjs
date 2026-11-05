#!/usr/bin/env node
// perf-ab: before/after page-load comparison. One measurement: real Lighthouse 13.6.0, mobile profile with real
// DevTools throttling (Slow 4G + 4x CPU, see lib/pagespeed/profile.mjs), alternating cold runs (fresh Chrome + empty profile per attempt, no warm-ups). Only the location
// differs: by default the perf-ab GitHub Actions workflow (verified-US egress, fail-closed); with --local the same job
// runs on this machine, pairs sequentially, and is recorded as local in results.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePriorityRules } from '../lib/pagespeed/transforms.mjs';
import { validateSpec } from '../lib/pagespeed/spec.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';
import { runLocal } from '../lib/pagespeed/local.mjs';
import { loadExperiment, CONFIG_PATH } from '../lib/pagespeed/experiment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGE_OPTIONS = ['before', 'after', 'before-query', 'after-query', 'head-inject', 'fetchpriority', 'patch', 'milo-pr', 'mas-pr', 'expect-title', 'expect-count'];

// --config: the file must be a committed-style experiments/**.json path of this repository (cwd- or repo-relative).
export function resolveConfig(file, { root = ROOT, cwd = process.cwd() } = {}) {
  const abs = [path.resolve(cwd, file), path.resolve(root, file)].find((f) => fs.existsSync(f));
  if (!abs) throw new Error(`--config ${file}: file not found`);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!CONFIG_PATH.test(rel)) throw new Error(`--config ${file}: must be an experiments/<name>.json file of the perf-tools repository (the workflow reads it from --ref)`);
  return { abs, rel };
}

// The workflow measures the committed config at --ref, so a local edit that is not on <remote>/<ref> would silently
// measure something else. Fail unless the experiments/ files match the local copy of the remote ref.
export function assertConfigPublished(rel, ref, { root = ROOT, git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const dir = rel.replace(/\.json$/, '');
  let diff;
  try {
    diff = git(['diff', '--name-only', `origin/${ref}`, '--', rel, dir]) + git(['ls-files', '--others', '--exclude-standard', '--', rel, dir]);
  } catch (e) {
    console.warn(`perf-ab: could not compare ${rel} with origin/${ref} (${String(e.stderr || e.message).trim().split('\n')[0]}); the workflow uses the committed copy`);
    return;
  }
  if (diff.trim()) throw new Error(`--config ${rel}: local files differ from origin/${ref} (${diff.trim().split('\n').join(', ')}); the workflow reads the committed copy, so commit and push first`);
}

export const HELP = `perf-ab <pageUrl> [options]
perf-ab --config experiments/<name>.json [-n <pairs>] [-o <dir>]
  Measurement (always the same): real Lighthouse 13.6.0, mobile (Moto G Power, 412x823 @ 1.75) with real DevTools
  throttling: Slow 4G (562.5 ms request latency, 1474.56 kb/s down, 675 kb/s up) and 4x CPU slowdown, applied by Chrome
  itself, so the trace, the metrics and the audits describe the same throttled load.
  Default location: GitHub Actions, the adobecom/perf-tools "perf-ab" workflow with
  VERIFIED US egress (fails closed if the egress is non-US or unknown). Runs alternate before/after; every run and
  retry is cold (new Chrome process, empty temporary profile, no warm-ups). Invalid renders are kept as rejected
  diagnostics and retried fresh. Requires gh authenticated with Actions write access to --repo.
  --local runs the identical Lighthouse job on this machine, with pairs measured sequentially. Set CHROME_PATH or
  install Chrome in a common macOS/Linux location. A known non-US local egress is allowed but recorded and warned;
  local results are not comparable with Actions results, even when profileKey matches. A local run authenticates its
  GitHub API reads (--milo-pr / --mas-pr) with GITHUB_TOKEN, GH_TOKEN or "gh auth token" when available.

  -n N dispatches N parallel matrix jobs; each measures ONE complete cold before/after pair on its own runner. Medians
  and the median per-pair delta use complete pairs only; any missing/failed pair makes the result partial (exit 1).

  Without variant options the URL is measured as-is. With any change option, "before" is the unchanged
  production page and "after" is the page with the changes applied by the runner's measuring proxy (HTTP/2 kept,
  real compressed sizes; unchanged responses are byte-identical).

  --config <file>         versioned experiment config in this repository (experiments/*.json): URL, render guards,
                          changes and default run count. The workflow reads the COMMITTED file from --ref; the
                          local copy is only validated. Cannot be combined with a URL or change options.
  -n, --runs <n>          before/after pairs = parallel jobs, 1..10 (default 3 or the config's runs; -n 1 = smoke; use -n 5 for a full campaign)
  -o, --out <dir>         download dir (default ./traces): results.json, pair<i>/<variant><i>/report.html|
                          report.json|trace.json|devtoolslog.json|run.json, pair<i>/rejected/...
  -b, --before <value> / -a, --after <value>
                          variant values sent as ?<param>=<value><suffix> (e.g. milolibs branches)
  --param <name>          (default milolibs)    --suffix <str>  (default --milo--adobecom)
  --before-query <qs> / --after-query <qs>   extra query params per variant
  --head-inject <file>    HTML inserted into the after document's <head> (before the first <script>). The injected tags are
                          then the ONLY preloads of the after page: every rel=preload / rel=modulepreload entry of its
                          Link response header is unset (other Link entries stay; before is untouched), reported in
                          results.json hints.linkHeaderStripped / linkHeaderEntries and the console. Hints whose
                          URL carries country/locale params are re-resolved against the US baseline's own requests
                          (unmatched ones are dropped and reported). /experienceedge hints are always dropped.
  --fetchpriority </path=high|low|auto>   (repeatable) set fetchpriority on matching injected hints (and, without
                          --head-inject, on the after document's Link response header entries)
  --patch <file.json>     {"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}:
                          guarded edits of live sources (after only); each find must match exactly once or the job fails
  --milo-pr <n> / --mas-pr <n>   pin the PR's exact commit, locally read only mapped changed files, and serve them
                          through the proxy in the after variant. Before remains unchanged production.
  --expect-title <regex>  render guard: document title must match
  --expect-count <selector=n>   render guard (repeatable), full-DOM count (hidden matches included), e.g. merch-card=19
  --repo <owner/name>     workflow repository (default adobecom/perf-tools)   --ref <branch> (default main)
  --timeout <minutes>     wait limit (default 75)
  --local                 run the same Lighthouse measurement locally (Actions is the default)`;

const fail = (m) => { console.error(`perf-ab: ${m}`); process.exit(1); };
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
export function buildSpec(o, pageUrl, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const runs = Number(o.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be an integer 1..10');
  const withQuery = (value, extra) => {
    const u = new URL(pageUrl);
    if (value != null) u.searchParams.set(o.param, `${value}${o.suffix}`);
    for (const [k, v] of new URLSearchParams(extra || '')) u.searchParams.set(k, v);
    return u.href;
  };
  if ((o.before == null) !== (o.after == null)) throw new Error('--before and --after must be given together');
  const after = { url: withQuery(o.after, o['after-query']) };
  const before = { url: withQuery(o.before, o['before-query']) };
  if (o['head-inject']) after.headInject = readFile(o['head-inject']);
  const priorities = parsePriorityRules(o.fetchpriority);
  if (priorities.length) after.priorities = priorities;
  if (o.patch) {
    const p = JSON.parse(readFile(o.patch));
    if (!Array.isArray(p.replacements) || !p.replacements.length) throw new Error(`--patch ${o.patch}: expected {"replacements":[{path,find,replace}]}`);
    after.patches = p.replacements.map(({ path: p2, find, replace }) => ({ path: p2, find, replace }));
  }
  for (const [flag, repo] of [['milo-pr', 'adobecom/milo'], ['mas-pr', 'adobecom/mas']]) {
    if (!o[flag]) continue;
    const number = Number(o[flag]);
    if (!Number.isInteger(number) || number < 1 || number > 999999) throw new Error(`--${flag} must be a positive PR number`);
    after.pullRequests = [...(after.pullRequests ?? []), { repo, number }];
  }
  const changed = o.before != null || o['before-query'] || o['after-query'] || after.headInject != null || after.priorities || after.patches || after.sources || after.pullRequests;
  const expect = {};
  if (o['expect-title']) expect.title = o['expect-title'];
  if (o['expect-count'].length) {
    expect.counts = o['expect-count'].map((x) => {
      const m = /^(.+)=(\d+)$/.exec(x);
      if (!m) throw new Error(`Bad --expect-count "${x}", expected <selector>=<n>`);
      return { selector: m[1], count: Number(m[2]) };
    });
  }
  return validateSpec({ version: 1, runs, names: changed ? ['before', 'after'] : ['after'], variants: changed ? { before, after } : { after }, expect });
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      config: { type: 'string' },
      runs: { type: 'string', short: 'n' },
      out: { type: 'string', short: 'o', default: './traces' },
      before: { type: 'string', short: 'b' },
      after: { type: 'string', short: 'a' },
      param: { type: 'string', default: 'milolibs' },
      suffix: { type: 'string', default: '--milo--adobecom' },
      'before-query': { type: 'string', default: '' },
      'after-query': { type: 'string', default: '' },
      'head-inject': { type: 'string' },
      fetchpriority: { type: 'string', multiple: true, default: [] },
      patch: { type: 'string' },
      'milo-pr': { type: 'string' },
      'mas-pr': { type: 'string' },
      'expect-title': { type: 'string' },
      'expect-count': { type: 'string', multiple: true, default: [] },
      repo: { type: 'string', default: 'adobecom/perf-tools' },
      ref: { type: 'string', default: 'main' },
      timeout: { type: 'string', default: '75' },
      local: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help || (!positionals[0] && !o.config)) { console.log(HELP); process.exit(positionals[0] || o.help ? 0 : 1); }
  const known = new Set(['config', 'runs', 'out', 'before', 'after', 'param', 'suffix', 'before-query', 'after-query', 'head-inject', 'fetchpriority', 'patch', 'milo-pr', 'mas-pr', 'expect-title', 'expect-count', 'repo', 'ref', 'timeout', 'local', 'help']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) fail(`unknown option(s): ${unknown.map((k) => `--${k}`).join(', ')}`);
  if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(' ')}`);
  let spec;
  let config = null;
  try {
    if (o.config) {
      const clash = CHANGE_OPTIONS.filter((k) => k in o && !(Array.isArray(o[k]) && !o[k].length) && o[k] !== '');
      if (positionals.length || clash.length) throw new Error(`--config defines the URL and changes; remove ${[...positionals, ...clash.map((k) => `--${k}`)].join(', ')}`);
      const c = resolveConfig(o.config);
      if (o.runs != null && !/^(?:[1-9]|10)$/.test(o.runs)) throw new Error('--runs must be an integer 1..10');
      spec = loadExperiment(c.abs, { runs: o.runs, config: c.rel });
      if (!o.local) assertConfigPublished(c.rel, o.ref);
      config = c.rel;
    } else {
      spec = buildSpec(o, positionals[0]);
    }
  } catch (e) {
    fail(e.message);
  }
  const out = path.resolve(o.out);
  let res;
  try {
    if (o.local) {
      const results = await runLocal({ spec, out });
      if (results.status !== 'ok') {
        throw new Error(`perf-ab failed: job reported ${results.status}${results.samples ? ` (${results.samples.pairs}/${results.samples.requested} complete pair(s))` : ''}: ${results.error}\n  diagnostics: ${out}`);
      }
      res = { results };
    } else {
      res = await runRemote({ spec, config, out, repo: o.repo, ref: o.ref, timeoutMs: Number(o.timeout) * 60000 });
    }
  } catch (e) {
    fail(e.message);
  }
  const { results } = res;
  const fmt = (k, v) => (v == null ? '-' : k === 'CLS' ? v.toFixed(3) : k === 'performance' ? String(v) : `${Math.round(v)}`);
  const line = (m) => Object.entries(m).map(([k, v]) => `${k}=${fmt(k, v)}`).join('  ');
  const pairs = results.pairs ?? [];
  const place = results.where === 'local'
    ? `egress ${results.egress?.country ?? 'unknown'} (local; not an Actions run)`
    : `egress ${results.egress?.country ?? 'unknown'}`;
  console.log(`\nLighthouse mobile, DevTools throttling (Lighthouse ${results.lighthouseVersion}, Chrome ${results.chromeVersion}), ${place}, ${results.samples?.pairs ?? pairs.length}/${results.samples?.requested ?? results.runsPerVariant} complete cold pair(s)`);
  for (const p of pairs) {
    const j = p.job ? ` [${p.job.chromeVersion ?? 'Chrome ?'}${p.job.runAttempt != null ? `, attempt ${p.job.runAttempt}` : ''}]` : '';
    const bench = (n) => (p.job?.benchmarkIndexes && n in p.job.benchmarkIndexes ? ` [benchmark ${p.job.benchmarkIndexes[n] ?? '?'}]` : '');
    for (const n of ['before', 'after', 'delta']) if (p[n]) console.log(`  pair${p.index} ${n.padEnd(6)} ${line(p[n])}${bench(n)}${n === 'before' || (n === 'after' && !p.before) ? j : ''}`);
  }
  console.log('  medians (complete pairs only; delta = median of per-pair deltas):');
  for (const n of Object.keys(results.medians)) if (results.medians[n]) console.log(`  ${n.padEnd(7)} ${line(results.medians[n])}`);
  if (results.hints) {
    console.log(`  hints: ${results.hints.usedLinks ?? results.hints.requestedLinks}/${results.hints.requestedLinks} used; contextual ${results.hints.contextual?.length ?? 0}; dropped ${results.hints.dropped?.length ?? 0}; Link header preloads unset in after: ${results.hints.linkHeaderStripped ?? 0}`);
    for (const e of results.hints.linkHeaderEntries ?? []) console.log(`    unset Link: ${e}`);
  }
  if (results.rejected.length) console.log(`  rejected attempts (kept as diagnostics): ${results.rejected.length}`);
  for (const w of results.warnings ?? []) console.log(`  WARNING (${w.kind}): ${w.message}`);
  console.log(`  reports: ${out}`);
  if (res.runUrl) console.log(`  run: ${res.runUrl}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) await main();
