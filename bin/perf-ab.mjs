#!/usr/bin/env node
// A/B page-load trace runner: mobile emulation, 4x CPU throttle, Slow 4G, cache disabled.
// Alternates baseline/change runs, each in a fresh browser process and profile with no warm-up,
// saves DevTools-loadable traces and prints a median summary.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { measureCold } from '../lib/cold-runs.mjs';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', short: 'n', default: '5' },
    out: { type: 'string', short: 'o', default: './traces' },
    before: { type: 'string', short: 'b' },
    after: { type: 'string', short: 'a' },
    param: { type: 'string', default: 'milolibs' },
    suffix: { type: 'string', default: '--milo--adobecom' },
    'before-query': { type: 'string', default: '' },
    'after-query': { type: 'string', default: '' },
    'milo-pr': { type: 'string' },
    'mas-pr': { type: 'string' },
    'pr-local': { type: 'boolean', default: false },
    override: { type: 'string', multiple: true, default: [] },
    'override-before': { type: 'string', multiple: true, default: [] },
    'head-inject': { type: 'string' },
    device: { type: 'string', default: 'iPhone 16 Pro Max' },
    cpu: { type: 'string', default: '4' },
    channel: { type: 'string', default: 'chrome' },
    headless: { type: 'boolean', default: false },
    settle: { type: 'string', default: '12000' },
    'lcp-wait': { type: 'string', default: '5000' },
    help: { type: 'boolean', short: 'h' },
  },
});

const hasOverrides = o['milo-pr'] || o['mas-pr'] || o.override.length || o['override-before'].length || o['head-inject'];
const hasQuery = o['before-query'] || o['after-query'];
const single = !hasOverrides && !hasQuery && !o.before && !o.after;
if (o.help || !positionals[0] || (!single && !hasOverrides && !hasQuery && (!o.before || !o.after))) {
  console.log(`perf-ab <pageUrl>   (no variants/PRs: measures the URL as-is)
perf-ab <pageUrl> --before <value> --after <value> [options]

  Loads <pageUrl> with ?<param>=<value><suffix> for each variant, alternating runs.
  Example (milo branches):
    perf-ab "https://www.stage.adobe.com/products/photoshop.html?mep=off&mas.preview=off" \\
      -b my-feature-stage -a my-feature -n 5

  -n, --runs <n>       runs per variant (default 5). Every run and retry is cold: a new browser process with an
                       empty temporary profile (no cache, cookies, storage or service workers). No warm-up loads.
  -o, --out <dir>      trace output dir (default ./traces)
  --param <name>       query param carrying the variant (default milolibs)
  --suffix <str>       appended to each variant value (default --milo--adobecom, use "" for raw values)
  --before-query <qs>  extra query params for the baseline only, e.g. "maslibs=main"
  --after-query <qs>   extra query params for the change only, e.g. "maslibs=my-mas-branch"
  --milo-pr <n> / --mas-pr <n>
                       Override only the files changed by that adobecom/milo or adobecom/mas PR (head commit)
                       on the live page, and the same files from the PR's stage (milo) / main (mas) for the baseline: milo libs/** -> /libs/**, mas web-components/dist/** -> /mas/libs/**.
    perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487
                       Changed files are re-routed (invisibly to the page) to <branch>--<repo>--adobecom.aem.live, so they
                       go through Chrome's real Slow 4G throttle and share its bandwidth with the rest of the page.
  --pr-local           with --milo-pr/--mas-pr, fulfill the PR files from local copies (simulated throttle on a
                       separate pipe, no contention with live requests) instead of the aem.live re-route
  --override <pfx=dir> serve files from <dir> for requests whose path starts with <pfx>, change variant only (repeatable).
                       Missing local files fall through to the live site. With overrides, -b/-a are optional
                       (use them only for the host's own milolibs-style param). Example, Milo + MAS PR checkouts:
    perf-ab "https://www.adobe.com/" --override /libs=~/git/milo/libs \\
      --override /libs/deps/mas=~/git/mas/web-components/dist
  --override-before    same, for the baseline variant (e.g. a stage-branch checkout)
  --head-inject <file> insert the file's HTML into the page document of the change variant, right before the first
                       <script> in <head> (falls back to </head>). Both variants' documents are fetched and fulfilled
                       through the same simulated Slow 4G delay, so the A/B stays symmetric. Combine with --override
                       to serve files the snippet requests. Example:
    perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject snippet.html \\
      --override /lcp-manifests=./manifests
  --device <name>      Playwright device (default "iPhone 16 Pro Max", or any Playwright device name)
  --cpu <rate>         CPU throttle (default 4)
  --channel <name>     browser channel (default chrome; use "" for bundled chromium)
  --headless           run headless (stage.adobe.com rejects headless browsers)
  --settle <ms>        max wait after load for LCP to settle (default 12000)
  --lcp-wait <ms>      quiet time required after the last LCP candidate (default 5000)`);
  process.exit(positionals[0] ? 0 : 1);
}

