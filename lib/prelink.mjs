// Per-page prelink manifests: the preload links perf-preload generates for a page, stored as a DA sheet next to the
// page (<dir>/<name> -> <dir>/preloads/<name>.json), sent early as a Link header prelink, and turned into <link>
// tags by the inline script in prelink/head.html.

export const MANIFEST_COLUMNS = ['rel', 'href', 'as', 'crossorigin', 'fetchpriority'];
export const MANIFEST_RELS = ['preload', 'modulepreload'];
export const MANIFEST_AS = ['script', 'style', 'font', 'image', 'fetch'];
export const CONTEXT_PARAM = /^(country|locale|lang|language|geo|region|market)$/i;

// Manifest path of a page path: /a/b/plans(.html) -> /a/b/preloads/plans.json, /a/b/ -> /a/b/preloads/index.json.
// Keep in sync with manifestUrl() in prelink/head.html.
export function manifestPath(pathname) {
  const p = String(pathname).replace(/\.html$/, '');
  const slash = p.lastIndexOf('/');
  return `${p.slice(0, slash + 1)}preloads/${p.slice(slash + 1) || 'index'}.json`;
}

// The Link response header entry that prelinks a manifest; plain fetch(url) in the inline script reuses it.
export const prelinkEntry = (pathname) => `<${pathname}>; rel=preload; as=fetch; crossorigin=anonymous`;

export const isContextual = (href, base) => [...new URL(href, base).searchParams.keys()].some((k) => CONTEXT_PARAM.test(k));

// DA sheet source (what da_create_source / da_update_source store); once published, EDS serves it as
// { total, offset, limit, data, columns, ":type": "sheet" }. Every cell is a string.
export function toManifest(links) {
  const data = links.map((l) => Object.fromEntries(MANIFEST_COLUMNS.map((c) => [c, l[c] == null ? '' : String(l[c])])));
  return { total: data.length, limit: data.length, offset: 0, data, ':sheetname': 'data', ':type': 'sheet' };
}

// Rows of a delivered or source manifest; throws when the document is not a manifest sheet.
export function manifestRows(doc) {
  const data = doc?.[':type'] === 'sheet' && Array.isArray(doc.data) ? doc.data : null;
  if (!data) throw new Error('not a prelink manifest: expected a single DA sheet with data rows');
  for (const row of data) {
    const keys = Object.keys(row ?? {});
    if (!MANIFEST_COLUMNS.every((c) => keys.includes(c)) || keys.some((k) => !MANIFEST_COLUMNS.includes(k))) {
      throw new Error(`not a prelink manifest: rows must have exactly the columns ${MANIFEST_COLUMNS.join(', ')}`);
    }
  }
  return data;
}
