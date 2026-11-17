// Site preloads: the preload links of many pages in one inline head.html block (prelink/site-head.html, whose LINKS and
// LOCALES headSnippet fills in). No request at run time: updating the preloads means updating head.html.
// perf-site-preloads builds the rows from perf-preload <page-key>.links.json files (mobile and --desktop recordings).
//
// LINKS rows (LINK_COLUMNS):
//   pages          comma-separated path patterns matched against the page path without .html: "*" = every page,
//                  "*" inside a pattern = one path segment part, "**" = anything (/acrobat/** = every page below /acrobat/)
//   viewport       all | mobile | desktop (the loader: mobile <= 599px, desktop >= 1200px; tablets get "all" rows only)
//   rel, href, as, crossorigin, fetchpriority   the link attributes (as in the per-page manifest)
// href placeholders, resolved by the loader on the page itself (a row whose placeholder has no value is skipped):
//   {milolibs}     Milo's libs base: /libs on production hosts, the ?milolibs= branch on .aem./.hlx./.stage./.da. hosts
//   {maslibs}      MAS's libs base: https://www.adobe.com/mas/libs on www.adobe.com, else the ?maslibs= branch's
//                  /web-components/dist (default main--mas--adobecom.aem.live)
//   {locale}       the MAS locale (en_US, or en_GB for AU/IN/GB visitors of the en_US site with MAS geo detection)
//   {country}      the MAS market country (geo detection) or the page locale's country, PR priced as US; in
//                  /mas/io/fragment URLs "&country={country}" is dropped when the locale already ends in _<country>,
//                  as MAS does. perf-site-preloads uses {locale} / {country} in MAS fragment URLs only.
// LOCALES rows (LOCALE_COLUMNS): the page locales the loader can resolve {locale} / {country} for, with their supported
// markets (Milo's supported-markets.json): prefix ("" = the root site), locale, defaultMarket, supportedRegions.
import { isContextual, CONTEXT_PARAM } from './prelink.mjs';

export const LINK_COLUMNS = ['pages', 'viewport', 'rel', 'href', 'as', 'crossorigin', 'fetchpriority'];
export const LOCALE_COLUMNS = ['prefix', 'locale', 'defaultMarket', 'supportedRegions'];
export const VIEWPORTS = ['all', 'mobile', 'desktop'];
export const PLACEHOLDERS = ['milolibs', 'maslibs', 'locale', 'country'];
export const MAS_IO = 'https://www.adobe.com/mas/io';
// First path segments that are Milo locale prefixes (fr, ch_de, mena_en, africa, langstore): such a page needs its
// own LOCALES row; it never falls back to the root site. Keep in sync with prelink/site-head.html.
export const LOCALE_SEGMENT = /^([a-z]{2}|[a-z]{2,4}_[a-z]{2,3}|africa|langstore)$/;

export const pagePath = (pathname) => String(pathname).replace(/\.html$/, '') || '/';

