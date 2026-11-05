#!/usr/bin/env node
// perf-ab measurement job. Runs on the GitHub Actions runner dispatched by the perf-ab CLI (see
// .github/workflows/perf-ab.yml or perf-ab --local). Checks egress before touching the page, then runs Lighthouse 13.6.0
// with the mobile DevTools-throttled profile (lib/pagespeed/profile.mjs), alternating cold runs: every attempt gets a fresh Chrome
// process, an empty temporary profile and a fresh proxy; no warm-ups. Invalid runs are kept as rejected
// diagnostics and retried fresh. Writes official Lighthouse reports, traces and results.json to --out.
// With spec.interactions every cold run is one Lighthouse user flow instead: the same cold navigation (all the usual
// metrics) followed by a timespan in which the declarative steps run, which supplies INP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import lighthouse, { startFlow } from 'lighthouse';
import { ReportGenerator } from 'lighthouse/report/generator/report-generator.js';
import puppeteer from 'puppeteer-core';
import { measureCold } from '../cold-runs.mjs';
import { median, metricDelta, metricKeys, pairStats, REQUIRED_KEYS } from './stats.mjs';
import { runInteractions, interactionsKey, plansFrom, targetsKey } from './interactions.mjs';
import { analyzeInteractions, INP_AUDIT } from './inp.mjs';
import { decodeSpec, validateSpec, REQUEST_ID } from './spec.mjs';
import { assertPublicHost, publicOnlyLookup, mainFrameDocumentUrls, assertMainFrameTargets } from '../target.mjs';
import { lighthouseConfig, resolvedProfile, LIGHTHOUSE_VERSION } from './profile.mjs';
import { verifyUsEgress, documentGeo } from './egress.mjs';
import { requireChromePath } from './chrome.mjs';
import { startProxy } from './proxy.mjs';
import { injectIntoHead, stripPreloadLinks, applyPatches, resolveContextualHints, countLinks } from './transforms.mjs';
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
const METRIC_AUDIT = { FCP: 'first-contentful-paint', LCP: 'largest-contentful-paint', SI: 'speed-index', TBT: 'total-blocking-time', CLS: 'cumulative-layout-shift', INP: INP_AUDIT };
// Every required metric (stats.mjs REQUIRED_KEYS, plus INP for interactions runs) must be a finite number for a run to be accepted: Lighthouse can finish without a runtimeError while an
// individual audit (or the performance score) errors, and a partial run must never feed the medians.
// INP comes from the timespan LHR of an interactions run (`interactionLhr`); Lighthouse reports it notApplicable when
// Chrome registered no interaction.
export function extractMetrics(lhr, interactionLhr = null) {
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, f(lhr)]));
  if (interactionLhr) metrics.INP = interactionLhr.audits?.[INP_AUDIT]?.numericValue ?? null;
  const missing = Object.keys(metrics).filter((k) => !Number.isFinite(metrics[k]) && (REQUIRED_KEYS.includes(k) || k === 'INP'));
  if (missing.length) {
    const why = missing.map((k) => {
      const a = k === 'performance' ? null : (k === 'INP' ? interactionLhr : lhr).audits?.[METRIC_AUDIT[k]];
      if (a?.errorMessage) return `${k} (${a.errorMessage})`;
      return k === 'INP' && a?.scoreDisplayMode === 'notApplicable' ? 'INP (Chrome registered no interaction)' : k;
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

// Runs the scenario inside one Lighthouse timespan of the flow. It never throws: the steps that ran and the error (if any)
// are returned, so the flow's artifacts can still be gathered and kept as rejected diagnostics. The main frame must stay
// on its document (a navigation or a new tab means the scenario leaves the measured page: fatal); iframes may navigate.
async function interact(flow, page, browser, steps, plans) {
  const navigations = [];
  const tabs = [];
  const onTarget = (target) => { if (target.type() === 'page') tabs.push(target.url()); };
  const session = await page.createCDPSession();
  session.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) navigations.push(frame.url); });
  browser.on('targetcreated', onTarget);
  let executed = [];
  let error = null;
  try {
    await session.send('Page.enable');
    await flow.startTimespan();
    try {
      executed = await runInteractions(page, steps, { plans });
    } catch (e) {
      error = e;
      executed = e.executed ?? [];
    }
    try {
      await flow.endTimespan();
    } catch (e) {
      error ??= e;
    }
  } catch (e) {
    error = e;
  } finally {
    browser.off('targetcreated', onTarget);
    await session.detach().catch(() => {});
  }
  const after = executed.length ? ` after "${executed.at(-1).label}"` : '';
  if (navigations.length) error = fatal(`the main frame navigated during the interactions${after} (${navigations.join(', ')}); a scenario must stay on the measured page (for auto steps, add the element to "exclude")`);
  else if (tabs.length) error = fatal(`an interaction opened a new tab or window${after}; a scenario must stay on the measured page`);
  return { executed, error };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

export async function runJob({
  spec, requestId, out, pair = null, attempts = 1, fetchJson, launchBrowser, upstreamOrigin, upstreamOptions, allowLocalTargets, dnsLookup,
  chromePath = process.env.CHROME_PATH, where = 'actions', log = console.log, warn = console.warn, checkoutSources = checkoutPrSources,
}) {
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  const results = {
    schema: 'perf-ab/pagespeed-v1', requestId, status: 'running', mode: where === 'local' ? 'pagespeed-local' : 'pagespeed-us', where, startedAt: new Date().toISOString(),
    github: { sha: process.env.GITHUB_SHA ?? null, runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, runner: process.env.RUNNER_NAME ?? null, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || null, os: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length },
    cold: { freshBrowserPerAttempt: true, emptyProfilePerAttempt: true, warmups: 0, lighthouseStorageReset: true },
    lighthouseVersion: LIGHTHOUSE_VERSION, names: [], runsPerVariant: null, runs: [], rejected: [], egress: null, documentGeo: [], hints: null, edits: {},
    interactions: null, interactionsKey: null, sourcePrs: [], sourceDrift: [], warnings: [],
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
    const interactions = spec.interactions ?? null;
    const keys = metricKeys({ interactions });
    // auto steps: what the accepted "before" load of each run resolved, so that "after" exercises the same elements.
    const autoPlans = new Map();
    results.interactions = interactions;
    results.interactionsKey = interactions ? interactionsKey(interactions) : null;
    // Paired matrix mode: this machine measures exactly one cold before/after pair (run index = pair).
    if (pair != null) {
      if (!Number.isInteger(pair) || pair < 1 || pair > spec.runs) throw fatal(`invalid pair ${pair} for ${spec.runs} run(s)`);
      results.pair = pair;
    }
    results.url = spec.variants.after.url;
    results.experiment = spec.meta ?? null;
    results.variants = Object.fromEntries(spec.names.map((n) => [n, { url: spec.variants[n].url }]));
    results.sourcePrs = spec.variants.after.sourcePrs ?? [];

    // 1. Actions probes egress before touching the measured site and fails closed. Local runs do no egress check.
    if (where === 'local') {
      results.egress = { where: 'local', ok: null, country: null, checks: [] };
    } else {
      results.egress = await verifyUsEgress({ ...(fetchJson ? { fetchJson } : {}) });
      results.egress.where = where;
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
    // Link header preload entries removed from the last served after document (identical for every load).
    const strippedLinkEntries = [];
    if (afterSnippet != null) results.hints = { requestedLinks: countLinks(afterSnippet), linkHeaderStripped: 0, linkHeaderEntries: [] };
    results.edits = Object.fromEntries(spec.names.map((n) => [n, {
      headInject: spec.variants[n].headInject != null,
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
          const injected = injectIntoHead(html, snippet);
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
      // rr = the navigation result; with interactions ir = the timespan result and flowResult the whole Lighthouse flow.
      let rr;
      let ir = null;
      let flowResult = null;
      const saveRun = (dir, nav, meta) => {
        fs.mkdirSync(dir, { recursive: true });
        if (nav?.report) {
          const [html, json] = nav.report;
          fs.writeFileSync(path.join(dir, 'report.html'), html);
          fs.writeFileSync(path.join(dir, 'report.json'), json);
        }
        if (nav?.artifacts?.Trace) writeJson(path.join(dir, 'trace.json'), nav.artifacts.Trace);
        if (nav?.artifacts?.DevtoolsLog) writeJson(path.join(dir, 'devtoolslog.json'), nav.artifacts.DevtoolsLog);
        if (ir) {
          const sub = path.join(dir, 'interaction');
          fs.mkdirSync(sub, { recursive: true });
          const [html, json] = ir.report;
          fs.writeFileSync(path.join(sub, 'report.html'), html);
          fs.writeFileSync(path.join(sub, 'report.json'), json);
          if (ir.artifacts?.Trace) writeJson(path.join(sub, 'trace.json'), ir.artifacts.Trace);
          if (ir.artifacts?.DevtoolsLog) writeJson(path.join(sub, 'devtoolslog.json'), ir.artifacts.DevtoolsLog);
        }
        if (flowResult) {
          // The flow report is a convenience view of the two reports above: never let it mask the run's own outcome.
          try { fs.writeFileSync(path.join(dir, 'flow-report.html'), ReportGenerator.generateFlowReportHtml(flowResult)); } catch (e) { warn(`${name}${i}: flow report not written: ${e.message}`); }
        }
        writeJson(path.join(dir, 'run.json'), meta);
      };
      const meta = {
        variant: name, run: i, attempt, url: v.url, chromeVersion, freshBrowser: true, emptyProfile: true, warmup: false,
        sourcePrs: results.sourcePrs, servedSources: [],
      };
      if (pair != null) meta.pair = pair;
      let interactionError = null;
      let executedSteps = [];
      try {
        if (interactions) {
          const flow = await startFlow(page, { config: lighthouseConfig(), flags: { logLevel: 'error' }, name: `${name}${i}` });
          // The same cold navigation as the plain path (including its about:blank hop); passive gathering (the flow
          // default) only skips the post-trace bfcache/full-page-screenshot probes, which would disturb the page.
          await flow.navigate(v.url, { skipAboutBlank: false });
          const loaded = page.url();
          if (loaded !== 'about:blank') {
            try { assertMainFrameTargets([loaded]); } catch (e) { throw fatal(`${e.message}; the interactions were not run`); }
          }
          const reuse = name === 'after' && spec.names.includes('before') ? autoPlans.get(i) : null;
          const outcome = await interact(flow, page, browser, interactions, reuse);
          executedSteps = outcome.executed;
          interactionError = outcome.error;
          flowResult = await flow.createFlowResult();
          const { gatherSteps } = flow.createArtifactsJson();
          const stepResult = (index) => flowResult.steps[index] && {
            lhr: flowResult.steps[index].lhr,
            artifacts: gatherSteps[index].artifacts,
            report: ReportGenerator.generateReport(flowResult.steps[index].lhr, ['html', 'json']),
          };
          rr = stepResult(0);
          ir = stepResult(1);
        } else {
          rr = await lighthouse(v.url, { logLevel: 'error' }, lighthouseConfig(), page);
        }
        if (!rr?.lhr) throw reject('Lighthouse returned no result');
        meta.profile = resolvedProfile(rr.lhr);
        meta.benchmarkIndex = rr.lhr.environment?.benchmarkIndex ?? null;
        results.profile ??= meta.profile;
        // Every main-frame URL (navigation, redirect hops, final URL) must stay a *.adobe.com https target. After the
        // interactions the main frame has not navigated (checked in interact), so only the page's final URL is added.
        const pageUrl = page.url();
        meta.mainFrameUrls = [...new Set([rr.lhr.requestedUrl, ...mainFrameDocumentUrls(rr.artifacts?.DevtoolsLog ?? []), rr.lhr.mainDocumentUrl, rr.lhr.finalDisplayedUrl, pageUrl === 'about:blank' ? null : pageUrl, ir?.lhr.finalDisplayedUrl].filter(Boolean))];
        try { assertMainFrameTargets(meta.mainFrameUrls); } catch (e) { throw fatal(e.message); }
        if (state.proxy.errors.fatal) throw state.proxy.errors.fatal;
        if (rr.lhr.runtimeError) throw reject(`Lighthouse runtime error ${rr.lhr.runtimeError.code}: ${rr.lhr.runtimeError.message}`);
        try {
          meta.metrics = extractMetrics(rr.lhr);
        } catch (e) {
          meta.metrics = e.metrics;
          throw e;
        }
        if (interactions) {
          meta.interaction = { steps: executedSteps };
          if (interactionError) throw interactionError;
          if (!ir?.lhr) throw reject('Lighthouse returned no timespan result for the interactions');
          meta.interaction.profile = resolvedProfile(ir.lhr);
          if (ir.lhr.runtimeError) throw reject(`Lighthouse runtime error ${ir.lhr.runtimeError.code} in the interactions timespan: ${ir.lhr.runtimeError.message}`);
          try {
            meta.metrics = extractMetrics(rr.lhr, ir.lhr);
          } catch (e) {
            meta.metrics = e.metrics;
            throw e;
          }
          // Auto steps are counted as the taps they resolved to.
          const resolved = executedSteps.map((e) => (e.auto ? { action: 'tap', label: e.label } : interactions[e.index]));
          meta.interaction.targetsKey = targetsKey(executedSteps);
          try {
            Object.assign(meta.interaction, await analyzeInteractions(ir.artifacts.Trace, resolved));
          } catch (e) {
            meta.interaction.analysisError = e.message;
          }
        }

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
        const expected = [...(e.headInject ? [pagePath(name)] : []), ...e.patches];
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
        results.runs.push({
          variant: name, run: i, attempt, dir: path.relative(out, runDir), metrics: meta.metrics, firstResponse: meta.firstResponse, benchmarkIndex: meta.benchmarkIndex,
          ...(interactions ? { interaction: { steps: meta.interaction.steps.length, interactions: meta.interaction.interactions ?? null, slowest: meta.interaction.slowest ?? null, targetsKey: meta.interaction.targetsKey ?? null } } : {}),
        });
        if (interactions && name === 'before') autoPlans.set(i, plansFrom(executedSteps));
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
      results.pairs.push({ index: i, before, after, delta: before && after ? metricDelta(before, after, keys) : null });
    }
    const stats = pairStats(results.pairs, spec.names, keys);
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
      for (const drift of results.sourceDrift.filter((d) => d.status === 'drift')) {
        results.warnings.push({
          kind: 'production-source-drift',
          message: `production ${drift.path} differs from the PR merge-base source; the after variant still uses the pinned PR head`,
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
