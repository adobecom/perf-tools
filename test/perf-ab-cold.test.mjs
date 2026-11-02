// End-to-end: runs the real perf-ab / perf-preload CLIs (headless bundled Chromium) against a local page that
// leaves a cookie, localStorage, a service worker and a long-lived cached asset behind, and checks that every
// measured load starts cold in its own, cleaned-up browser process and that there are no warm-up loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const run = promisify(execFile);
const skip = fs.existsSync(chromium.executablePath()) ? false : 'Playwright Chromium is not installed (npx playwright install chromium)';

const PAGE = `<!doctype html><html><head>
<script>
  const state = {
    cookie: document.cookie.includes('seen=1'),
    ls: localStorage.getItem('seen') === '1',
    sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  };
  document.write('<img src="/report?' + new URLSearchParams(state) + '">');
  document.cookie = 'seen=1; Max-Age=3600; Path=/';
  localStorage.setItem('seen', '1');
  navigator.serviceWorker?.register('/sw.js');
</script>
<script src="/asset.js"></script>
</head><body><h1>cold run check</h1></body></html>`;

async function withServer(fn) {
  const hits = { docs: [], reports: [], assets: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      hits.docs.push({ v: u.searchParams.get('v'), cookie: /seen=1/.test(req.headers.cookie ?? '') });
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=3600' });
      return res.end(PAGE);
    }
    if (u.pathname === '/report') {
      hits.reports.push(Object.fromEntries(u.searchParams));
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    if (u.pathname === '/asset.js') {
      hits.assets += 1;
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end('window.asset = 1;');
    }
    if (u.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', () => {});");
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://localhost:${server.address().port}`, hits);
  } finally {
    server.close();
  }
}

const FAST = ['--headless', '--channel', '', '--settle', '8000', '--lcp-wait', '300'];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const traces = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const meta = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).metadata.perfAb;

function assertCold(hits, expected) {
  assert.equal(hits.docs.length, expected, 'document loads == measured runs (no warm-up)');
  assert.equal(hits.assets, expected, 'cached asset fetched by every run');
  assert.ok(hits.docs.every((d) => !d.cookie), 'no cookie carried into a run');
  assert.equal(hits.reports.length, expected);
  for (const r of hits.reports) assert.deepEqual(r, { cookie: 'false', ls: 'false', sw: 'false' });
}

test('perf-ab A/B: runs x 2 cold loads, one fresh browser each, no warm-up, browsers cleaned up', { skip, timeout: 180000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-cold-'));
  try {
    await withServer(async (origin, hits) => {
      const { stdout } = await run(process.execPath, [path.join(BIN, 'perf-ab.mjs'), `${origin}/page`, '--before-query', 'v=b', '--after-query', 'v=a', '-n', '2', '-o', out, ...FAST]);
      assertCold(hits, 4);
      assert.deepEqual(hits.docs.map((d) => d.v), ['b', 'a', 'b', 'a'], 'alternating, starting at run 1');
      assert.match(stdout, /Medians over 2 cold runs/);
    });
    assert.deepEqual(traces(out), ['after1.json', 'after2.json', 'before1.json', 'before2.json']);
    const metas = traces(out).map((f) => meta(out, f));
    assert.ok(metas.every((m) => m.coldBrowser === true && m.warmup === false && m.run >= 1));
    const pids = metas.map((m) => m.browserPid);
    assert.ok(pids.every(Number.isInteger));
    assert.equal(new Set(pids).size, 4, 'a different browser process per run');
    assert.ok(pids.every((pid) => !alive(pid)), 'all browser processes exited');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('perf-preload records through perf-ab: -n cold loads, no warm-up trace, stale traces never mixed in', { skip, timeout: 180000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-cold-'));
  try {
    // Leftovers from an earlier, longer (or warm) capture in the same output folder.
    fs.mkdirSync(path.join(out, 'traces'));
    for (const f of ['after0.json', 'after3.json', 'after99.json']) fs.writeFileSync(path.join(out, 'traces', f), '{"traceEvents":[]}');
    await withServer(async (origin, hits) => {
      const { stdout } = await run(process.execPath, [path.join(BIN, 'perf-preload.mjs'), `${origin}/page`, '-n', '2', '-o', out, '--headless', '--channel', '']);
      assertCold(hits, 2);
      assert.match(stdout, /: 2 traces,/, 'only the two new cold runs are analyzed');
    });
    const dir = path.join(out, 'traces');
    assert.deepEqual(traces(dir), ['after1.json', 'after2.json']);
    const pids = traces(dir).map((f) => meta(dir, f).browserPid);
    assert.equal(new Set(pids).size, 2);
    assert.ok(pids.every((pid) => !alive(pid)));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
