// Pass-partout interactions: the `auto` step finds the in-page interactions of any page by itself, so a scenario needs no
// page-specific selectors. Discovery is deterministic and conservative: it only considers UI that changes what the page
// shows without leaving it or changing server state (tabs, expand/collapse toggles, plain buttons, one modal opener),
// in document order, ignores anything that looks like a purchase, sign-in, submit, download or cookie banner, and
// never taps a link that goes somewhere (an <a> with a real href).
//
//   { "action": "auto", "max"?: 1..10 (default 4), "kinds"?: ["tab","expandable","button","popup"],
//     "exclude"?: [css selector, ...], "scope"?: css selector (default: the whole body), "ms"?: settle pause, "label"?: string }
//
// Discovery runs again before every tap, so a target is always a live element of the page as the previous taps left it
// (switching a tab hides the other panels' toggles and shows new ones). Before and after must exercise the same
// elements: the job gives the "after" load the exact sequence of targets (kind, role, name, occurrence) that its "before"
// load of the same pair tapped, and rejects the run when one of them does not exist.

export const AUTO_VERSION = 1;
export const AUTO_KINDS = ['tab', 'expandable', 'button', 'popup'];
export const DEFAULT_AUTO_MAX = 4;
export const MAX_AUTO = 10;
export const MAX_AUTO_EXCLUDES = 10;
export const MAX_CANDIDATES = 300;
export const NAME_CHARS = 60;

// Always skipped, besides the step's own `exclude`: consent banners (they set cookies) and similar chrome.
export const DEFAULT_EXCLUDE = [
  '[id*="onetrust" i]', '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]', '[aria-label*="cookie" i]',
  '[class*="privacy-banner" i]',
];

// Buttons whose name says they buy, authenticate, submit, download, contact or otherwise act beyond the page.
export const DENY = /\b(?:buy|purchase|checkout|check out|add to (?:cart|bag|basket)|cart|bag|order|pay|subscribe|sign[ -]?(?:in|up|out)|log[ -]?(?:in|out)|register|submit|send|delete|remove|cancel|download|install|upgrade|contact|call|chat|accept|reject|agree|decline)\b/i;

// Runs in the page (serialized by Puppeteer): no closures. Returns the candidate elements and a JSON description of each.
// Walks open shadow roots, so web components (merch cards, tabs built as custom elements) are covered.
export function discoverInPage(scope, excludeSelectors, maxCandidates, nameChars) {
  let root;
  try {
    root = scope ? document.querySelector(scope) : document.body;
  } catch (error) {
    return { error: `invalid scope selector "${scope}"`, elements: [], info: [] };
  }
  if (!root) return { error: `scope "${scope}" matched nothing`, elements: [], info: [] };
  const all = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  const within = (el, selector) => {
    for (let n = el; n; n = n.parentElement ?? n.getRootNode()?.host ?? null) {
      if (n.matches?.(selector)) return true;
    }
    return false;
  };
  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, nameChars);
  const nameOf = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => el.getRootNode()?.getElementById?.(id)?.textContent ?? '').join(' ');
    return clean(el.getAttribute('aria-label')) || clean(labelled) || clean(el.textContent) || clean(el.getAttribute('title'))
      || clean(el.querySelector('img[alt]')?.getAttribute('alt')) || clean(el.getAttribute('value'));
  };
  const visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };
  const elements = [];
  const info = [];
  try {
    for (const el of all) {
      if (elements.length >= maxCandidates) break;
      const tag = el.localName;
      const role = el.getAttribute('role');
      const href = el.getAttribute('href');
      const isAnchor = tag === 'a';
      // A link that goes somewhere is never a target; hash and javascript: anchors act in the page.
      if (isAnchor && href != null && !/^(?:#|javascript:)/i.test(href.trim())) continue;
      const buttonish = tag === 'button' || tag === 'summary' || role === 'button' || role === 'tab' || (tag === 'input' && el.type === 'button')
        || (isAnchor && (href != null || role === 'button'));
      if (!buttonish) continue;
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]')) continue;
      // A <button> without a type attribute submits its form; outside a form it is a plain button.
      const type = el.getAttribute('type');
      if (tag === 'button' && (type === 'submit' || type === 'reset' || (type == null && el.closest('form')))) continue;
      if (!visible(el)) continue;
      if (excludeSelectors.some((s) => within(el, s))) continue;
      const popup = el.getAttribute('aria-haspopup');
      let kind = null;
      if (role === 'tab') kind = el.getAttribute('aria-selected') === 'true' ? null : 'tab';
      else if (popup === 'dialog' || el.matches('a.modal, [data-modal-path], [data-modal-hash]')) kind = 'popup';
      else if (el.hasAttribute('aria-expanded') || (tag === 'summary' && el.parentElement?.localName === 'details') || (popup && popup !== 'false')) kind = 'expandable';
      else if (!el.closest('form')) kind = 'button';
      if (!kind) continue;
      elements.push(el);
      info.push({ kind, tag, role, name: nameOf(el) });
    }
  } catch (error) {
    // An exclude selector that is not valid CSS is the usual cause.
    return { error: `invalid exclude selector (${String(error?.message ?? error)})`, elements: [], info: [] };
  }
  return { error: null, elements, info };
}

