// AEM Edge Delivery inlines a repository's head.html into every served document <head>, parsed and re-serialized
// (void tags are normalized, attribute entities re-encoded; <script>/<style> text stays verbatim). A pull request
// that changes head.html therefore cannot be served as a file: its element-level diff (merge-base -> head) is applied
// to the production document instead. Guarded like patches: every removed element and every insertion anchor must
// occur exactly once in the production <head>, otherwise production changed and the job stops.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const fatal = (message) => Object.assign(new Error(message), { fatal: true });
const decode = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
  if (name) return ENTITIES[name.toLowerCase()] ?? m;
  const code = hex ? parseInt(hex, 16) : Number(dec);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const lf = (s) => s.replace(/\r\n?/g, '\n');

// Index just after the '>' that closes the tag starting at `from`, skipping quoted attribute values.
function tagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') return i + 1;
  }
  throw fatal('head.html: unterminated tag');
}

function attributes(tag) {
  const out = [];
  const body = tag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out.push([m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? '')]);
  }
  return JSON.stringify(out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Top-level elements of an HTML head fragment: { start, end, raw, key }. `key` ignores serialization differences
// (attribute order/quoting/entities, void-tag slashes); raw-text elements keep their exact inner text.
export function headItems(html) {
  const items = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close < 0) throw fatal('head.html: unterminated comment');
      i = close + 3;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 80));
    if (!open) { i = lt + 1; continue; }
    const name = open[1].toLowerCase();
    const openEnd = tagEnd(html, lt + 1);
    const openTag = html.slice(lt, openEnd);
    let end = openEnd;
    let inner = '';
    if (!VOID.has(name) && !openTag.endsWith('/>')) {
      const closer = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'gi');
      closer.lastIndex = openEnd;
      let depth = 1;
      for (let m = closer.exec(html); m; m = closer.exec(html)) {
        if (RAW_TEXT.has(name) && !m[1]) continue;
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
          end = tagEnd(html, m.index + 1);
          inner = html.slice(openEnd, m.index);
          break;
        }
      }
      if (depth !== 0) throw fatal(`head.html: <${name}> is not closed`);
    }
    items.push({ start: lt, end, raw: html.slice(lt, end), key: `${name}${attributes(openTag)}${inner ? `\u0000${lf(RAW_TEXT.has(name) ? inner : inner.trim())}` : ''}` });
    i = end;
  }
  return items;
}

// Longest common subsequence of item keys -> pairs [baseIndex, headIndex] of kept items.
function common(base, head) {
  const dp = Array.from({ length: base.length + 1 }, () => new Array(head.length + 1).fill(0));
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = head.length - 1; j >= 0; j -= 1) {
      dp[i][j] = base[i].key === head[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < base.length && j < head.length;) {
    if (base[i].key === head[j].key) { pairs.push([i, j]); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

const describe = (item) => `${item.raw.replace(/\s+/g, ' ').slice(0, 70)}…`;

// head.html content before/after the PR -> the element-level changes.
export function diffHead(baseHtml, headHtml) {
  const base = headItems(baseHtml);
  const head = headItems(headHtml);
  const kept = common(base, head);
  const keptBase = new Set(kept.map(([b]) => b));
  const keptHead = new Map(kept.map(([b, h]) => [h, b]));
  const removed = base.filter((_, i) => !keptBase.has(i));
  const added = head.map((item, index) => ({ item, index })).filter(({ index }) => !keptHead.has(index));
  return { base, head, kept, removed, added, keptHead };
}

// Applies the head.html PR diff to a served document. Returns { html, removed, added } (element counts).
export function applyHeadDiff(documentHtml, baseHtml, headHtml) {
  const { base, removed, added, keptHead } = diffHead(baseHtml, headHtml);
  if (!removed.length && !added.length) throw fatal('head.html PR diff has no element-level change');
  const headStart = documentHtml.search(/<head[\s>]/i);
  const headEnd = documentHtml.search(/<\/head>/i);
  if (headStart < 0 || headEnd < 0) throw fatal('document has no <head> to apply the head.html change to');
  const open = tagEnd(documentHtml, headStart + 1);
  const docItems = headItems(documentHtml.slice(open, headEnd)).map((it) => ({ ...it, start: it.start + open, end: it.end + open }));
  const only = (item, what) => {
    const hits = docItems.filter((d) => d.key === item.key);
    if (hits.length !== 1) throw fatal(`head.html change: ${what} ${describe(item)} occurs ${hits.length} times in the production document, expected exactly 1 (production head.html changed?)`);
    return hits[0];
  };
  const edits = [];
  for (const item of removed) {
    const hit = only(item, 'removed element');
    const lead = /\s*$/.exec(documentHtml.slice(open, hit.start))[0].length;
    edits.push({ at: hit.start - lead, remove: hit.end - (hit.start - lead), text: '' });
  }
  const keptIndexes = [...keptHead.keys()];
  const groups = new Map();
  for (const { item, index } of added) {
    const before = keptIndexes.filter((k) => k < index).pop();
    const after = keptIndexes.find((k) => k > index);
    const anchorIndex = before ?? after;
    if (anchorIndex == null) throw fatal('head.html change: no unchanged element to anchor the added elements to');
    const side = before != null ? 'after' : 'before';
    const key = `${side}:${anchorIndex}`;
    if (!groups.has(key)) groups.set(key, { anchor: base[keptHead.get(anchorIndex)], side, texts: [] });
    groups.get(key).texts.push(item.raw);
  }
  for (const { anchor, side, texts } of groups.values()) {
    const hit = only(anchor, 'anchor element');
    const text = texts.map((t) => `\n    ${t}`).join('');
    edits.push(side === 'after' ? { at: hit.end, remove: 0, text } : { at: hit.start, remove: 0, text: `${texts.map((t) => `${t}\n    `).join('')}` });
  }
  let html = documentHtml;
  for (const edit of edits.sort((a, b) => b.at - a.at)) html = `${html.slice(0, edit.at)}${edit.text}${html.slice(edit.at + edit.remove)}`;
  return { html, removed: removed.length, added: added.length };
}

// True when every merge-base head.html element occurs in the document <head> as often as in the base file.
export function headMatchesBase(documentHtml, baseHtml) {
  const headStart = documentHtml.search(/<head[\s>]/i);
  const headEnd = documentHtml.search(/<\/head>/i);
  if (headStart < 0 || headEnd < 0) return false;
  const open = tagEnd(documentHtml, headStart + 1);
  const keys = headItems(documentHtml.slice(open, headEnd)).map((d) => d.key);
  const baseKeys = headItems(baseHtml).map((d) => d.key);
  return baseKeys.every((key) => keys.filter((k) => k === key).length === baseKeys.filter((k) => k === key).length);
}