const RUNS = Number(o.runs);
const OUT = path.resolve(o.out);
const PAGE = positionals[0];
const VARIANTS = { before: o.before, after: o.after };
const expand = (d) => path.resolve(d.replace(/^~(?=\/|$)/, process.env.HOME));
const parseMaps = (list) => list.map((x) => {
  const i = x.indexOf('=');
  if (i < 1) { console.error(`Bad --override "${x}", expected <pathPrefix>=<dir>`); process.exit(1); }
  return { prefix: x.slice(0, i), dir: expand(x.slice(i + 1)) };
}).sort((a, b) => b.prefix.length - a.prefix.length);
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const REWRITES = { before: new Map(), after: new Map() };
const aemHost = (ref, repo) => `${ref.toLowerCase().replace(/[^a-z0-9-]/g, '-')}--${repo.split('/')[1]}--${repo.split('/')[0]}.aem.live`;
function fetchPrDelta(repo, num, root, rules) {
  const { headRefOid, headRefName, headRepositoryOwner } = JSON.parse(gh(['pr', 'view', num, '-R', repo, '--json', 'headRefOid,headRefName,headRepositoryOwner']));
  const baseRefName = repo.endsWith('/milo') ? 'stage' : 'main';
  // Cumulative delta vs the base branch (not the PR's own base), so stacked and already-merged PRs include their parents' changes.
  const files = gh(['api', `repos/${repo}/compare/${baseRefName}...${headRefOid}`, '--paginate', '--jq', '.files[]']).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!o['pr-local'] && headRepositoryOwner.login === repo.split('/')[0]) {
    const hosts = { after: aemHost(headRefName, repo), before: aemHost(baseRefName, repo) };
    const kept = [];
    for (const f of files) {
      const rule = rules.find((r) => f.filename.startsWith(r.from));
      if (!rule) continue;
      const pathname = `${rule.to}/${f.filename.slice(rule.from.length)}`;
      kept.push(`${f.status === 'removed' ? '(removed, live in after) ' : ''}${f.status === 'added' ? '(added, live in before) ' : ''}${pathname}`);
      if (f.status !== 'removed') REWRITES.after.set(pathname, `https://${hosts.after}/${f.filename}`);
      if (f.status !== 'added') REWRITES.before.set(pathname, `https://${hosts.before}/${f.previous_filename ?? f.filename}`);
    }
    console.log(`${repo}#${num}: after=${hosts.after} (head @${headRefOid.slice(0, 7)}; aem.live serves the latest push), before=${hosts.before} (${kept.length} files)\n  ${kept.join('\n  ') || '(none)'}`);
    if (!kept.length) console.warn(`WARNING: ${repo}#${num} yielded no overridable files (no matching paths in the diff vs the base branch); that side serves live.`);
    return null;
  }
  const dirs = {};
  const kept = [];
  // "after" gets the PR head version of each changed file; "before" (control) gets the same files from the base branch.
  for (const [variant, ref] of [['after', headRefOid], ['before', baseRefName]]) {
    dirs[variant] = path.join(root, variant, repo.split('/')[1]);
    for (const f of files) {
      const rule = rules.find((r) => f.filename.startsWith(r.from));
      if (!rule) continue;
      const rel = f.filename.slice(rule.from.length);
      const dest = path.join(dirs[variant], rel);
      if (variant === 'after') kept.push(`${f.status === 'removed' ? '(removed, skipped) ' : ''}${rule.to}/${rel}`);
      if (variant === 'after' && f.status === 'removed') continue;
      const src = f.status === 'added' && variant === 'before' ? null : f.previous_filename && variant === 'before' ? f.previous_filename : f.filename;
      if (!src) continue; // new file: absent on the base branch, so the control serves live
      try {
        const buf = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${src}?ref=${ref}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
      } catch { /* missing at ref: fall through to live */ }
    }
  }
  console.log(`${repo}#${num}: after=@${headRefOid.slice(0, 7)}, before=${baseRefName} (same ${kept.length} files)\n  ${kept.join('\n  ') || '(none)'}`);
  if (!kept.length) console.warn(`WARNING: ${repo}#${num} yielded no overridable files (no matching paths in the diff vs the base branch); that side serves live.`);
  return dirs;
}
const HEAD_SNIPPET = o['head-inject'] ? fs.readFileSync(expand(o['head-inject']), 'utf8') : null;
function injectIntoHead(html) {
  const headStart = html.search(/<head[\s>]/i);
  const headEnd = html.search(/<\/head>/i);
  if (headStart < 0 || headEnd < 0) return null;
  const rel = html.slice(headStart, headEnd).search(/<script[\s>]/i);
  const at = rel >= 0 ? headStart + rel : headEnd;
  return { html: `${html.slice(0, at)}${HEAD_SNIPPET}\n${html.slice(at)}`, at, beforeScript: rel >= 0 };
}
const prRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-pr-'));
const addPr = (repo, num, rules, prefix) => {
  const dirs = fetchPrDelta(repo, num, prRoot, rules);
  if (!dirs) return;
  o.override.push(`${prefix}=${dirs.after}`);
  o['override-before'].push(`${prefix}=${dirs.before}`);
};
if (o['milo-pr']) addPr('adobecom/milo', o['milo-pr'], [{ from: 'libs/', to: '/libs' }], '/libs');
if (o['mas-pr']) addPr('adobecom/mas', o['mas-pr'], [{ from: 'web-components/dist/', to: '/mas/libs' }], '/mas/libs');
const MAPS = { before: parseMaps(o['override-before']), after: parseMaps(o.override) };
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.html': 'text/html', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

