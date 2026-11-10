// Change-variant edits applied by the measuring proxy: head snippet injection, guarded source patches, guarded Link
// response header edits, and resolution of country/locale-specific hint URLs against what the measured baseline page
// actually requested.

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

const TARGET = /^<([^<>]*)>/;
export const LINK_EDIT_OPS = ['remove', 'replace', 'add'];
export const linkHeaderValue = (v) => (v == null ? null : Array.isArray(v) ? v.join(', ') : String(v));

// One Link entry "<url>; rel=...; as=..." -> its target URL reference and lower-cased rel tokens (null if malformed).
export function parseLinkEntry(entry) {
  const m = TARGET.exec(String(entry).trim());
  if (!m) return null;
  const rel = REL.exec(entry);
  return { target: m[1].trim(), rels: rel ? (rel[1] ?? rel[2]).trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()) : [] };
}

const resolveTarget = (target, pageUrl) => { try { return new URL(target, pageUrl).href; } catch { return null; } };
const entryKey = (entry, pageUrl) => { const p = parseLinkEntry(entry); return p ? resolveTarget(p.target, pageUrl) : null; };
const sameEntry = (a, b) => a.replace(/\s*([;=])\s*/g, '$1').trim() === b.replace(/\s*([;=])\s*/g, '$1').trim();

// Edits of the after document's Link response header (e.g. the prelink of a preload manifest), applied in the order
// remove -> replace -> add. Entries are matched by target URL resolved against the page URL, so "</a.js>" and
// "<https://host/a.js>" are the same entry. Like source patches the edits are guarded: a remove target (or "*", every
// rel=preload / rel=modulepreload entry) must match at least one entry, a replace exactly one (with a different
// value), and an add none; otherwise production changed and the job stops. Returns the new header (null when empty).
export function applyLinkHeaderEdits(value, edits, pageUrl) {
  const report = { removed: [], replaced: [], added: [] };
  let entries = value ? splitLinkHeader(String(value)) : [];
  const keyOf = (entry) => entryKey(entry, pageUrl);
  const isPreload = (entry) => (parseLinkEntry(entry)?.rels ?? []).some((t) => PRELOAD_RELS.has(t));
  const removes = (edits.remove ?? []).map((t) => t.trim());
  for (const t of removes) {
    const hits = t === '*' ? entries.filter(isPreload) : entries.filter((e) => keyOf(e) === resolveTarget(t, pageUrl));
    if (!hits.length) throw fatal(`Link header edit: remove ${t} matches no ${t === '*' ? 'rel=preload/modulepreload ' : ''}entry of the after document's Link header (production changed?)`);
  }
  const removeKeys = new Set(removes.filter((t) => t !== '*').map((t) => resolveTarget(t, pageUrl)));
  entries = entries.filter((e) => (removeKeys.has(keyOf(e)) ? (report.removed.push(e), false) : true));
  if (removes.includes('*')) {
    const stripped = stripPreloadLinks(entries.join(', '));
    report.removed.push(...stripped.removed);
    entries = stripped.value ? splitLinkHeader(stripped.value) : [];
  }
  for (const raw of edits.replace ?? []) {
    const entry = raw.trim();
    const key = keyOf(entry);
    const at = entries.flatMap((e, i) => (keyOf(e) === key ? [i] : []));
    if (at.length !== 1) throw fatal(`Link header edit: replace <${parseLinkEntry(entry)?.target}>: the after document's Link header has ${at.length} entries for it, expected exactly 1 (production changed?)`);
    if (sameEntry(entries[at[0]], entry)) throw fatal(`Link header edit: replace <${parseLinkEntry(entry)?.target}> is identical to the served entry`);
    report.replaced.push({ from: entries[at[0]], to: entry });
    entries[at[0]] = entry;
  }
  for (const raw of edits.add ?? []) {
    const entry = raw.trim();
    const key = keyOf(entry);
    if (entries.some((e) => keyOf(e) === key)) throw fatal(`Link header edit: add <${parseLinkEntry(entry)?.target}>: the Link header already has an entry for it; use replace`);
    entries.push(entry);
    report.added.push(entry);
  }
  return { value: entries.length ? entries.join(', ') : null, ...report };
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

export const hasContextualHints = (snippet, pageUrl) => linkTags(snippet).some(([tag]) => {
  const url = urlOf(hrefOf(tag), pageUrl);
  return url && !isExperienceEdge(url) && [...url.searchParams.keys()].some((k) => CONTEXT_PARAMS.includes(k.toLowerCase()));
});

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
