// Render guard for the measured document (lib/pagespeed/render-guard.mjs). Unit tests only, no browser: Lighthouse
// 13.6.0's BFCacheFailures gatherer sends the tab to chrome://terms and back after the trace, which can load a
// different document (e.g. an Akamai "Access Denied" page). That post-trace navigation is simulated with a fake tab
// behind the driver surface the gatherer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lighthouseConfig } from '../lib/pagespeed/profile.mjs';
import {
  MeasuredRenderGatherer, MeasuredRenderAudit, RENDER_ARTIFACT, RENDER_AUDIT, assessRender, measuredNavigation, readRender, renderOk,
} from '../lib/pagespeed/render-guard.mjs';

const EXPECT = { title: '^Fixture plans$', counts: [{ selector: '.card', count: 3 }] };
const frame = (id, loaderId, extra = {}) => ({ method: 'Page.frameNavigated', params: { frame: { id, loaderId, url: 'https://x', ...extra } } });

// A tab whose document can be swapped.
function fakeTab(document) {
  const tab = {
    document,
    navigate(next) { tab.document = next; },
    driver: {
      defaultSession: { sendCommand: async () => ({ frameTree: { frame: { id: 'F1', loaderId: tab.document.loaderId } } }) },
      executionContext: {
        evaluate: async (fn, { args: [selectors] }) => {
          if (tab.document.captureError) throw new Error(tab.document.captureError);
          return {
            url: 'https://www.adobe.com/page', readyState: 'complete', title: tab.document.title, bodyVisible: tab.document.bodyVisible,
            counts: Object.fromEntries(selectors.map((s) => [s, tab.document.counts[s] ?? 0])),
          };
        },
      },
    },
  };
  return tab;
}
const measuredDoc = (over = {}) => ({ loaderId: 'L-measured', title: 'Fixture plans', bodyVisible: true, counts: { '.card': 3 }, ...over });
const accessDenied = { loaderId: 'L-post-trace', title: 'Access Denied', bodyVisible: true, counts: {} };

// Lighthouse order: stopInstrumentation of every gatherer first, then getArtifact; BFCacheFailures navigates in between.
async function lifecycle(measured, expect = EXPECT) {
  const tab = fakeTab(measured);
  const gatherer = lighthouseConfig({ expect }).artifacts[0].gatherer.instance;
  gatherer.startInstrumentation();
  let artifact;
  try {
    await gatherer.stopInstrumentation({ driver: tab.driver });
    tab.navigate(accessDenied);
    artifact = gatherer.getArtifact();
  } catch (e) {
    artifact = e;
  }
  return { render: assessRender(artifact, [frame('F1', measured.loaderId)], expect), tab };
}

test('post-trace navigation swaps the document: the guard still validates the measured one', async () => {
  const { render, tab } = await lifecycle(measuredDoc());
  assert.equal(tab.document.title, 'Access Denied', 'the tab no longer holds the measured document');
  assert.deepEqual(render, {
    title: 'Fixture plans', titleOk: true, bodyVisible: true, counts: { '.card': 3 }, countsOk: true,
    measured: { source: 'lighthouse-stopInstrumentation', url: 'https://www.adobe.com/page', readyState: 'complete', frameId: 'F1', loaderId: 'L-measured', matchesDevtoolsLog: true },
  });
  assert.equal(renderOk(render), true);
  // What a check after lighthouse() returns would have seen: the wrong document, rejecting this valid page.
  const afterwards = await fakeTab(accessDenied).driver.executionContext.evaluate(readRender, { args: [['.card']] });
  assert.equal(new RegExp(EXPECT.title).test(afterwards.title), false);
});

test('post-trace navigation swaps the document: an invalid measured document is rejected', async () => {
  for (const [name, doc, field] of [
    ['wrong title', measuredDoc({ title: 'Wrong page' }), 'titleOk'],
    ['wrong count', measuredDoc({ counts: { '.card': 1 } }), 'countsOk'],
    ['hidden body', measuredDoc({ bodyVisible: false }), 'bodyVisible'],
  ]) {
    const { render } = await lifecycle(doc);
    assert.equal(render[field], false, name);
    assert.equal(renderOk(render), false, name);
    assert.equal(render.measured.matchesDevtoolsLog, true, `${name}: still the measured document`);
  }
});

test('post-trace navigation swaps the document: a failed capture rejects', async () => {
  const { render } = await lifecycle(measuredDoc({ captureError: 'Evaluation exception: invalid selector' }));
  assert.deepEqual(render, { captured: false, error: 'Evaluation exception: invalid selector' });
  assert.equal(renderOk(render), false);
  // The main frame navigated while the page was being read: not provably the measured document.
  const tab = fakeTab(measuredDoc());
  let calls = 0;
  tab.driver.defaultSession.sendCommand = async () => ({ frameTree: { frame: { id: 'F1', loaderId: calls++ ? 'L-other' : 'L-measured' } } });
  await assert.rejects(new MeasuredRenderGatherer(EXPECT).stopInstrumentation({ driver: tab.driver }), /navigated while the render was being captured/);
});

