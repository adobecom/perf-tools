import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestPath, prelinkEntry, toManifest, manifestRows, isContextual, MANIFEST_COLUMNS } from '../lib/prelink.mjs';

test('manifest path: <dir>/<name> -> <dir>/preloads/<name>.json', () => {
  assert.equal(manifestPath('/drafts/ilyas/acrobat/plans'), '/drafts/ilyas/acrobat/preloads/plans.json');
  assert.equal(manifestPath('/acrobat/plans.html'), '/acrobat/preloads/plans.json');
  assert.equal(manifestPath('/acrobat/'), '/acrobat/preloads/index.json');
  assert.equal(manifestPath('/'), '/preloads/index.json');
  assert.equal(prelinkEntry('/acrobat/preloads/plans.json'), '</acrobat/preloads/plans.json>; rel=preload; as=fetch; crossorigin=anonymous');
});

test('manifest: DA sheet with string cells in a fixed column set; rows are validated', () => {
  const m = toManifest([
    { rel: 'modulepreload', href: 'https://main--milo--adobecom.aem.live/libs/utils/utils.js', crossorigin: 'anonymous', url: 'ignored' },
    { rel: 'preload', href: '/x.json', as: 'fetch', crossorigin: 'anonymous' },
  ]);
  assert.deepEqual(m, {
    total: 2, limit: 2, offset: 0, ':sheetname': 'data', ':type': 'sheet',
    data: [
      { rel: 'modulepreload', href: 'https://main--milo--adobecom.aem.live/libs/utils/utils.js', as: '', crossorigin: 'anonymous', fetchpriority: '' },
      { rel: 'preload', href: '/x.json', as: 'fetch', crossorigin: 'anonymous', fetchpriority: '' },
    ],
  });
  assert.deepEqual(manifestRows(m), m.data);
  assert.deepEqual(manifestRows({ total: 0, offset: 0, limit: 0, data: [], columns: MANIFEST_COLUMNS, ':type': 'sheet' }), []);
  assert.throws(() => manifestRows({ data: [] }), /single DA sheet/);
  assert.throws(() => manifestRows({ ':type': 'multi-sheet', data: [] }), /single DA sheet/);
  assert.throws(() => manifestRows({ ':type': 'sheet', data: [{ key: 'title', value: 'x' }] }), /exactly the columns rel, href, as, crossorigin, fetchpriority/);
  assert.equal(isContextual('/mas/io/fragment?id=1&country=CH', 'https://www.adobe.com/'), true);
  assert.equal(isContextual('https://www.adobe.com/x.json?sheet=en', undefined), false);
});
