#!/usr/bin/env node
// Preload generator: records cold page-load traces with perf-ab (default: Actions; optionally --local), finds the LCP and the resources that finished loading
// before it, and writes a static <link> snippet for head.html.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isLegacyWarmup } from '../lib/cold-runs.mjs';
import { assertTargetUrl, isAemLiveHost } from '../lib/target.mjs';
import { BUILT_IN_EXCLUDES, parseExclude, matchExclude, describeRule, isAllowedHost } from '../lib/preload-rules.mjs';
import { manifestPath, prelinkEntry, toManifest, isContextual } from '../lib/prelink.mjs';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', short: 'n', default: '3' },
    out: { type: 'string', short: 'o', default: './preloads' },
    from: { type: 'string', multiple: true, default: [] },
    'min-runs': { type: 'string' },
    'all-origins': { type: 'boolean', default: false },
    'no-lcp-image': { type: 'boolean', default: false },
    exclude: { type: 'string', multiple: true, default: [] },
    local: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (o.help || (!positionals[0] && !o.from.length)) {
  console.log(`perf-preload <pageUrl> [options]
perf-preload --from <trace.json|dir> [--from ...] [options]

  Loads <pageUrl> -n times through perf-ab (real Lighthouse 13.6.0, mobile, real DevTools throttling: Slow 4G and 4x
  CPU; Actions is the default, --local runs on this machine). Every load is cold in a fresh Chrome process and empty
  profile, with no warm-up, and exactly the n accepted Lighthouse traces are analyzed. The throttling is applied by
  Chrome itself, so the trace times (LCP, "finished before LCP") are those of the throttled load. It finds the LCP in
  each trace and keeps the scripts,
  stylesheets, fonts, GET JSON/HTML data fetches (fetch(), XHR or script as="fetch" preloads, also when Chrome
  records them as type Other) and the LCP image that finished before it. POST, beacons, other requests and any
  /experienceedge or /experienceedge/* path never become preloads. Each URL counts once per trace.
  Data links assume a default fetch()/XHR (CORS, same-origin credentials); custom headers or non-default
  credentials are not detected or reproduced, so review and remove links for such consumers.
  Resources the HTML parser already requests from the document itself are skipped. A resource must appear in
  --min-runs traces to be kept. Writes <out>/<page-key>.html with static <link> tags, ready for
  perf-ab --head-inject, and <out>/<page-key>.json: the same links (minus country/locale specific URLs) as a
  prelink manifest (DA sheet: rel, href, as, crossorigin, fetchpriority) to publish at <dir>/preloads/<name>.json.
  fetchpriority (all links start together and share the bandwidth): data fetches high; scripts high when first
  requested in the first half of the median time to LCP, otherwise low; stylesheets and fonts keep the browser
  default; the LCP image is high.

  -n, --runs <n>       cold page loads to record (default 3, all counted)
  -o, --out <dir>      output dir for the snippet and traces (default ./preloads)
  --from <path>        analyze existing DevTools traces (file or dir of *.json) instead of recording (repeatable).
                       In a dir, legacy perf-ab warm-ups (before0.json / after0.json) are skipped; a default perf-ab
                       output dir (results.json) contributes only its accepted runs' trace.json, never rejected/;
                       for a before/after output only the unchanged "before" runs.
  --min-runs <k>       traces a resource must appear in (default: majority, e.g. 2 of 3)
  --all-origins        keep all cross-site resources (default: the page's site plus *.typekit.net)
  --no-lcp-image       do not preload the LCP image (its URL is viewport specific)
  --exclude <rule>     (repeatable) never preload a path prefix (/marketingtech) or a host (bfp.adobe.com, subdomains
                       included), on top of the built-in rules below
  Built-in rules (always on, listed as "excluded by rule" in the output): /experienceedge/*, /marketingtech/*
  (any origin) and bfp.adobe.com. The snippet is meant to be the ONLY source of preloads for the page: perf-ab
  --head-inject unsets every rel=preload/modulepreload entry of the after document's Link response header, so
  resources that the header preloads today are generated here like any other (marked ^).
  --local              record with the same Lighthouse job locally (Actions is the default). A known non-US
                       location is allowed and reported, but local results are not comparable with Actions.`);
  process.exit(positionals[0] || o.from.length ? 0 : 1);
}
if (o.local && o.from.length) { console.error('--local applies only when recording a page; it cannot be combined with --from'); process.exit(1); }

