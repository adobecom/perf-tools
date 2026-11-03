#!/usr/bin/env node
// Preload generator: records page-load traces with perf-ab (same mobile, 4x CPU, Slow 4G conditions), finds the
// LCP and the resources that finished loading before it, and writes a static <link> snippet for head.html.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isLegacyWarmup } from '../lib/cold-runs.mjs';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', short: 'n', default: '3' },
    out: { type: 'string', short: 'o', default: './preloads' },
    from: { type: 'string', multiple: true, default: [] },
    'min-runs': { type: 'string' },
    'all-origins': { type: 'boolean', default: false },
    'no-lcp-image': { type: 'boolean', default: false },
    device: { type: 'string' },
    cpu: { type: 'string' },
    channel: { type: 'string' },
    headless: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (o.help || (!positionals[0] && !o.from.length)) {
  console.log(`perf-preload <pageUrl> [options]
perf-preload --from <trace.json|dir> [--from ...] [options]

  Loads <pageUrl> -n times through perf-ab (iPhone 16 Pro Max, 4x CPU, Slow 4G, cache disabled; every load cold in
  a fresh browser process and profile, no warm-up), finds the LCP in each trace and keeps the scripts,
  stylesheets, fonts, GET JSON/HTML data fetches (fetch(), XHR or script as="fetch" preloads, also when Chrome
  records them as type Other) and the LCP image that finished before it. POST, beacons, other requests and any
  /experienceedge or /experienceedge/* path never become preloads. Each URL counts once per trace.
  Data links assume a default fetch()/XHR (CORS, same-origin credentials); custom headers or non-default
  credentials are not detected or reproduced, so review and remove links for such consumers.
  Resources the HTML parser already requests from the document itself are skipped. A resource must appear in
  --min-runs traces to be kept. Writes <out>/<page-key>.html with static <link> tags, ready for
  perf-ab --head-inject.

  -n, --runs <n>       cold page loads to record (default 3, all counted)
  -o, --out <dir>      output dir for the snippet and traces (default ./preloads)
  --from <path>        analyze existing DevTools traces (file or dir of *.json) instead of recording (repeatable).
                       In a dir, legacy perf-ab warm-ups (before0.json / after0.json) are skipped.
  --min-runs <k>       traces a resource must appear in (default: majority, e.g. 2 of 3)
  --all-origins        keep cross-site resources too (default: same site as the page only)
  --no-lcp-image       do not preload the LCP image (its URL is viewport specific)
  --device, --cpu, --channel, --headless
                       passed to perf-ab`);
  process.exit(positionals[0] || o.from.length ? 0 : 1);
}

