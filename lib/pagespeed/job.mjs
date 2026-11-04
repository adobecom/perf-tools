#!/usr/bin/env node
// perf-ab measurement job. Runs on the GitHub Actions runner dispatched by the perf-ab CLI (see
// .github/workflows/perf-ab.yml or perf-ab --local). Checks egress before touching the page, then runs Lighthouse 13.6.0
// with the mobile DevTools-throttled profile (lib/pagespeed/profile.mjs), alternating cold runs: every attempt gets a fresh Chrome
// process, an empty temporary profile and a fresh proxy; no warm-ups. Invalid runs are kept as rejected
// diagnostics and retried fresh. Writes official Lighthouse reports, traces and results.json to --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer-core';
import { measureCold } from '../cold-runs.mjs';
import { median, metricDelta, pairStats } from './stats.mjs';
import { decodeSpec, validateSpec, REQUEST_ID } from './spec.mjs';
import { assertPublicHost, publicOnlyLookup, mainFrameDocumentUrls, assertMainFrameTargets } from '../target.mjs';
import { lighthouseConfig, verifyProfile, LIGHTHOUSE_VERSION } from './profile.mjs';
import { RENDER_ARTIFACT, assessRender, renderOk } from './render-guard.mjs';
import { verifyUsEgress, documentGeo } from './egress.mjs';
import { requireChromePath } from './chrome.mjs';
import { startProxy } from './proxy.mjs';
import { injectIntoHead, prioritizeSnippet, prioritizeLinkHeader, stripPreloadLinks, applyPatches, resolveContextualHints, countLinks } from './transforms.mjs';
import { checkoutPrSources } from './pr-sources.mjs';

const fatal = (m, extra = {}) => Object.assign(new Error(m), { fatal: true }, extra);
const reject = (m) => Object.assign(new Error(m), { rejected: true });
const TEXT_SOURCE = /\.(?:m?js|css|json|html|svg|txt)$/i;
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm',
};
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
export { median };

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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