let excludeRules;
try {
  excludeRules = [...BUILT_IN_EXCLUDES, ...o.exclude.map(parseExclude)];
} catch (e) { console.error(e.message); process.exit(1); }

const OUT = path.resolve(o.out);
const traceFiles = [];
if (o.from.length) {
  for (const p of o.from) {
    const abs = path.resolve(p);
    if (fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, 'results.json'))) {
      // Default perf-ab output: only the accepted runs listed in results.json, never rejected/ attempts.
      const results = JSON.parse(fs.readFileSync(path.join(abs, 'results.json'), 'utf8'));
      if (results.status !== 'ok') { console.error(`${p}: perf-ab results status is ${results.status}; not analyzing`); process.exit(1); }
      // A/B outputs: only the unchanged production variant ("before"); the "after" page carries the tested changes.
      // Single-URL outputs measure the page as "after". Paired outputs list pair<i>/<variant><i> dirs.
      const variant = (results.runs ?? []).some((r) => r.variant === 'before') ? 'before' : 'after';
      const runs = (results.runs ?? []).filter((r) => r.variant === variant);
      console.warn(`${p}: Lighthouse ${results.lighthouseVersion} traces of the ${variant === 'before' ? 'unchanged "before"' : 'measured'} variant, ${runs.length} run(s) (DevTools-throttled load)`);
      for (const r of runs) {
        const f = path.join(abs, r.dir, 'trace.json');
        if (!fs.existsSync(f)) { console.error(`Missing trace ${f}`); process.exit(1); }
        traceFiles.push(f);
      }
    } else if (fs.statSync(abs).isDirectory()) {
      const files = fs.readdirSync(abs).filter((f) => f.endsWith('.json')).sort();
      const warmups = files.filter(isLegacyWarmup);
      if (warmups.length) console.warn(`${p}: skipped legacy perf-ab warm-up traces ${warmups.join(', ')} (not measurements)`);
      files.filter((f) => !isLegacyWarmup(f)).forEach((f) => traceFiles.push(path.join(abs, f)));
    } else {
      if (isLegacyWarmup(abs)) console.warn(`WARNING: ${p} looks like a legacy perf-ab warm-up load (warm, not a measurement); analyzing it because it was named explicitly`);
      traceFiles.push(abs);
    }
  }
} else {
  try {
    assertTargetUrl(positionals[0]);
  } catch (e) { console.error(e.message); process.exit(1); }
  const traceDir = path.join(OUT, 'traces');
  fs.rmSync(traceDir, { recursive: true, force: true });
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-ab.mjs'), positionals[0], '-n', o.runs, '-o', traceDir];
  if (o.local) args.push('--local');
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit' });
  } catch (e) {
    console.error(`perf-ab failed (exit ${e.status ?? e.message}); no preloads generated`);
    process.exit(1);
  }
  let results = null;
  try { results = JSON.parse(fs.readFileSync(path.join(traceDir, 'results.json'), 'utf8')); } catch (e) { console.error(`perf-ab produced no readable results.json: ${e.message}`); process.exit(1); }
  const locationOk = o.local
    ? results.where === 'local' && results.egress?.where === 'local'
    : results.where !== 'local' && results.egress?.ok === true && results.egress?.country === 'US';
  if (results.status !== 'ok' || !locationOk || !results.profile) { console.error(`perf-ab results are not a complete ${o.local ? 'local' : 'verified US'} Lighthouse run (status ${results.status}); no preloads generated`); process.exit(1); }
  const location = o.local ? 'local (not comparable with Actions)' : 'verified US egress';
  console.log(`traces: Lighthouse ${results.lighthouseVersion} ${results.profile.name}, ${location}, ${results.runsPerVariant} cold run(s)`);
  // perf-ab saves one cold load per run and no warm-up. Read exactly the
  // requested runs, never whatever else happens to be in the folder.
  for (let i = 1; i <= Number(o.runs); i += 1) {
    const run = results?.runs?.find((r) => r.variant === 'after' && r.run === i && r.dir);
    const f = path.join(traceDir, run?.dir ?? `after${i}`, 'trace.json');
    if (!fs.existsSync(f)) { console.error(`Missing trace ${f}: perf-ab did not record run ${i}`); process.exit(1); }
    traceFiles.push(f);
  }
}
if (!traceFiles.length) { console.error('No traces to analyze'); process.exit(1); }