const OUT = path.resolve(o.out);
const traceFiles = [];
if (o.from.length) {
  for (const p of o.from) {
    const abs = path.resolve(p);
    if (fs.statSync(abs).isDirectory()) {
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
  const traceDir = path.join(OUT, 'traces');
  fs.rmSync(traceDir, { recursive: true, force: true });
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-ab.mjs'), positionals[0], '-n', o.runs, '-o', traceDir];
  for (const k of ['device', 'cpu', 'channel']) if (o[k] !== undefined) args.push(`--${k}`, o[k]);
  if (o.headless) args.push('--headless');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  // perf-ab saves one cold load per run as after1..n.json and no warm-up. Read exactly the requested runs, never
  // whatever else happens to be in the folder.
  for (let i = 1; i <= Number(o.runs); i += 1) {
    const f = path.join(traceDir, `after${i}.json`);
    if (!fs.existsSync(f)) { console.error(`Missing trace ${f}: perf-ab did not record run ${i}`); process.exit(1); }
    traceFiles.push(f);
  }
}
if (!traceFiles.length) { console.error('No traces to analyze'); process.exit(1); }

const site = (host) => host.split('.').slice(-2).join('.');
const KEEP = new Set(['Script', 'Stylesheet', 'Font']);
// Data requests a static <link rel="preload" as="fetch" crossorigin> can serve. Modern Chrome records fetch(),
// XHR and script-inserted as="fetch" preloads as resourceType "Other", so the role comes from the initiator's
// fetchType and the response MIME. Only GET JSON/HTML with a 2xx response qualifies; POST, beacons, pings,
// navigations, favicons, workers and other "Other" requests never do.
// Never preloaded, whatever the method, type or MIME: Adobe Experience Platform Edge (analytics/personalization).
const EXCLUDED_PATH = /^\/experienceedge(\/|$)/;
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
  const finish = new Map(events.filter((e) => e.name === 'ResourceFinish').map((e) => [e.args.data.requestId, e.ts]));
  const response = new Map(events.filter((e) => e.name === 'ResourceReceiveResponse').map((e) => [e.args.data.requestId, e.args.data]));
  // One entry per URL per trace: a page can request the same URL more than once (a script preload plus the
  // consumer fetch), and that must count as one run for --min-runs.
  const byUrl = new Map();
  for (const e of events) {
    if (e.name !== 'ResourceSendRequest' || e.ts < t0 || e.args.data.frame !== frame) continue;
    const d = e.args.data;
    const end = finish.get(d.requestId);
    if (!end || end > lcp.ts || d.url === docUrl || !/^https?:\/\//.test(d.url)) continue;
    if (EXCLUDED_PATH.test(new URL(d.url).pathname)) continue;
    const isLcpImage = d.url === lcpImage;
    const data = !isLcpImage && dataRequest(d, response.get(d.requestId));
    if (!KEEP.has(d.resourceType) && !isLcpImage && !data) continue;
    if (d.initiator?.type === 'parser' && d.initiator.url === docUrl && !isLcpImage) continue;
    const jsPreload = !!d.isLinkPreload && d.initiator?.type !== 'parser';
    const q = {
      url: d.url,
      type: isLcpImage ? 'LCP image' : data ? 'Fetch' : d.resourceType,
      // A real consumer (not a script-inserted preload) decides the preload type and its fetch mode.
      consumer: !jsPreload,
      module: modules.has(d.url),
      jsPreload,
      start: (e.ts - t0) / 1000,
      end: (end - t0) / 1000,
    };
    const x = byUrl.get(d.url);
    if (!x) { byUrl.set(d.url, q); continue; }
    if (q.consumer && !x.consumer) Object.assign(x, { type: q.type, consumer: true });
    if (q.start < x.start) Object.assign(x, { start: q.start, end: q.end });
    x.module ||= q.module;
    x.jsPreload ||= q.jsPreload;
  }
  return { docUrl, lcp: (lcp.ts - t0) / 1000, lcpNode: lcp.args.data.nodeName, lcpImage, reqs: [...byUrl.values()] };
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
}
if (legacyNoMethod) console.warn(`${legacyNoMethod} Fetch/XHR request(s) without requestMethod (older or synthetic trace) were assumed to be GET`);
const CONTEXT_PARAM = /^(country|locale|lang|language|geo|region|market)$/i;
const contextual = (url) => [...new URL(url).searchParams.keys()].some((k) => CONTEXT_PARAM.test(k));
const picked = [...byUrl.values()]
  .filter((x) => x.starts.length >= minRuns)
  .filter((x) => o['all-origins'] || site(new URL(x.url).hostname) === site(page.hostname))
  .filter((x) => !(o['no-lcp-image'] && x.type === 'LCP image'))
  .map((x) => ({ ...x, start: median(x.starts), end: median(x.ends) }))
  .sort((a, b) => a.start - b.start);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function tag(x) {
  const u = new URL(x.url);
  const cross = u.origin !== page.origin;
  // Stylesheets are always absolute: some site loaders (e.g. Acrobat's loadLink) look for an existing
  // link[href="<relative path>"] without checking rel, find the preload and never add the stylesheet.
  const href = esc(cross || x.type === 'Stylesheet' ? x.url : `${u.pathname}${u.search}`);
  const co = (always) => (always || cross ? ' crossorigin' : '');
  switch (x.type) {
    case 'Script': return x.module ? `<link rel="modulepreload" href="${href}"${co()}>` : `<link rel="preload" href="${href}" as="script"${co()}>`;
    // <link rel="stylesheet"> and @import fetch in no-cors mode; a crossorigin preload would not be reused.
    case 'Stylesheet': return `<link rel="preload" href="${href}" as="style">`;
    case 'Font': return `<link rel="preload" href="${href}" as="font"${co(true)}>`;
    case 'LCP image': return `<link rel="preload" href="${href}" as="image" fetchpriority="high">`;
    default: return `<link rel="preload" href="${href}" as="fetch"${co(true)}>`;
  }
}

const key = page.pathname.replace(/\.html$/, '').replace(/^\/|\/$/g, '').replace(/\//g, '--') || 'index';
fs.mkdirSync(OUT, { recursive: true });
const snippet = path.join(OUT, `${key}.html`);
fs.writeFileSync(snippet, `${picked.map(tag).join('\n')}\n`);

const lcps = runs.map((r) => Math.round(r.lcp));
console.log(`\n${page.href}: ${runs.length} traces, LCP ${lcps.join(' / ')} ms (median ${Math.round(median(lcps))}), element ${runs[0].lcpNode}${runs[0].lcpImage ? ` ${runs[0].lcpImage}` : ''}`);
console.log(`Resources finished before LCP in >= ${minRuns} traces (median ms):`);
console.log('start'.padStart(7), 'end'.padStart(7), ' type'.padEnd(18), 'url');
for (const x of picked) {
  const type = `${x.type}${x.module ? ' (module)' : ''}${x.jsPreload ? ' *' : ''}${contextual(x.url) ? ' !' : ''}`;
  console.log(String(Math.round(x.start)).padStart(7), String(Math.round(x.end)).padStart(7), ` ${type}`.padEnd(18), x.url);
}
if (picked.some((x) => x.jsPreload)) console.log('* already preloaded by a script (e.g. preloadLcpCodeFiles); a static tag starts it earlier');
if (picked.some((x) => contextual(x.url))) console.log('! country/locale specific URL: serve this link only to visitors in the matching context, never hardcode it for every geo');
console.log(`\nSnippet (${picked.length} links): ${snippet}`);
const rel = path.relative(process.cwd(), snippet);
if (positionals[0]) console.log(`Validate: perf-ab "${page.href}" --head-inject ${rel.startsWith('..') ? snippet : rel} -n 5`);
