// Render guard for the document Lighthouse actually measured.
//
// Lighthouse 13.6.0 runs its last navigation-mode gatherer (BFCacheFailures) after the measured trace has been
// stopped: it sends the tab to chrome://terms and back to test back/forward-cache eligibility. When the page is not
// restored from the bfcache, "back" loads the URL again, so the tab that is left after lighthouse() returns can hold a
// different document than the one in the trace (for example an Akamai "Access Denied" page). The guard therefore
// runs inside Lighthouse's own lifecycle: the MeasuredRender gatherer reads the page in its stopInstrumentation phase.
// Lighthouse runs every stopSensitiveInstrumentation/stopInstrumentation before ANY getArtifact, so the trace and the
// DevTools log are complete, the measured document is still the tab's document, and no gatherer has navigated yet,
// whatever the artifact order is.
//
// Lighthouse drops artifacts that no kept audit requires, and audits that no category lists. The artifact is therefore
// required by one informative audit, listed in the performance category with weight 0 in the hidden group (the way
// Lighthouse lists final-screenshot, metrics and similar): it cannot change a score or any standard audit, it is not
// rendered in report.html, and it puts the measured render into report.json.
import { Audit, Gatherer } from 'lighthouse';

export const RENDER_ARTIFACT = 'MeasuredRender';
export const RENDER_AUDIT = 'perf-ab-measured-render';

// Runs in the measured page (Lighthouse isolated world, same DOM). counts are the FULL DOM count of
// document.querySelectorAll(selector): hidden and off-screen matches included. body must be a visible, non-empty element.
export function readRender(selectors) {
  const body = document.body;
  const style = body && getComputedStyle(body);
  return {
    url: document.URL,
    readyState: document.readyState,
    title: document.title,
    bodyVisible: !!body && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && body.children.length > 0,
    counts: Object.fromEntries(selectors.map((s) => [s, document.querySelectorAll(s).length])),
  };
}

const mainFrame = async (driver) => (await driver.defaultSession.sendCommand('Page.getFrameTree')).frameTree.frame;

export class MeasuredRenderGatherer extends Gatherer {
  meta = { supportedModes: ['navigation'] };

  constructor(expect = {}) {
    super();
    this.selectors = [...new Set((expect.counts ?? []).map((c) => c.selector))];
    this.capture = undefined;
  }

  startInstrumentation() {
    this.capture = undefined;
  }

  async stopInstrumentation({ driver }) {
    const before = await mainFrame(driver);
    const page = await driver.executionContext.evaluate(readRender, { args: [this.selectors], useIsolation: true });
    const after = await mainFrame(driver);
    if (before.loaderId !== after.loaderId) throw new Error('the main frame navigated while the render was being captured');
    this.capture = { ...page, frameId: after.id, loaderId: after.loaderId };
  }

  getArtifact() {
    return this.capture;
  }
}

export class MeasuredRenderAudit extends Audit {
  static get meta() {
    return {
      id: RENDER_AUDIT,
      title: 'Measured document render (perf-ab)',
      description: 'Title, body visibility and selector counts read from the measured document, before Lighthouse leaves the page for its back/forward-cache test. Informative only; weight 0.',
      scoreDisplayMode: Audit.SCORING_MODES.INFORMATIVE,
      requiredArtifacts: [RENDER_ARTIFACT],
    };
  }

  static audit(artifacts) {
    return { score: 1, details: { type: 'debugdata', ...artifacts[RENDER_ARTIFACT] } };
  }
}

// The config fragment that adds the guard to lighthouse:default (merged by lib/pagespeed/profile.mjs).
export function renderGuardConfig(expect = {}) {
  return {
    artifacts: [{ id: RENDER_ARTIFACT, gatherer: { instance: new MeasuredRenderGatherer(expect) } }],
    audits: [{ implementation: MeasuredRenderAudit }],
    categories: { performance: { auditRefs: [{ id: RENDER_AUDIT, weight: 0, group: 'hidden' }] } },
  };
}

// The last committed main-frame navigation in the DevTools log of the measured load.
export function measuredNavigation(devtoolsLog = []) {
  return devtoolsLog
    .filter((e) => e.method === 'Page.frameNavigated' && !e.params?.frame?.parentId)
    .map((e) => e.params.frame)
    .at(-1) ?? null;
}

// Evaluates the render captured from the measured navigation against the render guard. Fails closed: a missing or
// failed capture, or a capture whose document is not the one in the DevTools log, never passes.
export function assessRender(capture, devtoolsLog, expect = {}) {
  if (capture instanceof Error) return { captured: false, error: capture.message };
  if (!capture || typeof capture !== 'object') return { captured: false, error: 'no render was captured from the measured navigation' };
  const navigation = measuredNavigation(devtoolsLog);
  const title = typeof capture.title === 'string' ? capture.title : '';
  const counts = capture.counts && typeof capture.counts === 'object' ? capture.counts : {};
  return {
    title,
    titleOk: expect.title == null || new RegExp(expect.title).test(title),
    bodyVisible: capture.bodyVisible === true,
    counts,
    countsOk: (expect.counts ?? []).every((c) => counts[c.selector] === c.count),
    measured: {
      source: 'lighthouse-stopInstrumentation',
      url: capture.url ?? null,
      readyState: capture.readyState ?? null,
      frameId: capture.frameId ?? null,
      loaderId: capture.loaderId ?? null,
      matchesDevtoolsLog: !!navigation && !!capture.loaderId && navigation.id === capture.frameId && navigation.loaderId === capture.loaderId,
    },
  };
}

export const renderOk = (render) => render.captured !== false && render.bodyVisible && render.titleOk && render.countsOk && render.measured?.matchesDevtoolsLog === true;
