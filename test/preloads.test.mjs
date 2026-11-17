import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preloadUsage, unusedPreloadUrl } from '../lib/pagespeed/preloads.mjs';

const sent = (url, extra = {}) => ({ method: 'Network.requestWillBeSent', params: { frameId: 'MAIN', type: 'Script', request: { url, isLinkPreload: true }, initiator: { type: 'other' }, ...extra } });

test('Chrome unused-preload console warnings are recognised by URL', () => {
  const text = "The resource https://www.adobe.com/a.js was preloaded using link preload but not used within a few seconds from the window's load event. Please make sure it has an appropriate `as` value and it is preloaded intentionally.";
  assert.equal(unusedPreloadUrl(text), 'https://www.adobe.com/a.js');
  assert.equal(unusedPreloadUrl('Uncaught TypeError: x'), null);
  assert.equal(unusedPreloadUrl(undefined), null);
});

test('preload usage: main-frame preload requests with their declaring source and unused flag', () => {
  const log = [
    { method: 'Network.requestWillBeSent', params: { frameId: 'MAIN', type: 'Document', request: { url: 'https://www.adobe.com/page' }, initiator: { type: 'other' } } },
    sent('https://www.adobe.com/a.js'),
    sent('https://www.adobe.com/b.css', { type: 'Stylesheet', initiator: { type: 'parser' } }),
    sent('https://www.adobe.com/c.json', { type: 'Fetch', initiator: { type: 'script' } }),
    sent('https://www.adobe.com/a.js'),
    sent('https://iframe.adobe.com/d.js', { frameId: 'CHILD' }),
    { method: 'Network.requestWillBeSent', params: { frameId: 'MAIN', type: 'Script', request: { url: 'https://www.adobe.com/not-a-preload.js' }, initiator: { type: 'parser' } } },
  ];
  assert.deepEqual(preloadUsage(log, new Set(['https://www.adobe.com/b.css'])), [
    { url: 'https://www.adobe.com/a.js', source: 'link-header', type: 'Script', unused: false },
    { url: 'https://www.adobe.com/b.css', source: 'html', type: 'Stylesheet', unused: true },
    { url: 'https://www.adobe.com/c.json', source: 'script', type: 'Fetch', unused: false },
  ]);
  assert.deepEqual(preloadUsage(null), []);
});