function localFile(maps, pathname) {
  for (const m of maps) {
    if (pathname !== m.prefix && !pathname.startsWith(`${m.prefix}/`)) continue;
    const f = path.join(m.dir, pathname.slice(m.prefix.length));
    if (f.startsWith(m.dir) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

// Local overrides are fulfilled in-page (same origin, so no CORS/origin changes). Network emulation does not
// apply to fulfilled responses, so the Slow 4G cost is simulated: one RTT plus brotli-sized transfer on a
// 180 KB/s pipe shared by the overridden files only (live requests use Chrome's own throttle, so the two
// do not compete for bandwidth). Both variants use this path, so the A/B stays symmetric.
const served = { before: new Set(), after: new Set() };
const sizeCache = new Map();
const wireSize = (f, buf) => {
  if (!sizeCache.has(f)) sizeCache.set(f, zlib.brotliCompressSync(buf).length);
  return sizeCache.get(f);
};

// Matches Chrome DevTools device mode; Playwright has no iPhone 16 profile.
const DEVICES = {
  'iPhone 16 Pro Max': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 440, height: 956 },
    screen: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};
const device = DEVICES[o.device] ?? devices[o.device];
if (!device) { console.error(`Unknown device "${o.device}"`); process.exit(1); }

const NET = { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }; // DevTools "Slow 4G"
const CATS = ['-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'v8', 'blink.user_timing', 'loading', 'latencyInfo', 'disabled-by-default-v8.compile'];

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function variantUrl(name) {
  const u = new URL(PAGE);
  if (VARIANTS[name]) u.searchParams.set(o.param, `${VARIANTS[name]}${o.suffix}`);
  const extra = name === 'before' ? o['before-query'] : o['after-query'];
  new URLSearchParams(extra).forEach((v, k) => u.searchParams.set(k, v));
  return u.toString();
}

function analyze(events) {
  const nav = events.find((e) => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL?.startsWith('http'));
  if (!nav) return null;
  const { ts: t0, pid } = nav;
  const frame = nav.args.frame;
  const last = (n) => {
    const x = events.filter((e) => e.name === n && e.ts >= t0 && e.args?.frame === frame).pop();
    return x ? Math.round((x.ts - t0) / 1000) : null;
  };
  const tid = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && e.pid === pid)?.tid;
  const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && e.ts >= t0);
  const fcpEv = events.find((e) => e.name === 'firstContentfulPaint' && e.pid === pid && e.ts >= t0);
  const tbt = main.filter((e) => e.name === 'RunTask' && e.dur > 50e3 && fcpEv && e.ts >= fcpEv.ts).reduce((s, e) => s + e.dur / 1000 - 50, 0);
  const compileModule = main.filter((e) => e.name === 'v8.compileModule').reduce((s, e) => s + e.dur / 1000, 0);
  const cls = events.filter((e) => e.name === 'LayoutShift' && e.ts >= t0 && !e.args.data.had_recent_input && e.args.data.is_main_frame)
    .reduce((s, e) => s + e.args.data.weighted_score_delta, 0);
  const reqs = new Map();
  events.filter((e) => e.name === 'ResourceSendRequest' && e.ts >= t0).forEach((e) => reqs.set(e.args.data.requestId, e.args.data));
  const scripts = [...reqs.values()].filter((r) => r.resourceType === 'Script');
  const topFrame = (r) => (r.stackTrace ?? r.initiator?.stack?.callFrames ?? [])[0];
  const viaLoadLink = scripts.filter((r) => topFrame(r)?.functionName === 'loadLink');
  const urls = scripts.map((r) => r.url);
  const fromCache = events.filter((e) => e.name === 'ResourceReceiveResponse' && e.ts >= t0 && (e.args.data.fromCache || e.args.data.fromServiceWorker)).length;
  return {
    FCP: last('firstContentfulPaint'),
    LCP: last('largestContentfulPaint::Candidate'),
    DCL: last('domContentLoadedEventEnd'),
    Load: last('loadEventEnd'),
    TBT: Math.round(tbt),
    CLS: +cls.toFixed(4),
    compileModule: Math.round(compileModule),
    requests: reqs.size,
    loadLinkModule: viaLoadLink.filter((r) => r.initiator.fetchType === 'script').length,
    loadLinkPreload: viaLoadLink.filter((r) => r.initiator.fetchType === 'link').length,
    dupScripts: urls.length - new Set(urls).size,
    fromCache,
  };
}

async function run(browser, name, i, attempt) {
  const ctx = await browser.newContext({ ...device, bypassCSP: true });
  const maps = MAPS[name];
  const rewrites = REWRITES[name];
  if (maps.length || rewrites.size || HEAD_SNIPPET) {
    let pipeFree = 0;
    // Same simulated Slow 4G cost for any response fulfilled in-page: RTT, then a transfer queued on a shared pipe.
    const simulate = async (started, wireBytes) => {
      const now = Date.now();
      pipeFree = Math.max(pipeFree, started + NET.latency) + (wireBytes / NET.downloadThroughput) * 1000;
      if (pipeFree > now) await new Promise((r) => setTimeout(r, pipeFree - now));
    };
    await ctx.route(/^https?:\/\//, async (route) => {
      const req = route.request();
      if (HEAD_SNIPPET && req.resourceType() === 'document' && !req.frame().parentFrame()) {
        const started = Date.now();
        const response = await route.fetch();
        const ctype = response.headers()['content-type'] ?? '';
        if (!ctype.includes('text/html')) return route.fulfill({ response });
        let body = await response.text();
        if (name === 'after') {
          const injected = injectIntoHead(body);
          if (injected) {
            body = injected.html;
            if (i === 1) console.log(`head snippet injected at char ${injected.at} (${injected.beforeScript ? 'before first <script>' : 'before </head>, no <script> in head'})`);
          } else console.warn('WARNING: no <head>...</head> found, snippet not injected');
        }
        await simulate(started, zlib.brotliCompressSync(body).length);
        const headers = { ...response.headers() };
        delete headers['content-encoding'];
        delete headers['content-length'];
        return route.fulfill({ status: response.status(), headers, body });
      }
      const u = new URL(req.url());
      const target = rewrites.get(decodeURI(u.pathname));
      if (target) {
        served[name].add(`${u.host}${u.pathname}`);
        return route.continue({ url: `${target}${u.search}` });
      }
      const f = localFile(maps, decodeURI(u.pathname));
      if (!f) return route.continue();
      const body = fs.readFileSync(f);
      await simulate(Date.now(), wireSize(f, body));
      served[name].add(`${u.host}${u.pathname}`);
      return route.fulfill({ status: 200, body, headers: { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    });
  }
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    new PerformanceObserver((list) => {
      window.__lcpSeenAt = performance.now();
      const el = list.getEntries().at(-1)?.element;
      if (el) window.__lcpEl = `${el.tagName}${el.closest('merch-card') ? ' in merch-card' : ''}`;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  if (process.env.PERF_AB_DEBUG) {
    page.on('console', (m) => console.log(`[${name}] console:`, m.text().slice(0, 300)));
    page.on('requestfailed', (r) => console.log(`[${name}] failed:`, r.url().slice(0, 140), r.failure()?.errorText));
    page.on('response', (r) => console.log(`[${name}]`, r.status(), r.url().slice(0, 140)));
  }
  await page.bringToFront();
  const cdp = await ctx.newCDPSession(page);
  const { width, height } = device.viewport;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: device.deviceScaleFactor, mobile: true, screenWidth: width, screenHeight: height,
  });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: device.userAgent });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(o.cpu) });
  const chunks = [];
  cdp.on('Tracing.dataCollected', (d) => chunks.push(...d.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: CATS }, transferMode: 'ReportEvents' });
  let err;
  await page.goto(variantUrl(name), { waitUntil: 'load', timeout: 120000 }).catch((e) => { err = e.message.split('\n')[0]; });
  // Stop --lcp-wait ms after the last LCP candidate (and not before load); --settle is the ceiling.
  await page.waitForFunction((wait) => {
    return window.__lcpSeenAt !== undefined && performance.now() - window.__lcpSeenAt >= wait;
  }, Number(o['lcp-wait']), { timeout: Number(o.settle), polling: 100 }).catch(() => {});
  if (i === 1) {
    const emu = await page.evaluate(() => ({
      innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, ua: navigator.userAgent.slice(0, 60),
    }));
    console.log(`emulation check (${name}):`, JSON.stringify(emu));
  }
  const lcpEl = await page.evaluate(() => window.__lcpEl ?? null).catch(() => null);
  if (process.env.PERF_AB_SHOT) await page.screenshot({ path: `${process.env.PERF_AB_SHOT}-${name}${i}.png`, fullPage: false }).catch(() => {});
  await cdp.send('Tracing.end');
  await done;
  await ctx.close();
  fs.mkdirSync(OUT, { recursive: true });
  const perfAb = { variant: name, run: i, attempt, browserPid: browserPids.get(browser) ?? null, coldBrowser: true, warmup: false };
  fs.writeFileSync(path.join(OUT, `${name}${i}.json`), JSON.stringify({ traceEvents: chunks, metadata: { perfAb } }));
  if (err) throw new Error(`${name} run ${i}: ${err}`);
  return { ...analyze(chunks), lcpEl };
}

