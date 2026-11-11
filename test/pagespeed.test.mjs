// Unit tests for the default perf-ab mode (verified-US Lighthouse PageSpeed mobile on GitHub Actions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { verifyUsEgress, documentGeo } from '../lib/pagespeed/egress.mjs';
import { findChromePath, requireChromePath, chromeCandidates } from '../lib/pagespeed/chrome.mjs';
import { runLocal } from '../lib/pagespeed/local.mjs';
import { findGithubToken } from '../lib/pagespeed/github-token.mjs';
import { encodeSpec, decodeSpec, validateSpec, MAX_SPEC_CHARS } from '../lib/pagespeed/spec.mjs';
import { resolvedProfile, lighthouseConfig, EXPECTED } from '../lib/pagespeed/profile.mjs';
import { CPU_SLOWDOWN_MULTIPLIER } from '../lib/pagespeed/stats.mjs';
import {
  injectIntoHead, stripPreloadLinks, applyPatches, resolveContextualHints, hasContextualHints, applyLinkHeaderEdits,
} from '../lib/pagespeed/transforms.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';
import { runJob, makeCert, scanForKeys, extractMetrics, median } from '../lib/pagespeed/job.mjs';
import { startProxy, sharedLookup } from '../lib/pagespeed/proxy.mjs';
import { buildSpec } from '../bin/perf-ab.mjs';

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin');
const run = promisify(execFile);
const answers = (map) => async (url) => {
  const v = Object.entries(map).find(([k]) => url.includes(k))?.[1];
  if (v instanceof Error) throw v;
  return v;
};
const spec = (extra = {}) => ({
  version: 1, runs: 1, names: ['before', 'after'],
  variants: { before: { url: 'https://www.adobe.com/acrobat/plans.html' }, after: { url: 'https://www.adobe.com/acrobat/plans.html', headInject: '<link rel="preload" href="/a.js" as="script">' } },
  expect: {},
  ...extra,
});

// ---------- egress ----------

test('US egress: all answering services must say US', async () => {
  const r = await verifyUsEgress({ fetchJson: answers({ ipinfo: { country: 'US', ip: '1.2.3.4' }, ifconfig: { country_iso: 'US' }, ipapi: new Error('rate limited') }) });
  assert.equal(r.ok, true);
  assert.equal(r.country, 'US');
});

test('US egress fails closed on a non-US answer (even if another says US) and on unknown', async () => {
  await assert.rejects(verifyUsEgress({ fetchJson: answers({ ipinfo: { country: 'US' }, ifconfig: { country_iso: 'CH' }, ipapi: { country_code: 'US' } }) }),
    (e) => e.fatal && /not US: ifconfig.co=CH/.test(e.message) && e.egress.ok === false);
  await assert.rejects(verifyUsEgress({ fetchJson: async () => { throw new Error('offline'); } }),
    (e) => e.fatal && /country unknown/.test(e.message));
  await assert.rejects(verifyUsEgress({ fetchJson: async () => ({}) }), /country unknown/);
});

test('document geo: Adobe Server-Timing geo;desc=<ISO> is parsed (US and CH), other entries ignored', () => {
  assert.deepEqual(documentGeo({ 'server-timing': 'cdn-cache; desc=MISS, edge; dur=12, geo; desc=US' }),
    { headers: { 'server-timing': 'cdn-cache; desc=MISS, edge; dur=12, geo; desc=US' }, countries: ['US'], status: 'US' });
  assert.equal(documentGeo({ 'Server-Timing': 'geo;desc=CH' }).status, 'non-US');
  assert.deepEqual(documentGeo({ 'server-timing': 'geo;desc="ch"' }).countries, ['CH']);
  assert.equal(documentGeo({ 'server-timing': 'cdn-cache;desc=HIT, geodesic;desc=US' }).status, 'unavailable');
  assert.equal(documentGeo({ 'content-type': 'text/html' }).status, 'unavailable');
  assert.equal(documentGeo({ 'x-country-code': 'US', 'server-timing': 'geo;desc=CH' }).status, 'non-US', 'any non-US evidence wins');
});

// ---------- spec ----------

