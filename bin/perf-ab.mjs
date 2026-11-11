#!/usr/bin/env node
// perf-ab: before/after page-load comparison. One measurement: real Lighthouse 13.6.0, mobile profile with real
// DevTools throttling (Slow 4G + 4x CPU, see lib/pagespeed/profile.mjs), counterbalanced cold pairs (fresh Chrome + empty profile per attempt, no warm-ups). Only the location
// differs: by default the perf-ab GitHub Actions workflow (verified-US egress, fail-closed); with --local the same job
// runs on this machine, pairs sequentially, and is recorded as local in results.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../lib/pagespeed/spec.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';
import { runLocal } from '../lib/pagespeed/local.mjs';
import { loadExperiment, CONFIG_PATH } from '../lib/pagespeed/experiment.mjs';
import { resolveInteractions } from '../lib/pagespeed/interactions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGE_OPTIONS = ['before', 'after', 'head-inject', 'link-add', 'link-remove', 'link-replace', 'patch', 'milo-pr', 'mas-pr', 'interactions'];

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
  VERIFIED US egress (fails closed if the egress is non-US or unknown). Odd pairs run before/after, even pairs after/before;
  contextual preload hints require baseline-first order (reported explicitly). Every
  run is cold (new Chrome process, empty temporary profile, no warm-ups). A failed run is not retried: it fails and
  the error is reported (the attempt is kept as a rejected diagnostic). Requires gh authenticated with Actions write access to --repo.
  --local runs the identical Lighthouse job on this machine, with pairs measured sequentially. Set CHROME_PATH or
  install Chrome in a common macOS/Linux location. A local run does no egress check;
  local results are not comparable with Actions results, even when profileKey matches. A local run authenticates its
  GitHub API reads (--milo-pr / --mas-pr) with GITHUB_TOKEN, GH_TOKEN or "gh auth token" when available.

  -n N dispatches N parallel matrix jobs; each measures ONE complete cold before/after pair on its own runner. Medians
  and the median per-pair delta use complete pairs only; any missing/failed pair makes the result partial (exit 1).

  Without variant options the URL is measured as-is. With any change option, "before" is the unchanged
  production page and "after" is the page with the changes applied by the runner's measuring proxy (HTTP/2 kept,
  real compressed sizes; unchanged responses are byte-identical).

  --config <file>         versioned experiment config in this repository (experiments/*.json): URL,
                          changes and default run count. The workflow reads the COMMITTED file from --ref; the
                          local copy is only validated. Cannot be combined with a URL or change options.
  -n, --runs <n>          before/after pairs = parallel jobs, 1..10 (default 3 or the config's runs; -n 1 = smoke; use -n 5 for a full campaign)
  -o, --out <dir>         download dir (default ./traces): results.json, pair<i>/<variant><i>/report.html|
                          report.json|trace.json|devtoolslog.json|run.json (with --interactions also
                          interaction/report.html|report.json|trace.json|devtoolslog.json and flow-report.html),
                          pair<i>/rejected/...
  -b, --before <value> / -a, --after <value>
                          variant values sent as ?<param>=<value><suffix> (e.g. milolibs branches)
  --param <name>          (default milolibs)    --suffix <str>  (default --milo--adobecom)
  --head-inject <file>    HTML inserted into the after document's <head> (before the first <script>). The injected tags are
                          then the ONLY preloads of the after page: every rel=preload / rel=modulepreload entry of its
                          Link response header is unset (other Link entries stay; before is untouched), reported in
                          results.json hints.linkHeaderStripped / linkHeaderEntries and the console. Hints whose
                          URL carries country/locale params are re-resolved against the US baseline's own requests
                          (unmatched ones are dropped and reported). /experienceedge hints are always dropped.
  --link-add <entry>      repeatable. Appends a Link entry such as '</page/preloads/x.json>; rel=preload; as=fetch;
                          crossorigin=anonymous' (a prelink) to the after document's Link response header.
  --link-remove <url|*>   repeatable. Removes the after document's Link entries for that URL (root-relative or https,
                          matched after resolving against the page URL); "*" removes every rel=preload/modulepreload entry.
  --link-replace <entry>  repeatable. Replaces the one Link entry with the same URL (e.g. to change rel, as or crossorigin).
                          Link edits apply to after only, in the order remove, replace, add (with --head-inject, after the
                          header preloads are unset). They are guarded: a removed URL must be present, a replaced URL present exactly
                          once with a different value, an added URL absent, or the job fails (production changed).
                          Reported in results.json linkHeader (production, served, removed, replaced, added) and the console.
  --after-only            measure only the changed (after) page: no before baseline, pairs or deltas. Needs a change option;
                          perf-preload records with --after-only --link-remove '*' so no server Link preload biases its traces.
  --patch <file.json>     {"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}:
                          guarded edits of live sources (after only); each find must match exactly once or the job fails
  --milo-pr <n> / --mas-pr <n>   pin the PR's exact commit, locally read only mapped changed files, and serve them
                          through the proxy in the after variant. Before remains unchanged production.
  --interactions <file.json|auto>   adds INP (Interaction to Next Paint) to the same measurement. "auto" is the pass-partout:
                          it finds the page's own in-page interactions (tabs, expand/collapse toggles, plain buttons, one modal
                          opener; never links, purchases, sign-in, submits or cookie banners) and taps them, no selectors needed;
                          before and after exercise the same elements. Otherwise the file is an array of declarative steps
                          ({"action":"tap|click|type|press|waitFor|scroll|pause|auto","selector":...,
                          "text":..., "key":..., "ms":..., "label":...}); every cold run then is one Lighthouse user flow:
                          the usual cold navigation (all usual metrics) followed by a timespan (mobile, same DevTools
                          throttling) in which the steps run, identically in before and after. Every interaction step must
                          find its selector, Chrome must register an interaction, and the main frame must not navigate
                          (iframes may), or the run is rejected. Not a change by itself: with no other change option the
                          URL is measured as-is (INP of the page's own scenario). Max 20 steps; use -n 5 for a campaign.
  --repo <owner/name>     workflow repository (default adobecom/perf-tools)   --ref <branch> (default main)
  --timeout <minutes>     wait limit (default 75)
  --local                 run the same Lighthouse measurement locally (Actions is the default)`;

const fail = (m) => { console.error(`perf-ab: ${m}`); process.exit(1); };
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
export function buildSpec(o, pageUrl, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const runs = Number(o.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be an integer 1..10');
  const withQuery = (value) => {
    const u = new URL(pageUrl);
    if (value != null) u.searchParams.set(o.param, `${value}${o.suffix}`);
    return u.href;
  };
  if ((o.before == null) !== (o.after == null)) throw new Error('--before and --after must be given together');
  const after = { url: withQuery(o.after) };
  const before = { url: withQuery(o.before) };
  if (o['head-inject']) after.headInject = readFile(o['head-inject']);
  const linkHeader = {};
  for (const [flag, op] of [['link-remove', 'remove'], ['link-replace', 'replace'], ['link-add', 'add']]) {
    const values = [o[flag] ?? []].flat();
    if (values.some((value) => typeof value !== 'string')) throw new Error(`--${flag} needs a value`);
    if (values.length) linkHeader[op] = values;
  }
  if (Object.keys(linkHeader).length) after.linkHeader = linkHeader;
  // Interactions apply to both variants and do not make a change on their own: they add INP to the same measurement.
  const interactions = o.interactions ? resolveInteractions(o.interactions, readFile, `--interactions ${o.interactions}`) : null;
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
  const changed = o.before != null || after.headInject != null || after.linkHeader || after.patches || after.sources || after.pullRequests;
  if (o['after-only'] && !changed) throw new Error('--after-only needs a change option (e.g. --link-remove \'*\'); without one the URL is already measured as-is');
  const paired = changed && !o['after-only'];
  return validateSpec({ version: 1, runs, names: paired ? ['before', 'after'] : ['after'], variants: paired ? { before, after } : { after }, ...(interactions ? { interactions } : {}) });
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
      'head-inject': { type: 'string' },
      'link-add': { type: 'string', multiple: true },
      'link-remove': { type: 'string', multiple: true },
      'link-replace': { type: 'string', multiple: true },
      patch: { type: 'string' },
      'milo-pr': { type: 'string' },
      'mas-pr': { type: 'string' },
      interactions: { type: 'string' },
      repo: { type: 'string', default: 'adobecom/perf-tools' },
      ref: { type: 'string', default: 'main' },
      timeout: { type: 'string', default: '75' },
      local: { type: 'boolean', default: false },
      'after-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help || (!positionals[0] && !o.config)) { console.log(HELP); process.exit(positionals[0] || o.help ? 0 : 1); }
  const known = new Set(['config', 'runs', 'out', 'before', 'after', 'param', 'suffix', 'head-inject', 'link-add', 'link-remove', 'link-replace', 'patch', 'milo-pr', 'mas-pr', 'interactions', 'repo', 'ref', 'timeout', 'local', 'after-only', 'help']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) fail(`unknown option(s): ${unknown.map((k) => `--${k}`).join(', ')}`);
  if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(' ')}`);
  let spec;
  let config = null;
  try {
    if (o.config) {
      if (o['after-only']) throw new Error('--after-only cannot be combined with --config');
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
    ? 'local; not an Actions run'
    : `egress ${results.egress?.country ?? 'unknown'}`;
  console.log(`\nLighthouse mobile, DevTools throttling (Lighthouse ${results.lighthouseVersion}, Chrome ${results.chromeVersion}), ${place}, ${results.samples?.pairs ?? pairs.length}/${results.samples?.requested ?? results.runsPerVariant} complete cold pair(s)`);
  for (const p of pairs) {
    const j = p.job ? ` [${p.job.chromeVersion ?? 'Chrome ?'}${p.job.runAttempt != null ? `, attempt ${p.job.runAttempt}` : ''}]` : '';
    if (p.job?.order?.length) console.log(`  pair${p.index} order: ${p.job.order.join(' -> ')} (${p.job.orderPolicy ?? 'recorded'})`);
    const bench = (n) => (p.job?.benchmarkIndexes && n in p.job.benchmarkIndexes ? ` [benchmark ${p.job.benchmarkIndexes[n] ?? '?'}]` : '');
    for (const n of ['before', 'after', 'delta']) if (p[n]) console.log(`  pair${p.index} ${n.padEnd(6)} ${line(p[n])}${bench(n)}${n === 'before' || (n === 'after' && !p.before) ? j : ''}`);
  }
  if (results.interactions) console.log(`  interactions: ${results.interactions.length} step(s), key ${String(results.interactionsKey).slice(0, 12)}; INP is the slowest interaction of each run's timespan, in ms`);
  console.log('  medians (complete pairs only; delta = median of per-pair deltas):');
  for (const n of Object.keys(results.medians)) if (results.medians[n]) console.log(`  ${n.padEnd(7)} ${line(results.medians[n])}`);
  if (results.hints) {
    console.log(`  hints: ${results.hints.usedLinks ?? results.hints.requestedLinks}/${results.hints.requestedLinks} used; contextual ${results.hints.contextual?.length ?? 0}; dropped ${results.hints.dropped?.length ?? 0}; Link header preloads unset in after: ${results.hints.linkHeaderStripped ?? 0}`);
    for (const e of results.hints.linkHeaderEntries ?? []) console.log(`    unset Link: ${e}`);
  }
  if (results.linkHeader) {
    const l = results.linkHeader;
    console.log(`  Link header edits in after: ${l.removed?.length ?? 0} removed, ${l.replaced?.length ?? 0} replaced, ${l.added?.length ?? 0} added`);
    for (const e of l.removed ?? []) console.log(`    removed Link: ${e}`);
    for (const e of l.replaced ?? []) console.log(`    replaced Link: ${e.from}  ->  ${e.to}`);
    for (const e of l.added ?? []) console.log(`    added Link: ${e}`);
    console.log(`    served Link: ${l.served ?? '(none)'}`);
  }
  if (results.rejected.length) console.log(`  rejected attempts (kept as diagnostics): ${results.rejected.length}`);
  for (const w of results.warnings ?? []) console.log(`  WARNING (${w.kind}): ${w.message}`);
  console.log(`  reports: ${out}`);
  if (res.runUrl) console.log(`  run: ${res.runUrl}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) await main();
