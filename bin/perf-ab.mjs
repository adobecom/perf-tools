#!/usr/bin/env node
// perf-ab: before/after page-load comparison. Default (and only non-legacy) mode: real Lighthouse 13.6.0 with the
// PageSpeed Insights mobile profile, run on a GitHub Actions runner whose egress is verified to be in the US,
// alternating cold runs (fresh Chrome + empty profile per attempt, no warm-ups). The CLI dispatches the perf-ab
// workflow, waits, and downloads the official reports. The old local iPhone/DevTools runner is available only
// through the explicit --local-devtools flag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parsePriorityRules } from '../lib/pagespeed/transforms.mjs';
import { validateSpec } from '../lib/pagespeed/spec.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';

const LEGACY_FLAG = '--local-devtools';
const LEGACY_ONLY = ['override', 'override-before', 'pr-local', 'device', 'cpu', 'channel', 'headless', 'settle', 'lcp-wait'];

export const HELP = `perf-ab <pageUrl> [options]
  Default mode: PageSpeed Insights mobile via real Lighthouse 13.6.0 (lr-mobile preset: Moto G Power, simulated
  150 ms RTT / 1638.4 kb/s, CPU x1.2), executed on the adobecom/perf-tools "perf-ab" GitHub Actions workflow with
  VERIFIED US egress (fails closed if the egress is non-US or unknown). Runs alternate before/after; every run and
  retry is cold (new Chrome process, empty temporary profile, no warm-ups). Invalid renders are kept as rejected
  diagnostics and retried fresh. Requires gh authenticated with Actions write access to --repo. No local fallback.

  Without variant options the URL is measured as-is. With any change option, "before" is the unchanged
  production page and "after" is the page with the changes applied by the runner's measuring proxy (HTTP/2 kept,
  real compressed sizes; unchanged responses are byte-identical).

  -n, --runs <n>          completed runs per variant, 1..10 (default 3; use -n 1 for a smoke test)
  -o, --out <dir>         download dir (default ./traces): results.json, <variant><i>/report.html|report.json|
                          trace.json|devtoolslog.json|run.json, rejected/...
  -b, --before <value> / -a, --after <value>
                          variant values sent as ?<param>=<value><suffix> (e.g. milolibs branches)
  --param <name>          (default milolibs)    --suffix <str>  (default --milo--adobecom)
  --before-query <qs> / --after-query <qs>   extra query params per variant
  --head-inject <file>    HTML inserted into the after document's <head> (before the first <script>). Hints whose
                          URL carries country/locale params are re-resolved against the US baseline's own requests
                          (unmatched ones are dropped and reported). /experienceedge hints are always dropped.
  --fetchpriority </path=high|low|auto>   (repeatable) set fetchpriority on matching injected hints AND on the
                          after document's Link response header entries
  --patch <file.json>     {"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}:
                          guarded edits of live sources (after only); each find must match exactly once or the job fails
  --milo-pr <n> / --mas-pr <n>   serve the files changed by an adobecom/milo or adobecom/mas PR (same-repo branches):
                          after = PR branch, before = stage (milo) / main (mas), both from aem.live
  --expect-title <regex>  render guard: document title must match
  --expect-count <selector=n>   render guard (repeatable), e.g. merch-card=19
  --repo <owner/name>     workflow repository (default adobecom/perf-tools)   --ref <branch> (default main)
  --timeout <minutes>     wait limit (default 75)

  Legacy: perf-ab --local-devtools <pageUrl> ... runs the old LOCAL iPhone 16 Pro Max / 4x CPU / DevTools Slow 4G
  trace runner on this machine (not PageSpeed, not US). It must be requested explicitly; see perf-ab --local-devtools --help.`;

const fail = (m) => { console.error(`perf-ab: ${m}`); process.exit(1); };
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const aemHost = (ref, repo) => `${ref.toLowerCase().replace(/[^a-z0-9-]/g, '-')}--${repo.split('/')[1]}--${repo.split('/')[0]}.aem.live`;
const TEXT = /\.(?:m?js|css|json|html|svg|txt)$/i;

