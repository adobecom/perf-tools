import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

test('--all-origins: crossorigin follows the consumer request mode, same-origin stylesheets are absolute', () => {
  assert.deepEqual(generate('--all-origins'), [
    '<link rel="modulepreload" href="/acrobat/scripts/scripts.js">',
    '<link rel="preload" href="https://www.adobe.com/libs/c2/styles/styles.css" as="style">',
    '<link rel="preload" href="https://www.adobe.com/acrobat/styles/styles.css?a=1&amp;b=&quot;2&quot;" as="style">',
    '<link rel="modulepreload" href="/libs/utils/utils.js">',
    '<link rel="preload" href="https://use.typekit.net/vti0xwb.css" as="style">',
    '<link rel="preload" href="https://p.typekit.net/p.css?s=1&amp;k=vti0xwb&amp;ht=tk" as="style">',
    '<link rel="preload" href="https://use.typekit.net/af/abc/l?primer=7cdc&amp;fvd=n4&amp;v=3" as="font" crossorigin>',
    '<link rel="modulepreload" href="https://cdn.example.net/lib/module.js" crossorigin>',
    '<link rel="preload" href="https://cdn.example.net/lib/classic.js" as="script" crossorigin>',
    '<link rel="preload" href="/acrobat/placeholders.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/acrobat/media_123.png?width=750&amp;format=webp" as="image" fetchpriority="high">',
  ]);
});

test('same-site only by default; stylesheet preloads never match a relative link[href] lookup', () => {
  const lines = generate();
  assert.deepEqual(lines, [
    '<link rel="modulepreload" href="/acrobat/scripts/scripts.js">',
    '<link rel="preload" href="https://www.adobe.com/libs/c2/styles/styles.css" as="style">',
    '<link rel="preload" href="https://www.adobe.com/acrobat/styles/styles.css?a=1&amp;b=&quot;2&quot;" as="style">',
    '<link rel="modulepreload" href="/libs/utils/utils.js">',
    '<link rel="preload" href="/acrobat/placeholders.json" as="fetch" crossorigin>',
    '<link rel="preload" href="/acrobat/media_123.png?width=750&amp;format=webp" as="image" fetchpriority="high">',
  ]);
  for (const l of lines.filter((x) => x.includes('as="style"'))) {
    assert.doesNotMatch(l, /href="\//);
    assert.doesNotMatch(l, /crossorigin/);
  }
});
