#!/usr/bin/env node
// perf-ab measurement job. Runs on the GitHub Actions runner dispatched by the perf-ab CLI (see
// .github/workflows/perf-ab.yml). Verifies US egress before touching the page, then runs real Lighthouse 13.6.0
// with the PageSpeed mobile (lr-mobile) profile, alternating cold runs: every attempt gets a fresh Chrome
// process, an empty temporary profile and a fresh proxy; no warm-ups. Invalid runs are kept as rejected
// diagnostics and retried fresh. Writes official Lighthouse reports, traces and results.json to --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer-core';
import { measureCold } from '../cold-runs.mjs';
import { decodeSpec, validateSpec, REQUEST_ID } from './spec.mjs';
import { assertPublicHost, publicOnlyLookup, mainFrameDocumentUrls, assertMainFrameTargets } from '../target.mjs';
import { lighthouseConfig, verifyProfile, LIGHTHOUSE_VERSION } from './profile.mjs';
import { verifyUsEgress, documentGeo } from './egress.mjs';
import { startProxy } from './proxy.mjs';
import { injectIntoHead, prioritizeSnippet, prioritizeLinkHeader, applyPatches, resolveContextualHints, countLinks } from './transforms.mjs';

const fatal = (m, extra = {}) => Object.assign(new Error(m), { fatal: true }, extra);
const reject = (m) => Object.assign(new Error(m), { rejected: true });
const TEXT_SOURCE = /\.(?:m?js|css|json|html|svg|txt)$/i;
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
export const METRICS = {
  performance: (lhr) => (lhr.categories?.performance?.score == null ? null : Math.round(lhr.categories.performance.score * 100)),
  FCP: (lhr) => lhr.audits['first-contentful-paint']?.numericValue ?? null,
  LCP: (lhr) => lhr.audits['largest-contentful-paint']?.numericValue ?? null,
  SI: (lhr) => lhr.audits['speed-index']?.numericValue ?? null,
  TBT: (lhr) => lhr.audits['total-blocking-time']?.numericValue ?? null,
  CLS: (lhr) => lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
};
const METRIC_AUDIT = { FCP: 'first-contentful-paint', LCP: 'largest-contentful-paint', SI: 'speed-index', TBT: 'total-blocking-time', CLS: 'cumulative-layout-shift' };
// Every metric must be a finite number for a run to be accepted: Lighthouse can finish without a runtimeError while an
// individual audit (or the performance score) errors, and a partial run must never feed the medians.
export function extractMetrics(lhr) {
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, f(lhr)]));
  const missing = Object.keys(metrics).filter((k) => !Number.isFinite(metrics[k]));
  if (missing.length) {
    const why = missing.map((k) => {
      const a = k === 'performance' ? null : lhr.audits?.[METRIC_AUDIT[k]];
      return a?.errorMessage ? `${k} (${a.errorMessage})` : k;
    });
    throw Object.assign(reject(`Lighthouse metric(s) missing or not finite: ${why.join(', ')}`), { metrics });
  }
  return metrics;
}
export const median = (xs) => {
  if (xs.some((x) => !Number.isFinite(x))) throw new Error(`median over a non-finite value: ${JSON.stringify(xs)}`);
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Throwaway certificate for the measured host, created outside the artifact directory and removed afterwards.
export function makeCert(host, outDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-cert-'));
  if (outDir && !path.relative(path.resolve(outDir), dir).startsWith('..')) throw fatal('certificate directory must not be inside the output directory');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=DNS:${host}`, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  return { dir, key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function firstDocumentResponse(devtoolsLog, url) {
  const responses = devtoolsLog.filter((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document');
  return (responses.find((e) => e.params.response.url === url) ?? responses[0])?.params.response ?? null;
}

async function renderCheck(page, expect = {}) {
  return page.evaluate(({ title, counts }) => {
    const body = document.body;
    const cs = body && getComputedStyle(body);
    const counted = Object.fromEntries((counts ?? []).map((c) => [c.selector, document.querySelectorAll(c.selector).length]));
    return {
      title: document.title,
      titleOk: title == null || new RegExp(title).test(document.title),
      bodyVisible: !!body && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && body.children.length > 0,
      counts: counted,
      countsOk: (counts ?? []).every((c) => counted[c.selector] === c.count),
    };
  }, { title: expect.title ?? null, counts: expect.counts ?? [] });
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

export async function runJob({
  spec, requestId, out, attempts = 3, fetchJson, launchBrowser, upstreamOrigin, upstreamOptions, allowLocalTargets, dnsLookup,
  chromePath = process.env.CHROME_PATH, log = console.log, warn = console.warn,
}) {
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  const results = {
    schema: 'perf-ab/pagespeed-v1', requestId, status: 'running', mode: 'pagespeed-us', startedAt: new Date().toISOString(),
    github: { sha: process.env.GITHUB_SHA ?? null, runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, runner: process.env.RUNNER_NAME ?? null },
    cold: { freshBrowserPerAttempt: true, emptyProfilePerAttempt: true, warmups: 0, lighthouseStorageReset: true },
    lighthouseVersion: LIGHTHOUSE_VERSION, names: [], runsPerVariant: null, runs: [], rejected: [], egress: null, documentGeo: [], hints: null, edits: {},
  };
  const save = () => writeJson(path.join(out, 'results.json'), results);
  let cert;
  try {
    if (!REQUEST_ID.test(requestId ?? '')) throw fatal('invalid request id');
    validateSpec(spec);
    results.names = spec.names;
    results.runsPerVariant = spec.runs;
    results.url = spec.variants.after.url;
    results.variants = Object.fromEntries(spec.names.map((n) => [n, { url: spec.variants[n].url }]));

    // 1. Egress first: nothing is launched or requested from the measured site unless the egress is verified US.
    results.egress = await verifyUsEgress(fetchJson ? { fetchJson } : {});
    log(`egress verified US: ${results.egress.checks.map((c) => `${c.service}=${c.country ?? c.error}`).join(', ')}`);

    const host = new URL(spec.variants.after.url).host;
    // 2. The page host must resolve to public addresses only (re-checked by the proxy at every connect).
    if (!allowLocalTargets) results.target = { host, addresses: await assertPublicHost(host, dnsLookup ? { lookup: promisify(dnsLookup) } : {}) };
    cert = makeCert(host, out);
    const pagePath = (n) => new URL(spec.variants[n].url).pathname;
    const editedPaths = new Set(spec.names.flatMap((n) => [...(spec.variants[n].patches ?? []).map((p) => p.path), ...Object.keys(spec.variants[n].sources ?? {})]));
    let afterSnippet = spec.variants.after.headInject ?? null;
    const priorities = spec.variants.after.priorities ?? [];
    if (afterSnippet != null) results.hints = { requestedLinks: countLinks(afterSnippet) };
    results.edits = Object.fromEntries(spec.names.map((n) => [n, {
      headInject: spec.variants[n].headInject != null, priorities: spec.variants[n].priorities ?? [],
      patches: (spec.variants[n].patches ?? []).map((p) => p.path), sources: spec.variants[n].sources ?? {},
    }]));

    const transformFor = (name) => async ({ kind, path: reqPath, status, headers, body }) => {
      const v = spec.variants[name];
      const pathname = new URL(reqPath, 'https://x').pathname;
      if (kind === 'document') {
        let html = body;
        let outHeaders = headers;
        const snippet = name === 'after' ? afterSnippet : v.headInject;
        if (snippet) {
          const prioritized = name === 'after' && priorities.length ? prioritizeSnippet(snippet, priorities, v.url).html : snippet;
          const injected = injectIntoHead(html, prioritized);
          if (!injected) throw new Error('document has no <head> to inject into');
          html = injected.html;
        }
        if (name === 'after' && priorities.length && headers.link) outHeaders = { ...headers, link: prioritizeLinkHeader(headers.link, priorities, v.url).value };
        return { body: html, headers: outHeaders };
      }
      if (v.sources?.[pathname]) {
        if (!TEXT_SOURCE.test(pathname)) throw fatal(`source override ${pathname}: only text assets are supported`);
        const res = await fetch(v.sources[pathname]);
        if (!res.ok) throw fatal(`source override ${pathname}: ${v.sources[pathname]} returned HTTP ${res.status}`);
        const type = res.headers.get('content-type') ?? MIME[path.extname(pathname).toLowerCase()];
        return { status: 200, body: await res.text(), headers: { ...headers, 'content-type': type }, encoding: headers['content-encoding'] ?? 'br' };
      }
      const patches = (v.patches ?? []).filter((p) => p.path === pathname);
      if (patches.length) {
        if (status !== 200) throw fatal(`patch target ${pathname} returned HTTP ${status}`);
        return { body: applyPatches(body, patches, pathname), headers };
      }
      return { body, headers };
    };

    const launch = async () => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-profile-'));
      const state = { userDataDir, browser: null, proxy: null };
      state.start = async (name) => {
        state.proxy = await startProxy({
          host, key: cert.key, cert: cert.cert, upstreamOrigin, upstreamOptions, allowLocalTargets,
          ...(dnsLookup ? { lookup: publicOnlyLookup({ lookup: dnsLookup }) } : {}),
          select: (reqPath, h) => {
            const pathname = new URL(reqPath, 'https://x').pathname;
            if (h[':method'] === 'GET' && h['sec-fetch-dest'] === 'document' && pathname === pagePath(name)) return 'document';
            return h[':method'] === 'GET' && editedPaths.has(pathname) ? 'asset' : null;
          },
          transform: transformFor(name),
        });
        const opts = {
          headless: true, userDataDir, defaultViewport: null,
          args: [`--proxy-server=127.0.0.1:${state.proxy.port}`, `--ignore-certificate-errors-spki-list=${state.proxy.spki}`, '--proxy-bypass-list=<-loopback>',
            '--disable-background-networking', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--no-first-run', '--no-default-browser-check'],
          ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
        };
        state.browser = await (launchBrowser ?? ((o) => puppeteer.launch(o)))(opts);
        return state.browser;
      };
      state.close = async () => {
        const errors = [];
        await state.browser?.close().catch((e) => errors.push(`browser: ${e.message}`));
        await state.proxy?.close().catch((e) => errors.push(`proxy: ${e.message}`));
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { errors.push(`profile: ${e.message}`); }
        if (errors.length) throw new Error(errors.join('; '));
      };
      return state;
    };

    const measure = async (state, name, i, attempt) => {
      const v = spec.variants[name];
      const browser = await state.start(name);
      const chromeVersion = await browser.version();
      results.chromeVersion ??= chromeVersion;
      const page = (await browser.pages())[0] ?? await browser.newPage();
      const runDir = path.join(out, `${name}${i}`);
      const saveRun = (dir, rr, meta) => {
        fs.mkdirSync(dir, { recursive: true });
        if (rr?.report) {
          const [html, json] = rr.report;
          fs.writeFileSync(path.join(dir, 'report.html'), html);
          fs.writeFileSync(path.join(dir, 'report.json'), json);
        }
        if (rr?.artifacts?.Trace) writeJson(path.join(dir, 'trace.json'), rr.artifacts.Trace);
        if (rr?.artifacts?.DevtoolsLog) writeJson(path.join(dir, 'devtoolslog.json'), rr.artifacts.DevtoolsLog);
        writeJson(path.join(dir, 'run.json'), meta);
      };
      let rr;
      const meta = { variant: name, run: i, attempt, url: v.url, chromeVersion, freshBrowser: true, emptyProfile: true, warmup: false };
      try {
        rr = await lighthouse(v.url, { logLevel: 'error' }, lighthouseConfig(), page);
        if (!rr?.lhr) throw reject('Lighthouse returned no result');
        meta.profile = verifyProfile(rr.lhr);
        results.profile ??= meta.profile;
        // Every main-frame URL (navigation, redirect hops, final URL) must stay a *.adobe.com https target.
        const pageUrl = page.url();
        meta.mainFrameUrls = [...new Set([rr.lhr.requestedUrl, ...mainFrameDocumentUrls(rr.artifacts?.DevtoolsLog ?? []), rr.lhr.mainDocumentUrl, rr.lhr.finalDisplayedUrl, pageUrl === 'about:blank' ? null : pageUrl].filter(Boolean))];
        try { assertMainFrameTargets(meta.mainFrameUrls); } catch (e) { throw fatal(e.message); }
        if (state.proxy.errors.fatal) throw state.proxy.errors.fatal;
        if (rr.lhr.runtimeError) throw reject(`Lighthouse runtime error ${rr.lhr.runtimeError.code}: ${rr.lhr.runtimeError.message}`);
        try {
          meta.metrics = extractMetrics(rr.lhr);
        } catch (e) {
          meta.metrics = e.metrics;
          throw e;
        }
        const render = await renderCheck(page, spec.expect);
        meta.render = render;
        if (!render.bodyVisible || !render.titleOk || !render.countsOk) throw reject(`render check failed: ${JSON.stringify(render)}`);

        const docs = state.proxy.requests.filter((r) => r.kind === 'document');
        if (!docs.length) throw reject('the proxy saw no document request for the page');
        if (docs.some((d) => d.alpn !== 'h2')) throw fatal(`page document was not served over HTTP/2 (${docs.map((d) => d.alpn).join(',')})`);
        const geo = documentGeo(docs[0].upstreamHeaders);
        meta.documentGeo = geo;
        if (geo.status === 'non-US') throw fatal(`the measured site reports a non-US visitor: ${JSON.stringify(geo.headers)}`);
        const dlog = rr.artifacts.DevtoolsLog ?? [];
        const docResponse = firstDocumentResponse(dlog, rr.lhr.finalDisplayedUrl);
        meta.firstResponse = docResponse && {
          url: docResponse.url, status: docResponse.status, protocol: docResponse.protocol,
          fromDiskCache: !!docResponse.fromDiskCache, fromServiceWorker: !!docResponse.fromServiceWorker, fromPrefetchCache: !!docResponse.fromPrefetchCache,
          encodedDataLength: docResponse.encodedDataLength,
        };
        meta.requestsServedFromCache = dlog.filter((e) => e.method === 'Network.requestServedFromCache').length;
        if (!docResponse) throw reject('no document response in the DevTools log');
        if (meta.firstResponse.fromDiskCache || meta.firstResponse.fromServiceWorker || meta.firstResponse.fromPrefetchCache) throw reject(`first document response was not cold: ${JSON.stringify(meta.firstResponse)}`);
        if (docResponse.protocol !== 'h2') throw fatal(`first document response protocol ${docResponse.protocol}, expected h2`);

        const edited = state.proxy.requests.filter((r) => r.edited).map((r) => new URL(r.path, 'https://x').pathname);
        meta.editedResponses = edited;
        const e = results.edits[name];
        const expected = [...((e.headInject || (name === 'after' && e.priorities.length)) ? [pagePath(name)] : []), ...e.patches];
        const missing = expected.filter((p) => !edited.includes(p));
        if (missing.length) throw reject(`${name} edits not applied to: ${missing.join(', ')}`);
        // A source override may be byte-identical to production (e.g. an unchanged base-branch file): it only has to
        // have been served through the override without error.
        const sourceHits = Object.keys(e.sources).filter((p) => state.proxy.requests.some((r) => r.kind === 'asset' && !r.error && new URL(r.path, 'https://x').pathname === p));
        meta.sourcesServed = sourceHits;
        const unexpected = edited.filter((p) => !expected.includes(p) && !(p in e.sources));
        if (unexpected.length) throw fatal(`${name} served unexpected edits: ${unexpected.join(', ')}`);
        if (state.proxy.errors.length) warn(`${name}${i}: proxy notes: ${state.proxy.errors.slice(0, 5).join(' | ')}`);
        meta.proxyNotes = state.proxy.errors.slice(0, 20);
        meta.requests = state.proxy.requests.map(({ upstreamHeaders, ...r }) => r);

        // US context for the change: re-resolve country/locale-specific hints once, against the first accepted
        // baseline run's own requests (this page, this egress), before the first change run.
        if (name === 'before' && results.hints && !results.hints.resolved) {
          const observed = (rr.lhr.audits['network-requests']?.details?.items ?? []).map((x) => x.url);
          const { html, report } = resolveContextualHints(afterSnippet, spec.variants.after.url, observed);
          afterSnippet = html;
          Object.assign(results.hints, { resolved: true, resolvedFrom: `before${i}`, usedLinks: report.kept, contextual: report.contextual, dropped: report.dropped });
          log(`hints: ${report.kept}/${report.links} kept, ${report.contextual.length} resolved to this context, ${report.dropped.length} dropped`);
        }
        saveRun(runDir, rr, { ...meta, accepted: true });
        results.runs.push({ variant: name, run: i, attempt, dir: path.relative(out, runDir), metrics: meta.metrics, firstResponse: meta.firstResponse, render: meta.render });
        return meta.metrics;
      } catch (err) {
        const dir = path.join(out, 'rejected', `${name}${i}-attempt${attempt}`);
        saveRun(dir, rr, { ...meta, accepted: false, reason: err.message, fatal: !!err.fatal, proxyNotes: state.proxy?.errors.slice(0, 20) ?? [] });
        results.rejected.push({ variant: name, run: i, attempt, reason: err.message, fatal: !!err.fatal, dir: path.relative(out, dir) });
        save();
        throw err;
      }
    };

    await measureCold({
      names: spec.names, runs: spec.runs, attempts, launch,
      measure,
      onRetry: (n, i, t, e) => warn(`rejected ${n}${i} attempt ${t}: ${e.message}; retrying with a fresh browser and profile`),
      onResult: (n, i, m) => log(`${n}${i} ${JSON.stringify(m)}`),
    });

    for (const n of spec.names) {
      const accepted = results.runs.filter((r) => r.variant === n);
      if (accepted.length !== spec.runs) throw new Error(`${n}: ${accepted.length} accepted run(s), expected ${spec.runs}`);
    }
    results.medians = Object.fromEntries(spec.names.map((n) => [n, Object.fromEntries(Object.keys(METRICS).map((k) => [k, median(results.runs.filter((r) => r.variant === n).map((r) => r.metrics[k]))]))]));
    if (spec.names.includes('before')) results.medians.delta = Object.fromEntries(Object.keys(METRICS).map((k) => [k, results.medians.after[k] == null || results.medians.before[k] == null ? null : results.medians.after[k] - results.medians.before[k]]));
    results.status = 'ok';
  } catch (e) {
    results.status = 'failed';
    results.error = e.message;
    results.errorKind = e.fatal ? 'fatal' : e.rejected ? 'rejected-after-retries' : 'infrastructure';
    if (e.egress) results.egress = e.egress;
  } finally {
    cert?.cleanup();
    results.finishedAt = new Date().toISOString();
    save();
  }
  const leaked = scanForKeys(out);
  if (leaked.length) {
    for (const f of leaked) fs.rmSync(f, { force: true });
    results.status = 'failed';
    results.error = `private key material found in output (${leaked.length} files removed)`;
    save();
  }
  return results;
}

export function scanForKeys(dir) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (/PRIVATE KEY-----/.test(fs.readFileSync(file, 'latin1'))) hits.push(file);
  }
  return hits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) { console.error('usage: SPEC=<encoded> REQUEST_ID=<id> node lib/pagespeed/job.mjs --out <dir>'); process.exit(2); }
  let results;
  try {
    results = await runJob({ spec: decodeSpec(process.env.SPEC), requestId: process.env.REQUEST_ID, out: values.out });
  } catch (e) {
    fs.mkdirSync(values.out, { recursive: true });
    fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify({ schema: 'perf-ab/pagespeed-v1', requestId: process.env.REQUEST_ID ?? null, status: 'failed', error: e.message, errorKind: 'fatal' }));
    console.error(`perf-ab job failed: ${e.message}`);
    process.exit(1);
  }
  if (results.status !== 'ok') { console.error(`perf-ab job failed (${results.errorKind}): ${results.error}`); process.exit(1); }
  console.log(JSON.stringify(results.medians));
}