test('gatherer reads the page in stopInstrumentation, before any getArtifact', async () => {
  const gatherer = new MeasuredRenderGatherer(EXPECT);
  assert.deepEqual(gatherer.meta.supportedModes, ['navigation']);
  const calls = [];
  const driver = {
    defaultSession: { sendCommand: async (method) => { calls.push(method); return { frameTree: { frame: { id: 'F1', loaderId: 'L1' } } }; } },
    executionContext: { evaluate: async (fn, opts) => { calls.push(`evaluate:${fn.name}:${JSON.stringify(opts)}`); return { url: 'https://x', readyState: 'complete', title: 'T', bodyVisible: true, counts: { '.card': 3 } }; } },
  };
  await gatherer.stopInstrumentation({ driver });
  assert.deepEqual(calls, ['Page.getFrameTree', 'evaluate:readRender:{"args":[[".card"]],"useIsolation":true}', 'Page.getFrameTree']);
  assert.deepEqual(gatherer.getArtifact(), { url: 'https://x', readyState: 'complete', title: 'T', bodyVisible: true, counts: { '.card': 3 }, frameId: 'F1', loaderId: 'L1' });
  gatherer.startInstrumentation();
  assert.equal(gatherer.getArtifact(), undefined, 'nothing from an earlier load survives');
});

test('readRender: counts are the full DOM (hidden matches included); body must be a visible, non-empty element', () => {
  const style = (o) => ({ display: 'block', visibility: 'visible', opacity: '1', ...o });
  const run = (body, nodes) => {
    globalThis.document = { URL: 'https://x/', readyState: 'complete', title: 'T', body, querySelectorAll: () => nodes };
    globalThis.getComputedStyle = () => body.style;
    try { return readRender(['.card']); } finally { delete globalThis.document; delete globalThis.getComputedStyle; }
  };
  const visible = { children: [{}], style: style({}) };
  assert.deepEqual(run(visible, [{}, {}, {}]).counts, { '.card': 3 });
  assert.equal(run(visible, [{}]).bodyVisible, true);
  for (const bad of [style({ display: 'none' }), style({ visibility: 'hidden' }), style({ opacity: '0' })]) {
    assert.equal(run({ children: [{}], style: bad }, []).bodyVisible, false);
  }
  assert.equal(run({ children: [], style: style({}) }, []).bodyVisible, false, 'empty body');
});

const log = [frame('F1', 'L1'), frame('C1', 'LC', { parentId: 'F1' }), frame('F1', 'L2')];
const capture = (over = {}) => ({ url: 'https://www.adobe.com/page', readyState: 'complete', title: 'Plans', bodyVisible: true, counts: { 'main h1': 1 }, frameId: 'F1', loaderId: 'L2', ...over });
const expectation = { title: '^Plans$', counts: [{ selector: 'main h1', count: 1 }] };

test('assessRender: only a visible measured document with the expected title and full-DOM counts passes', () => {
  assert.equal(renderOk(assessRender(capture(), log, expectation)), true);
  // Without expectations only the body visibility and the measured-document proof apply.
  assert.equal(renderOk(assessRender(capture({ title: 'Access Denied', counts: {} }), log, {})), true);
  for (const [name, c] of [
    ['wrong title', capture({ title: 'Access Denied' })],
    ['count differs', capture({ counts: { 'main h1': 2 } })],
    ['count missing', capture({ counts: {} })],
    ['hidden body', capture({ bodyVisible: false })],
  ]) assert.equal(renderOk(assessRender(c, log, expectation)), false, name);
});

test('assessRender: a render that is not provably the measured navigation never passes', () => {
  assert.equal(renderOk(assessRender(capture({ loaderId: 'L-other' }), log, expectation)), false, 'different document loader');
  assert.equal(renderOk(assessRender(capture({ frameId: 'C1' }), log, expectation)), false, 'a subframe is not the measured document');
  assert.equal(renderOk(assessRender(capture(), [], expectation)), false, 'no navigation in the DevTools log');
  assert.equal(renderOk(assessRender(capture(), undefined, expectation)), false);
  assert.equal(renderOk(assessRender(capture({ loaderId: undefined }), log, expectation)), false);
  assert.equal(measuredNavigation(log).loaderId, 'L2', 'the last main-frame navigation wins; subframes are ignored');
});

test('assessRender: a failed or missing capture fails closed', () => {
  for (const artifact of [new Error('Evaluation exception: SyntaxError'), undefined, null, 'oops']) {
    const render = assessRender(artifact, log, expectation);
    assert.equal(render.captured, false);
    assert.equal(renderOk(render), false);
  }
  assert.equal(assessRender(new Error('boom'), log, {}).error, 'boom');
});

test('lighthouseConfig: the guard adds one artifact and one weight-0 informative audit, settings unchanged', () => {
  const plain = lighthouseConfig();
  const guarded = lighthouseConfig({ expect: EXPECT });
  assert.deepEqual(plain.settings, guarded.settings);
  assert.equal(plain.extends, 'lighthouse:default');
  assert.deepEqual(guarded.artifacts.map((a) => a.id), [RENDER_ARTIFACT]);
  assert.deepEqual(guarded.audits.map((a) => a.implementation), [MeasuredRenderAudit]);
  assert.deepEqual(guarded.categories, { performance: { auditRefs: [{ id: RENDER_AUDIT, weight: 0, group: 'hidden' }] } }, 'weight 0: not scored');
  assert.deepEqual(MeasuredRenderAudit.meta.requiredArtifacts, [RENDER_ARTIFACT]);
  assert.deepEqual(guarded.artifacts[0].gatherer.instance.selectors, ['.card']);
  assert.deepEqual(lighthouseConfig({ expect: { counts: [{ selector: 'a', count: 1 }, { selector: 'a', count: 1 }] } }).artifacts[0].gatherer.instance.selectors, ['a']);
});
