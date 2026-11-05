// Real-browser checks for the read-only history dashboard (site/). A local fixture server serves site/ with
// synthetic test-only data under /m/<mode>/data/, and headless Chromium loads it as GitHub Pages would.
// Covers every page state, URL filters and deep links, mobile master/detail, and read-only/XSS/link safety.
// Set DASHBOARD_SCREENSHOTS=<dir> to also write desktop, mobile and dark-mode screenshots to <dir>.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { safeExternalUrl } from '../site/dashboard-core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dashboard');
const NOW = new Date('2026-11-03T12:00:00Z');
const SHOTS = process.env.DASHBOARD_SCREENSHOTS || '';
const skip = fs.existsSync(chromium.executablePath()) ? false : 'Playwright Chromium is not installed (npx playwright install chromium)';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MODES = new Set(['populated', 'empty', 'schema', 'badjson', 'missing', 'slow', 'warning', 'inp']);

// A synthetic INP run derived from a fixture run: the shared fixtures stay INP-free, so every other mode keeps proving that
// runs without an interaction scenario show no INP column, row or plot.
const INP_RUN = '41700000200-1';
function inpRun() {
  const detail = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'runs', '41700000001-1.json'), 'utf8'));
  const inp = [[620, 310], [580, 290], [640, 330], [600, 280], [610, 300]];
  Object.assign(detail, {
    id: INP_RUN, name: 'acrobat-plans-inp', config: 'experiments/acrobat-plans-inp.json', createdAt: '2026-11-02T20:00:00Z', detailPath: `data/runs/${INP_RUN}.json`,
    interactionsKey: 'c'.repeat(64),
    interactions: [{ action: 'waitFor', label: null }, { action: 'tap', label: 'Open the plans modal' }, { action: 'click', label: 'Pick the Pro plan' }, { action: 'auto', label: null }],
    medians: {
      before: { ...detail.medians.before, INP: 610 }, after: { ...detail.medians.after, INP: 300 }, delta: { ...detail.medians.delta, INP: -310 },
    },
    pairs: detail.pairs.map((p, i) => ({
      ...p, before: { ...p.before, INP: inp[i][0] }, after: { ...p.after, INP: inp[i][1] }, delta: { ...p.delta, INP: inp[i][1] - inp[i][0] },
    })),
  });
  return detail;
}
function inpIndex() {
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8'));
  const { schema, pairs, rejectedAttempts, changes, warnings, artifact, interactions, ...summary } = inpRun();
  index.runs.push(summary);
  return index;
}

function inside(base, rel) {
  const file = path.resolve(base, rel);
  return file.startsWith(base + path.sep) ? file : null;
}