const browserPids = new WeakMap();
async function launch() {
  const browser = await chromium.launch({
    headless: o.headless,
    ...(o.channel ? { channel: o.channel } : {}),
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    browserPids.set(browser, processInfo.find((p) => p.type === 'browser')?.id ?? null);
    await cdp.detach();
  } catch { /* the PID is informational only */ }
  return browser;
}
const NAMES = single ? ['after'] : ['before', 'after'];
let results;
try {
  results = await measureCold({
    names: NAMES,
    runs: RUNS,
    launch,
    measure: run,
    onRetry: (n, i, t, e) => console.warn(`retry ${n} ${i} (attempt ${t + 1}, fresh browser): ${e.message}`),
    onResult: (n, i, r) => console.log(n, i, JSON.stringify(r)),
  });
} finally {
  fs.rmSync(prRoot, { recursive: true, force: true });
}

const keys = ['FCP', 'LCP', 'DCL', 'Load', 'TBT', 'CLS', 'compileModule', 'requests', 'loadLinkModule', 'loadLinkPreload', 'dupScripts', 'fromCache'];
console.log(`\nMedians over ${RUNS} cold runs (${o.device}, ${o.cpu}x CPU, Slow 4G, fresh browser per run, no warm-up)`);
if (single) {
  console.log('metric'.padEnd(16), 'median'.padStart(8));
  for (const k of keys) console.log(k.padEnd(16), String(median(results.after.map((r) => r?.[k]).filter((v) => v != null))).padStart(8));
  console.log(`\nTraces saved to ${OUT}`);
  process.exit(0);
}
console.log('metric'.padEnd(16), 'before'.padStart(8), 'after'.padStart(8), 'delta'.padStart(8));
for (const k of keys) {
  const b = median(results.before.map((r) => r?.[k]).filter((v) => v != null));
  const a = median(results.after.map((r) => r?.[k]).filter((v) => v != null));
  console.log(k.padEnd(16), String(b).padStart(8), String(a).padStart(8), (a - b).toFixed(k === 'CLS' ? 4 : 0).padStart(8));
}
for (const n of ['before', 'after']) {
  if (served[n].size) console.log(`${n}: ${served[n].size} overridden files served, e.g. ${[...served[n]].slice(0, 3).join(', ')}`);
  for (const [a, b] of [["before", "after"], ["after", "before"]]) { const only = [...served[a]].filter((x) => !served[b].has(x)); if (only.length) console.log(`  requested only in ${a} (override exists in both): ${only.join(", ")}`); }
}
console.log(`\nTraces saved to ${OUT} (load in DevTools Performance panel)`);
