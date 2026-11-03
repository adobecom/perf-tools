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
import { encodeSpec, decodeSpec, validateSpec, MAX_SPEC_CHARS } from '../lib/pagespeed/spec.mjs';
import { verifyProfile, lighthouseConfig, EXPECTED } from '../lib/pagespeed/profile.mjs';
import {
  injectIntoHead, prioritizeSnippet, prioritizeLinkHeader, applyPatches, resolveContextualHints, parsePriorityRules,
} from '../lib/pagespeed/transforms.mjs';
import { runRemote } from '../lib/pagespeed/remote.mjs';
import { runJob, makeCert, scanForKeys, extractMetrics, median } from '../lib/pagespeed/job.mjs';
import { startProxy } from '../lib/pagespeed/proxy.mjs';
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
  assert.throws(() => decodeSpec('not-a-spec'), /cannot decode/);
  const random = Array.from({ length: 60000 }, () => Math.random().toString(36)).join('');
  assert.throws(() => encodeSpec(spec({ variants: { ...s.variants, after: { ...s.variants.after, headInject: random } } })), new RegExp(`> ${MAX_SPEC_CHARS}`));
});

// ---------- profile ----------

const lhrWith = (over = {}) => ({
  lighthouseVersion: '13.6.0',
  configSettings: {
    formFactor: 'mobile', throttlingMethod: 'simulate', disableStorageReset: false,
    throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 1.2 },
    screenEmulation: { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true },
    ...over,
  },
});

test('profile: the lr-mobile preset is used as-is and verified from the resolved settings', () => {
  const c = lighthouseConfig();
  assert.equal(c.settings.throttling.cpuSlowdownMultiplier, 1.2);
  assert.deepEqual(Object.keys(c.settings.throttling), ['cpuSlowdownMultiplier'], 'RTT/throughput come from the preset defaults, not local values');
  assert.equal(c.settings.disableStorageReset, false);
  assert.equal(verifyProfile(lhrWith()).cpuSlowdownMultiplier, EXPECTED.cpuSlowdownMultiplier);
  assert.throws(() => verifyProfile(lhrWith({ throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } })), /cpuSlowdownMultiplier=4/);
  assert.throws(() => verifyProfile(lhrWith({ throttlingMethod: 'devtools' })), /throttlingMethod/);
  assert.throws(() => verifyProfile({ ...lhrWith(), lighthouseVersion: '13.5.0' }), /lighthouseVersion/);
  assert.throws(() => verifyProfile(lhrWith({ disableStorageReset: true })), /not be cold/);
});

// ---------- transforms ----------