test('spec: validated, gzip+base64 round trip, size-limited, rejects bad shapes', () => {
  const s = spec();
  assert.deepEqual(decodeSpec(encodeSpec(s)), s);
  assert.throws(() => validateSpec({ ...s, runs: 0 }), /runs/);
  assert.throws(() => validateSpec({ ...s, runs: 11 }), /runs/);
  assert.throws(() => validateSpec({ ...s, names: ['after', 'before'] }), /names/);
  assert.throws(() => validateSpec({ ...s, variants: { ...s.variants, before: { url: 'http://www.adobe.com/' } } }), /https/);
  assert.throws(() => validateSpec({ ...s, variants: { ...s.variants, before: { url: 'https://other.adobe.com/' } } }), /same host/);
  assert.throws(() => validateSpec({ ...s, variants: { before: { url: 'https://www.adobe.com.evil.example/' }, after: { url: 'https://www.adobe.com.evil.example/' } } }), /not a \*\.adobe\.com/);
  assert.throws(() => validateSpec({ ...s, variants: { ...s.variants, after: { ...s.variants.after, patches: [{ path: '/x.js', find: '', replace: '' }] } } }), /patches/);
  const withAfter = (after) => ({ ...s, variants: { ...s.variants, after: { ...s.variants.after, ...after } } });
  for (const [after, pattern] of [
    [{ sources: { '/libs/a.js': 'https://main--milo--adobecom.aem.live/libs/a.js?access_token=SECRET' } }, /sources \/libs\/a\.js must not carry credentials \(parameter "access_token"/],
    [{ sources: { '/libs/a.js': 'https://cdn.example/a.js?X-Amz-Signature=SECRET' } }, /parameter "X-Amz-Signature"/],
    [{ sources: { '/libs/a.js': 'https://user:SECRET@cdn.example/a.js' } }, /sources \/libs\/a\.js must not contain credentials\/userinfo/],
    [{ sources: { '/libs/a.js': 'https://cdn.example/a.js#token=SECRET' } }, /parameter "token"/],
  ]) {
    assert.throws(() => validateSpec(withAfter(after)), (e) => pattern.test(e.message) && !e.message.includes('SECRET'), JSON.stringify(after));
  }
  for (const url of ['https://www.adobe.com/?api_key=SECRET', 'https://user:SECRET@www.adobe.com/']) {
    assert.throws(() => validateSpec({ ...s, variants: { before: { url }, after: { ...s.variants.after, url } } }), (e) => /before page URL must not/.test(e.message) && !e.message.includes('SECRET'), url);
  }
  validateSpec(withAfter({ sources: { '/libs/a.js': 'https://main--milo--adobecom.aem.live/libs/a.js?ref=main&key=x' } }));
  assert.throws(() => decodeSpec('not-a-spec'), /cannot decode/);
  const random = Array.from({ length: 60000 }, () => Math.random().toString(36)).join('');
  assert.throws(() => encodeSpec(spec({ variants: { ...s.variants, after: { ...s.variants.after, headInject: random } } })), new RegExp(`> ${MAX_SPEC_CHARS}`));
});

// ---------- profile ----------

const lhrWith = (over = {}) => ({
  lighthouseVersion: '13.6.0',
  configSettings: {
    formFactor: 'mobile', throttlingMethod: 'devtools', disableStorageReset: false,
    throttling: { rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.5600000000002, uploadThroughputKbps: 675, cpuSlowdownMultiplier: 4 },
    screenEmulation: { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true },
    ...over,
  },
});

test('profile: Lighthouse mobile with DevTools throttling is used as-is and verified from the resolved settings', () => {
  const c = lighthouseConfig();
  assert.equal(c.settings.throttlingMethod, 'devtools', 'real throttling, never simulated');
  assert.deepEqual(c.settings.throttling, { rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.5600000000002, uploadThroughputKbps: 675, cpuSlowdownMultiplier: CPU_SLOWDOWN_MULTIPLIER });
  assert.equal(CPU_SLOWDOWN_MULTIPLIER, 4);
  assert.equal(c.settings.maxWaitForLoad, undefined, 'Lighthouse default wait; no override');
  assert.equal(c.settings.disableStorageReset, false);
  const p = resolvedProfile(lhrWith());
  assert.deepEqual([p.throttlingMethod, p.requestLatencyMs, p.downloadThroughputKbps, p.uploadThroughputKbps, p.cpuSlowdownMultiplier], ['devtools', 562.5, 1474.56, 675, 4]);
  assert.equal(EXPECTED.throttlingMethod, 'devtools');
});

// ---------- transforms ----------

test('head injection goes before the first head script', () => {
  const r = injectIntoHead('<html><head><meta charset=utf-8><script src=a.js></script></head><body></body></html>', '<link rel=x>');
  assert.match(r.html, /<meta charset=utf-8><link rel=x>\n<script/);
  assert.equal(injectIntoHead('<p>no head</p>', 'x'), null);
});

test('guarded patches: exactly one match each, otherwise fatal (no partial edit)', () => {
  assert.equal(applyPatches('a b c', [{ find: 'b', replace: '$&B' }], '/x.js'), 'a $&B c', 'replacement is literal');
  assert.throws(() => applyPatches('a b c', [{ find: 'z', replace: '' }], '/x.js'), (e) => e.fatal && /occurs 0 times/.test(e.message));
  assert.throws(() => applyPatches('b b', [{ find: 'b', replace: '' }], '/x.js'), /occurs 2 times/);
});

test('contextual hints: CH URLs resolve to the US consumer request, never blindly; experienceedge dropped', () => {
  const page = 'https://www.adobe.com/acrobat/plans.html';
  const mas = (q) => `https://www.adobe.com/mas/io/fragment?${q}`;
  const snippet = [
    `<link rel="preload" as="fetch" href="${mas('id=1&amp;api_key=k&amp;locale=en_US&amp;country=CH').replace(/&(?!amp;)/g, '&amp;')}" crossorigin>`,
    `<link rel="preload" as="fetch" href="${mas('id=2&amp;api_key=k&amp;locale=en_US&amp;country=CH')}" crossorigin>`,
    `<link rel="preload" as="fetch" href="${mas('id=3&amp;api_key=k&amp;country=CH')}" crossorigin>`,
    `<link rel="preload" as="fetch" href="${mas('id=4&amp;country=CH')}" crossorigin>`,
    '<link rel="preload" as="fetch" href="/experienceedge/v2/interact" crossorigin>',
    '<link rel="modulepreload" href="/libs/utils/utils.js">',
    '<link rel="preload" as="fetch" href="/dc-shared/placeholders-geo-ip.json?sheet=en" crossorigin>',
  ].join('\n');
  const observed = [
    mas('id=1&api_key=k&locale=en_US&country=US'),
    mas('id=2&api_key=k&locale=en_US'), // consumer sends no country: used as-is, not rewritten CH->US
    mas('id=3&api_key=k&country=US'), mas('id=3&api_key=k&country=CA'), // ambiguous
  ];
  const { html, report } = resolveContextualHints(snippet, page, observed);
  assert.match(html, /id=1&amp;api_key=k&amp;locale=en_US&amp;country=US"/);
  assert.match(html, /id=2&amp;api_key=k&amp;locale=en_US"/);
  assert.doesNotMatch(html, /country=CH|id=3|id=4|experienceedge/);
  assert.match(html, /utils\.js/);
  assert.match(html, /placeholders-geo-ip\.json\?sheet=en/);
  assert.equal(report.links, 7);
  assert.equal(report.kept, 4);
  assert.deepEqual(report.contextual.map((c) => c.to), [observed[0], observed[1]]);
  assert.deepEqual(report.dropped.map((d) => d.reason.split(':')[0]), ['ambiguous', 'no matching request in the baseline page', '/experienceedge is never preloaded']);
});

test('only contextual hints need a baseline-first load; static bursts and excluded edge links do not', () => {
  const page = 'https://www.adobe.com/acrobat/plans.html';
  for (const href of ['/mas/io/fragment?id=x&amp;country=CH', '/data.json?LOCALE=en_US', '/data.json?market=US']) {
    assert.equal(hasContextualHints(`<link rel="preload" href="${href}">`, page), true, href);
  }
  for (const snippet of ['', '<link rel="modulepreload" href="/libs/utils.js">', '<link href="/data.json?sheet=en">', '<link href="/experienceedge/v2/interact?country=CH">']) {
    assert.equal(hasContextualHints(snippet, page), false, snippet);
  }
});

// ---------- proxy accounting ----------

test('proxy: unchanged responses keep the original compressed bytes; changed ones are Brotli q6 over HTTP/2', { timeout: 30000 }, async () => {
  const cert = makeCert('perf-ab.test');
  const js = `export const x = ${JSON.stringify('lorem ipsum dolor '.repeat(4000))};\n`;
  const wire = brotliCompressSync(Buffer.from(js), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const upstream = http2.createSecureServer({ key: cert.key, cert: cert.cert });
  upstream.on('stream', (s) => s.respond({ ':status': 200, 'content-type': 'text/javascript', 'content-encoding': 'br' }) || s.end(wire));
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const proxy = await startProxy({
    host: 'perf-ab.test', key: cert.key, cert: cert.cert, upstreamOrigin: `https://127.0.0.1:${upstream.address().port}`, upstreamOptions: { rejectUnauthorized: false },
    select: (p) => (p.startsWith('/edit') || p.startsWith('/same') ? 'asset' : null),
    transform: async ({ path: p, headers, body }) => ({ headers, body: p.startsWith('/edit') ? body.replace('lorem', 'LOREM') : body }),
  });
  const net = await import('node:net');
  const tls = await import('node:tls');
  const fetchVia = (p) => new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, '127.0.0.1', () => sock.write('CONNECT perf-ab.test:443 HTTP/1.1\r\nHost: perf-ab.test:443\r\n\r\n'));
    sock.once('data', () => {
      const session = http2.connect('https://perf-ab.test', { createConnection: () => tls.connect({ socket: sock, servername: 'perf-ab.test', ALPNProtocols: ['h2'], rejectUnauthorized: false }) });
      const req = session.request({ ':path': p });
      const chunks = [];
      let headers;
      req.on('response', (h) => { headers = h; });
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { session.close(); resolve({ headers, body: Buffer.concat(chunks) }); });
      req.on('error', reject);
    });
    sock.on('error', reject);
  });
  try {
    const same = await fetchVia('/same.js');
    const tunneled = await fetchVia('/other.js');
    const edited = await fetchVia('/edit.js');
    assert.ok(same.body.equals(wire), 'unchanged selected response: original wire bytes');
    assert.ok(tunneled.body.equals(wire), 'unselected response: piped untouched');
    assert.equal(brotliDecompressSync(edited.body).toString(), js.replace('lorem', 'LOREM'));
    assert.ok(edited.body.equals(brotliCompressSync(Buffer.from(js.replace('lorem', 'LOREM')), { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })));
    assert.equal(edited.headers['content-encoding'], 'br');
    const byPath = Object.fromEntries(proxy.requests.map((r) => [r.path, r]));
    assert.equal(byPath['/same.js'].servedEncodedBytes, byPath['/same.js'].originalEncodedBytes);
    assert.equal(byPath['/same.js'].edited, false);
    assert.equal(byPath['/edit.js'].edited, true);
    assert.ok(proxy.requests.every((r) => r.alpn === 'h2'));
  } finally {
    await proxy.close();
    upstream.close();
    cert.cleanup();
  }
});

