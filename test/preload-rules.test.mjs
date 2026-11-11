// Built-in preload exclusions (/marketingtech/*, bfp.adobe.com, /experienceedge/*, MEP preview tooling), --exclude, and Link header
// preloads in recorded traces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_EXCLUDES, parseExclude, matchExclude, describeRule } from '../lib/preload-rules.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'perf-preload.mjs');
const DOC = 'https://www.adobe.com/acrobat/plans.html';
const FRAME = 'F1';

// [url, resourceType, initiator]; every request finishes before the LCP.
function trace(requests) {
  const events = [{ name: 'navigationStart', ts: 1000, args: { frame: FRAME, data: { documentLoaderURL: DOC, isOutermostMainFrame: true } } }];
  requests.forEach(([url, resourceType, initiator, extra = {}], i) => {
    const ts = 2000 + i * 1000;
    events.push({ name: 'ResourceSendRequest', ts, args: { data: { requestId: `R${i}`, frame: FRAME, url, resourceType, initiator, ...extra } } });
    events.push({ name: 'ResourceFinish', ts: ts + 500, args: { data: { requestId: `R${i}` } } });
  });
  events.push({ name: 'largestContentfulPaint::Candidate', ts: 500000, args: { frame: FRAME, data: { type: 'text', nodeId: 7, nodeName: 'H1' } } });
  return { traceEvents: events };
}

const SCRIPT = { type: 'script' };
const REQUESTS = [
  ['https://www.adobe.com/acrobat/scripts/scripts.js', 'Script', SCRIPT],
  ['https://www.adobe.com/marketingtech/main.min.js', 'Script', SCRIPT],
  ['https://www.adobe.com/marketingtech/nested/dir/launch.js', 'Script', SCRIPT],
  ['https://www.adobe.com/marketingtechnology/ok.js', 'Script', SCRIPT],
  ['https://www.adobe.com/libs/marketingtech/ok.js', 'Script', SCRIPT],
  ['https://bfp.adobe.com/bfp.js', 'Script', SCRIPT],
  ['https://bfp.adobe.com/styles/bfp.css', 'Stylesheet', SCRIPT],
  ['https://www.adobe.com/libs/blocks/hero/hero.js', 'Script', SCRIPT],
  ['https://assets.adobe.com/marketingtech/other-origin.js', 'Script', SCRIPT],
  ['https://www.adobe.com/experienceedge/v1/x.json', 'Fetch', SCRIPT, { requestMethod: 'GET' }],
];

function run(requests, ...flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-preload-rules-'));
  try {
    fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify(trace(requests)));
    const r = spawnSync(process.execPath, [CLI, DOC, '--from', path.join(dir, 't.json'), '-o', dir, ...flags], { encoding: 'utf8' });
    const file = path.join(dir, 'acrobat--plans.html');
    return { ...r, links: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const hrefs = (links) => links.map((l) => /href="([^"]*)"/.exec(l)[1]);

test('rules: built-ins and --exclude values parse and match path prefixes and hosts', () => {
  assert.deepEqual(BUILT_IN_EXCLUDES.map(describeRule), ['/experienceedge/*', '/marketingtech/*', 'bfp.adobe.com', '/libs/features/mep/mep-next/*']);
  const u = (s) => new URL(s);
  assert.ok(matchExclude(BUILT_IN_EXCLUDES, u('https://www.adobe.com/marketingtech/a.js')));
  assert.ok(matchExclude(BUILT_IN_EXCLUDES, u('https://x.example/marketingtech')));
  assert.equal(matchExclude(BUILT_IN_EXCLUDES, u('https://www.adobe.com/marketingtechx/a.js')), null);
  assert.equal(matchExclude(BUILT_IN_EXCLUDES, u('https://www.adobe.com/libs/marketingtech/a.js')), null);
  assert.ok(matchExclude(BUILT_IN_EXCLUDES, u('https://bfp.adobe.com/a.js')));
  assert.ok(matchExclude(BUILT_IN_EXCLUDES, u('https://sub.bfp.adobe.com/a.js')));
  assert.equal(matchExclude(BUILT_IN_EXCLUDES, u('https://notbfp.adobe.com/a.js')), null);
  assert.deepEqual(parseExclude('/libs/martech/'), { kind: 'path', value: '/libs/martech', reason: 'excluded by --exclude' });
  assert.equal(parseExclude('/libs/martech/*').value, '/libs/martech');
  assert.deepEqual([parseExclude('CDN.Example.net').kind, parseExclude('CDN.Example.net').value], ['host', 'cdn.example.net']);
  for (const bad of ['', '/', 'not a host', 'https://x.com/', '/a b']) assert.throws(() => parseExclude(bad), /--exclude/, bad);
});

test('perf-preload never emits /marketingtech/* (any origin) or bfp.adobe.com, and lists them as excluded by rule', () => {
  const r = run(REQUESTS, '--all-origins', '--min-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hrefs(r.links), [
    '/acrobat/scripts/scripts.js',
    '/marketingtechnology/ok.js',
    '/libs/marketingtech/ok.js',
    '/libs/blocks/hero/hero.js',
  ]);
  assert.match(r.stdout, /Excluded by rule/);
  for (const url of ['www.adobe.com/marketingtech/main.min.js', 'marketingtech/nested/dir/launch.js', 'bfp.adobe.com/bfp.js', 'bfp.adobe.com/styles/bfp.css', 'assets.adobe.com/marketingtech/other-origin.js', 'experienceedge/v1/x.json']) {
    assert.ok(r.stdout.includes(url), `${url} listed as excluded`);
  }
  assert.match(r.stdout, /\/marketingtech\/\*  https:\/\/www\.adobe\.com\/marketingtech\/main\.min\.js/);
  assert.match(r.stdout, /bfp\.adobe\.com  https:\/\/bfp\.adobe\.com\/bfp\.js/);
  assert.match(r.stdout, /Exclude rules: \/experienceedge\/\*, \/marketingtech\/\*, bfp\.adobe\.com, \/libs\/features\/mep\/mep-next\/\*/);
  assert.doesNotMatch(r.links.join('\n'), /marketingtech\/(main|nested|other)|bfp\.adobe\.com/);
});

