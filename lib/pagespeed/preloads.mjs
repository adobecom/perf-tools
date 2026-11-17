// Preloads (<link rel=preload>, Link response headers and script-created links) of one page load and which of them
// Chrome reported as unused. Chrome logs a console warning for a preload that was not consumed within a few seconds
// of the window's load event; the job captures those warnings from the page's console.

export const MAX_PRELOADS = 200;
const UNUSED = /^The resource (\S+) was preloaded using link preload but not used within a few seconds from the window's load event\./;

// URL of the preload a console message calls unused, or null for any other message.
export function unusedPreloadUrl(text) {
  return typeof text === 'string' ? UNUSED.exec(text)?.[1] ?? null : null;
}

const SOURCES = { other: 'link-header', parser: 'html', script: 'script' };

// Main-frame preload requests of a DevTools log: { url, source, type, unused }. `source` is where the preload was
// declared: the Link response header, the HTML, or a script.
export function preloadUsage(devtoolsLog, unusedUrls = new Set()) {
  if (!Array.isArray(devtoolsLog)) return [];
  const sent = devtoolsLog.filter((e) => e.method === 'Network.requestWillBeSent' && e.params?.request);
  const mainFrame = sent.find((e) => e.params.type === 'Document')?.params.frameId;
  const seen = new Map();
  for (const { params } of sent) {
    if (!params.request.isLinkPreload || (mainFrame && params.frameId !== mainFrame)) continue;
    const url = params.request.url;
    if (seen.has(url)) continue;
    seen.set(url, {
      url,
      source: SOURCES[params.initiator?.type] ?? 'other',
      type: typeof params.type === 'string' ? params.type : null,
      unused: unusedUrls.has(url),
    });
  }
  return [...seen.values()].slice(0, MAX_PRELOADS);
}
