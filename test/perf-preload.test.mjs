import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'perf-preload.mjs');
const DOC = 'https://www.adobe.com/acrobat/plans.html';
const FRAME = 'F1';

// [url, resourceType, { module, parser, lcpImage }]
const RESOURCES = [
  ['https://www.adobe.com/acrobat/scripts/scripts.js', 'Script', { module: true }],
  ['https://www.adobe.com/libs/c2/styles/styles.css', 'Stylesheet', {}],
  ['https://www.adobe.com/acrobat/styles/styles.css?a=1&b="2"', 'Stylesheet', {}],
  ['https://www.adobe.com/libs/utils/utils.js', 'Script', { module: true }],
  ['https://use.typekit.net/vti0xwb.css', 'Stylesheet', {}],
  ['https://p.typekit.net/p.css?s=1&k=vti0xwb&ht=tk', 'Stylesheet', {}],
  ['https://use.typekit.net/af/abc/l?primer=7cdc&fvd=n4&v=3', 'Font', {}],
  ['https://cdn.example.net/lib/module.js', 'Script', { module: true }],
  ['https://cdn.example.net/lib/classic.js', 'Script', {}],
  ['https://www.adobe.com/acrobat/placeholders.json', 'Fetch', {}],
  ['https://www.adobe.com/acrobat/media_123.png?width=750&format=webp', 'Image', { lcpImage: true }],
  ['https://www.adobe.com/acrobat/inline-head.js', 'Script', { parser: true }],
];

function trace() {
  const events = [{ name: 'navigationStart', ts: 1000, args: { frame: FRAME, data: { documentLoaderURL: DOC, isOutermostMainFrame: true } } }];
  RESOURCES.forEach(([url, resourceType, opt], i) => {
    const requestId = `R${i}`;
    const ts = 2000 + i * 1000;
    const initiator = opt.parser ? { type: 'parser', url: DOC } : { type: 'script', url: RESOURCES[0][0] };
    events.push({ name: 'ResourceSendRequest', ts, args: { data: { requestId, frame: FRAME, url, resourceType, initiator } } });
    events.push({ name: 'ResourceFinish', ts: ts + 500, args: { data: { requestId } } });
    if (opt.module) events.push({ name: 'v8.compileModule', ts: ts + 600, args: { data: { url } } });
  });
  const lcpUrl = RESOURCES.find(([, , opt]) => opt.lcpImage)[0];
  events.push({ name: 'largestContentfulPaint::Candidate', ts: 100000, args: { frame: FRAME, data: { type: 'image', nodeId: 7, nodeName: 'IMG' } } });
  events.push({ name: 'LargestImagePaint::Candidate', ts: 100000, args: { frame: FRAME, data: { DOMNodeId: 7, imageUrl: lcpUrl } } });
  return { traceEvents: events };
}

function generate(...flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace()));
    execFileSync(process.execPath, [CLI, DOC, '--from', path.join(dir, 'trace.json'), '-o', dir, ...flags], { stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, 'acrobat--plans.html'), 'utf8').trim().split('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--exclude typekit.net still removes the allowed typekit hosts; other third parties stay out by default', () => {
  const out = generate('--exclude', 'typekit.net');
  assert.ok(!out.some((l) => l.includes('typekit.net') || l.includes('cdn.example.net')));
});

test('--all-origins: crossorigin follows the consumer request mode, stylesheets are protocol-relative', () => {
  assert.deepEqual(generate('--all-origins'), [
    '<link rel="modulepreload" href="/acrobat/scripts/scripts.js">',
    '<link rel="preload" href="//www.adobe.com/libs/c2/styles/styles.css" as="style">',
    '<link rel="preload" href="//www.adobe.com/acrobat/styles/styles.css?a=1&amp;b=&quot;2&quot;" as="style">',
    '<link rel="modulepreload" href="/libs/utils/utils.js">',
    '<link rel="preload" href="//use.typekit.net/vti0xwb.css" as="style">',
    '<link rel="preload" href="//p.typekit.net/p.css?s=1&amp;k=vti0xwb&amp;ht=tk" as="style">',
    '<link rel="preload" href="https://use.typekit.net/af/abc/l?primer=7cdc&amp;fvd=n4&amp;v=3" as="font" crossorigin>',
    '<link rel="modulepreload" href="https://cdn.example.net/lib/module.js" crossorigin>',
    '<link rel="preload" href="https://cdn.example.net/lib/classic.js" as="script" crossorigin>',
    '<link rel="preload" href="/acrobat/placeholders.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/acrobat/media_123.png?width=750&amp;format=webp" as="image" fetchpriority="high">',
  ]);
});