test('MEP preview tooling and what it imports are never preloaded; the page\'s own requests stay', () => {
  const M = 'https://main--milo--adobecom.aem.live/libs';
  const r = run([
    [`${M}/features/personalization/personalization.js`, 'Script', SCRIPT],
    [`${M}/features/mep/mep-next/mep-next.js`, 'Script', { type: 'script', url: `${M}/features/personalization/personalization.js` }],
    [`${M}/blocks/merch/merch.js`, 'Script', { type: 'script', url: `${M}/features/mep/mep-next/mep-next.js` }],
    [`${M}/features/mep/mep-next/mep-overlay/mep-overlay.js`, 'Script', SCRIPT],
    [`${M}/features/mep/sidekick-auth.js`, 'Script', { type: 'script', url: `${M}/features/mep/mep-next/mep-overlay/mep-overlay.js` }],
    [`${M}/utils/decorate.js`, 'Script', { type: 'script', stack: { callFrames: [{ url: `${M}/c2/blocks/rich-content/rich-content.js` }] } }],
  ], '--all-origins', '--min-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hrefs(r.links), [`${M}/features/personalization/personalization.js`, `${M}/utils/decorate.js`]);
  assert.match(r.stdout, /\/libs\/features\/mep\/mep-next\/\*  https:\/\/[^\n]*mep-next\.js/);
  assert.match(r.stdout, /requested by excluded https:\/\/[^\n]*mep-next\.js  https:\/\/[^\n]*\/blocks\/merch\/merch\.js/);
  assert.match(r.stdout, /requested by excluded https:\/\/[^\n]*mep-overlay\.js  https:\/\/[^\n]*sidekick-auth\.js/);
});

test('a resource the page requested before an excluded one did is kept', () => {
  const M = 'https://main--milo--adobecom.aem.live/libs';
  const r = run([
    [`${M}/blocks/merch/merch.js`, 'Script', SCRIPT],
    [`${M}/features/mep/mep-next/mep-next.js`, 'Script', SCRIPT],
    [`${M}/blocks/merch/merch.js`, 'Script', { type: 'script', url: `${M}/features/mep/mep-next/mep-next.js` }],
  ], '--all-origins', '--min-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hrefs(r.links), [`${M}/blocks/merch/merch.js`]);
});

test('--exclude adds path prefixes and hosts (repeatable) on top of the built-ins', () => {
  const r = run(REQUESTS, '--all-origins', '--min-runs', '1', '--exclude', '/libs/blocks', '--exclude', 'assets.adobe.com', '--exclude', '/marketingtechnology/');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hrefs(r.links), ['/acrobat/scripts/scripts.js', '/libs/marketingtech/ok.js']);
  assert.match(r.stdout, /\/libs\/blocks\/\*  https:\/\/www\.adobe\.com\/libs\/blocks\/hero\/hero\.js/);
  assert.match(r.stdout, /Exclude rules: .*\/libs\/blocks\/\*, assets\.adobe\.com, \/marketingtechnology\/\*/);
  const bad = run(REQUESTS, '--exclude', 'https://nope/');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--exclude https:\/\/nope\//);
});

test('Link header preloads (initiator "other") are still generated, marked ^ with a bias warning; script preloads keep the * note', () => {
  const header = (url, type) => [url, type, { type: 'other' }, { isLinkPreload: true }];
  const r = run([
    header('https://www.adobe.com/libs/utils/utils.js', 'Script'),
    header('https://www.adobe.com/libs/deps/imslib.min.js', 'Script'),
    header('https://www.adobe.com/libs/c2/styles/styles.css', 'Stylesheet'),
    ['https://www.adobe.com/libs/blocks/a/a.js', 'Script', { type: 'script' }, { isLinkPreload: true }],
    ['https://www.adobe.com/inline.js', 'Script', { type: 'parser', url: DOC }],
    header('https://www.adobe.com/marketingtech/header-preloaded.js', 'Script'),
  ], '--min-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hrefs(r.links), [
    '/libs/utils/utils.js',
    '/libs/deps/imslib.min.js',
    '//www.adobe.com/libs/c2/styles/styles.css',
    '/libs/blocks/a/a.js',
  ]);
  assert.match(r.stdout, /Script \^ +https:\/\/www\.adobe\.com\/libs\/utils\/utils\.js/);
  assert.match(r.stdout, /Script \* +https:\/\/www\.adobe\.com\/libs\/blocks\/a\/a\.js/);
  assert.match(r.stdout, /\^ preloaded by the document's Link response header in these traces\. WARNING: biased list/);
  assert.match(r.stdout, /already preloaded by a script/);
  assert.ok(r.stdout.includes('/marketingtech/*  https://www.adobe.com/marketingtech/header-preloaded.js'), 'rules also apply to header-preloaded resources');
});