function startServer() {
  const requests = [];
  let releaseSlow;
  const slowGate = new Promise((r) => { releaseSlow = r; });
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const sendFile = (res, file) => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: u.pathname });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'read-only', 'text/plain');
    const m = /^\/m\/([a-z]+)\/(.*)$/.exec(decodeURIComponent(u.pathname));
    if (!m || !MODES.has(m[1]) || m[2].includes('\0')) return send(res, 404, 'not found', 'text/plain');
    const [, mode, rest] = m;
    if (!rest.startsWith('data/')) return sendFile(res, inside(SITE, rest || 'index.html'));
    const data = rest.slice('data/'.length);
    if (mode === 'empty' && data === 'index.json') return send(res, 200, JSON.stringify({ schema: 'perf-ab/history-v1', updatedAt: '2026-11-02T18:00:00Z', runs: [] }));
    if (mode === 'schema' && data === 'index.json') return send(res, 200, JSON.stringify({ schema: 'perf-ab/history-v0', runs: [] }));
    if (mode === 'badjson' && data === 'index.json') return send(res, 200, '{"schema":"perf-ab/history-v1","runs":[{"id":');
    if (mode === 'missing') return send(res, 404, 'not found', 'text/plain');
    if (mode === 'inp' && data === 'index.json') return send(res, 200, JSON.stringify(inpIndex()));
    if (mode === 'inp' && data === `runs/${INP_RUN}.json`) return send(res, 200, JSON.stringify(inpRun()));
    if (mode === 'slow' && data === 'index.json') await slowGate;
    if (mode === 'warning' && data === 'runs/41700000008-1.json') {
      const detail = JSON.parse(fs.readFileSync(path.join(FIXTURES, data), 'utf8'));
      detail.warnings = [{ kind: 'environment-variability' }];
      return send(res, 200, JSON.stringify(detail));
    }
    if (mode === 'warning' && data === 'runs/41700000001-1.json') {
      const detail = JSON.parse(fs.readFileSync(path.join(FIXTURES, data), 'utf8'));
      const drift = {
        kind: 'production-source-drift', path: '/libs/utils/utils.js', repo: 'adobecom/milo', number: 7095,
        expectedMergeBaseSha256: 'a'.repeat(64), productionSha256: 'b'.repeat(64),
      };
      detail.warnings = [
        { kind: 'environment-variability', benchmark: { min: 1000, max: 1800, ratio: 1.8, threshold: 1.2 } },
        ...[1, 2, 3].map((pair) => ({ ...drift, pair })),
        { ...drift, pair: 4, productionSha256: 'c'.repeat(64) },
        { ...drift, pair: 5, path: '/libs/other.js' },
      ];
      return send(res, 200, JSON.stringify(detail));
    }
    return sendFile(res, inside(FIXTURES, data));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, releaseSlow, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('history dashboard in a real browser', { skip }, () => {
  let srv;
  let browser;
  const pageErrors = [];

  before(async () => {
    srv = await startServer();
    browser = await chromium.launch();
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  });

  after(async () => {
    srv?.releaseSlow();
    await browser?.close();
    await new Promise((r) => (srv ? srv.server.close(r) : r()));
  });

  async function newPage({ mobile = false, dark = false, timezoneId = 'UTC', viewportWidth } = {}) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: viewportWidth ?? 1440, height: 900 },
      deviceScaleFactor: mobile ? 2 : 1,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
      timezoneId,
    });
    await context.clock.setFixedTime(NOW);
    await context.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (/Failed to load resource: the server responded with a status of 404/.test(msg.text())) return;
      pageErrors.push(`console: ${msg.text()}`);
    });
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.origin !== srv.origin) pageErrors.push(`cross-origin request: ${req.url()}`);
      if (req.method() !== 'GET') pageErrors.push(`non-GET request: ${req.method()} ${req.url()}`);
    });
    return page;
  }

  const settled = (page) => page.waitForFunction(() => {
    const meta = document.getElementById('data-meta').textContent;
    const detail = document.getElementById('detail');
    return meta !== 'Loading history…' && !detail.hasAttribute('aria-busy');
  });

  async function open(page, mode, search = '') {
    await page.goto(`${srv.origin}/m/${mode}/${search}`);
    await settled(page);
  }

  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' '));
  const verdicts = (page) => page.$$eval('#detail td.verdict[data-verdict]', (tds) => tds.map((td) => td.dataset.verdict));
  const rows = (page) => page.$$eval('#history-body a.run-link', (as) => as.map((a) => a.dataset.run));

  // Every page state must stay inert: no frames, no injected markup, only vetted links, no CSP violations.
  async function assertSafe(page) {
    const r = await page.evaluate(() => ({
      xss: window.__xss,
      csp: window.__csp,
      frames: document.querySelectorAll('iframe, frame, object, embed').length,
      imgs: [...document.images].map((i) => i.getAttribute('src')),
      scripts: [...document.scripts].map((s) => s.getAttribute('src')),
      forms: [...document.forms].map((f) => [f.getAttribute('action'), f.getAttribute('method')]),
      inputs: [...document.querySelectorAll('input[type=submit], button[type=submit], button:not([type])')].length,
      hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.href),
      stray: (document.body.textContent.match(/\[object \w+\]|\bundefined\b|\bnull\b|\bNaN\b/g) ?? []),
      handlers: [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)),
      duplicateIds: [...document.querySelectorAll('[id]')].map((el) => el.id).filter((id, i, ids) => ids.indexOf(id) !== i),
    }));
    assert.equal(r.xss, undefined, 'no injected script ran');
    assert.deepEqual(r.csp, [], 'no CSP violations');
    assert.equal(r.frames, 0, 'no frames or embedded reports');
    assert.deepEqual(r.imgs, ['favicon.svg']);
    assert.deepEqual(r.scripts, ['app.js']);
    assert.deepEqual(r.forms, [[null, null]], 'the filter form has no action or method');
    assert.equal(r.inputs, 0, 'no submit controls');
    assert.deepEqual(r.handlers, [], 'no inline event handler attributes');
    assert.deepEqual(r.duplicateIds, [], 'every document id is unique');
    assert.deepEqual(r.stray, [], 'no stringified objects or missing values in the page text');
    for (const href of r.hrefs) {
      const u = new URL(href);
      assert.ok(u.origin === srv.origin ? u.pathname.startsWith('/m/') : safeExternalUrl(href) === href, `unexpected link ${href}`);
    }
  }

  test('populated history: newest run selected, smoke run labelled with no performance conclusion', async () => {
    const page = await newPage();
    await open(page, 'populated');
    assert.equal((await rows(page)).length, 13);
    assert.equal(await text(page, '#history-count'), '13 total');
    assert.match(await text(page, '#data-meta'), /^13 runs · updated 2026-11-02 18:00 UTC$/);
    assert.match(await text(page, '#history-body details.skipped summary'), /^2 entries skipped: not valid history-v1 runs$/);
    assert.equal(await page.$eval('a.run-link[aria-current="true"]', (a) => a.dataset.run), '41631000001-1');
    const smokeRow = await text(page, 'tr.run-row.is-selected');
    assert.match(smokeRow, /1-pair smoke/);
    assert.match(smokeRow, /1\/1/);
    const detail = await text(page, '#detail');
    assert.match(detail, /Smoke: one pair; no conclusion/);
    assert.match(detail, /1\/1 pair/);
    assert.match(detail, /US verified/);
    assert.match(detail, /acrobat-plans-latest/);
    assert.doesNotMatch(await text(page, '#detail table.medians tbody'), /Consistently|signific|confiden/i);
    assert.doesNotMatch(await text(page, '#detail .detail-head'), /signific|confiden|\bwins?\b|improve/i);
    const v = await verdicts(page);
    assert.equal(v.length, 6);
    assert.ok(v.every((x) => x === 'inconclusive'), `smoke verdicts ${v}`);
    assert.match(detail, /Direction is a descriptive heuristic, not a statistical significance test/);
    assert.match(await text(page, '#detail table.medians thead'), /Median paired Δ/);
    assert.equal(await page.$$eval('#detail svg.plot-svg', (s) => s.length), 6);
    assert.equal(await page.locator('#detail a', { hasText: 'Download perf-ab-41631000001-1' }).getAttribute('href'),
      'https://github.com/adobecom/perf-tools/actions/runs/41631000001/artifacts/1');
    await assertSafe(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-smoke.png'), fullPage: true });
    await page.context().close();
  });

  test('timestamps and created dates follow the browser timezone', async () => {
    const page = await newPage({ timezoneId: 'America/Los_Angeles' });
    await open(page, 'populated', '?run=41631000001-1');
    assert.match(await text(page, '#data-meta'), /^13 runs · updated 2026-11-02 10:00 PST$/);
    const smokeRow = page.locator('#history-body tr.run-row').filter({ hasText: '41631000001-1' });
    assert.equal(await smokeRow.locator('time').textContent(), '2026-11-02 02:00 PST');
    assert.equal(await page.$eval('#history-body th', (el) => el.textContent), 'Created (local)');
    assert.equal(await page.$eval('#detail time[datetime]', (el) => el.textContent), '2026-11-02 02:00 PST');
    await page.fill('#filter-from', '2026-11-02');
    await page.fill('#filter-to', '2026-11-02');
    assert.deepEqual(await rows(page), ['41631000001-1']);
    await assertSafe(page);
    await page.context().close();
  });

  test('intermediate desktop keeps the wide medians table inside its local scroller', async () => {
    const page = await newPage({ viewportWidth: 1076 });
    await open(page, 'populated', '?run=41700000001-1');
    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      table: document.querySelector('.medians').scrollWidth,
      scroller: document.querySelector('.medians-scroll').clientWidth,
      scrollable: document.querySelector('.medians-scroll').scrollWidth,
    }));
    assert.ok(sizes.table > sizes.scroller, `medians table should scroll inside wrapper: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.document <= sizes.viewport, `page should not scroll horizontally: ${JSON.stringify(sizes)}`);
    await assertSafe(page);
    await page.context().close();
  });

  test('tiny unanimous changes read Within noise; a clear improvement names a direction', async () => {
    const page = await newPage();
    await open(page, 'populated', '?run=41700000002-1');
    assert.deepEqual(await verdicts(page), Array(6).fill('noise'));
    assert.doesNotMatch(await text(page, '#detail table.medians tbody'), /Consistently/);
    assert.equal(await page.$$eval('#detail svg.plot-svg line.link.dir-better, #detail svg.plot-svg line.link.dir-worse', (l) => l.length), 0, 'tiny pair deltas are drawn neutral');

    await open(page, 'populated', '?run=41700000001-1');
    const byMetric = await page.$$eval('#detail table.medians tbody tr', (trs) => Object.fromEntries(trs.map((tr) => [tr.querySelector('.metric-short').textContent, tr.dataset.verdict])));
    assert.deepEqual(byMetric, { Perf: 'better', FCP: 'noise', LCP: 'better', SI: byMetric.SI, TBT: 'noise', CLS: byMetric.CLS });
    const lcpRow = await text(page, '#detail table.medians tbody tr:nth-child(3)');
    assert.match(lcpRow, /Consistently better/);
    assert.match(lcpRow, /5\/5 pairs same direction/);
    assert.ok(await page.$$eval('#detail svg.plot-svg line.link.dir-better', (l) => l.length) >= 5);
    assert.equal(await page.$eval('a.run-link[aria-current="true"]', (a) => a.dataset.run), '41700000001-1');
    const detail = await text(page, '#detail');
    assert.doesNotMatch(detail, /Comparable runs/);
    assert.match(detail, /57/);
    await assertSafe(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-improvement.png'), fullPage: true });
    await page.context().close();
  });

  test('INP: the column, row, plot and scenario appear only for runs with an interaction scenario', async () => {
    const page = await newPage();
    // Runs without a scenario: no INP anywhere.
    await open(page, 'populated', '?run=41700000001-1');
    assert.doesNotMatch(await text(page, '#history-body thead'), /INP/);
    assert.deepEqual(await page.$$eval('#detail table.medians tbody .metric-short', (e) => e.map((x) => x.textContent)), ['Perf', 'FCP', 'LCP', 'SI', 'TBT', 'CLS']);
    assert.equal(await page.$$eval('#detail svg.plot-svg', (s) => s.length), 6);
    assert.doesNotMatch(await text(page, '#detail'), /Interaction scenario|INP/);

    // A list containing an INP run gets the column (other rows show a dash); the run's detail gets the row, plot and scenario.
    await open(page, 'inp', `?run=${INP_RUN}`);
    assert.match(await text(page, '#history-body thead'), /Δ INP/);
    assert.match(await text(page, `#history-body tr.run-row:has(a[data-run="${INP_RUN}"])`), /−310 ms/);
    assert.match(await text(page, '#history-body tr.run-row:has(a[data-run="41700000001-1"])'), /—$/);
    assert.deepEqual(await page.$$eval('#detail table.medians tbody .metric-short', (e) => e.map((x) => x.textContent)), ['Perf', 'FCP', 'LCP', 'SI', 'TBT', 'CLS', 'INP']);
    assert.match(await text(page, '#detail table.medians tbody tr:nth-child(7)'), /610 ms300 ms−310 ms/);
    assert.equal(await page.$eval('#detail table.medians tbody tr:nth-child(7)', (tr) => tr.dataset.verdict), 'better');
    assert.equal(await page.$$eval('#detail svg.plot-svg', (s) => s.length), 7);
    assert.match(await text(page, '#detail table.pairs thead'), /INP/);
    assert.equal(await page.$$eval('#detail table.pairs thead th.num', (t) => t.length), 7);
    const scenario = await text(page, 'section[aria-labelledby="sec-interaction-scenario"]');
    assert.match(scenario, /Open the plans modal/);
    assert.match(scenario, /Pick the Pro plan/);
    assert.match(scenario, /Auto-discovered in-page interactions\s*auto/);
    assert.match(scenario, /Scenario key cccccccccccc/);
    assert.match(await text(page, '#detail'), /INP 40 ms/, 'the noise threshold is listed with the others');
    await assertSafe(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-inp.png'), fullPage: true });
    await page.context().close();
  });

  test('worse, expired, partial, failed, non-US, single-URL and unknown runs are explicit', async () => {
    const page = await newPage();
    await open(page, 'populated', '?run=41700000003-2');
    let detail = await text(page, '#detail');
    assert.match(detail, /Consistently worse/);
    assert.match(detail, /Artifact expired/);
    assert.match(detail, /1, 2 \(failed jobs were re-run\)/);
    assert.match(detail, /attempt 2 · Chrome 142\.0\.7444\.60 · CPU benchmark \d+ · US/);
    assert.equal(await page.locator('#detail a', { hasText: /^Download/ }).count(), 0, 'no link to an expired artifact');

    await open(page, 'populated', '?run=41500000009-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Artifact expired.*expired on 2026-08-31/);
    assert.equal(await page.locator('#detail a', { hasText: /^Download/ }).count(), 0);

    await open(page, 'populated', '?run=41700000005-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Partial: 3\/5 pairs2 incomplete; excluded/);
    assert.match(detail, /2 attempts rejected/);
    assert.match(detail, /2 incomplete pairs are listed but excluded/);
    assert.equal(await page.$$eval('#detail tr.pair-incomplete.pair-start', (t) => t.length), 2);
    assert.match(await text(page, '#sec-rejected-attempts + *'), /after41/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-partial.png'), fullPage: true });

    await open(page, 'populated', '?run=41700000006-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Run failed: rejected after retries/);
    assert.match(detail, /Lighthouse failed/);
    assert.match(detail, /<img src=x onerror="window\.__xss=1"> rejected after 3 attempts/, 'error text renders literally');
    assert.match(detail, /No full report artifact is available/);
    assert.match(detail, /Workflow conclusionfailure/);
    assert.equal(await page.$$eval('#detail img', (i) => i.length), 0);
    await assertSafe(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-failed.png'), fullPage: true });

    await open(page, 'populated', '?run=41700000007-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Not US-verified \(DE\)/);
    assert.match(detail, /Not US verified \(DE\); region may affect results/);
    assert.match(detail, /Egress was not verified as US/);
    assert.match(detail, /This run is unverified; shown for reference/);

    await open(page, 'warning', '?run=41700000008-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Single URL; no before\/after comparison/);
    assert.equal(await page.locator('#detail .plots svg').count(), 6);
    assert.equal(await page.locator('#detail .legend').innerText(), 'After\nMedian');
    assert.ok((await page.locator('#detail .plots svg').first().getAttribute('aria-label')).includes('load'));
    assert.match(detail, /CPU variation affects these timings/);
    assert.doesNotMatch(detail, /Deltas are indicative|How direction is set/);
    assert.match(detail, /Per-load numbers/);
    assert.deepEqual(await verdicts(page), []);

    await open(page, 'populated', '?run=41700000013-1');
    assert.match(await text(page, '#detail'), /Unknown status: "queued"/);
    await page.context().close();
  });

  test('production source drift warnings are grouped and expandable', async () => {
    const page = await newPage();
    await open(page, 'warning', '?run=41700000001-1');
    const detail = await text(page, '#detail');
    assert.doesNotMatch(detail, /Runner environment varied/);
    const warnings = page.locator('#detail .callout').filter({ hasText: 'Production source drift' });
    assert.equal(await warnings.count(), 3, 'identical drift is grouped; distinct path/hash conditions remain');
    assert.match(await warnings.nth(0).innerText(), /pairs 1, 2, 3/);
    assert.equal(await warnings.nth(0).locator('.disclosure-content').isVisible(), false);
    await warnings.nth(0).locator('summary').click();
    assert.match(await warnings.nth(0).innerText(), new RegExp(`Merge-base SHA-256: ${'a'.repeat(64)}`));
    assert.match(await warnings.nth(0).innerText(), /Affected pairs: 1, 2, 3/);
    await warnings.nth(1).locator('summary').click();
    assert.match(await warnings.nth(1).innerText(), new RegExp(`Production SHA-256: ${'c'.repeat(64)}`));
    assert.match(await warnings.nth(2).innerText(), /\/libs\/other.js/);
    assert.equal(await page.locator('#detail .medians tbody tr').count(), 6);
    assert.equal(await page.locator('#detail .pairs tr.pair-start').count(), 5);
    assert.equal(await page.locator('#detail svg.plot-svg').count(), 6);
    assert.equal(await warnings.nth(0).locator('a').textContent(), 'adobecom/milo#7095');
    await assertSafe(page);
    await page.context().close();
  });

  test('missing or malformed detail files and unknown deep links fail visibly', async () => {
    const page = await newPage();
    await open(page, 'populated', '?run=41700000011-1');
    let detail = await text(page, '#detail');
    assert.match(detail, /Run detail could not be loaded/);
    assert.match(detail, /HTTP 404/);
    assert.equal(await text(page, '#detail h2'), 'www.adobe.com/express/%3Cscript%3Ewindow.__xss=1%3C/script%3E', 'URL renders as text');
    assert.equal(await page.$$eval('#detail script, #history-body script', (s) => s.length), 0);
    await assertSafe(page);

    await open(page, 'populated', '?run=41700000012-1');
    detail = await text(page, '#detail');
    assert.match(detail, /Run detail has an unexpected format/);
    assert.match(detail, /attempt 1 \(no link published\)/);
    assert.equal(await page.locator('#detail a[href^="javascript"]').count(), 0);
    await assertSafe(page);

    await open(page, 'populated', '?run=99999999999-1');
    assert.match(await text(page, '#detail'), /Run 99999999999-1 is not in the published history/);
    await page.context().close();
  });

  test('filters live in the URL; no-match and hidden-selection states are explicit', async () => {
    const page = await newPage();
    await open(page, 'populated', '?q=acrobat');
    assert.equal(await page.inputValue('#filter-q'), 'acrobat');
    assert.equal(await text(page, '#history-count'), '1 of 13 shown');
    assert.deepEqual(await rows(page), ['41631000001-1']);

    await open(page, 'populated', '?status=failed');
    assert.deepEqual(await rows(page), ['41700000006-1', '41700000007-1']);

    await open(page, 'populated', '?status=failed&run=41700000001-1');
    assert.match(await text(page, '#detail'), /This run is hidden by the current filters\./);

    await open(page, 'populated', '?q=no-such-page');
    assert.match(await text(page, '#history-body'), /No runs match these filters13 published runs are hidden/);
    await page.click('#history-body button:has-text("Clear filters")');
    assert.equal((await rows(page)).length, 13);
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.isDisabled('#filter-clear'), true);

    await page.selectOption('#filter-status', 'partial');
    assert.deepEqual(await rows(page), ['41700000005-1']);
    assert.equal(new URL(page.url()).searchParams.get('status'), 'partial');
    await page.fill('#filter-from', '2026-10-31');
    await page.selectOption('#filter-status', '');
    await page.waitForFunction(() => document.querySelectorAll('#history-body a.run-link').length === 2);
    assert.deepEqual(await rows(page), ['41631000001-1', '41700000006-1']);

    const oldKey = await page.$eval('#filter-profile', (s) => [...s.options].find((o) => /13\.5\.0/.test(o.textContent))?.value);
    await page.click('#filter-clear');
    await page.selectOption('#filter-profile', oldKey);
    assert.deepEqual(await rows(page), ['41400000010-1']);

    await page.click('#filter-clear');
    await page.click('a.run-link[data-run="41700000005-1"]');
    await settled(page);
    assert.equal(new URL(page.url()).searchParams.get('run'), '41700000005-1');
    await page.click('a.run-link[data-run="41700000001-1"]');
    await settled(page);
    await page.goBack();
    await settled(page);
    assert.equal(await page.$eval('a.run-link[aria-current="true"]', (a) => a.dataset.run), '41700000005-1');
    assert.match(await text(page, '#detail'), /Partial: 3\/5 pairs/);
    await assertSafe(page);
    await page.context().close();
  });

  test('loading, empty, unpublished, wrong-schema and invalid-JSON histories', async () => {
    const page = await newPage();
    await page.goto(`${srv.origin}/m/slow/`);
    await page.waitForSelector('#history-body[aria-busy="true"]');
    assert.equal(await text(page, '#data-meta'), 'Loading history…');
    assert.equal(await page.$eval('#detail', (d) => d.getAttribute('aria-busy')), 'true');
    srv.releaseSlow();
    await settled(page);
    assert.equal((await rows(page)).length, 13);

    await open(page, 'empty');
    assert.equal(await text(page, '#history-body'), '');
    assert.equal(await page.locator('#history-body .empty').count(), 0);
    assert.match(await text(page, '#data-meta'), /^0 runs · updated/);
    assert.match(await text(page, '#detail'), /Nothing to show yet/);
    assert.equal(await page.locator('.topbar-nav a').getAttribute('href'),
      'https://github.com/adobecom/perf-tools/actions/workflows/perf-ab.yml');
    await assertSafe(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-empty.png') });

    await open(page, 'missing');
    assert.match(await text(page, '#history-body'), /History is not published yet.*HTTP 404/);
    assert.equal(await text(page, '#data-meta'), 'History unavailable');
    assert.equal(await page.locator('#history-body button', { hasText: 'Retry' }).count(), 1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-not-published.png') });

    await open(page, 'schema');
    assert.match(await text(page, '#history-body'), /History has an unexpected format.*history-v0/);

    await open(page, 'badjson');
    assert.match(await text(page, '#history-body'), /History could not be loaded.*not valid JSON/);
    await page.click('#history-body button:has-text("Retry")');
    await settled(page);
    assert.match(await text(page, '#history-body'), /not valid JSON/);
    await assertSafe(page);
    await page.context().close();
  });

  test('mobile: list first, run detail on selection, back returns to the list', async () => {
    const page = await newPage({ mobile: true });
    await open(page, 'populated');
    assert.equal(await page.$eval('#layout', (l) => l.dataset.view), 'list');
    assert.equal(await page.isVisible('#detail'), false);
    assert.equal(await page.$$eval('a.run-link[aria-current="true"]', (a) => a.length), 0, 'nothing auto-selected on narrow screens');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page scrolls horizontally by ${overflow}px`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mobile-list.png'), fullPage: true });

    await page.click('a.run-link[data-run="41631000001-1"]');
    await settled(page);
    assert.equal(await page.$eval('#layout', (l) => l.dataset.view), 'detail');
    assert.equal(await page.isVisible('.history'), false);
    assert.equal(await page.isVisible('#detail .back'), true);
    assert.match(await text(page, '#detail'), /Smoke: one pair; no conclusion/);
    const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(detailOverflow <= 0, `detail scrolls horizontally by ${detailOverflow}px`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mobile-smoke-detail.png'), fullPage: true });

    await page.click('#detail .back');
    assert.equal(await page.$eval('#layout', (l) => l.dataset.view), 'list');
    assert.equal(new URL(page.url()).searchParams.get('run'), null);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.run), '41631000001-1');

    await open(page, 'populated', '?run=41700000001-1');
    assert.equal(await page.$eval('#layout', (l) => l.dataset.view), 'detail');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mobile-improvement-detail.png'), fullPage: true });
    await assertSafe(page);
    await page.context().close();
  });

  test('dark mode renders the same detail', { skip: !SHOTS && 'screenshots only (DASHBOARD_SCREENSHOTS)' }, async () => {
    const page = await newPage({ dark: true });
    await open(page, 'populated', '?run=41700000001-1');
    await assertSafe(page);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-improvement-dark.png'), fullPage: true });
    await page.context().close();
  });

  test('the dashboard only ever issued GET requests for its own files', () => {
    assert.deepEqual(pageErrors, []);
    assert.ok(srv.requests.length > 20);
    for (const r of srv.requests) {
      assert.equal(r.method, 'GET', `${r.method} ${r.path}`);
      assert.match(r.path, /^\/m\/[a-z]+\/(|index\.html|app\.js|dashboard-core\.mjs|styles\.css|favicon\.svg|data\/index\.json|data\/runs\/[0-9]+-[0-9]+\.json)$/, r.path);
    }
  });
});