export async function runJob({
  spec, requestId, out, pair = null, attempts = 3, fetchJson, launchBrowser, upstreamOrigin, upstreamOptions, allowLocalTargets, dnsLookup,
  chromePath = process.env.CHROME_PATH, where = 'actions', log = console.log, warn = console.warn, checkoutSources = checkoutPrSources,
}) {
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  const results = {
    schema: 'perf-ab/pagespeed-v1', requestId, status: 'running', mode: where === 'local' ? 'pagespeed-local' : 'pagespeed-us', where, startedAt: new Date().toISOString(),
    github: { sha: process.env.GITHUB_SHA ?? null, runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, runner: process.env.RUNNER_NAME ?? null, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || null, os: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length },
    cold: { freshBrowserPerAttempt: true, emptyProfilePerAttempt: true, warmups: 0, lighthouseStorageReset: true },
    lighthouseVersion: LIGHTHOUSE_VERSION, names: [], runsPerVariant: null, runs: [], rejected: [], egress: null, documentGeo: [], hints: null, edits: {},
    sourcePrs: [], sourceDrift: [], warnings: [],
  };
  const save = () => writeJson(path.join(out, 'results.json'), results);
  let cert;
  let prCheckout = null;
  const productionSources = new Map();
  try {
    if (!REQUEST_ID.test(requestId ?? '')) throw fatal('invalid request id');
    if (!['actions', 'local'].includes(where)) throw fatal(`invalid measurement location ${where}`);
    validateSpec(spec);
    const executablePath = launchBrowser ? chromePath : requireChromePath({ preferred: chromePath });
    results.names = spec.names;
    results.runsPerVariant = spec.runs;
    // Paired matrix mode: this machine measures exactly one cold before/after pair (run index = pair).
    if (pair != null) {
      if (!Number.isInteger(pair) || pair < 1 || pair > spec.runs) throw fatal(`invalid pair ${pair} for ${spec.runs} run(s)`);
      results.pair = pair;
    }
    results.url = spec.variants.after.url;
    results.experiment = spec.meta ?? null;
    results.variants = Object.fromEntries(spec.names.map((n) => [n, { url: spec.variants[n].url }]));
    results.sourcePrs = spec.variants.after.sourcePrs ?? [];

    // 1. Probe egress before touching the measured site. Actions is fail-closed; local may use a known non-US egress.
    results.egress = await verifyUsEgress({ ...(fetchJson ? { fetchJson } : {}), allowNonUs: where === 'local' });
    results.egress.where = where;
    if (where === 'local') {
      if (!results.egress.ok) {
        results.warnings.push({
          kind: 'local-non-us-egress',
          message: `local measurement uses ${results.egress.country} egress, not verified-US Actions egress`,
          country: results.egress.country,
        });
      }
      log(`egress ${results.egress.country} (local; not an Actions run): ${results.egress.checks.map((c) => `${c.service}=${c.country ?? c.error}`).join(', ')}`);
    } else {
      log(`egress verified US: ${results.egress.checks.map((c) => `${c.service}=${c.country ?? c.error}`).join(', ')}`);
    }

    prCheckout = results.sourcePrs.length ? checkoutSources(spec.variants.after.localSources ?? {}) : null;
    const localSources = spec.variants.after.localSources ?? {};
    const host = new URL(spec.variants.after.url).host;
    // 2. The page host must resolve to public addresses only (re-checked by the proxy at every connect).
    if (!allowLocalTargets) results.target = { host, addresses: await assertPublicHost(host, dnsLookup ? { lookup: promisify(dnsLookup) } : {}) };
    cert = makeCert(host, out);
    const pagePath = (n) => new URL(spec.variants[n].url).pathname;
    const editedPaths = new Set(spec.names.flatMap((n) => [
      ...(spec.variants[n].patches ?? []).map((p) => p.path),
      ...Object.keys(spec.variants[n].sources ?? {}),
      ...(n === 'after' ? Object.keys(localSources) : []),
    ]));
    let afterSnippet = spec.variants.after.headInject ?? null;
    const priorities = spec.variants.after.priorities ?? [];
    // Link header preload entries removed from the last served after document (identical for every load).
    const strippedLinkEntries = [];
    if (afterSnippet != null) results.hints = { requestedLinks: countLinks(afterSnippet), linkHeaderStripped: 0, linkHeaderEntries: [] };
    results.edits = Object.fromEntries(spec.names.map((n) => [n, {
      headInject: spec.variants[n].headInject != null, priorities: spec.variants[n].priorities ?? [],
      patches: (spec.variants[n].patches ?? []).map((p) => p.path),
      sources: { ...Object.fromEntries(Object.keys(spec.variants[n].sources ?? {}).map((p) => [p, true])),
        ...(n === 'after' ? Object.fromEntries(Object.keys(localSources).map((p) => [p, true])) : {}) },
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
        // The injected snippet is the only source of preloads for the after document: the production Link header's
        // rel=preload / rel=modulepreload entries are unset (other Link entries stay). Before is never touched.
        if (name === 'after' && v.headInject != null) {
          const stripped = stripPreloadLinks(outHeaders.link);
          strippedLinkEntries.length = 0;
          strippedLinkEntries.push(...stripped.removed);
          outHeaders = { ...outHeaders };
          if (stripped.value) outHeaders.link = stripped.value; else delete outHeaders.link;
        }
        if (name === 'after' && priorities.length && outHeaders.link) outHeaders = { ...outHeaders, link: prioritizeLinkHeader(outHeaders.link, priorities, v.url).value };
        return { body: html, headers: outHeaders };
      }
      if (localSources[pathname]) {
        if (name === 'before') {
          productionSources.set(pathname, {
            status,
            sha256: status === 200 ? createHash('sha256').update(Buffer.from(body)).digest('hex') : null,
          });
          return { body, headers };
        }
        const source = prCheckout?.contents.get(pathname);
        if (!source) throw fatal(`local PR source ${pathname} was not materialized from its pinned commit`);
        if (source.deleted) {
          const outHeaders = { ...headers };
          delete outHeaders['content-encoding'];
          delete outHeaders['content-length'];
          return { status: 404, body: '', headers: outHeaders, encoding: null };
        }
        const type = MIME[path.extname(localSources[pathname].filePath).toLowerCase()] ?? 'application/octet-stream';
        return { status: 200, body: source.body, headers: { ...headers, 'content-type': type }, encoding: headers['content-encoding'] ?? 'br' };
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
            return h[':method'] === 'GET' && (editedPaths.has(pathname) || Object.hasOwn(localSources, pathname)) ? 'asset' : null;
          },
          transform: transformFor(name),
        });
        const opts = {
          headless: true, userDataDir, defaultViewport: null,
          args: [`--proxy-server=127.0.0.1:${state.proxy.port}`, `--ignore-certificate-errors-spki-list=${state.proxy.spki}`, '--proxy-bypass-list=<-loopback>',
            '--disable-background-networking', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--no-first-run', '--no-default-browser-check'],
          executablePath,
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
      const meta = {
        variant: name, run: i, attempt, url: v.url, chromeVersion, freshBrowser: true, emptyProfile: true, warmup: false,
        sourcePrs: results.sourcePrs, servedSources: [],
      };
      if (pair != null) meta.pair = pair;
      try {
        rr = await lighthouse(v.url, { logLevel: 'error' }, lighthouseConfig({ expect: spec.expect }), page);
        if (!rr?.lhr) throw reject('Lighthouse returned no result');
        meta.profile = verifyProfile(rr.lhr);
        meta.benchmarkIndex = rr.lhr.environment?.benchmarkIndex ?? null;
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
        // The render was read from the measured document inside Lighthouse's lifecycle (render-guard.mjs). The tab itself
        // is not inspected here: after lighthouse() returns it can hold the document of Lighthouse's bfcache test.
        const render = assessRender(rr.artifacts?.[RENDER_ARTIFACT], rr.artifacts?.DevtoolsLog, spec.expect);
        meta.render = render;
        if (!renderOk(render)) throw reject(`render check failed: ${JSON.stringify(render)}`);

        const docs = state.proxy.requests.filter((r) => r.kind === 'document');
        if (!docs.length) throw reject('the proxy saw no document request for the page');
        if (docs.some((d) => d.alpn !== 'h2')) throw fatal(`page document was not served over HTTP/2 (${docs.map((d) => d.alpn).join(',')})`);
        const geo = documentGeo(docs[0].upstreamHeaders);
        meta.documentGeo = geo;
        if (geo.status === 'non-US') {
          if (where === 'local') {
            if (!results.warnings.some((w) => w.kind === 'local-non-us-document')) results.warnings.push({
              kind: 'local-non-us-document',
              message: `the measured site reports local visitor geo ${geo.countries.join(', ')}`,
              countries: geo.countries,
            });
          } else {
            throw fatal(`the measured site reports a non-US visitor: ${JSON.stringify(geo.headers)}`);
          }
        }
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
        if (name === 'after') {
          meta.servedSources = sourceHits.filter((p) => localSources[p]).map((pathname) => {
            const source = localSources[pathname];
            const pr = results.sourcePrs.find((entry) => entry.repo === source.repo && entry.number === source.number);
            const local = prCheckout?.contents.get(pathname);
            return {
              path: pathname,
              repo: source.repo,
              number: source.number,
              baseSha: pr?.baseSha ?? null,
              headSha: source.headSha,
              mergeBaseSha: source.mergeBaseSha,
              status: source.deleted ? 'deleted' : 'served',
              blobSha: source.blobSha ?? null,
              sha256: local?.body ? createHash('sha256').update(local.body).digest('hex') : null,
            };
          });
        }
        const unexpected = edited.filter((p) => !expected.includes(p) && !(p in e.sources));
        if (unexpected.length) throw fatal(`${name} served unexpected edits: ${unexpected.join(', ')}`);
        if (state.proxy.errors.length) warn(`${name}${i}: proxy notes: ${state.proxy.errors.slice(0, 5).join(' | ')}`);
        meta.proxyNotes = state.proxy.errors.slice(0, 20);
        if (name === 'after' && results.hints) {
          meta.strippedLinkHeaderEntries = [...strippedLinkEntries];
          results.hints.linkHeaderStripped = strippedLinkEntries.length;
          results.hints.linkHeaderEntries = [...strippedLinkEntries];
        }
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
        results.runs.push({ variant: name, run: i, attempt, dir: path.relative(out, runDir), metrics: meta.metrics, firstResponse: meta.firstResponse, render: meta.render, benchmarkIndex: meta.benchmarkIndex });
        results.documentGeo.push({ variant: name, run: i, status: geo.status, countries: geo.countries });
        return meta.metrics;
      } catch (err) {
        const dir = path.join(out, 'rejected', `${name}${i}-attempt${attempt}`);
        saveRun(dir, rr, { ...meta, accepted: false, reason: err.message, fatal: !!err.fatal, proxyNotes: state.proxy?.errors.slice(0, 20) ?? [] });
        results.rejected.push({ variant: name, run: i, attempt, reason: err.message, fatal: !!err.fatal, dir: path.relative(out, dir) });
        save();
        throw err;
      }
    };

    const from = pair ?? 1;
    const lastRun = pair ?? spec.runs;
    await measureCold({
      names: spec.names, runs: lastRun, from, attempts, launch,
      measure,
      onRetry: (n, i, t, e) => warn(`rejected ${n}${i} attempt ${t}: ${e.message}; retrying with a fresh browser and profile`),
      onResult: (n, i, m) => log(`${n}${i} ${JSON.stringify(m)}`),
    });

    for (const n of spec.names) {
      const accepted = results.runs.filter((r) => r.variant === n);
      if (accepted.length !== lastRun - from + 1) throw new Error(`${n}: ${accepted.length} accepted run(s), expected ${lastRun - from + 1}`);
    }
    results.pairs = [];
    for (let i = from; i <= lastRun; i += 1) {
      const pick = (n) => results.runs.find((r) => r.variant === n && r.run === i)?.metrics ?? null;
      const before = spec.names.includes('before') ? pick('before') : null;
      const after = pick('after');
      results.pairs.push({ index: i, before, after, delta: before && after ? metricDelta(before, after) : null });
    }
    const stats = pairStats(results.pairs, spec.names);
    results.medians = stats.medians;
    results.samples = { requested: lastRun - from + 1, pairs: stats.complete, rejected: results.rejected.length };
    results.status = 'ok';
  } catch (e) {
    results.status = 'failed';
    results.error = e.message;
    results.errorKind = e.fatal ? 'fatal' : e.rejected ? 'rejected-after-retries' : 'infrastructure';
    if (e.egress) results.egress = e.egress;
  } finally {
    cert?.cleanup();
    if (spec?.variants?.after?.sourcePrs?.length) {
      const localSources = spec.variants.after.localSources ?? {};
      results.sourceDrift = [...Object.keys(localSources)].map((pathname) => {
        const expected = prCheckout?.baselineContentHashes.get(pathname) ?? null;
        const actual = productionSources.get(pathname);
        const checked = !!actual;
        const matches = checked && (expected == null ? actual.status === 404 : actual.status === 200 && actual.sha256 === expected);
        return {
          path: pathname,
          repo: localSources[pathname].repo,
          number: localSources[pathname].number,
          expectedMergeBaseSha256: expected,
          productionSha256: actual?.sha256 ?? null,
          productionStatus: actual?.status ?? null,
          status: !checked ? 'unverified' : matches ? 'matches-merge-base' : 'drift',
        };
      });
      for (const drift of results.sourceDrift.filter((d) => d.status !== 'matches-merge-base')) {
        results.warnings.push({
          kind: drift.status === 'drift' ? 'production-source-drift' : 'production-source-unverified',
          message: drift.status === 'drift'
            ? `production ${drift.path} differs from the PR merge-base source; the after variant still uses the pinned PR head`
            : `no baseline response for ${drift.path} was observed, so its merge-base drift could not be checked`,
          path: drift.path, repo: drift.repo, number: drift.number,
          expectedMergeBaseSha256: drift.expectedMergeBaseSha256, productionSha256: drift.productionSha256,
        });
      }
      if (results.warnings.length) for (const warning of results.warnings) warn(`WARNING (${warning.kind}): ${warning.message}`);
      prCheckout?.cleanup();
    }
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
  if (!values.out) { console.error('usage: SPEC=<encoded> REQUEST_ID=<id> [PAIR=<n>] node lib/pagespeed/job.mjs --out <dir>'); process.exit(2); }
  let results;
  try {
    const pair = process.env.PAIR ? Number(process.env.PAIR) : null;
    results = await runJob({ spec: decodeSpec(process.env.SPEC), requestId: process.env.REQUEST_ID, out: values.out, pair });
  } catch (e) {
    fs.mkdirSync(values.out, { recursive: true });
    fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify({ schema: 'perf-ab/pagespeed-v1', requestId: process.env.REQUEST_ID ?? null, status: 'failed', error: e.message, errorKind: 'fatal' }));
    console.error(`perf-ab job failed: ${e.message}`);
    process.exit(1);
  }
  if (results.status !== 'ok') { console.error(`perf-ab job failed (${results.errorKind}): ${results.error}`); process.exit(1); }
  console.log(JSON.stringify(results.medians));
}