// Elements and their descriptions from the page. Each candidate gets a `signature` that identifies it across loads
// (kind, tag, role, name and, for identical ones, the occurrence), and its element `handle`.
export async function discoverTargets(page, { scope = null, exclude = [] } = {}) {
  const handle = await page.evaluateHandle(discoverInPage, scope, [...DEFAULT_EXCLUDE, ...exclude], MAX_CANDIDATES, NAME_CHARS);
  try {
    const error = await (await handle.getProperty('error')).jsonValue();
    if (error) throw Object.assign(new Error(`auto: ${error}`), { fatal: error.startsWith('invalid '), rejected: !error.startsWith('invalid ') });
    const info = await (await handle.getProperty('info')).jsonValue();
    const props = await (await handle.getProperty('elements')).getProperties();
    const elements = [...props].sort(([a], [b]) => Number(a) - Number(b)).map(([, h]) => h.asElement());
    return withSignatures(info.map((d, i) => ({ ...d, handle: elements[i] })));
  } finally {
    await handle.dispose().catch(() => {});
  }
}

export function withSignatures(candidates) {
  const seen = new Map();
  return candidates.map((c) => {
    const base = [c.kind, c.tag, c.role ?? '', c.name].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...c, signature: n === 1 ? base : `${base}#${n}` };
  });
}

// Order in which kinds are exercised: state switches first, the modal opener last (it covers the page).
const ORDER = AUTO_KINDS;

// The next element to tap for an auto step, from a fresh discovery. `tapped` is what the step already tapped.
// Spread over the kinds (at most ceil(max / kinds) of each, then topped up in kind order); the modal opener, at most one,
// is taken for the last tap (or when nothing else is left) so that its overlay never covers later targets.
export function nextTarget(candidates, { max = DEFAULT_AUTO_MAX, kinds = AUTO_KINDS, tapped = [] } = {}) {
  const done = new Set(tapped.map((t) => t.signature));
  const usable = candidates.filter((c) => kinds.includes(c.kind) && c.name && !DENY.test(c.name) && !done.has(c.signature));
  const popup = tapped.every((t) => t.kind !== 'popup') ? usable.find((c) => c.kind === 'popup') : null;
  if (tapped.length >= max) return null;
  if (popup && max > 1 && tapped.length === max - 1) return popup;
  const cap = Math.ceil(max / kinds.length);
  const plain = ORDER.filter((k) => k !== 'popup' && kinds.includes(k));
  for (const kind of plain) {
    if (tapped.filter((t) => t.kind === kind).length < cap) {
      const c = usable.find((x) => x.kind === kind);
      if (c) return c;
    }
  }
  return plain.map((kind) => usable.find((x) => x.kind === kind)).find(Boolean) ?? popup ?? null;
}

// The whole sequence an auto step would tap on a page that does not change while it is exercised.
export function selectTargets(candidates, options = {}) {
  const tapped = [];
  for (let target = nextTarget(candidates, { ...options, tapped }); target; target = nextTarget(candidates, { ...options, tapped })) tapped.push(target);
  return tapped;
}