test('proxy refuses HTTP/2 server push upstream, like Chrome (a pushing CDN must not crash the run)', { timeout: 30000 }, async () => {
  const cert = makeCert('perf-ab.test');
  const pushAllowed = [];
  const upstream = http2.createSecureServer({ key: cert.key, cert: cert.cert });
  upstream.on('stream', (s) => {
    pushAllowed.push(s.pushAllowed);
    if (s.pushAllowed) s.pushStream({ ':path': '/pushed.css' }, (err, push) => { if (!err) { push.respond({ ':status': 200 }); push.end('x'); } });
    s.respond({ ':status': 200, 'content-type': 'text/html', link: '</pushed.css>; rel=preload; as=style' });
    s.end('<!doctype html>');
  });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });
  const proxy = await startProxy({ host: 'perf-ab.test', key: cert.key, cert: cert.cert, upstreamOrigin: `https://127.0.0.1:${upstream.address().port}`, upstreamOptions: { rejectUnauthorized: false } });
  const net = await import('node:net');
  const tls = await import('node:tls');
  try {
    const body = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => sock.write('CONNECT perf-ab.test:443 HTTP/1.1\r\nHost: perf-ab.test:443\r\n\r\n'));
      sock.once('data', () => {
        const session = http2.connect('https://perf-ab.test', { createConnection: () => tls.connect({ socket: sock, servername: 'perf-ab.test', ALPNProtocols: ['h2'], rejectUnauthorized: false }) });
        const req = session.request({ ':path': '/page' });
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { session.close(); resolve(Buffer.concat(chunks).toString()); });
        req.on('error', reject);
      });
      sock.on('error', reject);
    });
    assert.equal(body, '<!doctype html>');
    assert.deepEqual(pushAllowed, [false]);
  } finally {
    await proxy.close();
    upstream.close();
    cert.cleanup();
  }
});

test('proxy DNS: one lookup per host per load, shared by concurrent tunnels; failures are not cached', async () => {
  const calls = [];
  const addrs = [{ address: '2001:db8::1', family: 6 }, { address: '203.0.113.7', family: 4 }];
  const lookup = sharedLookup((host, opts, cb) => { calls.push([host, opts]); setTimeout(() => (host === 'bad.test' ? cb(new Error('ENOTFOUND')) : cb(null, addrs)), 10); });
  const ask = (host, opts) => new Promise((resolve) => lookup(host, opts, (err, a, f) => resolve(err ? err.message : [a, f])));
  const results = await Promise.all([ask('milo.test', {}), ask('milo.test', { all: true }), ask('milo.test', { family: 4 }), ask('cdn.test', 6)]);
  assert.deepEqual(results, [['2001:db8::1', 6], [addrs, undefined], ['203.0.113.7', 4], ['2001:db8::1', 6]]);
  assert.deepEqual(await ask('milo.test', {}), ['2001:db8::1', 6]);
  assert.deepEqual(calls.map(([h]) => h), ['milo.test', 'cdn.test']);
  assert.ok(calls.every(([, o]) => o.all === true), 'resolves all addresses once, then picks per caller');
  assert.equal(await ask('bad.test', {}), 'ENOTFOUND');
  assert.equal(await ask('bad.test', {}), 'ENOTFOUND');
  assert.equal(calls.filter(([h]) => h === 'bad.test').length, 2, 'a failed lookup is retried, not cached');
});