// Pattern -> RegExp for a "pages" cell entry. Keep in sync with prelink/site-head.html.
export function patternRegExp(pattern) {
  const p = pattern.trim();
  if (p === '*') return /^/;
  const body = p.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${body}$`);
}

export const matchesPages = (cell, path) => String(cell).split(',').some((p) => p.trim() && patternRegExp(p).test(path));

// "/acrobat/**" for pages that share the /acrobat/ directory; null when they share nothing but the root.
export function commonScope(paths) {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const common = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i += 1) common.push(dirs[0][i]);
  return common.length > 1 ? `${common.join('/')}/**` : null;
}

// The row href of a recorded absolute URL, with placeholders for what the loader resolves on the page, or
// { skip } when the URL depends on a context the loader cannot reproduce. Stylesheet hrefs stay plain here; the
// loader gives them their //host/path form.
export function templateHref(url, pageOrigin) {
  const u = new URL(url);
  const sameSite = u.origin === pageOrigin || u.origin === 'https://www.adobe.com';
  if (sameSite && u.pathname.startsWith('/mas/io/fragment')) {
    // MAS builds ?id&api_key&locale[&country][&instant][&mask][&pzn]; country is added by the loader when MAS adds it.
    const id = u.searchParams.get('id');
    const key = u.searchParams.get('api_key');
    if (!id || !key || !u.searchParams.has('locale')) return { skip: 'MAS fragment URL without id, api_key or locale' };
    const extra = [...u.searchParams.keys()].filter((k) => !['id', 'api_key', 'locale', 'country'].includes(k));
    if (extra.length) return { skip: `MAS fragment URL with ${extra.join(', ')} (page-specific MAS options)` };
    return { href: `${MAS_IO}/fragment?id=${id}&api_key=${key}&locale={locale}&country={country}` };
  }
  if (sameSite && u.pathname.startsWith('/mas/libs/')) return { href: `{maslibs}${u.pathname.slice('/mas/libs'.length)}${u.search}` };
  if (/^[a-z0-9-]+--mas--adobecom\.aem\.live$/.test(u.hostname) && u.pathname.startsWith('/web-components/dist/')) {
    return { href: `{maslibs}${u.pathname.slice('/web-components/dist'.length)}${u.search}` };
  }
  const miloHost = /^[a-z0-9-]+--milo--adobecom\.aem\.live$/.test(u.hostname);
  if ((u.origin === pageOrigin || miloHost) && u.pathname.startsWith('/libs/')) return { href: `{milolibs}${u.pathname.slice('/libs'.length)}${u.search}` };
  const base = u.origin === pageOrigin ? `${u.pathname}${u.search}` : u.href;
  if (!isContextual(u.href)) return { href: base };
  // {locale} / {country} are MAS's values (validated market, upper case); other consumers derive theirs differently.
  const params = [...u.searchParams.keys()].filter((k) => CONTEXT_PARAM.test(k));
  return { skip: `country/locale parameter ${params.join(', ')} outside a MAS fragment URL: its value cannot be reproduced` };
}

const PRIORITY = { high: 0, '': 1, auto: 1, low: 2 };
const scopeRank = (pages, global) => (pages === global ? 0 : pages.includes(',') ? 1 : 2);

// inputs: perf-preload .links.json documents ({ page, device, links: [{ rel, href, as, crossorigin, fetchpriority, url, start }] }).
// Returns { rows, skipped, pages, global }.
export function buildSitePreloads(inputs, { global } = {}) {
  if (!inputs.length) throw new Error('no perf-preload links files');
  const origins = new Set(inputs.map((d) => new URL(d.page).origin));
  if (origins.size !== 1) throw new Error(`pages must share one origin (got ${[...origins].join(', ')})`);
  const [origin] = origins;
  const seen = new Set();
  for (const d of inputs) {
    if (!['mobile', 'desktop'].includes(d.device)) throw new Error(`${d.page}: recorded with an unknown profile (${d.device}); record with perf-preload (mobile) or perf-preload --desktop`);
    const id = `${pagePath(new URL(d.page).pathname)} ${d.device}`;
    if (seen.has(id)) throw new Error(`${id} is given twice`);
    seen.add(id);
    const segment = new URL(d.page).pathname.split('/')[1] ?? '';
    if (LOCALE_SEGMENT.test(segment)) throw new Error(`${d.page}: localized pages (/${segment}/) are not supported yet; record root-site pages`);
  }
  const pages = [...new Set(inputs.map((d) => pagePath(new URL(d.page).pathname)))].sort();
  const scope = global === undefined ? (pages.length > 1 ? commonScope(pages) : null) : global;
  // (href, rel, as, crossorigin, fetchpriority) -> the pages it was recorded on, per form factor.
  const groups = new Map();
  const skipped = new Map();
  for (const d of inputs) {
    const path = pagePath(new URL(d.page).pathname);
    for (const l of d.links) {
      const t = templateHref(l.url, origin);
      if (t.skip) { skipped.set(l.url, t.skip); continue; }
      const cells = { rel: l.rel, href: t.href, as: l.as ?? '', crossorigin: l.crossorigin ?? '', fetchpriority: l.fetchpriority ?? '' };
      const key = JSON.stringify(cells);
      if (!groups.has(key)) groups.set(key, { cells, mobile: new Set(), desktop: new Set(), start: Infinity });
      const g = groups.get(key);
      g[d.device].add(path);
      g.start = Math.min(g.start, l.start ?? Infinity);
    }
  }
  const cell = (set) => {
    const list = [...set].sort();
    return scope && list.length === pages.length && list.length > 1 ? scope : list.join(', ');
  };
  const rows = [];
  for (const g of groups.values()) {
    const m = cell(g.mobile);
    const dsk = cell(g.desktop);
    const add = (pagesCell, viewport) => pagesCell && rows.push({ pages: pagesCell, viewport, ...g.cells, start: g.start });
    if (m === dsk) add(m, 'all');
    else { add(m, 'mobile'); add(dsk, 'desktop'); }
  }
  rows.sort((a, b) => scopeRank(a.pages, scope) - scopeRank(b.pages, scope) || a.pages.localeCompare(b.pages)
    || VIEWPORTS.indexOf(a.viewport) - VIEWPORTS.indexOf(b.viewport) || a.start - b.start
    || PRIORITY[a.fetchpriority] - PRIORITY[b.fetchpriority] || a.href.localeCompare(b.href));
  const data = rows.map((r) => Object.fromEntries(LINK_COLUMNS.map((c) => [c, String(r[c] ?? '')])));
  return { rows: data, skipped, pages, global: scope };
}

// Locale row of the root site from Milo's supported-markets.json (marketsLangForLocale: the "" prefix, else the first).
export function rootLocale(markets) {
  const languages = markets?.languages?.data ?? markets?.data ?? [];
  const lang = languages.find((l) => (l.prefix ?? '') === '') ?? languages[0];
  return { prefix: '', locale: 'en_US', defaultMarket: lang?.defaultMarket ?? '', supportedRegions: lang?.supportedRegions ?? '' };
}

export const usesPlaceholder = (rows, name) => rows.some((r) => r.href.includes(`{${name}}`));

export function validateRows(rows, locales = []) {
  for (const row of rows) {
    if (!VIEWPORTS.includes(row.viewport)) throw new Error(`unknown viewport ${row.viewport} for ${row.href}`);
    if (!['preload', 'modulepreload'].includes(row.rel)) throw new Error(`unknown rel ${row.rel} for ${row.href}`);
    const unknown = [...row.href.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((n) => !PLACEHOLDERS.includes(n));
    if (unknown.length) throw new Error(`unknown placeholder {${unknown[0]}} in ${row.href}`);
  }
  if ((usesPlaceholder(rows, 'locale') || usesPlaceholder(rows, 'country')) && !locales.some((l) => l.prefix === '' && l.supportedRegions)) {
    throw new Error('rows use {locale} / {country} but there is no root locale with supported regions');
  }
}

// One array literal line per row; "<" is escaped so no value can close the inline <script>.
const literal = (cells) => `[${cells.map((c) => JSON.stringify(String(c)).replace(/</g, '\\u003c')).join(', ')}]`;

// The site's head.html block: prelink/site-head.html with its LINKS and LOCALES filled in.
export function headSnippet(template, { rows, locales = [], note = '' }) {
  validateRows(rows, locales);
  const fill = (html, name, items) => {
    const marker = new RegExp(`^( *)const ${name} = \\[\\];$`, 'm');
    const m = html.match(marker);
    if (!m || html.split(m[0]).length !== 2) throw new Error(`template: expected exactly one "const ${name} = [];" line`);
    const pad = m[1];
    const body = items.length ? `[\n${items.map((cells) => `${pad}  ${literal(cells)},`).join('\n')}\n${pad}]` : '[]';
    // A replacement function: a "$&" or "$'" in a row must stay literal.
    return html.replace(marker, () => `${note && name === 'LINKS' ? `${pad}// ${note}\n` : ''}${pad}const ${name} = ${body};`);
  };
  const links = rows.map((r) => LINK_COLUMNS.map((c) => r[c] ?? ''));
  const localeRows = locales.map((l) => LOCALE_COLUMNS.map((c) => l[c] ?? ''));
  return fill(fill(template, 'LINKS', links), 'LOCALES', localeRows);
}