test('head injection goes before the first head script; fetchpriority on hints and Link header entries', () => {
  const r = injectIntoHead('<html><head><meta charset=utf-8><script src=a.js></script></head><body></body></html>', '<link rel=x>');
  assert.match(r.html, /<meta charset=utf-8><link rel=x>\n<script/);
  assert.equal(injectIntoHead('<p>no head</p>', 'x'), null);
  const rules = parsePriorityRules(['/libs/utils/utils.js=high', '/libs/blocks/merch/merch.js=auto']);
  assert.throws(() => parsePriorityRules(['utils.js=high']), /Bad --fetchpriority/);
  const s = prioritizeSnippet('<link rel="modulepreload" href="/libs/utils/utils.js" fetchpriority="low">\n<link rel="modulepreload" href="https://www.adobe.com/libs/blocks/merch/merch.js"/>\n<link rel="preload" href="https://other.example/libs/utils/utils.js" as="script">', rules, 'https://www.adobe.com/acrobat/plans.html');
  assert.match(s.html, /utils\.js" fetchpriority="high">/);
  assert.doesNotMatch(s.html, /fetchpriority="low"/);
  assert.match(s.html, /merch\.js" fetchpriority="auto" \/>/);
  assert.match(s.html, /other\.example\/libs\/utils\/utils\.js" as="script">/, 'other origins untouched');
  const h = prioritizeLinkHeader('</libs/utils/utils.js>; rel=modulepreload; fetchpriority=low, </libs/x.css>; rel=preload; as=style', rules, 'https://www.adobe.com/acrobat/plans.html');
  assert.equal(h.value, '</libs/utils/utils.js>; rel=modulepreload; fetchpriority=high, </libs/x.css>; rel=preload; as=style');
  assert.deepEqual(h.applied, ['/libs/utils/utils.js']);
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

test('metrics: a run is accepted only when every metric is a finite number (audit errors without runtimeError reject)', () => {
  assert.deepEqual(extractMetrics(fullLhr()), { performance: 42, FCP: 1800, LCP: 5200, SI: 4000, TBT: 300, CLS: 0 });
  const lcpErr = fullLhr();
  lcpErr.audits['largest-contentful-paint'] = { score: null, numericValue: undefined, errorMessage: 'NO_LCP' };
  assert.throws(() => extractMetrics(lcpErr), (e) => e.rejected && !e.fatal && /missing or not finite: LCP \(NO_LCP\)/.test(e.message) && e.metrics.LCP === null && e.metrics.FCP === 1800);
  const noScore = fullLhr();
  noScore.categories.performance.score = null;
  delete noScore.audits['total-blocking-time'];
  assert.throws(() => extractMetrics(noScore), /performance, TBT/);
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

const cliOpts = (o = {}) => ({ runs: '1', param: 'milolibs', suffix: '--milo--adobecom', 'before-query': '', 'after-query': '', fetchpriority: [], 'expect-count': [], ...o });

test('CLI spec: unchanged URL measures one variant; changes give before=production / after=changed', () => {
  const page = 'https://www.adobe.com/acrobat/plans.html';
  assert.deepEqual(buildSpec(cliOpts(), page).names, ['after']);
  const files = { 'h.html': '<link rel="preload" href="/x.json" as="fetch" crossorigin>', 'p.json': JSON.stringify({ replacements: [{ path: '/libs/utils/utils.js', find: 'a', replace: 'b' }] }) };
  const s = buildSpec(cliOpts({ 'head-inject': 'h.html', patch: 'p.json', fetchpriority: ['/libs/utils/utils.js=high'], 'expect-title': 'Acrobat plans', 'expect-count': ['merch-card=19'] }), page, { readFile: (f) => files[f] });
  assert.deepEqual(s.names, ['before', 'after']);
  assert.deepEqual(s.variants.before, { url: page });
  assert.equal(s.variants.after.headInject, files['h.html']);
  assert.deepEqual(s.variants.after.priorities, [{ path: '/libs/utils/utils.js', priority: 'high' }]);
  assert.deepEqual(s.expect, { title: 'Acrobat plans', counts: [{ selector: 'merch-card', count: 19 }] });
  const b = buildSpec(cliOpts({ before: 'stage', after: 'feat' }), page);
  assert.equal(new URL(b.variants.after.url).searchParams.get('milolibs'), 'feat--milo--adobecom');
  assert.throws(() => buildSpec(cliOpts({ runs: '0' }), page), /--runs/);
  assert.throws(() => buildSpec(cliOpts({ after: 'x' }), page), /together/);
});

test('CLI: legacy local DevTools options require the explicit --local-devtools flag; help shows the US default', async () => {
  const node = process.execPath;
  const cli = path.join(BIN, 'perf-ab.mjs');
  for (const flag of [['--device', 'Pixel 7'], ['--cpu', '4'], ['--override', 'x'], ['--headless']]) {
    await assert.rejects(run(node, [cli, 'https://www.adobe.com/', ...flag]), (e) => e.code === 1 && /only exist in the legacy local DevTools mode; add --local-devtools/.test(e.stderr));
  }
  await assert.rejects(run(node, [cli, 'https://www.adobe.com/', '--bogus']), (e) => /unknown option\(s\): --bogus/.test(e.stderr));
  const { stdout } = await run(node, [cli, '--help']);
  assert.match(stdout, /Lighthouse 13\.6\.0/);
  assert.match(stdout, /VERIFIED US egress/);
  assert.match(stdout, /No local fallback/);
  const legacy = await run(node, [cli, '--local-devtools', 'https://www.adobe.com/', '--help']);
  assert.match(legacy.stdout, /LEGACY LOCAL DEVTOOLS MODE \(explicit opt-in; not PageSpeed\/Lighthouse, not US\)/);
});

test('perf-preload: legacy-only capture options require --local-devtools', async () => {
  await assert.rejects(run(process.execPath, [path.join(BIN, 'perf-preload.mjs'), 'https://www.adobe.com/', '--cpu', '4']), (e) => e.code === 1 && /--local-devtools/.test(e.stderr));
});