test('same site plus *.typekit.net by default; stylesheet preloads never match a relative or absolute link[href] lookup', () => {
  const lines = generate();
  assert.deepEqual(lines, [
    '<link rel="modulepreload" href="/acrobat/scripts/scripts.js">',
    '<link rel="preload" href="//www.adobe.com/libs/c2/styles/styles.css" as="style">',
    '<link rel="preload" href="//www.adobe.com/acrobat/styles/styles.css?a=1&amp;b=&quot;2&quot;" as="style">',
    '<link rel="modulepreload" href="/libs/utils/utils.js">',
    '<link rel="preload" href="//use.typekit.net/vti0xwb.css" as="style">',
    '<link rel="preload" href="//p.typekit.net/p.css?s=1&amp;k=vti0xwb&amp;ht=tk" as="style">',
    '<link rel="preload" href="https://use.typekit.net/af/abc/l?primer=7cdc&amp;fvd=n4&amp;v=3" as="font" crossorigin>',
    '<link rel="preload" href="/acrobat/placeholders.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/acrobat/media_123.png?width=750&amp;format=webp" as="image" fetchpriority="high">',
  ]);
  for (const l of lines.filter((x) => x.includes('as="style"'))) {
    assert.match(l, /href="\/\/[^/]/, 'protocol-relative: neither the path nor the https URL a loader uses');
    assert.doesNotMatch(l, /crossorigin/);
  }
});

test('--from <dir> never counts warm-up loads (legacy before0/after0.json or metadata.perfAb.warmup)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  const withExtra = (url) => {
    const t = trace();
    const ts = 3000;
    t.traceEvents.push({ name: 'ResourceSendRequest', ts, args: { data: { requestId: url, frame: FRAME, url, resourceType: 'Script', initiator: { type: 'script', url: RESOURCES[0][0] } } } });
    t.traceEvents.push({ name: 'ResourceFinish', ts: ts + 100, args: { data: { requestId: url } } });
    return t;
  };
  try {
    const tr = path.join(dir, 'traces');
    fs.mkdirSync(tr);
    fs.writeFileSync(path.join(tr, 'after0.json'), JSON.stringify(withExtra('https://www.adobe.com/legacy-warmup.js')));
    fs.writeFileSync(path.join(tr, 'before0.json'), JSON.stringify(withExtra('https://www.adobe.com/legacy-warmup-before.js')));
    fs.writeFileSync(path.join(tr, 'after1.json'), JSON.stringify({ ...trace(), metadata: { perfAb: { variant: 'after', run: 1, warmup: false } } }));
    fs.writeFileSync(path.join(tr, 'after2.json'), JSON.stringify({ ...withExtra('https://www.adobe.com/flagged-warmup.js'), metadata: { perfAb: { warmup: true } } }));
    const r = spawnSync(process.execPath, [CLI, DOC, '--from', tr, '-o', dir, '--min-runs', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /skipped legacy perf-ab warm-up traces after0\.json, before0\.json/);
    assert.match(r.stderr, /after2\.json: perf-ab warm-up load, skipped/);
    assert.match(r.stdout, /: 1 traces,/);
    const snippet = fs.readFileSync(path.join(dir, 'acrobat--plans.html'), 'utf8');
    assert.doesNotMatch(snippet, /warmup/);
    assert.match(snippet, /scripts\/scripts\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--from <default perf-ab output dir> reads only accepted runs from results.json, never rejected/ attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  const extra = (url) => {
    const t = trace();
    t.traceEvents.push({ name: 'ResourceSendRequest', ts: 3000, args: { data: { requestId: url, frame: FRAME, url, resourceType: 'Script', initiator: { type: 'script', url: RESOURCES[0][0] } } } });
    t.traceEvents.push({ name: 'ResourceFinish', ts: 3100, args: { data: { requestId: url } } });
    return t;
  };
  const put = (rel, t) => { fs.mkdirSync(path.join(dir, 'traces', rel), { recursive: true }); fs.writeFileSync(path.join(dir, 'traces', rel, 'trace.json'), JSON.stringify(t)); };
  try {
    put('after1', trace());
    put('after2', extra('https://www.adobe.com/stale-run.js'));
    put('rejected/after1-attempt1', extra('https://www.adobe.com/rejected-attempt.js'));
    const results = { status: 'ok', lighthouseVersion: '13.6.0', runs: [{ variant: 'after', run: 1, attempt: 2, dir: 'after1' }], rejected: [{ variant: 'after', run: 1, attempt: 1, dir: 'rejected/after1-attempt1' }] };
    fs.writeFileSync(path.join(dir, 'traces', 'results.json'), JSON.stringify(results));
    const r = spawnSync(process.execPath, [CLI, DOC, '--from', path.join(dir, 'traces'), '-o', dir, '--min-runs', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /: 1 traces,/);
    const snippet = fs.readFileSync(path.join(dir, 'acrobat--plans.html'), 'utf8');
    assert.doesNotMatch(snippet, /stale-run|rejected-attempt/);
    assert.match(snippet, /scripts\/scripts\.js/);
    fs.writeFileSync(path.join(dir, 'traces', 'results.json'), JSON.stringify({ ...results, status: 'failed' }));
    const f = spawnSync(process.execPath, [CLI, DOC, '--from', path.join(dir, 'traces'), '-o', dir], { encoding: 'utf8' });
    assert.equal(f.status, 1);
    assert.match(f.stderr, /status is failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--from <paired perf-ab output> reads the unchanged "before" runs from pair<i>/ dirs, never the changed "after" page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  const extra = (url) => {
    const t = trace();
    t.traceEvents.push({ name: 'ResourceSendRequest', ts: 3000, args: { data: { requestId: url, frame: FRAME, url, resourceType: 'Script', initiator: { type: 'script', url: RESOURCES[0][0] } } } });
    t.traceEvents.push({ name: 'ResourceFinish', ts: 3100, args: { data: { requestId: url } } });
    return t;
  };
  const put = (rel, t) => { fs.mkdirSync(path.join(dir, 'traces', rel), { recursive: true }); fs.writeFileSync(path.join(dir, 'traces', rel, 'trace.json'), JSON.stringify(t)); };
  try {
    put('pair1/before1', trace());
    put('pair2/before2', trace());
    put('pair1/after1', extra('https://www.adobe.com/injected-after.js'));
    put('pair2/after2', extra('https://www.adobe.com/injected-after.js'));
    const runs = [1, 2].flatMap((i) => ['before', 'after'].map((variant) => ({ variant, run: i, pair: i, dir: `pair${i}/${variant}${i}` })));
    fs.writeFileSync(path.join(dir, 'traces', 'results.json'), JSON.stringify({ status: 'ok', mode: 'pagespeed-us-paired', lighthouseVersion: '13.6.0', runs, rejected: [] }));
    const r = spawnSync(process.execPath, [CLI, DOC, '--from', path.join(dir, 'traces'), '-o', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unchanged "before" variant, 2 run\(s\)/);
    assert.match(r.stdout, /: 2 traces,/);
    const snippet = fs.readFileSync(path.join(dir, 'acrobat--plans.html'), 'utf8');
    assert.doesNotMatch(snippet, /injected-after/);
    assert.match(snippet, /scripts\/scripts\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Real Chrome shape: fetch(), XHR and script-inserted as="fetch" preloads are resourceType "Other".
function dataTrace(reqs) {
  const events = [{ name: 'navigationStart', ts: 1000, args: { frame: FRAME, data: { documentLoaderURL: DOC, isOutermostMainFrame: true } } }];
  reqs.forEach((r, i) => {
    const requestId = `D${i}`;
    const ts = 1000 + (r.at ?? i + 1) * 100000; // 100 ms steps
    const data = {
      requestId, frame: FRAME, url: r.url, resourceType: r.type ?? 'Other',
      initiator: { type: 'script', fetchType: r.fetchType ?? 'fetch' },
      ...(r.method === null ? {} : { requestMethod: r.method ?? 'GET' }),
      ...(r.preload ? { isLinkPreload: true } : {}),
    };
    events.push({ name: 'ResourceSendRequest', ts, args: { data } });
    if (r.mime !== null) events.push({ name: 'ResourceReceiveResponse', ts: ts + 20000, args: { data: { requestId, statusCode: r.status ?? 200, mimeType: r.mime ?? 'application/json' } } });
    events.push({ name: 'ResourceFinish', ts: ts + 50000, args: { data: { requestId } } });
  });
  events.push({ name: 'largestContentfulPaint::Candidate', ts: 10000000, args: { frame: FRAME, data: { type: 'text', nodeId: 7, nodeName: 'P' } } });
  return { traceEvents: events };
}

function generateFrom(traces, ...flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  try {
    const from = traces.flatMap((t, i) => {
      const f = path.join(dir, `t${i + 1}.json`);
      fs.writeFileSync(f, JSON.stringify(t));
      return ['--from', f];
    });
    const r = spawnSync(process.execPath, [CLI, DOC, ...from, '-o', dir, ...flags], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return {
      ...r,
      lines: fs.readFileSync(path.join(dir, 'acrobat--plans.html'), 'utf8').trim().split('\n').filter(Boolean),
      manifest: JSON.parse(fs.readFileSync(path.join(dir, 'acrobat--plans.json'), 'utf8')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const A = 'https://www.adobe.com';
const MAS = `${A}/mas/io/fragment?id=33a8&api_key=k&locale=en_US&country=CH`;

test('GET JSON/HTML fetches and script as="fetch" preloads recorded as Other become fetch preloads', () => {
  const { lines, stdout, manifest } = generateFrom([dataTrace([
    { url: `${A}/dc-shared/placeholders.json`, fetchType: 'link', preload: true },
    { url: `${A}/libs/commerce/checkout-link.json` },
    { url: `${A}/dc-shared/fragments/offer.plain.html`, mime: 'text/html; charset=utf-8'.split(';')[0] },
    { url: MAS },
    { url: `${A}/api/data.json`, fetchType: 'xmlhttprequest', mime: 'application/ld+json' },
  ])]);
  assert.deepEqual(lines, [
    '<link rel="preload" href="/dc-shared/placeholders.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/libs/commerce/checkout-link.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/dc-shared/fragments/offer.plain.html" as="fetch" crossorigin>',
    '<link rel="preload" href="/mas/io/fragment?id=33a8&amp;api_key=k&amp;locale=en_US&amp;country=CH" as="fetch" crossorigin>',
    '<link rel="preload" href="/api/data.json" as="fetch" crossorigin>',
  ]);
  assert.match(stdout, /Fetch !\s+https:\/\/www\.adobe\.com\/mas\/io\/fragment/);
  assert.match(stdout, /country\/locale specific URL: serve this link only/);
  // The manifest has the same links minus the country/locale specific one (it is served to every visitor).
  assert.deepEqual(manifest.data.map((r) => r.href), ['/dc-shared/placeholders.json', '/libs/commerce/checkout-link.json', '/dc-shared/fragments/offer.plain.html', '/api/data.json']);
  assert.deepEqual(manifest.data[0], { rel: 'preload', href: '/dc-shared/placeholders.json', as: 'fetch', crossorigin: 'anonymous', fetchpriority: '' });
  assert.match(stdout, /Manifest \(4 rows, 1 country\/locale specific link\(s\) left out\)/);
  assert.match(stdout, /publish as \/acrobat\/preloads\/plans\.json on https:\/\/www\.adobe\.com; prelink: <\/acrobat\/preloads\/plans\.json>; rel=preload; as=fetch; crossorigin=anonymous/);
});

test('POST, beacons, non-data MIME, failed, navigation-like and non-preload Other requests never become preloads', () => {
  const { lines, stderr } = generateFrom([dataTrace([
    { url: `${A}/experienceedge/v2/interact?dataStreamId=1`, method: 'POST' },
    { url: `${A}/experienceedge/v1/collect?configId=1`, method: 'POST', fetchType: 'beacon', mime: 'text/plain', status: 204 },
    { url: `${A}/ims/check/v6/token`, method: 'POST', fetchType: 'xmlhttprequest' },
    { url: `${A}/api/explicit-post.json`, type: 'Fetch', method: 'post' },
    { url: `${A}/acrobat/img/favicons/favicon.ico`, fetchType: '', mime: null },
    { url: `${A}/federal/assets/icons/checkmark.svg`, mime: 'image/svg+xml' },
    { url: `${A}/bfp/bfp-worker.min.js`, mime: 'application/javascript' },
    { url: `${A}/missing.json`, status: 404 },
    { url: `${A}/no-response.json`, mime: null },
    { url: `${A}/prefetched.json`, fetchType: 'link' },
    { url: `${A}/no-method-other.json`, method: null },
    { url: `${A}/legacy-xhr.json`, type: 'XHR', method: null, mime: null },
  ])]);
  assert.deepEqual(lines, ['<link rel="preload" href="/legacy-xhr.json" as="fetch" crossorigin>']);
  assert.match(stderr, /1 Fetch\/XHR request\(s\) without requestMethod .* assumed to be GET/);
});

test('a URL requested twice in one trace counts once for --min-runs and yields one link at its earliest start', () => {
  const sm = `${A}/federal/assets/supported-markets/supported-markets.json`;
  const frag = `${A}/mas/io/fragment?id=64d1&locale=en_US&country=CH`;
  const t1 = dataTrace([
    { url: sm, fetchType: 'link', preload: true, at: 1 }, // script preload first, consumer fetch later
    { url: sm, at: 3 },
    { url: frag, at: 4 }, // consumer fetch first, late preload after it
    { url: frag, fetchType: 'link', preload: true, at: 5 },
    { url: `${A}/dup-only-in-one-trace.json`, at: 6 },
    { url: `${A}/dup-only-in-one-trace.json`, at: 7 },
    { url: `${A}/dup-only-in-one-trace.json`, at: 8 },
  ]);
  const t2 = dataTrace([{ url: sm, at: 2 }, { url: frag, at: 4 }]);
  const t3 = dataTrace([]);
  const { lines, stdout } = generateFrom([t1, t2, t3]);
  assert.deepEqual(lines, [
    '<link rel="preload" href="/federal/assets/supported-markets/supported-markets.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/mas/io/fragment?id=64d1&amp;locale=en_US&amp;country=CH" as="fetch" crossorigin>',
  ]);
  assert.match(stdout, />= 2 traces/);
  // median of per-trace earliest starts: t1 preload at 100 ms (not its consumer at 300 ms), t2 fetch at 200 ms
  assert.match(stdout, /\n\s+150\s+200\s+Fetch \*\s+https:\/\/www\.adobe\.com\/federal/);
  assert.doesNotMatch(stdout, /dup-only-in-one-trace/);
});

test('the consumer request decides the preload type when a script preload of the same URL differs', () => {
  const url = `${A}/libs/blocks/merch/merch.js`;
  const t = dataTrace([
    { url, type: 'Script', fetchType: 'link', preload: true, at: 1, mime: 'text/javascript' },
    { url, type: 'Script', fetchType: 'script', at: 2, mime: 'text/javascript' },
    { url: `${A}/libs/blocks/merch/merch.css`, type: 'Stylesheet', fetchType: 'link', preload: true, at: 3, mime: 'text/css' },
  ]);
  t.traceEvents.push({ name: 'v8.compileModule', ts: 500000, args: { data: { url } } });
  assert.deepEqual(generateFrom([t]).lines, [
    '<link rel="modulepreload" href="/libs/blocks/merch/merch.js">',
    '<link rel="preload" href="//www.adobe.com/libs/blocks/merch/merch.css" as="style">',
  ]);
});

test('/experienceedge and /experienceedge/* are never preloaded, whatever the method, type or MIME', () => {
  const { lines } = generateFrom([dataTrace([
    { url: `${A}/experienceedge` },
    { url: `${A}/experienceedge/v2/config.json?x=1` },
    { url: `${A}/experienceedge/v2/interact`, type: 'Fetch' },
    { url: `${A}/experienceedge/alloy.js`, type: 'Script', fetchType: 'script', mime: 'text/javascript' },
    { url: `${A}/experienceedge/v2/data.json`, fetchType: 'link', preload: true },
    { url: `${A}/experienceedgex.json` },
    { url: `${A}/experienceedge-docs/a.json` },
    { url: `${A}/federal/experienceedge/a.json` },
  ])]);
  assert.deepEqual(lines, [
    '<link rel="preload" href="/experienceedgex.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/experienceedge-docs/a.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/federal/experienceedge/a.json" as="fetch" crossorigin>',
  ]);
});

test('an adobecom aem.live page keeps its Milo libs from main--milo--adobecom.aem.live, not other aem.live owners', () => {
  const live = 'https://main--da-dc--adobecom.aem.live/drafts/ilyas/acrobat/plans';
  const milo = 'https://main--milo--adobecom.aem.live/libs/utils/utils.js';
  const t = dataTrace([
    { url: milo, type: 'Script', fetchType: 'script', mime: 'text/javascript' },
    { url: 'https://main--da-dc--adobecom.aem.live/acrobat/scripts/scripts.js', type: 'Script', fetchType: 'script', mime: 'text/javascript' },
    { url: 'https://main--x--someoneelse.aem.live/x.js', type: 'Script', fetchType: 'script', mime: 'text/javascript' },
    { url: 'https://www.adobe.com/libs/other.js', type: 'Script', fetchType: 'script', mime: 'text/javascript' },
    { url: 'https://main--da-dc--adobecom.aem.live/dc-shared/placeholders.json' },
  ]);
  t.traceEvents[0].args.data.documentLoaderURL = live;
  for (const url of [milo, 'https://main--da-dc--adobecom.aem.live/acrobat/scripts/scripts.js']) t.traceEvents.push({ name: 'v8.compileModule', ts: 900000, args: { data: { url } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-test-'));
  try {
    const f = path.join(dir, 't1.json');
    fs.writeFileSync(f, JSON.stringify(t));
    const r = spawnSync(process.execPath, [CLI, live, '--from', f, '-o', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'drafts--ilyas--acrobat--plans.html'), 'utf8').trim().split('\n'), [
      `<link rel="modulepreload" href="${milo}" crossorigin>`,
      '<link rel="modulepreload" href="/acrobat/scripts/scripts.js">',
      '<link rel="preload" href="/dc-shared/placeholders.json" as="fetch" crossorigin>',
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'drafts--ilyas--acrobat--plans.json'), 'utf8')).data, [
      { rel: 'modulepreload', href: milo, as: '', crossorigin: 'anonymous', fetchpriority: '' },
      { rel: 'modulepreload', href: '/acrobat/scripts/scripts.js', as: '', crossorigin: '', fetchpriority: '' },
      { rel: 'preload', href: '/dc-shared/placeholders.json', as: 'fetch', crossorigin: 'anonymous', fetchpriority: '' },
    ]);
    assert.match(r.stdout, /publish as \/drafts\/ilyas\/acrobat\/preloads\/plans\.json on https:\/\/main--da-dc--adobecom\.aem\.live/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