// Registrable site of a host; every <ref>--<repo>--adobecom.aem.live host (e.g. the page and its Milo libs on
// main--milo--adobecom.aem.live) is one site, other aem.live owners are not.
const site = (host) => (isAemLiveHost(host) ? 'adobecom.aem.live' : host.split('.').slice(-2).join('.'));
const KEEP = new Set(['Script', 'Stylesheet', 'Font']);
// Data requests a static <link rel="preload" as="fetch" crossorigin> can serve. Modern Chrome records fetch(),
// XHR and script-inserted as="fetch" preloads as resourceType "Other", so the role comes from the initiator's
// fetchType and the response MIME. Only GET JSON/HTML with a 2xx response qualifies; POST, beacons, pings,
// navigations, favicons, workers and other "Other" requests never do.
// Exclusion rules (built-in and --exclude) live in lib/preload-rules.mjs and are applied after the type checks.
const DATA_MIME = /^(application\/(.+\+)?json|text\/json|text\/html)$/i;
let legacyNoMethod = 0;
function dataRequest(d, res) {
  const explicit = d.resourceType === 'Fetch' || d.resourceType === 'XHR';
  const fetchType = d.initiator?.fetchType;
  const consumer = explicit || fetchType === 'fetch' || fetchType === 'xmlhttprequest';
  const fetchPreload = d.resourceType === 'Other' && fetchType === 'link' && !!d.isLinkPreload;
  if (!consumer && !fetchPreload) return false;
  if (d.requestMethod === undefined) {
    // Older/synthetic traces without requestMethod: only an explicit Fetch/XHR is assumed to be GET.
    if (!explicit) return false;
    legacyNoMethod += 1;
  } else if (String(d.requestMethod).toUpperCase() !== 'GET') return false;
  if (!res) return explicit;
  return res.statusCode >= 200 && res.statusCode < 300 && DATA_MIME.test(res.mimeType ?? '');
}