test('proxy refuses tunnels to local/IP targets (SSRF guard)', async () => {
  const cert = makeCert('perf-ab.test');
  const proxy = await startProxy({ host: 'perf-ab.test', key: cert.key, cert: cert.cert });
  const net = await import('node:net');
  try {
    for (const target of ['127.0.0.1:22', 'localhost:443', 'example.com:8443']) {
      const reply = await new Promise((resolve) => {
        const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`));
        s.once('data', (d) => { resolve(d.toString()); s.destroy(); });
      });
      assert.match(reply, /403/, target);
    }
  } finally {
    await proxy.close();
    cert.cleanup();
  }
});

// ---------- metrics ----------

const fullLhr = () => ({
  categories: { performance: { score: 0.42 } },
  audits: Object.fromEntries([['first-contentful-paint', 1800], ['largest-contentful-paint', 5200], ['speed-index', 4000], ['total-blocking-time', 300], ['cumulative-layout-shift', 0]].map(([k, v]) => [k, { numericValue: v }])),
});

test('metrics: a run is accepted only when every required metric is a finite number (audit errors without runtimeError reject)', () => {
  assert.deepEqual(extractMetrics(fullLhr()), { performance: 42, FCP: 1800, LCP: 5200, SI: 4000, TBT: 300, CLS: 0 });
  const lcpErr = fullLhr();
  lcpErr.audits['largest-contentful-paint'] = { score: null, numericValue: undefined, errorMessage: 'NO_LCP' };
  assert.throws(() => extractMetrics(lcpErr), (e) => e.rejected && !e.fatal && /missing or not finite: LCP \(NO_LCP\)/.test(e.message) && e.metrics.LCP === null && e.metrics.FCP === 1800);
  const noScore = fullLhr();
  noScore.categories.performance.score = null;
  delete noScore.audits['total-blocking-time'];
  assert.deepEqual(extractMetrics(noScore), { performance: null, FCP: 1800, LCP: 5200, SI: 4000, TBT: null, CLS: 0 }, 'score and TBT are optional (no TTI)');
  const nan = fullLhr();
  nan.audits['speed-index'].numericValue = NaN;
  assert.throws(() => extractMetrics(nan), /SI/);
  assert.equal(median([3, 1, 2]), 2);
  assert.throws(() => median([1, null, 3]), /non-finite/, 'medians never silently skip a missing value');
});

// ---------- job fail-closed ----------

test('job: non-US or unknown egress fails before any browser is launched; cert is never inside out', async () => {
  for (const fetchJson of [answers({ ipinfo: { country: 'CH' }, ifconfig: { country_iso: 'CH' }, ipapi: { country: 'CH' } }), async () => { throw new Error('offline'); }]) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-job-'));
    let launched = 0;
    try {
      const r = await runJob({ spec: spec(), requestId: 'test-request-1', out, fetchJson, launchBrowser: async () => { launched += 1; throw new Error('no'); }, log: () => {}, warn: () => {} });
      assert.equal(r.status, 'failed');
      assert.equal(r.errorKind, 'fatal');
      assert.match(r.error, /US egress verification failed/);
      assert.equal(r.egress.ok, false);
      assert.equal(launched, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).status, 'failed');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-job-'));
  try {
    assert.throws(() => makeCert('x.test', path.dirname(out) === os.tmpdir() ? os.tmpdir() : out), /must not be inside/);
    fs.writeFileSync(path.join(out, 'k.pem'), '-----BEGIN PRIVATE KEY-----\n');
    assert.equal(scanForKeys(out).length, 1);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- local location ----------

const fakeDns = (hostname, opts, cb) => cb(null, [{ address: '23.192.0.10', family: 4 }]);
const swissEgress = answers({ ipinfo: { country: 'CH' }, ifconfig: { country_iso: 'CH' }, ipapi: { country: 'CH' } });

test('local egress: a known non-US country is allowed only when asked for and is recorded honestly; unknown still fails', async () => {
  const r = await verifyUsEgress({ fetchJson: swissEgress, allowNonUs: true });
  assert.deepEqual([r.ok, r.country], [false, 'CH']);
  const mixed = await verifyUsEgress({ fetchJson: answers({ ipinfo: { country: 'US' }, ifconfig: { country_iso: 'CH' }, ipapi: new Error('x') }), allowNonUs: true });
  assert.deepEqual([mixed.ok, mixed.country], [false, null]);
  await assert.rejects(verifyUsEgress({ fetchJson: async () => { throw new Error('offline'); }, allowNonUs: true }), /country unknown/);
  await assert.rejects(verifyUsEgress({ fetchJson: swissEgress }), /not US/);
});

test('job: --local does no egress check, records no country, adds no egress warning and launches', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-job-local-'));
  let launched = 0;
  try {
    const r = await runJob({
      spec: spec(), requestId: 'test-local-1', out, where: 'local', fetchJson: swissEgress, dnsLookup: fakeDns,
      launchBrowser: async () => { launched += 1; throw new Error('stub browser'); }, log: () => {}, warn: () => {},
    });
    assert.ok(launched >= 1, 'local does not stop at a non-US egress');
    launched = 0;
    assert.equal(r.where, 'local');
    assert.equal(r.mode, 'pagespeed-local');
    assert.deepEqual([r.egress.ok, r.egress.country, r.egress.where], [null, null, 'local']);
    assert.deepEqual(r.warnings.map((w) => w.kind), []);
    assert.match(r.error, /stub browser/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  const failClosed = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-job-local-'));
  try {
    for (const where of ['actions', undefined]) {
      const r = await runJob({ spec: spec(), requestId: 'test-local-2', out: failClosed, where, fetchJson: swissEgress, launchBrowser: async () => { launched += 1; }, log: () => {}, warn: () => {} });
      assert.equal(r.status, 'failed');
      assert.match(r.error, /US egress verification failed/);
      assert.equal(r.where, 'actions');
    }
    assert.equal(launched, 0, 'Actions never launches on a non-US egress');
    const bad = await runJob({ spec: spec(), requestId: 'test-local-4', out: failClosed, where: 'cloud', fetchJson: swissEgress, log: () => {}, warn: () => {} });
    assert.match(bad.error, /invalid measurement location/);
  } finally {
    fs.rmSync(failClosed, { recursive: true, force: true });
  }
});

test('chrome discovery: CHROME_PATH first, then common macOS/Linux paths, otherwise a clear error', () => {
  const only = (...files) => (f) => files.includes(f);
  assert.equal(findChromePath({ preferred: '/x/chrome', isExecutable: only('/x/chrome') }), '/x/chrome');
  assert.throws(() => findChromePath({ preferred: '/x/missing', isExecutable: only() }), /CHROME_PATH does not point to an executable Chrome: \/x\/missing/);
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(findChromePath({ preferred: '', platform: 'darwin', isExecutable: only(mac) }), mac);
  assert.equal(findChromePath({ preferred: '', platform: 'linux', isExecutable: only('/usr/bin/google-chrome-stable') }), '/usr/bin/google-chrome-stable');
  assert.ok(chromeCandidates({ platform: 'darwin', home: '/h' }).includes('/h/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.equal(findChromePath({ preferred: '', platform: 'win32', isExecutable: () => true }), null);
  assert.throws(() => requireChromePath({ preferred: '', platform: 'linux', isExecutable: only() }), /Chrome was not found\. Set CHROME_PATH/);
});

test('runLocal: pairs run sequentially through the shared job, then the shared aggregate (local marker, no US label)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-local-'));
  const order = [];
  const base = { names: ['before', 'after'], url: 'https://www.adobe.com/acrobat/plans.html', profile: EXPECTED, chromeVersion: 'Chrome/150', where: 'local', cold: { warmups: 0 }, egress: { ok: false, country: 'CH', where: 'local', checks: [] }, documentGeo: [], rejected: [] };
  const metrics = (p) => ({ performance: p, FCP: 1000, LCP: 2000, SI: 1500, TBT: 100, CLS: 0.01 });
  const measurePair = async ({ spec: s, requestId, out: dir, pair, where }) => {
    order.push(`start${pair}`);
    await new Promise((r) => { setTimeout(r, 5); });
    order.push(`end${pair}`);
    assert.equal(where, 'local');
    fs.mkdirSync(path.join(dir, `after${pair}`), { recursive: true });
    const r = { ...base, requestId, status: 'ok', pair, runs: [{ variant: 'before', run: pair, dir: `before${pair}`, metrics: metrics(50) }, { variant: 'after', run: pair, dir: `after${pair}`, metrics: metrics(60) }], runsPerVariant: s.runs };
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(r));
    return r;
  };
  const warnings = [];
  try {
    fs.mkdirSync(path.join(out, 'pair9'));
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep');
    const results = await runLocal({ spec: spec({ runs: 2 }), out, requestId: 'local-test-1', root: process.cwd(), measurePair, log: () => {}, warn: (m) => warnings.push(m) });
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
    assert.equal(results.status, 'ok');
    assert.equal(results.where, 'local');
    assert.equal(results.mode, 'pagespeed-local-paired');
    assert.equal(results.egress.country, 'CH');
    assert.equal(results.medians.delta.performance, 10);
    assert.deepEqual(results.warnings.map((w) => w.kind), ['local-results-not-comparable']);
    assert.match(results.warnings[0].message, /not comparable with Actions results/);
    assert.deepEqual(warnings, [], 'no pair failed');
    assert.deepEqual(fs.readdirSync(out).sort(), ['notes.txt', 'pair1', 'pair2', 'results.json']);
    assert.ok(fs.existsSync(path.join(out, 'pair2', 'after2')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- remote client ----------

function fakeGh({ conclusion = 'success', results, failAt, files = {} } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (failAt === key) throw new Error(`gh ${key} failed: HTTP 403`);
    if (key === 'workflow run') gh.rid = args.find((a) => a.startsWith('request_id=')).split('=')[1];
    if (key === 'run list') return JSON.stringify([{ databaseId: 7, displayTitle: 'perf-ab other', status: 'completed', conclusion: 'success', url: 'u0' }, { databaseId: 42, displayTitle: `perf-ab ${gh.rid}`, status: 'in_progress', url: 'https://github.com/x/runs/42' }]);
    if (key === 'run view') return args.includes('--log-failed') ? 'step log line' : JSON.stringify({ status: 'completed', conclusion });
    if (key === 'run download') {
      const dir = args[args.indexOf('-D') + 1];
      const r = typeof results === 'function' ? results(gh.rid) : results;
      if (r) fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(r));
      for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
    }
    return '';
  };
  gh.calls = calls;
  return gh;
}
const okResults = (rid) => ({ requestId: rid, status: 'ok', profile: { cpuSlowdownMultiplier: 1.2 }, egress: { country: 'US' }, medians: {}, rejected: [] });
const remoteOpts = (gh, out) => ({ spec: spec(), out, gh, pollMs: 1, wait: async () => {}, log: () => {} });

test('remote: dispatches with inputs only, waits, downloads into -o and clears stale results there', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-remote-'));
  try {
    for (const stale of ['after3', 'rejected']) fs.mkdirSync(path.join(out, stale));
    fs.writeFileSync(path.join(out, 'after2.json'), '{}');
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep');
    const gh = fakeGh({ results: okResults, files: { 'before1/report.html': '<html>', 'after1/trace.json': '{}' } });
    const r = await runRemote(remoteOpts(gh, out));
    assert.equal(r.results.status, 'ok');
    assert.equal(r.runUrl, 'https://github.com/x/runs/42');
    const dispatch = gh.calls.find((c) => c[0] === 'workflow');
    assert.deepEqual(dispatch.slice(0, 7), ['workflow', 'run', 'perf-ab.yml', '-R', 'adobecom/perf-tools', '--ref', 'main']);
    assert.equal(decodeSpec(dispatch.find((a) => a.startsWith('spec=')).slice(5)).runs, 1);
    assert.deepEqual(fs.readdirSync(out).sort(), ['after1', 'before1', 'notes.txt', 'results.json']);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('remote: auth, dispatch permission, failed run, failed job, foreign artifact and missing US record all fail', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-remote-'));
  try {
    await assert.rejects(runRemote(remoteOpts(fakeGh({ failAt: 'auth status' }), out)), /not authenticated/);
    await assert.rejects(runRemote(remoteOpts(fakeGh({ failAt: 'workflow run' }), out)), /cannot dispatch perf-ab\.yml.*Actions write permission/);
    await assert.rejects(runRemote(remoteOpts(fakeGh({ conclusion: 'failure', results: (rid) => ({ ...okResults(rid), status: 'failed', error: 'US egress verification failed: egress is not US' }) }), out)),
      (e) => /job reported failed: US egress verification failed/.test(e.message) && /step log line/.test(e.message) && e.results.status === 'failed');
    await assert.rejects(runRemote(remoteOpts(fakeGh({ results: (rid) => ({ ...okResults(rid), status: 'failed', error: 'render check failed' }) }), out)), /job reported failed: render check failed/);
    await assert.rejects(runRemote(remoteOpts(fakeGh({ results: () => okResults('someone-else') }), out)), /belongs to request someone-else/);
    await assert.rejects(runRemote(remoteOpts(fakeGh({ results: (rid) => ({ ...okResults(rid), egress: { country: 'CH' } }) }), out)), /US egress record/);
    await assert.rejects(runRemote(remoteOpts(fakeGh({ results: null }), out)), /artifact download failed/);
    await assert.rejects(runRemote({ ...remoteOpts(fakeGh({ results: okResults }), out), timeoutMs: -1 }), /timed out/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- CLI ----------

const cliOpts = (o = {}) => ({ runs: '1', param: 'milolibs', suffix: '--milo--adobecom', ...o });

test('CLI spec: unchanged URL measures one variant; changes give before=production / after=changed', () => {
  const page = 'https://www.adobe.com/acrobat/plans.html';
  assert.deepEqual(buildSpec(cliOpts(), page).names, ['after']);
  const files = { 'h.html': '<link rel="preload" href="/x.json" as="fetch" crossorigin>', 'p.json': JSON.stringify({ replacements: [{ path: '/libs/utils/utils.js', find: 'a', replace: 'b' }] }) };
  const s = buildSpec(cliOpts({ 'head-inject': 'h.html', patch: 'p.json' }), page, { readFile: (f) => files[f] });
  assert.deepEqual(s.names, ['before', 'after']);
  assert.deepEqual(s.variants.before, { url: page });
  assert.equal(s.variants.after.headInject, files['h.html']);
  const b = buildSpec(cliOpts({ before: 'stage', after: 'feat' }), page);
  assert.equal(new URL(b.variants.after.url).searchParams.get('milolibs'), 'feat--milo--adobecom');
  const pr = buildSpec(cliOpts({ 'milo-pr': '7095' }), page);
  assert.deepEqual(pr.names, ['before', 'after']);
  assert.deepEqual(pr.variants.before, { url: page });
  assert.deepEqual(pr.variants.after.pullRequests, [{ repo: 'adobecom/milo', number: 7095 }]);
  assert.throws(() => buildSpec(cliOpts({ 'mas-pr': '0' }), page), /positive PR number/);
  assert.throws(() => buildSpec(cliOpts({ runs: '0' }), page), /--runs/);
  assert.throws(() => buildSpec(cliOpts({ after: 'x' }), page), /together/);
  const link = buildSpec(cliOpts({ 'link-remove': ['*'], 'link-replace': ['</libs/b.js>; rel=modulepreload'], 'link-add': ['</acrobat/preloads/plans.json>; rel=preload; as=fetch; crossorigin=anonymous'] }), page);
  assert.deepEqual(link.names, ['before', 'after']);
  assert.deepEqual(link.variants.before, { url: page });
  assert.deepEqual(link.variants.after, {
    url: page,
    linkHeader: { remove: ['*'], replace: ['</libs/b.js>; rel=modulepreload'], add: ['</acrobat/preloads/plans.json>; rel=preload; as=fetch; crossorigin=anonymous'] },
  });
  assert.deepEqual(buildSpec(cliOpts({ 'link-add': ['</x.json>; rel=preload; as=fetch'] }), page).variants.after.linkHeader, { add: ['</x.json>; rel=preload; as=fetch'] });
  assert.throws(() => buildSpec(cliOpts({ 'link-add': [true] }), page), /--link-add needs a value/);
  assert.throws(() => buildSpec(cliOpts({ 'link-add': ['/x.json'] }), page), /one Link entry/);
  const only = buildSpec(cliOpts({ 'link-remove': ['*'], 'after-only': true }), page);
  assert.deepEqual(only.names, ['after']);
  assert.deepEqual(only.variants, { after: { url: page, linkHeader: { remove: ['*'] } } });
  assert.throws(() => buildSpec(cliOpts({ 'after-only': true }), page), /--after-only needs a change option/);
});

test('CLI: Actions is the default location, --local opts into the shared Lighthouse job, and legacy flags are gone', async () => {
  const node = process.execPath;
  const cli = path.join(BIN, 'perf-ab.mjs');
  for (const flag of ['--local-devtools', '--override', '--override-before', '--pr-local', '--device', '--cpu', '--channel', '--headless', '--settle', '--lcp-wait']) {
    await assert.rejects(run(node, [cli, 'https://www.adobe.com/', flag]), (e) => e.code === 1 && new RegExp(`unknown option\\(s\\): ${flag}`).test(e.stderr));
  }
  await assert.rejects(run(node, [cli, 'https://www.adobe.com/', '--bogus']), (e) => /unknown option\(s\): --bogus/.test(e.stderr));
  const { stdout } = await run(node, [cli, '--help']);
  assert.match(stdout, /Lighthouse 13\.6\.0/);
  assert.match(stdout, /DevTools\s+throttling/);
  assert.match(stdout, /562\.5 ms request latency.*4x CPU/s);
  assert.doesNotMatch(stdout, /simulat|lr-mobile|PageSpeed Insights/i);
  assert.match(stdout, /Default location: GitHub Actions/);
  assert.match(stdout, /--local runs the identical Lighthouse job/);
  assert.match(stdout, /local results are not comparable with Actions results/);
  for (const flag of ['--link-add <entry>', '--link-remove <url\\|\\*>', '--link-replace <entry>']) assert.match(stdout, new RegExp(flag));
  await assert.rejects(run(node, [cli, '--config', 'experiments/x.json', '--link-add', '</x.json>; rel=preload']), (e) => e.code === 1 && /remove --link-add/.test(e.stderr));
});

test('perf-preload: exposes the same local location switch and rejects removed local DevTools options', async () => {
  const cli = path.join(BIN, 'perf-preload.mjs');
  const { stdout } = await run(process.execPath, [cli, 'https://www.adobe.com/', '--help']);
  assert.match(stdout, /Actions is the default/);
  assert.match(stdout, /--local runs on this machine/);
  await assert.rejects(run(process.execPath, [cli, 'https://www.adobe.com/', '--cpu', '4']), (e) => e.code === 1 && /Unknown option/.test(e.stderr));
});

// ---------- Link header preloads ----------

test('stripPreloadLinks: preload and modulepreload entries are unset, everything else stays', () => {
  const header = '</libs/utils/utils.js>;rel=preload;as=script;crossorigin, </libs/deps/imslib.min.js>; rel="modulepreload", </creativecloud/plans.json>;rel=preload;as=fetch, <https://cdn.example/>; rel=preconnect, <https://www.adobe.com/a>; rel="canonical", </x.css>; rel="preload prefetch"; as=style';
  const r = stripPreloadLinks(header);
  assert.deepEqual(r.removed, ['</libs/utils/utils.js>;rel=preload;as=script;crossorigin', '</libs/deps/imslib.min.js>; rel="modulepreload"', '</creativecloud/plans.json>;rel=preload;as=fetch', '</x.css>; rel="preload prefetch"; as=style']);
  assert.equal(r.value, '<https://cdn.example/>; rel=preconnect, <https://www.adobe.com/a>; rel="canonical", </x.css>; rel="prefetch"; as=style');
  assert.deepEqual(stripPreloadLinks('</a.js>; rel=preload'), { value: null, removed: ['</a.js>; rel=preload'] });
  assert.deepEqual(stripPreloadLinks(undefined), { value: null, removed: [] });
  assert.deepEqual(stripPreloadLinks('<https://x/>; rel=preconnect'), { value: '<https://x/>; rel=preconnect', removed: [] });
});

const PLANS = 'https://www.adobe.com/acrobat/plans.html';
const PRELINK = '</acrobat/preloads/plans.json>; rel=preload; as=fetch; crossorigin=anonymous';

test('Link header edits: remove, replace and add by resolved target URL, guarded like patches', () => {
  const header = '</libs/utils/utils.js>;rel=preload;as=script;crossorigin=anonymous, </libs/martech/martech.js>;rel=preload;as=script;crossorigin=anonymous, <https://www.adobe.com/acrobat/plans.html>; rel="canonical"';
  const r = applyLinkHeaderEdits(header, {
    remove: ['https://www.adobe.com/libs/martech/martech.js'],
    replace: ['</libs/utils/utils.js>; rel=modulepreload'],
    add: [PRELINK],
  }, PLANS);
  assert.deepEqual(r.removed, ['</libs/martech/martech.js>;rel=preload;as=script;crossorigin=anonymous']);
  assert.deepEqual(r.replaced, [{ from: '</libs/utils/utils.js>;rel=preload;as=script;crossorigin=anonymous', to: '</libs/utils/utils.js>; rel=modulepreload' }]);
  assert.deepEqual(r.added, [PRELINK]);
  assert.equal(r.value, `</libs/utils/utils.js>; rel=modulepreload, <https://www.adobe.com/acrobat/plans.html>; rel="canonical", ${PRELINK}`);
  // A page without a Link header gets the prelink as its only entry; removing the last entry drops the header.
  assert.equal(applyLinkHeaderEdits(undefined, { add: [PRELINK] }, PLANS).value, PRELINK);
  assert.equal(applyLinkHeaderEdits('</a.js>; rel=preload; as=script', { remove: ['/a.js'] }, PLANS).value, null);
  // "*" removes every preload/modulepreload entry and keeps the rest: replacing all preloads = remove "*" + add.
  const all = applyLinkHeaderEdits(header, { remove: ['*'], add: [PRELINK] }, PLANS);
  assert.equal(all.removed.length, 2);
  assert.equal(all.value, `<https://www.adobe.com/acrobat/plans.html>; rel="canonical", ${PRELINK}`);
  for (const [value, edits, pattern] of [
    [header, { remove: ['/libs/missing.js'] }, /remove \/libs\/missing\.js matches no entry/],
    ['<https://x/>; rel=preconnect', { remove: ['*'] }, /remove \* matches no rel=preload\/modulepreload entry/],
    [header, { replace: ['</libs/missing.js>; rel=preload; as=script'] }, /has 0 entries for it, expected exactly 1/],
    ['</a.js>; rel=preload, </a.js>; rel=prefetch', { replace: ['</a.js>; rel=modulepreload'] }, /has 2 entries for it/],
    ['</a.js>;rel=preload;as=script', { replace: ['</a.js>; rel=preload; as=script'] }, /identical to the served entry/],
    [header, { add: ['<https://www.adobe.com/libs/utils/utils.js>; rel=modulepreload'] }, /already has an entry for it; use replace/],
  ]) assert.throws(() => applyLinkHeaderEdits(value, edits, PLANS), (e) => e.fatal && pattern.test(e.message), JSON.stringify(edits));
});

test('spec: Link header edits are after-only single entries with https/root-relative targets and no conflicts', () => {
  const withEdits = (linkHeader, extra = {}) => ({
    version: 1, runs: 1, names: ['before', 'after'],
    variants: { before: { url: PLANS, ...extra.before }, after: { url: PLANS, linkHeader, ...extra.after } },
  });
  const ok = withEdits({ remove: ['*', 'https://www.adobe.com/libs/a.js'], replace: ['</libs/b.js>; rel=modulepreload'], add: [PRELINK, '<https://use.typekit.net/x.css>; rel=preload; as=style'] });
  assert.deepEqual(decodeSpec(encodeSpec(ok)), ok);
  validateSpec(withEdits({ add: [PRELINK] }, { after: { headInject: '<link rel="preload" href="/a.js" as="script">' } }));
  for (const [s, pattern] of [
    [withEdits({ add: [PRELINK] }, { before: { linkHeader: { add: [PRELINK] } } }), /before\.linkHeader: Link header edits apply to the after variant only/],
    [withEdits([PRELINK]), /must be an object/],
    [withEdits({ insert: [PRELINK] }), /unknown field\(s\): insert/],
    [withEdits({ add: [] }), /add must be a non-empty array/],
    [withEdits({}), /at least one remove, replace or add entry/],
    [withEdits({ add: [`${PRELINK}\r\nset-cookie: a=1`] }), /single-line strings/],
    [withEdits({ add: ['/acrobat/preloads/plans.json'] }), /one Link entry "<url>; rel=\.\.\."/],
    [withEdits({ add: ['</a.json>; rel=preload, </b.json>; rel=preload'] }), /one Link entry/],
    [withEdits({ replace: ['</a.json>; as=fetch'] }), /<\/a\.json> needs a rel parameter/],
    [withEdits({ add: ['<http://www.adobe.com/a.json>; rel=preload; as=fetch'] }), /root-relative paths or https URLs/],
    [withEdits({ add: ['<//cdn.example/a.json>; rel=preload; as=fetch'] }), /root-relative paths or https URLs/],
    [withEdits({ remove: ['libs/a.js'] }), /root-relative paths or https URLs/],
    [withEdits({ remove: ['/libs/a.js', 'https://www.adobe.com/libs/a.js'] }), /remove lists https:\/\/www\.adobe\.com\/libs\/a\.js twice/],
    [withEdits({ remove: ['*', '*'] }), /remove lists \* twice/],
    [withEdits({ remove: ['/a.js'], replace: ['</a.js>; rel=preload; as=script'] }), /both removed and replaced/],
    [withEdits({ replace: ['</a.js>; rel=preload; as=script'], add: ['</a.js>; rel=modulepreload'] }), /both replaced and added/],
    [withEdits({ remove: ['*'] }, { after: { headInject: '<link rel="preload" href="/a.js" as="script">' } }), /redundant with headInject/],
    [withEdits({ add: Array.from({ length: 101 }, (_, i) => `</p${i}.json>; rel=preload; as=fetch`) }), /at most 100 entries/],
  ]) assert.throws(() => validateSpec(s), pattern, pattern.source);
  assert.throws(() => validateSpec(withEdits({ add: ['<https://cdn.example/a.json?token=SECRET>; rel=preload; as=fetch'] })),
    (e) => /must not carry credentials \(parameter "token"/.test(e.message) && !e.message.includes('SECRET'));
});

// ---------- local: GitHub token and no Actions dispatch ----------

test('local GitHub token: GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`; junk and absence give null', () => {
  const t1 = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const t2 = 'gho_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const t3 = 'github_pat_cccccccccccccccccccccccccccccc';
  const never = () => { throw new Error('gh must not be asked'); };
  assert.equal(findGithubToken({ env: { GITHUB_TOKEN: t1, GH_TOKEN: t2 }, authToken: never }), t1);
  assert.equal(findGithubToken({ env: { GH_TOKEN: ` ${t2}\n` }, authToken: never }), t2);
  assert.equal(findGithubToken({ env: {}, authToken: () => `${t3}\n` }), t3);
  assert.equal(findGithubToken({ env: { GITHUB_TOKEN: 'x y\nInjected: header' }, authToken: () => '' }), null);
  assert.equal(findGithubToken({ env: {}, authToken: () => { throw new Error('no gh'); } }) ?? null, null);
});

test('runLocal: PR resolution gets the local token only when a PR is requested; no workflow is ever dispatched', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-local-pr-'));
  const calls = [];
  const resolvePrs = async (requests, { token }) => {
    calls.push({ requests, token });
    return { localSources: {}, sourcePrs: [] };
  };
  const measurePair = async () => ({ status: 'failed', errorKind: 'fatal', error: 'stub' });
  try {
    const withPr = spec({ variants: { before: { url: 'https://www.adobe.com/acrobat/plans.html' }, after: { url: 'https://www.adobe.com/acrobat/plans.html', pullRequests: [{ repo: 'adobecom/milo', number: 7095 }] } } });
    await runLocal({ spec: withPr, out, requestId: 'local-pr-1', resolvePrs, findToken: () => 'tok-secret-value-000000000', measurePair, log: () => {}, warn: () => {} });
    assert.deepEqual(calls.map((c) => [c.requests, c.token]), [[[{ repo: 'adobecom/milo', number: 7095 }], 'tok-secret-value-000000000']]);
    calls.length = 0;
    let asked = 0;
    await runLocal({ spec: spec(), out, requestId: 'local-pr-2', resolvePrs, findToken: () => { asked += 1; return 'x'; }, measurePair, log: () => {}, warn: () => {} });
    assert.equal(asked, 0, 'no token lookup without a PR');
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  // CLI level: --local never calls `gh workflow ...` (a stub gh records every call; only `gh auth token` is allowed).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-stubgh-'));
  const log = path.join(bin, 'calls.log');
  try {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    const outDir = path.join(bin, 'out');
    const r = await run(process.execPath, [path.join(BIN, 'perf-ab.mjs'), 'https://www.adobe.com/acrobat/plans.html', '--local', '-n', '1', '-o', outDir], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CHROME_PATH: path.join(bin, 'no-such-chrome'), GITHUB_TOKEN: '', GH_TOKEN: '' },
    }).catch((e) => e);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CHROME_PATH does not point to an executable Chrome/);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.ok(calls.every((c) => c === 'auth token'), `unexpected gh calls: ${calls.join(' | ')}`);
    assert.ok(!calls.some((c) => /workflow|run |dispatch/.test(c)));
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
