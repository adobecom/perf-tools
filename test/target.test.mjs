// Benchmark target policy: only https *.adobe.com pages, every main-frame hop validated, no private destinations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isAdobeHost, assertTargetUrl, isPublicAddress, assertPublicHost, publicOnlyLookup, mainFrameDocumentUrls, assertMainFrameTargets,
} from '../lib/target.mjs';
import { runJob, makeCert } from '../lib/pagespeed/job.mjs';
import { startProxy } from '../lib/pagespeed/proxy.mjs';

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin');
const run = promisify(execFile);
const fakeLookup = (map) => (hostname, opts, cb) => {
  const a = map[hostname];
  if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  return cb(null, a.map((address) => ({ address, family: net.isIP(address) })));
};

test('target: accepts https *.adobe.com pages only', () => {
  for (const ok of ['https://www.adobe.com/acrobat/plans.html', 'https://business.adobe.com/', 'https://main--cc--adobecom.aem.page.adobe.com/x?a=1#h', 'https://WWW.Adobe.com/']) {
    assert.doesNotThrow(() => assertTargetUrl(ok), ok);
  }
  for (const bad of [
    'https://adobe.com/', // apex is not *.adobe.com
    'https://www.adobe.com.evil.example/',
    'https://evil-adobe.com/',
    'https://wwwadobe.com/',
    'https://www.adobe.co/',
    'https://www.adobe.com@evil.example/',
    'https://user:pw@www.adobe.com/',
    'https://www.adobe.com:8443/',
    'https://www.adobe.com./',
    'http://www.adobe.com/',
    'ftp://www.adobe.com/',
    'https://127.0.0.1/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://evil.example/#www.adobe.com',
    'https://evil.example/?u=https://www.adobe.com/',
    'https://evil.example\\@www.adobe.com/',
    'https://www..adobe.com/',
    'https://-x.adobe.com/',
    'not a url',
    '',
  ]) {
    assert.throws(() => assertTargetUrl(bad), (e) => e.fatal === true && e.code === 'ETARGET', bad);
  }
  assert.equal(isAdobeHost('adobe.com.evil.example'), false);
  assert.equal(isAdobeHost('www.adobe.com'), true);
});

test('target: loopback fixtures only with the explicit switch, and never other domains', () => {
  assert.throws(() => assertTargetUrl('http://localhost:8080/page'), /https/);
  assert.doesNotThrow(() => assertTargetUrl('http://localhost:8080/page', { allowLoopbackFixture: true }));
  assert.doesNotThrow(() => assertTargetUrl('http://127.0.0.1:9/page', { allowLoopbackFixture: true }));
  assert.throws(() => assertTargetUrl('http://10.0.0.1/page', { allowLoopbackFixture: true }), /https/);
  assert.throws(() => assertTargetUrl('https://evil.example/', { allowLoopbackFixture: true }), /adobe\.com/);
  assert.throws(() => assertTargetUrl('http://u:p@localhost/', { allowLoopbackFixture: true }), /https/);
});

test('target: private/reserved destinations are not public', () => {
  for (const a of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.5.4', '192.168.1.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', 'nope']) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['23.192.0.10', '8.8.8.8', '2600:1406::1', '::ffff:23.192.0.10']) assert.equal(isPublicAddress(a), true, a);
});

test('target: host resolution and connect-time lookup refuse non-public answers', async () => {
  const lookup = fakeLookup({ 'www.adobe.com': ['23.192.0.10', '2600:1406::1'], 'rebind.adobe.com': ['23.192.0.10', '10.0.0.5'] });
  assert.deepEqual(await assertPublicHost('www.adobe.com', { lookup: promisify(lookup) }), ['23.192.0.10', '2600:1406::1']);
  await assert.rejects(assertPublicHost('rebind.adobe.com', { lookup: promisify(lookup) }), /non-public address\(es\) 10\.0\.0\.5/);
  await assert.rejects(assertPublicHost('missing.adobe.com', { lookup: promisify(lookup) }), /cannot resolve/);
  const guarded = publicOnlyLookup({ lookup });
  const one = await new Promise((r) => { guarded('www.adobe.com', {}, (e, a, f) => r({ e, a, f })); });
  assert.deepEqual([one.e, one.a, one.f], [null, '23.192.0.10', 4]);
  const all = await new Promise((r) => { guarded('www.adobe.com', { all: true }, (e, a) => r(a)); });
  assert.equal(all.length, 2);
  const err = await new Promise((r) => { guarded('rebind.adobe.com', 4, (e) => r(e)); });
  assert.equal(err.code, 'ETARGETPRIVATE');
});

test('target: proxy refuses tunnels and the page origin when they resolve to private addresses (connect-time)', async () => {
  const cert = makeCert('www.adobe.com');
  const lookup = publicOnlyLookup({ lookup: fakeLookup({ 'internal.example': ['10.0.0.7'], 'www.adobe.com': ['10.0.0.8'] }) });
  const proxy = await startProxy({ host: 'www.adobe.com', key: cert.key, cert: cert.cert, lookup });
  const connect = (target) => new Promise((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => s.destroy(), 1500);
  });
  try {
    const priv = await connect('internal.example:443');
    assert.doesNotMatch(priv, /200 Connection Established/, 'no tunnel to a private destination');
    assert.match(priv, /403 Forbidden/);
    assert.ok(proxy.errors.some((e) => /internal\.example.*non-public address 10\.0\.0\.7/.test(e)), proxy.errors.join('\n'));
    // Page origin (DNS rebinding after the up-front check): the request fails and the run is marked fatal.
    const tls = await import('node:tls');
    const http2 = await import('node:http2');
    await new Promise((resolve) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => sock.write('CONNECT www.adobe.com:443 HTTP/1.1\r\n\r\n'));
      sock.once('data', () => {
        const session = http2.connect('https://www.adobe.com', { createConnection: () => tls.connect({ socket: sock, servername: 'www.adobe.com', ALPNProtocols: ['h2'], rejectUnauthorized: false }) });
        session.on('error', () => {});
        const req = session.request({ ':path': '/' });
        req.on('error', () => {});
        req.on('close', () => { session.destroy(); resolve(); });
        req.end();
      });
    });
    assert.equal(proxy.errors.fatal?.code, 'ETARGET');
    assert.match(proxy.errors.fatal.message, /non-public address 10\.0\.0\.8/);
  } finally {
    await proxy.close();
    cert.cleanup();
  }
});

