// Unit tests for client-side Splunk CSV parsing and analysis (site/splunk-core.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as splunk from '../site/splunk-core.mjs';

test('isCsvFile accepts CSV extensions and CSV MIME types, rejects non-CSV files', () => {
  assert.equal(splunk.isCsvFile({ name: 'export.csv', type: '' }), true);
  assert.equal(splunk.isCsvFile({ name: 'EXPORT.CSV', type: 'application/vnd.ms-excel' }), true);
  assert.equal(splunk.isCsvFile({ name: 'splunk-data', type: 'text/csv; charset=utf-8' }), true);
  assert.equal(splunk.isCsvFile({ name: 'report.json', type: 'application/json' }), false);
  assert.equal(splunk.isCsvFile({ name: 'image.png', type: 'image/png' }), false);
  assert.equal(splunk.isCsvFile({ name: 'notes.txt', type: 'text/plain' }), false);
  assert.equal(splunk.isCsvFile(null), false);
});

test('parseCsv handles BOM, CRLF, quoted commas and escaped quotes, and rejects invalid inputs', () => {
  const parsed = splunk.parseCsv('\uFEFF"a","b"\r\n"hello, ""world""","123"\r\n');
  assert.deepEqual(parsed.headers, ['a', 'b']);
  assert.deepEqual(parsed.rows, [['hello, "world"', '123']]);

  assert.throws(() => splunk.parseCsv('a\0b'), splunk.SplunkError);
  assert.throws(() => splunk.parseCsv('"unclosed'), splunk.SplunkError);
  assert.throws(() => splunk.parseCsv('only_header\n'), splunk.SplunkError);
});

test('parseSplunkCsv parses raw _time/_raw Splunk exports including commas in manifests and bots', () => {
  const row1 = JSON.stringify({
    log_timestamp: '2026-11-19T13:22:45.131Z',
    log_message: 'client=pageperf¦type=e¦sample=100¦user-agent=Mozilla/5.0 Chrome/126.0.0.0¦referer=https://www.adobe.com/acrobat/plans.html?a=1&amp;b=2¦message=chromeVer=126.0.0.0,cls=0.002,country=il,downlink=0.4,isFrag=false,isMep=true,lcp=4104,lcpEl=&lt;h1 id="title"&gt;Plans&lt;/h1&gt;,lcpElType=h1,lcpSectionOne=true,loggedIn=false,manifest1path=/acrobat/swap.json,manifest1selected=countryip(it,pt,es),os=win,tablet=no,url=www.adobe.com/acrobat/plans.html,windowHeight=800,windowWidth=1200',
  });
  const row2 = JSON.stringify({
    log_timestamp: '2026-11-19T13:31:51.400Z',
    log_message: 'client=pageperf¦type=e¦sample=100¦user-agent=Mozilla/5.0 Tokowaka/1.0 AdobeEdgeOptimize/1.0¦referer=https://www.adobe.com/acrobat/plans.html¦message=cls=0.527,country=cn,downlink=10,lcp=697,lcpElType=Element Was Replaced,lcpSectionOne=true,os=mac,url=www.adobe.com/acrobat/plans.html,windowHeight=1080,windowWidth=1920',
  });
  const csv = '"_time","_raw"\n'
    + `"2026-11-19T13:22:45.131+0000","${row1.replace(/"/g, '""')}"\n`
    + `"2026-11-19T13:31:51.400+0000","${row2.replace(/"/g, '""')}"\n`;

  const parsed = splunk.parseSplunkCsv(csv, 'raw.csv');
  assert.equal(parsed.kind, 'events');
  assert.equal(parsed.source, 'raw');
  assert.equal(parsed.events.length, 2);

  assert.equal(parsed.events[0].lcp, 4104);
  assert.equal(parsed.events[0].lcpEl, '<h1 id="title">Plans</h1>');
  assert.equal(parsed.events[0].manifests[0].selected, 'countryip(it,pt,es)');
  assert.equal(parsed.events[0].bot, null);

  assert.equal(parsed.events[1].lcpEl, '(Element Was Replaced / Missing)');
  assert.equal(parsed.events[1].bot, 'Tokowaka');

  const all = splunk.analyzeSplunk(parsed);
  assert.equal(all.botCount, 1);
  assert.equal(all.cls.max, 0.527);
  assert.ok(all.insights.some((i) => /synthetic\/automation/i.test(i.title)));

  const humanOnly = splunk.analyzeSplunk(parsed, { ...splunk.EMPTY_SPLUNK_FILTERS, excludeBots: true });
  assert.equal(humanOnly.matchedEvents, 1);
  assert.equal(humanOnly.cls.max, 0.002);
});

test('parseSplunkCsv parses extracted pp_* columns and aggregated stats tables', () => {
  const extractedCsv = [
    '_time,pp_lcp,pp_cls,pp_lcpEl,pp_windowWidth,pp_country,pp_url',
    '2026-11-19T10:00:00Z,1200,0.01,<h1>Hero</h1>,1280,us,www.adobe.com/test.html',
    '2026-11-19T10:05:00Z,3200,0.02,<h1>Hero</h1>,390,gb,www.adobe.com/test.html',
  ].join('\n');
  const extracted = splunk.parseSplunkCsv(extractedCsv, 'fields.csv');
  assert.equal(extracted.kind, 'events');
  assert.equal(extracted.source, 'fields');
  const analysis = splunk.analyzeSplunk(extracted);
  assert.equal(analysis.matchedEvents, 2);
  assert.equal(analysis.breakdowns.device.length, 2);

  const statsCsv = [
    'device,pp_lcpEl,lcpCount,percent,p50_lcp,p75_lcp,p95_lcp',
    'desktop,<h1>Plans</h1>,90,90.0,750,1200,2600',
    'mobile,<p>Subhead</p>,10,10.0,2200,3500,9000',
  ].join('\n');
  const stats = splunk.parseSplunkCsv(statsCsv, 'stats.csv');
  assert.equal(stats.kind, 'stats');
  assert.equal(stats.hasDevice, true);
  assert.equal(stats.totalCount, 100);
  const statsAnalysis = splunk.analyzeSplunk(stats);
  assert.equal(statsAnalysis.rows[0].cwvStatus, 'good');
  assert.equal(statsAnalysis.rows[1].cwvStatus, 'ni');
});

test('parseSplunkCsv rejects unrecognized CSV schemas clearly', () => {
  assert.throws(() => splunk.parseSplunkCsv('foo,bar\n1,2\n', 'other.csv'), /Unrecognized Splunk CSV columns/);
});