function analyze(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.traceEvents;
  if (raw.metadata?.perfAb?.warmup) { console.warn(`${path.basename(file)}: perf-ab warm-up load, skipped`); return null; }
  const nav = events.find((e) => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL?.startsWith('http') && e.args?.data?.isOutermostMainFrame !== false);
  if (!nav) { console.warn(`${path.basename(file)}: no navigation, skipped`); return null; }
  const { ts: t0, args: { frame } } = nav;
  const docUrl = nav.args.data.documentLoaderURL;
  const lcp = events.filter((e) => e.name === 'largestContentfulPaint::Candidate' && e.ts >= t0 && e.args?.frame === frame).pop();
  if (!lcp) { console.warn(`${path.basename(file)}: no LCP, skipped`); return null; }
  const lcpImage = lcp.args.data.type === 'image'
    ? events.filter((e) => e.name === 'LargestImagePaint::Candidate' && e.ts >= t0 && e.args?.frame === frame && e.args.data.DOMNodeId === lcp.args.data.nodeId).pop()?.args.data.imageUrl
    : null;
  const modules = new Set(events.filter((e) => e.name === 'v8.compileModule').map((e) => e.args?.data?.url));
  const finish = new Map(events.filter((e) => e.name === 'ResourceFinish').map((e) => [e.args.data.requestId, e]));
  const response = new Map(events.filter((e) => e.name === 'ResourceReceiveResponse').map((e) => [e.args.data.requestId, e.args.data]));
  // One entry per URL per trace: a page can request the same URL more than once (a script preload plus the
  // consumer fetch), and that must count as one run for --min-runs.
  const byUrl = new Map();
  const excluded = new Map();
  const failed = new Map();
  for (const e of events) {
    if (e.name !== 'ResourceSendRequest' || e.ts < t0 || e.args.data.frame !== frame) continue;
    const d = e.args.data;
    const done = finish.get(d.requestId);
    const end = done?.ts;
    if (!end || end > lcp.ts || d.url === docUrl || !/^https?:\/\//.test(d.url)) continue;
    // A failed request finishes early without serving anything (e.g. a Link header preload that 404s on this host).
    const status = response.get(d.requestId)?.statusCode;
    if (done.args.data.didFail || status >= 400) { failed.set(d.url, done.args.data.didFail ? 'network error' : `HTTP ${status}`); continue; }
    const isLcpImage = d.url === lcpImage;
    const data = !isLcpImage && dataRequest(d, response.get(d.requestId));
    if (!KEEP.has(d.resourceType) && !isLcpImage && !data) continue;
    if (d.initiator?.type === 'parser' && d.initiator.url === docUrl && !isLcpImage) continue;
    const rule = matchExclude(excludeRules, d.url);
    if (rule) { excluded.set(d.url, rule); continue; }
    const jsPreload = !!d.isLinkPreload && d.initiator?.type !== 'parser';
    // Chrome reports a Link response header preload with initiator type "other", a script-inserted one with "script".
    const headerPreload = !!d.isLinkPreload && !['parser', 'script'].includes(d.initiator?.type);
    const q = {
      url: d.url,
      type: isLcpImage ? 'LCP image' : data ? 'Fetch' : d.resourceType,
      // A real consumer (not a script-inserted preload) decides the preload type and its fetch mode.
      consumer: !jsPreload,
      module: modules.has(d.url),
      jsPreload,
      headerPreload,
      start: (e.ts - t0) / 1000,
      end: (end - t0) / 1000,
    };
    const x = byUrl.get(d.url);
    if (!x) { byUrl.set(d.url, q); continue; }
    if (q.consumer && !x.consumer) Object.assign(x, { type: q.type, consumer: true });
    if (q.start < x.start) Object.assign(x, { start: q.start, end: q.end });
    x.module ||= q.module;
    x.jsPreload ||= q.jsPreload;
    x.headerPreload ||= q.headerPreload;
  }
  return { docUrl, lcp: (lcp.ts - t0) / 1000, lcpNode: lcp.args.data.nodeName, lcpImage, reqs: [...byUrl.values()], excluded, failed };
}

const runs = traceFiles.map(analyze).filter(Boolean);
if (!runs.length) { console.error('No usable traces'); process.exit(1); }
const page = new URL(positionals[0] ?? runs[0].docUrl);
const minRuns = Number(o['min-runs'] ?? Math.floor(runs.length / 2) + 1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const byUrl = new Map();
for (const r of runs) for (const q of r.reqs) {
  if (!byUrl.has(q.url)) byUrl.set(q.url, { ...q, starts: [], ends: [] });
  const x = byUrl.get(q.url);
  x.starts.push(q.start); // r.reqs holds each URL once, so starts.length counts traces
  x.ends.push(q.end);
  if (q.consumer && !x.consumer) Object.assign(x, { type: q.type, consumer: true });
  x.module ||= q.module;
  x.jsPreload ||= q.jsPreload;
  x.headerPreload ||= q.headerPreload;
}
if (legacyNoMethod) console.warn(`${legacyNoMethod} Fetch/XHR request(s) without requestMethod (older or synthetic trace) were assumed to be GET`);
const contextual = (url) => isContextual(url);
const picked = [...byUrl.values()]
  .filter((x) => x.starts.length >= minRuns)
  .filter((x) => o['all-origins'] || site(new URL(x.url).hostname) === site(page.hostname) || isAllowedHost(new URL(x.url).hostname))
  .filter((x) => !(o['no-lcp-image'] && x.type === 'LCP image'))
  .map((x) => ({ ...x, start: median(x.starts), end: median(x.ends) }))
  .sort((a, b) => a.start - b.start);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lcps = runs.map((r) => Math.round(r.lcp));
// fetchpriority: all links start together and share the bandwidth, so what the page needs first should win it.
// Data fetches (JSON/HTML, small and awaited by code before rendering) are high; scripts the page first requested
// in the first half of the time to LCP are high, later ones low; stylesheets and fonts keep the browser default
// (already the highest); the LCP image is high.
const PRIORITY_SPLIT = 0.5;
const priorityCutoff = median(lcps) * PRIORITY_SPLIT;
// The link attributes of a picked resource, shared by the HTML snippet and the JSON manifest.
function linkOf(x) {
  const u = new URL(x.url);
  const cross = u.origin !== page.origin;
  // Stylesheets are protocol-relative (//host/path): site loaders such as Acrobat's loadLink look for an existing
  // link[href="<the URL they load>"] without checking rel, find the preload and never add the stylesheet. They load
  // either a relative path (/libs/... on www.adobe.com) or an absolute URL (https://main--milo--adobecom.aem.live/...
  // on aem.live); "//host/path" resolves to the same URL, so the preload is reused, but never equals either string.
  const href = x.type === 'Stylesheet' ? x.url.replace(/^https:/, '') : cross ? x.url : `${u.pathname}${u.search}`;
  const co = (always) => (always || cross ? 'anonymous' : '');
  const scriptPriority = x.start <= priorityCutoff ? 'high' : 'low';
  switch (x.type) {
    case 'Script': return x.module
      ? { rel: 'modulepreload', href, crossorigin: co(), fetchpriority: scriptPriority }
      : { rel: 'preload', href, as: 'script', crossorigin: co(), fetchpriority: scriptPriority };
    // <link rel="stylesheet"> and @import fetch in no-cors mode; a crossorigin preload would not be reused.
    case 'Stylesheet': return { rel: 'preload', href, as: 'style' };
    case 'Font': return { rel: 'preload', href, as: 'font', crossorigin: co(true) };
    case 'LCP image': return { rel: 'preload', href, as: 'image', fetchpriority: 'high' };
    default: return { rel: 'preload', href, as: 'fetch', crossorigin: co(true), fetchpriority: 'high' };
  }
}
const tag = ({ rel, href, as, crossorigin, fetchpriority }) => `<link rel="${rel}" href="${esc(href)}"${as ? ` as="${as}"` : ''}${crossorigin ? ' crossorigin' : ''}${fetchpriority ? ` fetchpriority="${fetchpriority}"` : ''}>`;

const key = page.pathname.replace(/\.html$/, '').replace(/^\/|\/$/g, '').replace(/\//g, '--') || 'index';
fs.mkdirSync(OUT, { recursive: true });
const links = picked.map((x) => ({ ...linkOf(x), url: x.url }));
const snippet = path.join(OUT, `${key}.html`);
fs.writeFileSync(snippet, `${links.map(tag).join('\n')}\n`);
// The manifest is served to every visitor, so country/locale specific URLs stay out of it. The page's own files are
// root-relative (stylesheets too), so one manifest works on every host serving the page (e.g. aem.live branches);
// prelink/head.html resolves them against the page and gives stylesheets their //host/path form.
const manifestLinks = links.filter((l) => !isContextual(l.url)).map((l) => {
  const u = new URL(l.url);
  return u.origin === page.origin ? { ...l, href: `${u.pathname}${u.search}` } : l;
});
const manifestFile = path.join(OUT, `${key}.json`);
fs.writeFileSync(manifestFile, `${JSON.stringify(toManifest(manifestLinks), null, 2)}\n`);

console.log(`\n${page.href}: ${runs.length} traces, LCP ${lcps.join(' / ')} ms (median ${Math.round(median(lcps))}), element ${runs[0].lcpNode}${runs[0].lcpImage ? ` ${runs[0].lcpImage}` : ''}`);
console.log(`Resources finished before LCP in >= ${minRuns} traces (median ms):`);
console.log('start'.padStart(7), 'end'.padStart(7), ' type'.padEnd(18), 'url');
for (const [i, x] of picked.entries()) {
  const type = `${x.type}${x.module ? ' (module)' : ''}${x.jsPreload && !x.headerPreload ? ' *' : ''}${x.headerPreload ? ' ^' : ''}${contextual(x.url) ? ' !' : ''}`;
  console.log(String(Math.round(x.start)).padStart(7), String(Math.round(x.end)).padStart(7), ` ${type}`.padEnd(18), x.url, links[i].fetchpriority ? ` [${links[i].fetchpriority}]` : '');
}
const excludedByRule = new Map();
for (const r of runs) for (const [url, rule] of r.excluded) if (!excludedByRule.has(url)) excludedByRule.set(url, rule);
if (excludedByRule.size) {
  console.log('Excluded by rule (finished before LCP, never preloaded):');
  for (const [url, rule] of excludedByRule) console.log(`  ${describeRule(rule)}  ${url}`);
}
const pickedUrls = new Set(picked.map((x) => x.url));
const failedResponses = new Map();
for (const r of runs) for (const [url, why] of r.failed) if (!pickedUrls.has(url) && !failedResponses.has(url)) failedResponses.set(url, why);
if (failedResponses.size) {
  console.log('Failed responses (finished before LCP without content, never preloaded):');
  for (const [url, why] of failedResponses) console.log(`  ${why}  ${url}`);
}
console.log(`Exclude rules: ${excludeRules.map(describeRule).join(', ')}`);
if (picked.some((x) => x.jsPreload && !x.headerPreload)) console.log('* already preloaded by a script (e.g. preloadLcpCodeFiles); a static tag starts it earlier');
if (picked.some((x) => x.headerPreload)) console.log("^ preloaded by the document's Link response header today; perf-ab --head-inject unsets those header entries, so this tag takes over");
if (picked.some((x) => contextual(x.url))) console.log('! country/locale specific URL: serve this link only to visitors in the matching context, never hardcode it for every geo');
console.log(`[high]/[low] fetchpriority: data fetches high; scripts first requested by ${Math.round(priorityCutoff)} ms (${PRIORITY_SPLIT * 100}% of the median LCP) high, later ones low; stylesheets and fonts keep the browser default`);
console.log(`\nSnippet (${picked.length} links): ${snippet}`);
const contextualDropped = links.length - manifestLinks.length;
console.log(`Manifest (${manifestLinks.length} rows${contextualDropped ? `, ${contextualDropped} country/locale specific link(s) left out` : ''}): ${manifestFile}`);
console.log(`  publish as ${manifestPath(page.pathname)} on ${page.origin}; prelink: ${prelinkEntry(manifestPath(page.pathname))}`);
const rel = path.relative(process.cwd(), snippet);
if (positionals[0]) console.log(`Validate: perf-ab "${page.href}" --head-inject ${rel.startsWith('..') ? snippet : rel} -n 5`);
const headScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prelink', 'head.html');
const headRel = path.relative(process.cwd(), headScript);
if (positionals[0]) console.log(`Validate the published manifest: perf-ab "${page.href}" --head-inject ${headRel.startsWith('..') ? headScript : headRel} --link-add '${prelinkEntry(manifestPath(page.pathname))}' -n 5`);