test('target: main-frame redirect hops and final URL are extracted and validated', () => {
  const log = [
    { method: 'Page.frameNavigated', params: { frame: { id: 'F', url: 'https://www.adobe.com/a' } } },
    { method: 'Network.requestWillBeSent', params: { frameId: 'F', type: 'Document', request: { url: 'https://www.adobe.com/a' } } },
    { method: 'Network.requestWillBeSent', params: { frameId: 'F', type: 'Document', request: { url: 'https://evil.example/landing' }, redirectResponse: { url: 'https://www.adobe.com/a' } } },
    { method: 'Network.responseReceived', params: { frameId: 'F', type: 'Document', response: { url: 'https://evil.example/landing' } } },
    { method: 'Network.requestWillBeSent', params: { frameId: 'IFRAME', type: 'Document', request: { url: 'https://www.youtube.com/embed/x' } } },
    { method: 'Network.requestWillBeSent', params: { frameId: 'F', type: 'Script', request: { url: 'https://use.typekit.net/x.js' } } },
  ];
  const urls = mainFrameDocumentUrls(log);
  assert.deepEqual(urls, ['https://www.adobe.com/a', 'https://evil.example/landing'], 'subframes and third-party subresources are not page targets');
  assert.throws(() => assertMainFrameTargets(urls), (e) => e.fatal && /evil\.example/.test(e.message));
  assert.doesNotThrow(() => assertMainFrameTargets(['https://www.adobe.com/a', 'https://www.adobe.com/b']));
});

test('target: runJob fails closed (fatal, no browser) when the page host resolves to a private address', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-target-'));
  let launched = 0;
  try {
    const r = await runJob({
      spec: { version: 1, runs: 1, names: ['after'], variants: { after: { url: 'https://www.adobe.com/x' } }, expect: {} },
      requestId: 'target-test-1',
      out,
      fetchJson: async () => ({ country: 'US', country_iso: 'US', country_code: 'US' }),
      dnsLookup: fakeLookup({ 'www.adobe.com': ['127.0.0.1'] }),
      launchBrowser: async () => { launched += 1; throw new Error('no'); },
      log: () => {},
      warn: () => {},
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.errorKind, 'fatal');
    assert.match(r.error, /non-public/);
    assert.equal(launched, 0);
    const bad = await runJob({
      spec: { version: 1, runs: 1, names: ['after'], variants: { after: { url: 'https://adobe.com.evil.example/x' } }, expect: {} },
      requestId: 'target-test-2', out, fetchJson: async () => ({ country: 'US' }), launchBrowser: async () => { launched += 1; }, log: () => {}, warn: () => {},
    });
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /not a \*\.adobe\.com/);
    assert.equal(launched, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('target: CLIs reject non-Adobe pages before doing anything', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-target-cli-'));
  try {
    for (const args of [
      [path.join(BIN, 'perf-ab.mjs'), 'https://www.adobe.com.evil.example/', '-n', '1', '-o', out],
      [path.join(BIN, 'perf-ab.mjs'), '--local-devtools', 'https://evil.example/', '-n', '1', '-o', out],
      [path.join(BIN, 'perf-ab.mjs'), '--local-devtools', 'http://localhost:9/page', '-n', '1', '-o', out],
      [path.join(BIN, 'perf-preload.mjs'), 'https://user@www.adobe.com/', '-n', '1', '-o', out],
    ]) {
      const env = { ...process.env, PATH: process.env.PATH, GH_TOKEN: '', PERF_TOOLS_LOOPBACK_FIXTURE: '' };
      await assert.rejects(run(process.execPath, args, { env, timeout: 30000 }), (e) => e.code === 1 && /adobe\.com|https|credentials/.test(e.stderr), args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(out), [], 'nothing recorded or downloaded');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
