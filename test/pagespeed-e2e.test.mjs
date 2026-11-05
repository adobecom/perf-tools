// End-to-end: the real runner job (lib/pagespeed/job.mjs) with real Chrome and real Lighthouse 13.6.0 against a
// local HTTP/2 + Brotli fixture reached through the per-run proxy. Only the egress lookup is stubbed (as US).
// Skipped when no local Chrome is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { runJob, makeCert, scanForKeys } from '../lib/pagespeed/job.mjs';
import { interactionsKey } from '../lib/pagespeed/interactions.mjs';

const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
  .find((p) => p && fs.existsSync(p));
// A *.adobe.com name that never reaches real DNS: the proxy terminates it and forwards to the local fixture, and the
// public-address check is answered by a fake resolver (documentation-free public address).
const HOST = 'perf-ab-e2e.adobe.com';
const fakeDns = (hostname, opts, cb) => cb(null, [{ address: '23.192.0.10', family: 4 }]);
const br = (s) => brotliCompressSync(Buffer.from(s), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
const page = (cards) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fixture plans</title><script type="module" src="/app.js"></script></head>
<body><main><h1>Plans</h1><p>${'Plan details. '.repeat(40)}</p></main><div id="cards" data-n="${cards}"></div></body></html>`;
const APP = `const version = "v1";
const { revision } = await import('/libs/utils/utils.js');
const { count } = await (await fetch('/data.json')).json();
const n = Math.min(count, Number(document.getElementById('cards').dataset.n));
for (let i = 0; i < n; i += 1) {
  const c = document.createElement('div');
  c.className = 'card';
  c.dataset.version = version;
  c.dataset.revision = revision;
  c.textContent = 'Card ' + i + ' ' + 'x'.repeat(200);
  document.getElementById('cards').append(c);
}
`;

function snapshot(prefix) {
  return new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(prefix)));
}

test('runner job: real Lighthouse (mobile, DevTools throttling) through the HTTP/2 proxy, cold retries, unchanged baseline bytes', { skip: !CHROME && 'no local Chrome', timeout: 240000 }, async () => {
  const cert = makeCert(HOST);
  let documents = 0;
  const wire = {};
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: false });
  server.on('stream', (stream, h) => {
    const p = h[':path'];
    const send = (status, type, body, extra = {}) => {
      wire[p] = br(body);
      stream.respond({ ':status': status, 'content-type': type, 'content-encoding': 'br', 'cache-control': 'max-age=3600', ...extra });
      stream.end(wire[p]);
    };
    if (p === '/page') {
      // Lighthouse also fetches the page itself (sec-fetch-dest: empty) for its own audits; count navigations only.
      if (h['sec-fetch-dest'] === 'document') documents += 1;
      // The 2nd page document (change run 1, attempt 1) renders 1 card instead of 3: an incorrect render.
      return send(200, 'text/html; charset=utf-8', page(documents === 2 && h['sec-fetch-dest'] === 'document' ? 1 : 3), { link: '</app.js>; rel=modulepreload, <https://www.adobe.com/page>; rel="canonical"', 'server-timing': 'cdn-cache; desc=MISS, geo; desc=US' });
    }
    if (p === '/app.js') return send(200, 'text/javascript', APP);
    if (p === '/libs/utils/utils.js') return send(200, 'text/javascript', 'export const revision = "production";\n');
    if (p === '/data.json') return send(200, 'application/json', JSON.stringify({ count: 3, pad: 'y'.repeat(500) }));
    stream.respond({ ':status': 404 });
    return stream.end();
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-'));
  // A private temp dir for the job, so certs/profiles created by test files running in parallel don't interfere.
  const jobTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-tmp-'));
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = jobTmp;
  const certsBefore = snapshot('perf-ab-cert-');
  const profilesBefore = snapshot('perf-ab-profile-');
  const url = `https://${HOST}/page`;
  const productionSource = Buffer.from('export const revision = "production";\n');
  const prSource = Buffer.from('export const revision = "pinned-pr";\n');
  const prHead = 'a'.repeat(40);
  const prBase = 'b'.repeat(40);
  const prMergeBase = 'c'.repeat(40);
  const prBlob = 'd'.repeat(40);
  const sourcePath = '/libs/utils/utils.js';
  const localSources = {
    [sourcePath]: {
      repo: 'adobecom/milo', number: 7095, headSha: prHead, mergeBaseSha: prMergeBase,
      filePath: 'libs/utils/utils.js', baseFilePath: 'libs/utils/utils.js', blobSha: prBlob, deleted: false,
    },
  };
  const sourcePrs = [{
    repo: 'adobecom/milo', number: 7095, baseRef: 'stage', headRef: 'MWPW-213916',
    baseSha: prBase, headSha: prHead, mergeBaseSha: prMergeBase,
    files: [{ status: 'modified', path: sourcePath, blobSha: prBlob }],
  }];
  const logs = [];
  try {
    const results = await runJob({
      spec: {
        version: 1, runs: 2, names: ['before', 'after'],
        variants: {
          before: { url },
          after: {
            url,
            headInject: '<link rel="preload" href="/data.json" as="fetch" crossorigin>',
            patches: [{ path: '/app.js', find: 'const version = "v1";', replace: 'const version = "v2";' }],
            localSources,
            sourcePrs,
          },
        },
        expect: { title: '^Fixture plans$', counts: [{ selector: '.card', count: 3 }] },
      },
      requestId: 'e2e-fixture-1',
      out,
      // Paired matrix mode: this job measures only pair 2 of 2 (another runner measures pair 1).
      pair: 2,
      fetchJson: async () => ({ country: 'US', country_iso: 'US', country_code: 'US' }),
      upstreamOrigin: `https://127.0.0.1:${server.address().port}`,
      upstreamOptions: { rejectUnauthorized: false },
      dnsLookup: fakeDns,
      chromePath: CHROME,
      checkoutSources: () => ({
        contents: new Map([[sourcePath, { body: prSource, deleted: false }]]),
        baselineContentHashes: new Map([[sourcePath, createHash('sha256').update(productionSource).digest('hex')]]),
        cleanup: () => {},
      }),
      log: (m) => logs.push(m),
      warn: (m) => logs.push(`WARN ${m}`),
    });
    assert.equal(results.status, 'ok', `${results.error}\n${logs.join('\n')}`);
    assert.equal(results.lighthouseVersion, '13.6.0');
    assert.match(results.chromeVersion, /Chrome\/\d+/);
    assert.equal(results.egress.country, 'US');
    assert.equal(results.profile.cpuSlowdownMultiplier, 4);
    assert.equal(results.profile.rttMs, 150);
    assert.equal(results.profile.throughputKbps, 1638.4);
    assert.deepEqual([results.profile.requestLatencyMs, results.profile.downloadThroughputKbps, results.profile.uploadThroughputKbps], [562.5, 1474.56, 675]);
    assert.equal(results.profile.throttlingMethod, 'devtools');
    assert.deepEqual(results.cold, { freshBrowserPerAttempt: true, emptyProfilePerAttempt: true, warmups: 0, lighthouseStorageReset: true });

    // Exactly one accepted run per variant, for pair 2 only; the incorrect render was kept as a rejected diagnostic and
    // retried fresh.
    assert.equal(results.pair, 2);
    assert.deepEqual(results.runs.map((r) => `${r.variant}${r.run}#${r.attempt}`), ['before2#1', 'after2#2']);
    assert.deepEqual(results.pairs.map((p) => p.index), [2]);
    assert.deepEqual(results.samples, { requested: 1, pairs: 1, rejected: 1 });
    assert.equal(results.rejected.length, 1);
    assert.equal(results.rejected[0].variant, 'after');
    assert.match(results.rejected[0].reason, /render check failed/);
    assert.ok(fs.existsSync(path.join(out, results.rejected[0].dir, 'report.html')));
    assert.equal(documents, 3, 'three cold navigations: before2, after2 (rejected), after2 retry; no warm-ups or pair-1 runs');

    for (const r of results.runs) {
      // Full rendered DOM checked in the measured page itself.
      const { measured, ...rendered } = r.render;
      assert.deepEqual(rendered, { title: 'Fixture plans', titleOk: true, bodyVisible: true, counts: { '.card': 3 }, countsOk: true });
      assert.deepEqual([measured.source, measured.matchesDevtoolsLog], ['lighthouse-stopInstrumentation', true]);
      for (const f of ['report.html', 'report.json', 'trace.json', 'devtoolslog.json', 'run.json']) assert.ok(fs.existsSync(path.join(out, r.dir, f)), `${r.dir}/${f}`);
      assert.equal(r.firstResponse.protocol, 'h2');
      assert.equal(r.firstResponse.fromDiskCache, false);
      for (const k of ['performance', 'FCP', 'LCP', 'SI', 'TBT', 'CLS']) assert.ok(Number.isFinite(r.metrics[k]), `${r.dir} ${k}`);
      // Real throttling through the proxy: the 562.5 ms request latency applies to the document request, so no paint can come earlier.
      assert.ok(r.metrics.FCP > 562.5 && r.metrics.LCP > 562.5, `${r.dir} FCP ${r.metrics.FCP} LCP ${r.metrics.LCP} are not throttled`);
      const lhr = JSON.parse(fs.readFileSync(path.join(out, r.dir, 'report.json'), 'utf8'));
      assert.equal(lhr.lighthouseVersion, '13.6.0');
      assert.match(fs.readFileSync(path.join(out, r.dir, 'report.html'), 'utf8'), /Lighthouse Report/i);
    }
    assert.ok(Object.values(results.medians.before).every(Number.isFinite));
    assert.ok(Object.values(results.medians.delta).every(Number.isFinite));

    const runJson = (d) => JSON.parse(fs.readFileSync(path.join(out, d, 'run.json'), 'utf8'));
    const before = runJson('before2');
    const after = runJson('after2');
    // Baseline: served exactly as the origin sent it (same compressed bytes, nothing edited), over HTTP/2.
    assert.deepEqual(before.editedResponses, []);
    for (const r of before.requests.filter((x) => x.kind)) {
      assert.equal(r.edited, false, r.path);
      assert.equal(r.servedEncodedBytes, r.originalEncodedBytes, r.path);
      assert.equal(r.alpn, 'h2');
    }
    assert.equal(before.requests.find((r) => r.path === '/page').originalEncodedBytes, br(page(3)).length);
    assert.equal(before.documentGeo.status, 'US');
    assert.deepEqual(results.sourceDrift, [{
      path: sourcePath, repo: 'adobecom/milo', number: 7095,
      expectedMergeBaseSha256: createHash('sha256').update(productionSource).digest('hex'),
      productionSha256: createHash('sha256').update(productionSource).digest('hex'),
      productionStatus: 200, status: 'matches-merge-base',
    }]);
    // Change: document + patched module edited and recompressed as Brotli; hints injected.
    assert.deepEqual([...after.editedResponses].sort(), ['/app.js', '/libs/utils/utils.js', '/page']);
    assert.deepEqual(after.sourcePrs, sourcePrs);
    assert.deepEqual(after.servedSources, [{
      path: sourcePath, repo: 'adobecom/milo', number: 7095, baseSha: prBase, headSha: prHead,
      mergeBaseSha: prMergeBase, status: 'served', blobSha: prBlob,
      sha256: createHash('sha256').update(prSource).digest('hex'),
    }]);
    assert.equal(after.requests.find((r) => r.path === sourcePath).edited, true);
    assert.ok(after.requests.filter((r) => r.edited).every((r) => r.encoding === 'br' && r.servedEncodedBytes > 0));
    const dlog = JSON.parse(fs.readFileSync(path.join(out, 'after2', 'devtoolslog.json'), 'utf8'));
    const linkOf = (log) => Object.entries(log.find((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document').params.response.headers).find(([k]) => k.toLowerCase() === 'link')?.[1];
    // head-inject makes the snippet the only source of preloads: the after document's Link header loses its
    // rel=modulepreload entry (other entries stay), the unchanged before document keeps it.
    assert.equal(linkOf(dlog), '<https://www.adobe.com/page>; rel="canonical"');
    assert.match(linkOf(JSON.parse(fs.readFileSync(path.join(out, 'before2', 'devtoolslog.json'), 'utf8'))), /<\/app\.js>; rel=modulepreload/);
    assert.deepEqual(after.strippedLinkHeaderEntries, ['</app.js>; rel=modulepreload']);
    assert.equal(results.hints.linkHeaderStripped, 1);
    assert.deepEqual(results.hints.linkHeaderEntries, ['</app.js>; rel=modulepreload']);
    const lhrAfter = JSON.parse(fs.readFileSync(path.join(out, 'after2', 'report.json'), 'utf8'));
    const reqs = lhrAfter.audits['network-requests'].details.items.map((x) => new URL(x.url).pathname);
    assert.equal(reqs.filter((p) => p === '/data.json').length, 1, 'injected fetch preload was consumed (no second download)');
    assert.equal(results.hints.requestedLinks, 1);
    assert.equal(results.hints.usedLinks, 1);

    // No keys or certificates in the artifact directory; per-run certs and profiles are removed.
    assert.deepEqual(scanForKeys(out), []);
    assert.deepEqual([...snapshot('perf-ab-cert-')].filter((f) => !certsBefore.has(f)), []);
    assert.deepEqual([...snapshot('perf-ab-profile-')].filter((f) => !profilesBefore.has(f)), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).status, 'ok');
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    fs.rmSync(jobTmp, { recursive: true, force: true });
    server.close();
    cert.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('runner job with where=local: same Lighthouse run, non-US egress and document geo are recorded as warnings, never US', { skip: !CHROME && 'no local Chrome', timeout: 240000 }, async () => {
  const cert = makeCert(HOST);
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: false });
  server.on('stream', (stream, h) => {
    const p = h[':path'];
    if (p === '/page') {
      stream.respond({ ':status': 200, 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br', 'server-timing': 'geo; desc=CH', link: '</app.js>; rel=modulepreload, <https://www.adobe.com/page>; rel="canonical"' });
      return stream.end(br(page(1)));
    }
    if (p === '/app.js') {
      stream.respond({ ':status': 200, 'content-type': 'text/javascript', 'content-encoding': 'br' });
      return stream.end(br('document.getElementById("cards").textContent = "ok";'));
    }
    stream.respond({ ':status': 404 });
    return stream.end();
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-local-'));
  const jobTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-local-tmp-'));
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = jobTmp;
  const swiss = async () => ({ country: 'CH', country_iso: 'CH', country_code: 'CH' });
  const common = {
    spec: { version: 1, runs: 1, names: ['after'], variants: { after: { url: `https://${HOST}/page` } }, expect: {} },
    out, fetchJson: swiss, upstreamOrigin: `https://127.0.0.1:${server.address().port}`, upstreamOptions: { rejectUnauthorized: false },
    dnsLookup: fakeDns, chromePath: CHROME, log: () => {}, warn: () => {},
  };
  try {
    const results = await runJob({ ...common, requestId: 'e2e-local-1', where: 'local' });
    assert.equal(results.status, 'ok', results.error);
    assert.equal(results.where, 'local');
    assert.deepEqual([results.egress.ok, results.egress.country, results.egress.where], [false, 'CH', 'local']);
    assert.deepEqual(results.warnings.map((w) => w.kind).sort(), ['local-non-us-document', 'local-non-us-egress']);
    assert.equal(results.profile.cpuSlowdownMultiplier, 4);
    assert.equal(results.profile.throttlingMethod, 'devtools');
    assert.deepEqual(results.cold, { freshBrowserPerAttempt: true, emptyProfilePerAttempt: true, warmups: 0, lighthouseStorageReset: true });
    assert.ok(fs.existsSync(path.join(out, results.runs[0].dir, 'report.html')));
    // Without head-inject the production Link header is served untouched and nothing is reported as stripped.
    const linkIn = (dir) => Object.entries(JSON.parse(fs.readFileSync(path.join(out, dir, 'devtoolslog.json'), 'utf8')).find((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document').params.response.headers).find(([k]) => k.toLowerCase() === 'link')?.[1];
    assert.match(linkIn(results.runs[0].dir), /rel=modulepreload/);
    assert.equal(results.hints, null);
    // With head-inject (also locally) the after document's header preloads are unset and reported.
    const injected = await runJob({
      ...common, requestId: 'e2e-local-3', out: path.join(out, 'injected'), where: 'local',
      spec: { version: 1, runs: 1, names: ['after'], variants: { after: { url: `https://${HOST}/page`, headInject: '<link rel="modulepreload" href="/app.js">' } }, expect: {} },
    });
    assert.equal(injected.status, 'ok', injected.error);
    assert.equal(injected.hints.linkHeaderStripped, 1);
    assert.deepEqual(injected.hints.linkHeaderEntries, ['</app.js>; rel=modulepreload']);
    const strippedLog = JSON.parse(fs.readFileSync(path.join(out, 'injected', injected.runs[0].dir, 'devtoolslog.json'), 'utf8'));
    const strippedHeaders = strippedLog.find((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document').params.response.headers;
    assert.equal(Object.entries(strippedHeaders).find(([k]) => k.toLowerCase() === 'link')[1], '<https://www.adobe.com/page>; rel="canonical"');
    // The same request without the local flag still fails closed, before any browser is launched.
    const closed = await runJob({ ...common, requestId: 'e2e-local-2', out: path.join(out, 'actions') });
    assert.equal(closed.status, 'failed');
    assert.match(closed.error, /US egress verification failed/);
    assert.equal(closed.runs.length, 0);
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    fs.rmSync(jobTmp, { recursive: true, force: true });
    server.close();
    cert.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- INP: interactions replayed in a Lighthouse timespan after the cold navigation ----------

const inpPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fixture inp</title><script type="module" src="/app.js"></script></head>
<body><main><h1>Plans</h1><p>${'Plan details. '.repeat(20)}</p>
<button id="buy" style="width:220px;height:64px;font-size:20px">Buy now</button><p id="out">idle</p>
<a id="leave" href="/other" style="display:block;margin-top:24px">Leave</a></main></body></html>`;
const INP_APP = `const BLOCK_MS = 300;
document.getElementById('buy').addEventListener('click', () => {
  const t = performance.now();
  while (performance.now() - t < BLOCK_MS);
  document.getElementById('out').textContent = 'clicked ' + Math.round(performance.now());
});
`;

// A page for the pass-partout (auto) scenario: tabs, a toggle, a slow "Show more" button and a modal opener to be found,
// and a purchase button, a real link, a submit button and a consent banner button that must never be touched. Every
// click reports itself to the server, which is how the test sees what was (not) exercised.
const autoPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fixture auto</title><script type="module" src="/app.js"></script></head>
<body><main><h1>Plans</h1>
<div role="tablist"><button role="tab" aria-selected="true" id="t1" style="min-height:44px">One</button><button role="tab" aria-selected="false" id="t2" style="min-height:44px">Two</button><button role="tab" aria-selected="false" id="t3" style="min-height:44px">Three</button></div>
<button id="acc" aria-expanded="false" style="min-height:44px">More details</button>
<button id="more" style="min-height:44px">Show more</button>
<button id="buy" style="min-height:44px">Buy now</button>
<button id="dialog" aria-haspopup="dialog" style="min-height:44px">Open the gallery</button>
<a id="leave" href="/other" style="display:block;min-height:44px">Learn more</a>
<form onsubmit="return false"><button type="submit" id="sub" style="min-height:44px">Go</button></form>
<div id="onetrust-consent-sdk"><button id="accept" style="min-height:44px">Got it</button></div>
<p id="out">idle</p></main></body></html>`;
const AUTO_APP = `const BLOCK_MS = 300;
const hit = (id) => navigator.sendBeacon('/hit/' + id);
for (const el of document.querySelectorAll('button, a')) {
  el.addEventListener('click', (e) => {
    hit(el.id);
    if (el.id === 'more') { const t = performance.now(); while (performance.now() - t < BLOCK_MS); }
    if (el.getAttribute('role') === 'tab') {
      for (const tab of document.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab === el));
    }
    if (el.id === 'acc') el.setAttribute('aria-expanded', String(el.getAttribute('aria-expanded') !== 'true'));
    document.getElementById('out').textContent = 'clicked ' + el.id;
    if (el.tagName === 'A') e.preventDefault();
  });
}
`;

async function inpFixture(t, { html = inpPage, js = INP_APP, ready = '#buy' } = {}) {
  const cert = makeCert(HOST);
  const counts = { documents: 0, hits: {} };
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: false });
  server.on('stream', (stream, h) => {
    const p = h[':path'];
    const send = (type, body) => {
      stream.respond({ ':status': 200, 'content-type': type, 'content-encoding': 'br', 'cache-control': 'max-age=3600', 'server-timing': 'geo; desc=US' });
      stream.end(br(body));
    };
    if (p === '/page') {
      if (h['sec-fetch-dest'] === 'document') counts.documents += 1;
      return send('text/html; charset=utf-8', html);
    }
    if (p.startsWith('/hit/')) {
      const id = p.slice('/hit/'.length);
      counts.hits[id] = (counts.hits[id] ?? 0) + 1;
      stream.respond({ ':status': 204 });
      return stream.end();
    }
    if (p === '/other') return send('text/html; charset=utf-8', '<!doctype html><title>Other</title><h1>Other page</h1>');
    if (p === '/app.js') return send('text/javascript', js);
    stream.respond({ ':status': 404 });
    return stream.end();
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-inp-'));
  const jobTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-e2e-inp-tmp-'));
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = jobTmp;
  t.after(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    fs.rmSync(jobTmp, { recursive: true, force: true });
    server.close();
    cert.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  });
  const url = `https://${HOST}/page`;
  const logs = [];
  const run = (spec, requestId, extra = {}) => runJob({
    spec: { version: 1, runs: 1, expect: { counts: [{ selector: ready, count: 1 }] }, ...spec },
    requestId, out: path.join(out, requestId), attempts: 1,
    fetchJson: async () => ({ country: 'US', country_iso: 'US', country_code: 'US' }),
    upstreamOrigin: `https://127.0.0.1:${server.address().port}`, upstreamOptions: { rejectUnauthorized: false },
    dnsLookup: fakeDns, chromePath: CHROME, log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), ...extra,
  });
  return { url, out, counts, run, logs };
}

test('INP: interactions run as a timespan after the cold navigation; a patch that shortens the handler lowers INP', { skip: !CHROME && 'no local Chrome', timeout: 300000 }, async (t) => {
  const { url, out, counts, run, logs } = await inpFixture(t);
  const interactions = [
    { action: 'waitFor', selector: '#buy' },
    { action: 'tap', selector: '#buy', label: 'Buy (tap)' },
    { action: 'click', selector: '#buy', label: 'Buy (click)', ms: 500 },
  ];
  const results = await run({
    names: ['before', 'after'],
    variants: { before: { url }, after: { url, patches: [{ path: '/app.js', find: 'const BLOCK_MS = 300;', replace: 'const BLOCK_MS = 30;' }] } },
    interactions,
  }, 'e2e-inp-1');
  assert.equal(results.status, 'ok', `${results.error}\n${logs.join('\n')}`);
  assert.deepEqual(results.interactions, interactions);
  assert.equal(results.interactionsKey, interactionsKey(interactions));
  assert.equal(counts.documents, 2, 'one cold navigation per variant; the interactions never reload the page');

  const [before] = results.runs.filter((r) => r.variant === 'before');
  const [after] = results.runs.filter((r) => r.variant === 'after');
  for (const r of [before, after]) {
    for (const k of ['performance', 'FCP', 'LCP', 'SI', 'TBT', 'CLS', 'INP']) assert.ok(Number.isFinite(r.metrics[k]), `${r.dir} ${k}`);
    // The navigation step supplies the usual metrics under the same real throttling as the plain path.
    assert.ok(r.metrics.FCP > 562.5 && r.metrics.LCP > 562.5, `${r.dir} FCP ${r.metrics.FCP} LCP ${r.metrics.LCP} are not throttled`);
    for (const f of ['report.html', 'report.json', 'trace.json', 'devtoolslog.json', 'run.json', 'flow-report.html',
      'interaction/report.html', 'interaction/report.json', 'interaction/trace.json', 'interaction/devtoolslog.json']) {
      assert.ok(fs.existsSync(path.join(out, 'e2e-inp-1', r.dir, f)), `${r.dir}/${f}`);
    }
    const nav = JSON.parse(fs.readFileSync(path.join(out, 'e2e-inp-1', r.dir, 'report.json'), 'utf8'));
    const span = JSON.parse(fs.readFileSync(path.join(out, 'e2e-inp-1', r.dir, 'interaction', 'report.json'), 'utf8'));
    assert.equal(nav.gatherMode, 'navigation');
    assert.equal(span.gatherMode, 'timespan');
    assert.equal(span.audits['interaction-to-next-paint'].numericValue, r.metrics.INP);
    assert.equal(span.configSettings.throttlingMethod, 'devtools');
    assert.equal(span.configSettings.throttling.cpuSlowdownMultiplier, 4);
    assert.equal(span.configSettings.formFactor, 'mobile');
    assert.equal(r.interaction.steps, 3);
    assert.equal(r.interaction.interactions, 2, 'the tap and the click are two interactions');
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'e2e-inp-1', r.dir, 'run.json'), 'utf8'));
    assert.deepEqual(meta.interaction.steps.map((s) => s.action), ['waitFor', 'tap', 'click']);
  }
  // 300 ms of blocking handler before, 30 ms after: INP follows the handler, and the breakdown says why.
  assert.ok(before.metrics.INP >= 250, `before INP ${before.metrics.INP}`);
  assert.ok(after.metrics.INP < before.metrics.INP - 150, `after INP ${after.metrics.INP} vs before ${before.metrics.INP}`);
  assert.ok(before.interaction.slowest.processingTime >= 250, JSON.stringify(before.interaction.slowest));
  assert.ok([1, 2].includes(before.interaction.slowest.step.index), JSON.stringify(before.interaction.slowest));
  assert.ok(results.pairs[0].delta.INP < -150);
  assert.ok(results.medians.delta.INP < -150);
  assert.ok(Object.values(results.medians.before).every(Number.isFinite) && 'INP' in results.medians.before);
  assert.deepEqual(scanForKeys(path.join(out, 'e2e-inp-1')), []);
});

test('INP: a selector that never shows up is rejected with its artifacts kept; leaving the page is fatal', { skip: !CHROME && 'no local Chrome', timeout: 300000 }, async (t) => {
  const { url, out, run, logs } = await inpFixture(t);
  const spec = (interactions) => ({ names: ['after'], variants: { after: { url } }, interactions });
  const missing = await run(spec([{ action: 'waitFor', selector: '#nope', ms: 1000 }, { action: 'tap', selector: '#buy' }]), 'e2e-inp-missing');
  assert.equal(missing.status, 'failed', logs.join('\n'));
  assert.equal(missing.errorKind, 'rejected-after-retries');
  assert.match(missing.error, /interactions\[0\] waitFor #nope: selector did not become visible within 1000 ms/);
  assert.equal(missing.runs.length, 0, 'a run whose steps could not run never feeds the medians');
  const dir = path.join(out, 'e2e-inp-missing', missing.rejected[0].dir);
  for (const f of ['report.json', 'run.json', 'flow-report.html', 'interaction/report.json', 'interaction/trace.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);

  const left = await run(spec([{ action: 'tap', selector: '#leave' }]), 'e2e-inp-left');
  assert.equal(left.status, 'failed', logs.join('\n'));
  assert.equal(left.errorKind, 'fatal');
  assert.match(left.error, /the main frame navigated during the interactions/);
  assert.equal(left.runs.length, 0);
});

test('INP auto: the pass-partout finds tabs, toggles, a plain button and a modal opener by itself; before and after exercise the same ones and nothing risky is touched', { skip: !CHROME && 'no local Chrome', timeout: 300000 }, async (t) => {
  const { url, out, counts, run, logs } = await inpFixture(t, { html: autoPage, js: AUTO_APP, ready: '#more' });
  const interactions = [{ action: 'auto', max: 5 }];
  const results = await run({
    names: ['before', 'after'],
    variants: { before: { url }, after: { url, patches: [{ path: '/app.js', find: 'const BLOCK_MS = 300;', replace: 'const BLOCK_MS = 30;' }] } },
    interactions,
  }, 'e2e-auto-1');
  assert.equal(results.status, 'ok', `${results.error}\n${logs.join('\n')}`);
  assert.deepEqual(results.interactions, interactions);
  assert.equal(results.interactionsKey, interactionsKey(interactions));

  const meta = (variant) => JSON.parse(fs.readFileSync(path.join(out, 'e2e-auto-1', `${variant}1`, 'run.json'), 'utf8'));
  const targets = (variant) => meta(variant).interaction.steps.filter((s) => s.auto);
  // Discovery runs before every tap: once tab Two is selected, tab One is a target again and Three is never needed.
  const expected = ['tab: Two', 'tab: One', 'expandable: More details', 'button: Show more', 'popup: Open the gallery'];
  assert.deepEqual(targets('before').map((s) => s.label), expected, 'kind order: tabs, toggle, button, then the modal opener last');
  assert.deepEqual(targets('after').map((s) => s.signature), targets('before').map((s) => s.signature), 'after exercises exactly what before resolved');
  const [before] = results.runs.filter((r) => r.variant === 'before');
  const [after] = results.runs.filter((r) => r.variant === 'after');
  assert.equal(before.interaction.targetsKey, after.interaction.targetsKey);
  assert.match(before.interaction.targetsKey, /^[a-f0-9]{64}$/);
  assert.equal(before.interaction.interactions, 5, 'five taps, five interactions');

  // Each target was tapped once in each of the two loads; the purchase button, the link, the submit button and the consent button never.
  assert.deepEqual(counts.hits, { t2: 2, t1: 2, acc: 2, more: 2, dialog: 2 }, 'each target tapped once per load (before and after)');
  for (const untouched of ['t3', 'buy', 'leave', 'sub', 'accept']) assert.ok(!(untouched in counts.hits), `${untouched} must never be tapped`);

  assert.ok(before.metrics.INP >= 250, `before INP ${before.metrics.INP}`);
  assert.ok(after.metrics.INP < before.metrics.INP - 150, `after INP ${after.metrics.INP} vs before ${before.metrics.INP}`);
  assert.equal(before.interaction.slowest.step.label, 'button: Show more');
  assert.ok(results.medians.delta.INP < -150);
});