function prSources(repo, num, rule) {
  const { headRefOid, headRefName, headRepositoryOwner } = JSON.parse(gh(['pr', 'view', num, '-R', repo, '--json', 'headRefOid,headRefName,headRepositoryOwner']));
  if (headRepositoryOwner.login !== repo.split('/')[0]) fail(`${repo}#${num} is from a fork; only same-repository PR branches can be served from aem.live`);
  const base = repo.endsWith('/milo') ? 'stage' : 'main';
  const files = gh(['api', `repos/${repo}/compare/${base}...${headRefOid}`, '--paginate', '--jq', '.files[]']).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = { before: {}, after: {} };
  for (const f of files) {
    if (!f.filename.startsWith(rule.from)) continue;
    const pathname = `${rule.to}/${f.filename.slice(rule.from.length)}`;
    if (!TEXT.test(pathname)) { console.warn(`${repo}#${num}: skipping non-text ${pathname}`); continue; }
    if (f.status !== 'removed') out.after[pathname] = `https://${aemHost(headRefName, repo)}/${f.filename}`;
    if (f.status !== 'added') out.before[pathname] = `https://${aemHost(base, repo)}/${f.previous_filename ?? f.filename}`;
  }
  console.log(`${repo}#${num}: after=${aemHost(headRefName, repo)} before=${aemHost(base, repo)} (${Object.keys(out.after).length} files)`);
  return out;
}

export function buildSpec(o, pageUrl, { readFile = (f) => fs.readFileSync(f, 'utf8'), prSourcesFn = prSources } = {}) {
  const runs = Number(o.runs);
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
  for (const [flag, repo, rule] of [['milo-pr', 'adobecom/milo', { from: 'libs/', to: '/libs' }], ['mas-pr', 'adobecom/mas', { from: 'web-components/dist/', to: '/mas/libs' }]]) {
    if (!o[flag]) continue;
    const s = prSourcesFn(repo, o[flag], rule);
    after.sources = { ...after.sources, ...s.after };
    before.sources = { ...before.sources, ...s.before };
  }
  const changed = o.before != null || o['before-query'] || o['after-query'] || after.headInject != null || after.priorities || after.patches || after.sources;
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
  if (argv.includes(LEGACY_FLAG)) {
    process.argv = [process.argv[0], process.argv[1], ...argv.filter((a) => a !== LEGACY_FLAG)];
    await import('../lib/local-devtools-ab.mjs');
    return;
  }
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      runs: { type: 'string', short: 'n', default: '3' },
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help || !positionals[0]) { console.log(HELP); process.exit(positionals[0] || o.help ? 0 : 1); }
  const legacy = LEGACY_ONLY.filter((k) => k in o);
  if (legacy.length) fail(`${legacy.map((k) => `--${k}`).join(', ')} only exist in the legacy local DevTools mode; add ${LEGACY_FLAG} to use it explicitly (it is not PageSpeed and not US)`);
  const known = new Set(['runs', 'out', 'before', 'after', 'param', 'suffix', 'before-query', 'after-query', 'head-inject', 'fetchpriority', 'patch', 'milo-pr', 'mas-pr', 'expect-title', 'expect-count', 'repo', 'ref', 'timeout', 'help']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) fail(`unknown option(s): ${unknown.map((k) => `--${k}`).join(', ')}`);
  if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(' ')}`);
  let spec;
  try {
    spec = buildSpec(o, positionals[0]);
  } catch (e) {
    fail(e.message);
  }
  const out = path.resolve(o.out);
  let res;
  try {
    res = await runRemote({ spec, out, repo: o.repo, ref: o.ref, timeoutMs: Number(o.timeout) * 60000 });
  } catch (e) {
    fail(e.message);
  }
  const { results } = res;
  const fmt = (k, v) => (v == null ? '-' : k === 'CLS' ? v.toFixed(3) : k === 'performance' ? String(v) : `${Math.round(v)}`);
  console.log(`\nPageSpeed mobile (Lighthouse ${results.lighthouseVersion}, Chrome ${results.chromeVersion}), egress ${results.egress.country}, ${results.runsPerVariant} cold run(s)/variant, medians:`);
  for (const n of Object.keys(results.medians)) console.log(`  ${n.padEnd(7)} ${Object.entries(results.medians[n]).map(([k, v]) => `${k}=${fmt(k, v)}`).join('  ')}`);
  if (results.hints) console.log(`  hints: ${results.hints.usedLinks ?? results.hints.requestedLinks}/${results.hints.requestedLinks} used; contextual ${results.hints.contextual?.length ?? 0}; dropped ${results.hints.dropped?.length ?? 0}`);
  if (results.rejected.length) console.log(`  rejected attempts (kept as diagnostics): ${results.rejected.length}`);
  console.log(`  reports: ${out}\n  run: ${res.runUrl}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) await main();
