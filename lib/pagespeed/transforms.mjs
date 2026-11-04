// Change-variant edits applied by the measuring proxy: head snippet injection, guarded source patches, and
// resolution of country/locale-specific hint URLs against what the measured baseline page actually requested.

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

export function injectIntoHead(html, snippet) {
  const headStart = html.search(/<head[\s>]/i);
  const headEnd = html.search(/<\/head>/i);
  if (headStart < 0 || headEnd < 0) return null;
  const rel = html.slice(headStart, headEnd).search(/<script[\s>]/i);
  const at = rel >= 0 ? headStart + rel : headEnd;
  return { html: `${html.slice(0, at)}${snippet}\n${html.slice(at)}`, at, beforeScript: rel >= 0 };
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const linkTags = (html) => [...html.matchAll(/<link\b[^>]*>/gi)];
const hrefOf = (tag) => { const m = tag.match(HREF); return m ? decode(m[1] ?? m[2] ?? m[3]) : null; };
const setHref = (tag, url) => tag.replace(HREF, `href="${escapeAttr(url)}"`);
const urlOf = (href, base) => { try { return new URL(href, base); } catch { return null; } };

export function splitLinkHeader(value) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '"' ) quoted = !quoted;
    else if (!quoted && ch === '<') depth += 1;
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth && !quoted) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const REL = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]*))/i;
const PRELOAD_RELS = new Set(['preload', 'modulepreload']);

// Unsets every rel=preload / rel=modulepreload entry of a Link response header, so that only injected tags provide
// preloads. Other entries (preconnect, canonical, ...) stay; an entry whose rel mixes preload with other tokens
// keeps only the other tokens. Returns the remaining header (null when nothing is left) and the removed entries.
export function stripPreloadLinks(value) {
  if (!value) return { value: value ?? null, removed: [] };
  const removed = [];
  const kept = [];
  for (const entry of splitLinkHeader(String(value))) {
    const m = REL.exec(entry);
    const tokens = m ? (m[1] ?? m[2]).trim().split(/\s+/).filter(Boolean) : [];
    if (!tokens.some((t) => PRELOAD_RELS.has(t.toLowerCase()))) { kept.push(entry); continue; }
    removed.push(entry);
    const rest = tokens.filter((t) => !PRELOAD_RELS.has(t.toLowerCase()));
    if (rest.length) kept.push(entry.replace(REL, `; rel="${rest.join(' ')}"`));
  }
  return { value: kept.length ? kept.join(', ') : null, removed };
}

// Guarded patches: every `find` must occur exactly once in the live source, otherwise the experiment no longer
// matches production and the whole job stops (no partial or silently skipped edit).
export function applyPatches(body, patches, pathname) {
  let out = body;
  for (const [i, p] of patches.entries()) {
    const count = out.split(p.find).length - 1;
    if (count !== 1) throw fatal(`patch #${i + 1} for ${pathname}: source no longer matches (find text occurs ${count} times, expected exactly 1)`);
    out = out.replace(p.find, () => p.replace);
  }
  return out;
}

export const isExperienceEdge = (url) => /^\/experienceedge(?:\/|$)/.test(url.pathname);

export const CONTEXT_PARAMS = ['country', 'locale', 'lang', 'language', 'geo', 'region', 'market'];
const nonContext = (u) => [...u.searchParams].filter(([k]) => !CONTEXT_PARAMS.includes(k.toLowerCase())).map(([k, v]) => `${k}=${v}`).sort().join('&');

// Hint URLs carrying country/locale params were captured in some other context (e.g. country=CH). Re-resolve each
// against the baseline page's own requests in this context: same origin + path + all non-context params. Exactly
// one observed URL is used verbatim (including when the consumer sends no country at all); none or several
// candidates drop the hint, reported. /experienceedge hints are always dropped.
export function resolveContextualHints(snippet, pageUrl, observedUrls) {
  const observed = [...new Set(observedUrls)].map((u) => urlOf(u)).filter(Boolean);
  const report = { links: 0, kept: 0, contextual: [], dropped: [] };
  const html = snippet.replace(/<link\b[^>]*>\s*/gi, (tag) => {
    const href = hrefOf(tag);
    const url = urlOf(href, pageUrl);
    if (!url) return tag;
    report.links += 1;
    if (isExperienceEdge(url)) { report.dropped.push({ href, reason: '/experienceedge is never preloaded' }); return ''; }
    const ctx = [...url.searchParams.keys()].filter((k) => CONTEXT_PARAMS.includes(k.toLowerCase()));
    if (!ctx.length) { report.kept += 1; return tag; }
    const key = nonContext(url);
    const matches = [...new Set(observed.filter((o) => o.origin === url.origin && o.pathname === url.pathname && nonContext(o) === key).map((o) => o.href))];
    if (matches.length !== 1) {
      report.dropped.push({ href, reason: matches.length ? `ambiguous: ${matches.length} baseline requests match` : 'no matching request in the baseline page' });
      return '';
    }
    report.kept += 1;
    report.contextual.push({ from: href, to: matches[0] });
    return setHref(tag, matches[0]);
  });
  return { html, report };
}

export const countLinks = (html) => linkTags(html).length;
