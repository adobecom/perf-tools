// Read-only perf-ab history dashboard. Reads the sanitized static JSON published next to this page
// (data/index.json and data/runs/<id>.json) and renders it with DOM APIs only: no HTML strings, no writes.
// Also supports client-side Splunk pageperf CSV analysis via drag-and-drop or file picker.
import * as core from './dashboard-core.mjs';
import * as splunk from './splunk-core.mjs';

const { METRICS, METRIC_KEYS, STATUS, VERDICT_LABEL, CHANGE_KINDS } = core;
const FETCH_TIMEOUT_MS = 15000;
const wide = window.matchMedia('(min-width: 1024px)');

const els = {
  meta: document.getElementById('data-meta'),
  count: document.getElementById('history-count'),
  form: document.getElementById('filters'),
  q: document.getElementById('filter-q'),
  status: document.getElementById('filter-status'),
  profile: document.getElementById('filter-profile'),
  from: document.getElementById('filter-from'),
  to: document.getElementById('filter-to'),
  clear: document.getElementById('filter-clear'),
  splunkList: document.getElementById('splunk-list'),
  body: document.getElementById('history-body'),
  detail: document.getElementById('detail'),
  layout: document.getElementById('layout'),
  splunkUploadBtn: document.getElementById('splunk-upload-btn'),
  splunkFile: document.getElementById('splunk-file'),
  dropOverlay: document.getElementById('drop-overlay'),
};

const state = {
  history: null, // { updatedAt, runs, skipped } once loaded
  loadError: null,
  filters: { ...core.EMPTY_FILTERS },
  run: '', // explicitly selected run id (deep link or click)
  details: new Map(), // id -> { status: 'loading' | 'ready' | 'error', data, error }
  splunkReports: [], // [{ id, fileName, uploadedAt, parsed, filters, activeTab }]
  activeSplunkId: '',
  splunkLauncher: false,
  splunkAllLocales: false,
  splunkCustomUrl: '',
  splunkError: null, // { fileName, message }
};
let sectionIds = new Map();
let splunkSeq = 0;

// ---------------------------------------------------------------- DOM helpers (text only)

const ATTRS = new Set([
  'id', 'role', 'title', 'colspan', 'rowspan', 'scope', 'type', 'datetime', 'tabindex', 'hidden', 'value', 'lang', 'target',
  'aria-label', 'aria-live', 'aria-busy', 'aria-current', 'aria-describedby', 'aria-labelledby', 'aria-hidden', 'aria-sort', 'aria-selected', 'aria-checked',
  'data-label', 'data-tone', 'data-run', 'data-state', 'data-verdict', 'data-dir', 'data-kind', 'data-zone', 'data-bot', 'data-series', 'aria-pressed', 'disabled',
  'placeholder', 'autocomplete', 'spellcheck', 'name',
]);

function h(tag, opts, ...children) {
  const el = document.createElement(tag);
  if (opts) setOpts(el, opts);
  add(el, children);
  if (opts && tag === 'select' && opts.value != null) el.value = String(opts.value);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      el.setAttribute(k, String(v));
    }
  }
  add(el, children);
  return el;
}

function setOpts(el, opts) {
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (ATTRS.has(k)) el.setAttribute(k, v === true ? '' : String(v));
    else throw new Error(`attribute ${k} is not allowed`);
  }
}

// Native append/replaceChildren stringify arrays and null; always insert children through add() or fill().
function add(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

function fill(el, ...children) {
  el.replaceChildren();
  add(el, children);
}

// Links only to vetted https URLs; anything else is shown as plain text.
function extLink(href, text, cls, { newTab = false } = {}) {
  const safe = core.safeExternalUrl(href);
  if (!safe) return h('span', { class: ['unlinked', cls] }, text);
  const a = h('a', { class: cls, target: newTab ? '_blank' : null }, text);
  a.href = safe;
  a.rel = 'noopener noreferrer';
  return a;
}

function runHref(id) {
  return core.serializeState({ ...state.filters, run: id }) || '?';
}

function badge(text, tone = 'neutral', title) {
  return h('span', { class: 'badge', 'data-tone': tone, title }, text);
}

function callout(tone, title, ...body) {
  return h('div', { class: 'callout', 'data-tone': tone, role: tone === 'bad' ? 'alert' : null },
    h('p', { class: 'callout-title', text: title }), body.length ? h('div', { class: 'callout-body' }, body) : null);
}

function disclosure(title, ...children) {
  return h('details', { class: 'disclosure' },
    h('summary', { text: title }),
    h('div', { class: 'disclosure-content' }, children));
}

function section(title, ...children) {
  const base = `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const count = (sectionIds.get(base) ?? 0) + 1;
  sectionIds.set(base, count);
  const id = count === 1 ? base : `${base}-${count}`;
  return h('section', { class: 'block', 'aria-labelledby': id }, h('h3', { id, text: title }), children);
}

function mono(text, cls) {
  return h('span', { class: ['mono', cls], text });
}

function timeEl(t, text = core.formatDateTime(t)) {
  return h('time', { datetime: t == null ? null : new Date(t).toISOString(), text });
}

function skeleton(lines = 3, cls = '') {
  return h('div', { class: ['skeleton-block', cls], 'aria-hidden': 'true' },
    Array.from({ length: lines }, (_, i) => h('span', { class: `skeleton-line w${(i % 3) + 1}` })));
}

// ---------------------------------------------------------------- fetching

class FetchError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

async function fetchJson(path) {
  const url = new URL(path, document.baseURI);
  if (url.origin !== window.location.origin) throw new FetchError('blocked', `Refused to read ${path}: not same-origin.`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'GET', cache: 'no-cache', credentials: 'omit', signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (e.name === 'AbortError') throw new FetchError('timeout', `${path} did not respond within ${FETCH_TIMEOUT_MS / 1000} s.`);
      throw new FetchError('network', `${path} could not be fetched (network error).`);
    }
    if (!res.ok) throw new FetchError('http', `${path} returned HTTP ${res.status}.`, res.status);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new FetchError('parse', `${path} is not valid JSON.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function describeError(e, what) {
  if (e instanceof core.SchemaError) return { title: `${what} has an unexpected format`, message: `${e.message}.` };
  if (e instanceof FetchError) {
    if (e.kind === 'http' && e.status === 404 && what === 'History') {
      return { title: 'History is not published yet', message: `${e.message} The publisher has not deployed data/index.json to this site, or a deploy is still in progress.` };
    }
    return { title: `${what} could not be loaded`, message: e.message };
  }
  return { title: `${what} could not be loaded`, message: e?.message ?? String(e) };
}

async function loadHistory() {
  state.history = null;
  state.loadError = null;
  state.details.clear();
  render();
  try {
    state.history = core.parseHistory(await fetchJson('data/index.json'));
  } catch (e) {
    state.loadError = describeError(e, 'History');
  }
  fillProfileOptions();
  render();
}

function ensureDetail(summary) {
  const existing = state.details.get(summary.id);
  if (existing) return existing;
  if (!summary.detailPath) {
    const entry = { status: 'error', error: { title: 'No detail file', message: 'This run has no published detail file, so per-pair data, changes and the artifact are unavailable.' } };
    state.details.set(summary.id, entry);
    return entry;
  }
  const entry = { status: 'loading' };
  state.details.set(summary.id, entry);
  fetchJson(summary.detailPath)
    .then((json) => {
      entry.data = core.parseRun(json, summary.id);
      entry.status = 'ready';
    })
    .catch((e) => {
      entry.error = describeError(e, 'Run detail');
      entry.status = 'error';
    })
    .finally(() => {
      if (selectedId() === summary.id) renderDetail();
    });
  return entry;
}

// ---------------------------------------------------------------- state and URL

function readLocation() {
  const parsed = core.parseFilters(window.location.search);
  state.run = parsed.run;
  state.filters = { q: parsed.q, status: parsed.status, profile: parsed.profile, from: parsed.from, to: parsed.to };
  els.q.value = state.filters.q;
  els.status.value = state.filters.status;
  els.from.value = state.filters.from;
  els.to.value = state.filters.to;
  fillProfileOptions();
}

function readForm() {
  return {
    q: els.q.value.trim().slice(0, 200),
    status: els.status.value,
    profile: els.profile.value,
    from: /^\d{4}-\d{2}-\d{2}$/.test(els.from.value) ? els.from.value : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(els.to.value) ? els.to.value : '',
  };
}

function filtersChanged() {
  state.filters = readForm();
  window.history.replaceState(null, '', core.serializeState({ ...state.filters, run: state.run }) || window.location.pathname);
  render();
}

function clearFilters() {
  state.filters = { ...core.EMPTY_FILTERS };
  els.q.value = '';
  els.status.value = '';
  els.profile.value = '';
  els.from.value = '';
  els.to.value = '';
  window.history.replaceState(null, '', core.serializeState({ run: state.run }) || window.location.pathname);
  render();
  els.q.focus();
}

function selectRun(id) {
  state.activeSplunkId = '';
  state.splunkLauncher = false;
  state.splunkError = null;
  state.run = id;
  window.history.pushState(null, '', core.serializeState({ ...state.filters, run: id }) || window.location.pathname);
  render();
  if (!wide.matches) window.scrollTo({ top: 0 });
  const heading = els.detail.querySelector('h2');
  (heading ?? els.detail).focus({ preventScroll: wide.matches });
}

function openSplunkLauncher() {
  state.activeSplunkId = '';
  state.splunkError = null;
  state.splunkLauncher = true;
  render();
  if (!wide.matches) window.scrollTo({ top: 0 });
  const heading = els.detail.querySelector('h2');
  (heading ?? els.detail).focus({ preventScroll: wide.matches });
}

function selectSplunkReport(id) {
  state.activeSplunkId = id;
  state.splunkLauncher = false;
  state.splunkError = null;
  render();
  if (!wide.matches) window.scrollTo({ top: 0 });
  const heading = els.detail.querySelector('h2');
  (heading ?? els.detail).focus({ preventScroll: wide.matches });
}

function removeSplunkReport(id) {
  state.splunkReports = state.splunkReports.filter((r) => r.id !== id);
  if (state.activeSplunkId === id) {
    state.activeSplunkId = state.splunkReports[0]?.id ?? '';
  }
  render();
}

function backToList() {
  if (state.activeSplunkId || state.splunkError || state.splunkLauncher) {
    state.activeSplunkId = '';
    state.splunkLauncher = false;
    state.splunkError = null;
    render();
    return;
  }
  const id = state.run;
  state.run = '';
  window.history.pushState(null, '', core.serializeState(state.filters) || window.location.pathname);
  render();
  const link = els.body.querySelector(`a[data-run="${CSS.escape(id)}"]`);
  link?.focus();
}

function filteredRuns() {
  return state.history ? core.applyFilters(state.history.runs, state.filters) : [];
}

function selectedId() {
  if (state.activeSplunkId || state.splunkError || state.splunkLauncher) return '';
  if (state.run) return state.run;
  return wide.matches ? filteredRuns()[0]?.id ?? '' : '';
}

function fillProfileOptions() {
  const current = state.filters.profile;
  const options = state.history ? core.profileOptions(state.history.runs) : [];
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: `${current} (no published runs)` });
  fill(els.profile, h('option', { value: '', text: 'All profiles' }), options.map((o) => h('option', { value: o.value, text: o.label })));
  els.profile.value = current;
}

// ---------------------------------------------------------------- rendering

function render() {
  els.layout.dataset.view = state.run || state.activeSplunkId || state.splunkError || state.splunkLauncher ? 'detail' : 'list';
  renderMeta();
  renderSplunkList();
  renderHistory();
  renderDetail();
}

function renderSplunkList() {
  if (!state.splunkReports.length) {
    els.splunkList.hidden = true;
    els.splunkList.replaceChildren();
    return;
  }
  els.splunkList.hidden = false;
  const items = state.splunkReports.map((rep) => {
    const selected = rep.id === state.activeSplunkId;
    const summaryText = rep.parsed.kind === 'stats'
      ? `${rep.parsed.rowCount} element group${rep.parsed.rowCount === 1 ? '' : 's'} · stats`
      : `${rep.parsed.events.length} events · P75 ${splunk.formatMsOrSec(rep.summaryLcpP75)}`;
    return h('div', { class: ['splunk-item', selected && 'is-selected'] },
      h('button', {
        type: 'button',
        class: 'splunk-item-btn',
        'aria-current': selected ? 'true' : null,
        on: { click: () => selectSplunkReport(rep.id) },
      },
      h('span', { class: 'splunk-item-name', text: rep.summaryTitle || rep.fileName }),
      h('span', { class: 'sub', text: rep.summaryWindow ? `${rep.summaryWindow} · ${summaryText}` : summaryText })),
      h('button', {
        type: 'button',
        class: 'splunk-item-remove',
        'aria-label': `Remove ${rep.fileName}`,
        title: 'Remove export',
        on: { click: () => removeSplunkReport(rep.id) },
      }, '×'));
  });
  els.splunkList.replaceChildren(
    h('div', { class: 'splunk-list-head' },
      h('span', { text: 'Splunk exports (local)' }),
      h('span', { text: String(state.splunkReports.length) })),
    ...items);
}

function renderMeta() {
  if (state.loadError) {
    els.meta.textContent = 'History unavailable';
    return;
  }
  if (!state.history) {
    els.meta.textContent = 'Loading history…';
    return;
  }
  const n = state.history.runs.length;
  els.meta.replaceChildren(`${n} run${n === 1 ? '' : 's'} · updated `,
    state.history.updatedAt == null ? 'at an unknown time' : timeEl(state.history.updatedAt));
}

function renderHistory() {
  const hasF = core.hasFilters(state.filters);
  els.clear.disabled = !hasF;
  els.body.removeAttribute('aria-busy');
  if (state.loadError) {
    els.count.textContent = '';
    els.body.replaceChildren(h('div', { class: 'state' },
      callout('bad', state.loadError.title, h('p', { text: state.loadError.message })),
      h('button', { type: 'button', class: 'btn', text: 'Retry', on: { click: loadHistory } })));
    return;
  }
  if (!state.history) {
    els.count.textContent = '';
    els.body.setAttribute('aria-busy', 'true');
    els.body.replaceChildren(h('div', { class: 'history-skeleton', 'aria-hidden': 'true' },
      Array.from({ length: 7 }, () => h('div', { class: 'skeleton-row' }, h('span', { class: 'skeleton-line w1' }), h('span', { class: 'skeleton-line w2' })))),
    h('p', { class: 'sr-only', text: 'Loading history…' }));
    return;
  }
  const all = state.history.runs;
  const runs = filteredRuns();
  els.count.textContent = hasF ? `${runs.length} of ${all.length} shown` : `${all.length} total`;
  const nodes = [];
  if (state.history.skipped.length) {
    nodes.push(h('details', { class: 'skipped' },
      h('summary', { text: `${state.history.skipped.length} entr${state.history.skipped.length === 1 ? 'y' : 'ies'} skipped: not valid history-v1 runs` }),
      h('ul', {}, state.history.skipped.slice(0, 20).map((m) => h('li', { text: m })))));
  }
  if (all.length && !runs.length) {
    nodes.push(h('div', { class: 'empty' },
      h('p', { class: 'empty-title', text: 'No runs match these filters' }),
      h('p', { text: `${all.length} published run${all.length === 1 ? ' is' : 's are'} hidden by the current filters.` }),
      h('button', { type: 'button', class: 'btn', text: 'Clear filters', on: { click: clearFilters } })));
  } else if (runs.length) {
    nodes.push(historyTable(runs));
  }
  els.body.replaceChildren(...nodes);
}

function runFlags(r) {
  const flags = [];
  if (r.smoke) flags.push(badge('1-pair smoke', 'warn', 'Single pair: shows the pipeline works, not whether performance changed'));
  if (r.where === 'local') flags.push(badge('Local run', 'warn', 'Local results are not comparable with Actions results, even with the same profile key'));
  else if (!r.us) flags.push(badge('Not US-verified', 'bad', 'Egress was not verified as US; not comparable with US runs'));
  if (r.single) flags.push(badge('Single URL', 'neutral', 'No before variant, so no deltas'));
  return flags;
}

function statusBadge(r, compact = false) {
  const s = STATUS[r.status];
  const title = r.status === 'unknown' ? `Unrecognized status ${JSON.stringify(r.rawStatus)}` : r.errorCodeLabel ?? r.errorKindLabel ?? undefined;
  return badge(!compact && r.status === 'failed' && r.errorKindLabel ? `${s.label} · ${r.errorKindLabel.toLowerCase()}` : s.label, s.tone, title);
}

function pairsText(r) {
  const s = r.samples;
  if (s.pairs == null && s.requested == null) return '—';
  return s.requested == null ? `${s.pairs ?? 0}` : `${s.pairs ?? 0}/${s.requested}`;
}

function historyDeltaCell(r, key) {
  const d = r.medians.delta?.[key];
  const weak = d != null && (r.samples.pairs ?? 0) < core.MIN_PAIRS;
  return h('td', { class: ['num', weak && 'weak'], 'data-label': `Δ ${METRICS[key].short}`, title: weak ? 'Fewer than 3 complete pairs: not evidence of a change' : null },
    core.formatDelta(key, d));
}

function historyTable(runs) {
  const current = selectedId();
  const withInp = runs.some(core.hasInp);
  const tbody = h('tbody', {});
  for (const r of runs) {
    const link = h('a', { class: 'run-link', 'data-run': r.id, 'aria-current': r.id === current ? 'true' : null },
      timeEl(r.createdAt, core.formatDateTime(r.createdAt)));
    link.href = runHref(r.id);
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      selectRun(r.id);
    });
    link.addEventListener('keydown', onRunKey);
    const rejected = r.samples.rejected ? h('span', { class: 'sub', text: `${r.samples.rejected} rejected` }) : null;
    const tr = h('tr', { class: ['run-row', r.id === current && 'is-selected'] },
      h('td', { class: 'cell-run', 'data-label': 'Run' }, link, mono(r.id, 'sub')),
      h('td', { class: 'cell-page', 'data-label': 'Page' },
        h('span', { class: 'page', title: r.url ?? undefined, text: core.displayUrl(r.url) || 'Unknown page' }),
        r.name ? h('span', { class: 'sub', text: r.name }) : null),
      h('td', { class: 'cell-status', 'data-label': 'Status' }, h('span', { class: 'badges' }, statusBadge(r, true), runFlags(r)),
        r.status === 'failed' && r.errorKindLabel ? h('span', { class: 'sub sub-line', text: r.errorKindLabel }) : null),
      h('td', { class: 'num cell-pairs', 'data-label': 'Pairs' }, h('span', { text: pairsText(r) }), rejected),
      historyDeltaCell(r, 'LCP'),
      historyDeltaCell(r, 'performance'),
      withInp ? historyDeltaCell(r, 'INP') : null);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || window.getSelection()?.toString()) return;
      selectRun(r.id);
    });
    tbody.append(tr);
  }
  return h('table', { class: 'data runs' },
    h('caption', { class: 'sr-only', text: 'Published perf-ab runs, newest first. Deltas are medians of paired after − before differences.' }),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'Created (local)' }),
      h('th', { scope: 'col', text: 'Page' }),
      h('th', { scope: 'col', text: 'Status' }),
      h('th', { scope: 'col', class: 'num', text: 'Pairs', title: 'Complete pairs / requested pairs' }),
      h('th', { scope: 'col', class: 'num', text: 'Δ LCP' }),
      h('th', { scope: 'col', class: 'num', text: 'Δ Perf' }),
      withInp ? h('th', { scope: 'col', class: 'num', text: 'Δ INP', title: 'Only runs with an interaction scenario have INP' }) : null)),
    tbody);
}

function onRunKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const links = [...els.body.querySelectorAll('a.run-link')];
  const i = links.indexOf(e.currentTarget);
  const next = links[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

// ---------------------------------------------------------------- detail

function renderDetail() {
  sectionIds = new Map();
  const d = els.detail;
  if (state.splunkError) {
    d.removeAttribute('aria-busy');
    document.title = 'Splunk CSV error · perf-ab history';
    d.replaceChildren(h('div', { class: 'detail-inner' },
      backButton(),
      callout('bad', `Could not open ${state.splunkError.fileName || 'file'}`,
        h('p', { text: state.splunkError.message }),
        h('button', { type: 'button', class: 'btn', text: 'Choose another CSV', on: { click: () => els.splunkFile.click() } }))));
    return;
  }
  if (state.activeSplunkId) {
    const rep = state.splunkReports.find((r) => r.id === state.activeSplunkId);
    if (rep) {
      d.removeAttribute('aria-busy');
      document.title = `${rep.fileName} · Splunk analysis`;
      renderSplunkDetail(rep);
      return;
    }
    state.activeSplunkId = '';
  }
  if (state.splunkLauncher) {
    d.removeAttribute('aria-busy');
    document.title = 'Splunk Analyzer · perf-ab history';
    renderSplunkLauncher();
    return;
  }
  const id = selectedId();
  document.title = id ? `Run ${id} · perf-ab history` : 'perf-ab history · adobecom/perf-tools';
  d.removeAttribute('aria-busy');
  if (state.loadError) {
    d.replaceChildren(h('div', { class: 'detail-empty' }, h('p', { text: 'Run details appear once the history loads. You can still drag and drop any Splunk CSV export here.' })));
    return;
  }
  if (!state.history) {
    d.setAttribute('aria-busy', 'true');
    d.replaceChildren(h('div', { class: 'detail-inner' }, skeleton(2, 'head'), skeleton(6), skeleton(4)));
    return;
  }
  if (!id) {
    const msg = state.history.runs.length ? 'Select a run to see its metrics, paired samples and provenance.' : 'Nothing to show yet. This page is read-only and lists runs once they are published.';
    d.replaceChildren(h('div', { class: 'detail-empty' }, h('p', { text: msg })));
    return;
  }
  const summary = state.history.runs.find((r) => r.id === id);
  if (!summary) {
    d.replaceChildren(h('div', { class: 'detail-inner' }, backButton(),
      callout('warn', `Run ${id} is not in the published history`, h('p', { text: 'It may not have been published yet, or the link is wrong.' }))));
    return;
  }
  const entry = ensureDetail(summary);
  const ready = entry.status === 'ready';
  const run = ready ? entry.data : summary;
  const inner = h('div', { class: 'detail-inner' }, backButton(), detailHeader(run));
  if (state.run && !filteredRuns().some((r) => r.id === id)) {
    add(inner, [h('p', { class: 'note', text: 'This run is hidden by the current filters.' })]);
  }
  add(inner, [stateCallouts(run, ready)]);
  if (entry.status === 'loading') {
    d.setAttribute('aria-busy', 'true');
    add(inner, [section('Medians', mediansTable(run, null)), skeleton(6), h('p', { class: 'sr-only', text: 'Loading run detail…' })]);
  } else if (entry.status === 'error') {
    add(inner, [
      callout('bad', entry.error.title, h('p', { text: entry.error.message }),
        h('p', { text: 'The summary below comes from the history index; direction readings need per-pair data.' }),
        summary.detailPath ? h('button', { type: 'button', class: 'btn', text: 'Retry', on: { click: () => { state.details.delete(id); renderDetail(); } } }) : null),
      section('Medians', mediansTable(run, null)),
      provenanceSection(run, null)]);
  } else {
    add(inner, [
      section('Medians', mediansTable(run, run.pairs)),
      preloadsSection(run),
      pairsSection(run),
      eventsSection(run),
      changesSection(run),
      interactionsSection(run),
      provenanceSection(run, run),
      artifactSection(run)]);
  }
  add(inner, [warningsCallout(run, ready)]);
  d.replaceChildren(inner);
}

function backButton() {
  return h('button', { type: 'button', class: 'btn btn-quiet back', on: { click: backToList } }, '← All runs');
}

function detailHeader(run) {
  const { runId, attempt } = core.splitRunId(run.id);
  const p = run.profile;
  const chips = [
    statusBadge(run),
    run.smoke ? badge('1-pair smoke', 'warn') : null,
    badge(core.sampleSummary(run), (run.samples.pairs ?? 0) < core.MIN_PAIRS ? 'warn' : 'neutral', 'Complete pairs / requested pairs'),
    run.where === 'local' ? badge(`Local run${run.egress.country ? ` (${run.egress.country})` : ''}`, 'warn')
      : run.us ? badge('US verified', 'ok') : badge(`Not US-verified${run.egress.country ? ` (${run.egress.country})` : ''}`, 'bad'),
    p?.lighthouseVersion ? badge(`Lighthouse ${p.lighthouseVersion}`) : null,
    p?.name ? badge(p.name) : run.profileKey ? badge(run.profileKey) : null,
  ];
  const heading = h('h2', { tabindex: '-1' }, core.displayUrl(run.url) || 'Unknown page');
  return h('header', { class: 'detail-head' },
    heading,
    h('p', { class: 'detail-sub' },
      run.name ? h('span', { text: run.name }) : null,
      h('span', {}, 'Run ', mono(runId), ` · attempt ${attempt}`),
      h('span', {}, 'Created ', timeEl(run.createdAt)),
      run.pageHref ? extLink(run.pageHref, 'Open page') : null),
    h('div', { class: 'badges' }, chips));
}

function stateCallouts(run, ready) {
  const out = [];
  const s = run.samples;
  if (run.smoke) {
    out.push(callout('warn', 'Smoke: one pair; no conclusion',
      disclosure('Why one pair is inconclusive', h('p', { text: 'One before/after pair cannot separate a real change from run-to-run noise. Use at least three pairs before judging performance.' }))));
  } else if (s.pairs != null && s.pairs < core.MIN_PAIRS && run.medians.delta) {
    out.push(callout('warn', `Few samples: ${s.pairs} complete pair${s.pairs === 1 ? '' : 's'}`,
      disclosure('Why direction is inconclusive', h('p', { text: `Direction requires at least ${core.MIN_PAIRS} complete pairs.` }))));
  }
  if (run.status === 'failed') {
    out.push(callout('bad', `Run failed${run.errorKindLabel ? `: ${run.errorKindLabel.toLowerCase()}` : ''}`,
      run.errorCodeLabel ? h('p', {}, h('strong', { text: run.errorCodeLabel }), run.errorCode !== run.errorCodeLabel ? [' ', mono(run.errorCode)] : null) : null,
      run.error ? h('p', { class: 'error-text', text: run.error }) : null,
      disclosure('How failed runs are handled', h('p', { text: 'Failed runs are excluded from comparisons.' }))));
  } else if (run.status === 'unknown') {
    out.push(callout('warn', `Unknown status: ${JSON.stringify(run.rawStatus)}`));
  }
  if (run.where === 'local') {
    out.push(callout('warn', 'Local measurement; not comparable with Actions results.',
      disclosure('Egress details', h('p', { text: `Measured locally from ${run.egress.country ?? 'an unknown country'}.` }))));
  } else if (!run.us) {
    const region = run.egress.country ?? 'unknown';
    out.push(callout('bad', `Not US verified (${region}); region may affect results.`,
      disclosure('Egress details', h('p', { text: `Egress ${region}; ${run.egress.verified ? 'verified' : 'not verified'}${run.egress.documentGeo ? `; document geo ${run.egress.documentGeo}` : ''}.` }))));
  }
  if (run.single) {
    out.push(callout('neutral', 'Single URL; no before/after comparison.'));
  }
  return out;
}

function warningsCallout(run, ready) {
  const s = run.samples;
  const items = [];
  if (run.status === 'partial') {
    const incomplete = ready ? run.incompletePairs : null;
    items.push(h('li', { text: `${s.pairs ?? 0}/${s.requested ?? '?'} pairs complete${incomplete ? `; ${incomplete} excluded` : ''}` }));
  }
  if (s.rejected) items.push(h('li', { text: `${s.rejected} attempt${s.rejected === 1 ? '' : 's'} rejected` }));
  const drift = new Map();
  for (const w of run.warnings?.filter((x) => x.kind === 'production-source-drift') ?? []) {
    const key = [w.path, w.repo, w.number].join('\0');
    const group = drift.get(key) ?? { ...w, pairs: new Set() };
    if (w.pair != null) group.pairs.add(w.pair);
    drift.set(key, group);
  }
  for (const w of drift.values()) {
    const prUrl = w.repo && w.number ? core.safeExternalUrl(`https://github.com/${w.repo}/pull/${w.number}`) : null;
    const pairs = [...w.pairs].sort((a, b) => a - b);
    items.push(h('li', {}, `Production source drift: ${w.path}${pairs.length ? ` (pair${pairs.length === 1 ? '' : 's'} ${pairs.join(', ')})` : ''}`,
      prUrl ? [' ', extLink(prUrl, `${w.repo}#${w.number}`)] : null));
  }
  return items.length ? callout('warn', 'Warnings', h('ul', {}, items)) : null;
}

function verdictDetail(key, c) {
  const n = `${c.total} pair${c.total === 1 ? '' : 's'}`;
  if (c.verdict === 'none') return '';
  if (c.excluded) return c.excluded;
  if (c.total < core.MIN_PAIRS) return `${n}; needs ${core.MIN_PAIRS}+`;
  if (c.verdict === 'noise') return `median |Δ| < ${core.formatNoise(key)}`;
  return `${c.agree}/${c.total} pairs same direction`;
}

function verdictCell(key, run, pairs) {
  const label = 'Direction';
  if (!run.medians.delta || run.medians.delta[key] == null) return h('td', { class: 'verdict', 'data-label': label, text: '—' });
  if (!pairs) return h('td', { class: 'verdict', 'data-label': label, text: 'Needs pair data' });
  const c = core.runVerdict(run, key, pairs);
  const detail = verdictDetail(key, c);
  return h('td', { class: 'verdict', 'data-label': label, 'data-verdict': c.verdict },
    h('span', { class: 'verdict-label', text: VERDICT_LABEL[c.verdict] }), detail ? h('span', { class: 'sub', text: detail }) : null);
}

function mediansTable(run, pairs) {
  const m = run.medians;
  const complete = pairs ? pairs.filter((p) => p.complete).length : run.samples.pairs;
  const keys = core.metricKeysFor(run);
  const rows = keys.map((key) => {
    const d = m.delta?.[key];
    const verdict = pairs && d != null ? core.runVerdict(run, key, pairs).verdict : 'none';
    return h('tr', { 'data-verdict': verdict },
      h('th', { scope: 'row' }, h('span', { class: 'metric-short', text: METRICS[key].short }), h('span', { class: 'metric-long', text: METRICS[key].label })),
      h('td', { class: 'num', 'data-label': 'Before', text: core.formatMetric(key, m.before?.[key]) }),
      h('td', { class: 'num', 'data-label': 'After', text: core.formatMetric(key, m.after?.[key]) }),
      h('td', { class: 'num delta', 'data-label': 'Δ', text: core.formatDelta(key, d) }),
      h('td', { class: 'num pct', 'data-label': 'Δ %', text: core.formatPercent(key, d, m.before?.[key]) || '—' }),
      verdictCell(key, run, pairs));
  });
  const note = run.single
    ? 'Single URL; no paired Δ.'
    : complete == null ? 'Sample counts unavailable.' : `Δ = median of per-pair (after − before) differences; Δ% vs. before.`;
  return h('div', { class: 'medians-content' },
    h('div', { class: 'table-scroll medians-scroll' }, h('table', { class: 'data medians' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Metric' }),
        h('th', { scope: 'col', class: 'num', text: 'Before' }),
        h('th', { scope: 'col', class: 'num', text: 'After' }),
        h('th', { scope: 'col', class: 'num', text: 'Median paired Δ' }),
        h('th', { scope: 'col', class: 'num', text: 'Δ %' }),
        h('th', { scope: 'col', text: 'Direction', title: 'Descriptive heuristic, not a statistical significance test' }))),
      h('tbody', {}, rows))),
    h('p', { class: 'note', text: note }),
    !run.single ? disclosure('How direction is set',
      h('p', { class: 'note', text: `Direction is a descriptive heuristic, not a statistical significance test, and carries no confidence level. A metric reads Consistently better or worse only with at least ${core.MIN_PAIRS} complete pairs, a median Δ at or beyond its noise threshold and at least ${Math.round(core.AGREEMENT * 100)}% of pair differences on the median's side; a smaller median Δ reads Within noise and everything else Inconclusive. Noise thresholds: ${noiseThresholds(keys)}. Lower is better except Performance.` })) : null);
}

function noiseThresholds(keys = METRIC_KEYS) {
  return keys.map((k) => `${METRICS[k].short} ${core.formatNoise(k)}`).join(', ');
}

// ---------------------------------------------------------------- unused preloads

// Preloads (Link header, HTML or script created) that Chrome reported as not used within a few seconds of the load event.
function preloadsSection(run) {
  const report = run.preloads;
  if (!report) return null;
  const single = run.single;
  const totals = (t) => (t ? `${t.unused} of ${t.total} unused` : '—');
  const stat = (s) => (s ? `unused in ${s.unused}/${s.loads} load${s.loads === 1 ? '' : 's'}` : '—');
  const summary = single
    ? `Median per load: ${totals(report.after)}.`
    : `Median per load: before ${totals(report.before)}; after ${totals(report.after)}.`;
  const body = report.rows.length
    ? h('div', { class: 'table-scroll' }, h('table', { class: 'data preloads' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Preloaded URL' }),
        h('th', { scope: 'col', text: 'Declared in' }),
        ...(single ? [] : [h('th', { scope: 'col', class: 'num', text: 'Before' })]),
        h('th', { scope: 'col', class: 'num', text: 'After' }))),
      h('tbody', {}, report.rows.map((row) => h('tr', {},
        h('th', { scope: 'row', class: 'event-name' }, mono(row.url)),
        h('td', { 'data-label': 'Declared in', text: core.PRELOAD_SOURCE_LABELS[row.source] }),
        ...(single ? [] : [h('td', { class: 'num', 'data-label': 'Before', text: stat(row.before) })]),
        h('td', { class: 'num', 'data-label': 'After', text: stat(row.after) }))))))
    : h('p', { class: 'note', text: 'Chrome reported no unused preloads.' });
  return section('Unused preloads',
    h('p', { class: 'note', text: `${summary} Chrome warns about a preload the page did not use within a few seconds of its load event.` }),
    body);
}

// ---------------------------------------------------------------- timing events

// The aggregate and individual pairs share name/type filters without replacing the controls.
function eventsSection(run) {
  const rows = run.events ?? [];
  if (!rows.length) return null;
  const single = run.single;
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const body = h('tbody');
  const count = h('p', { class: 'note', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', name: 'event-q', autocomplete: 'off', spellcheck: 'false', placeholder: 'Filter by event name…', 'aria-label': 'Filter timing events by name' });
  const kind = h('select', { name: 'event-kind', 'aria-label': 'Filter timing events by type' },
    h('option', { value: '', text: 'All types' }),
    ...kinds.map((k) => h('option', { value: k, text: core.EVENT_KIND_LABELS[k] })));
  const pair = h('select', { name: 'event-pair', 'aria-label': single ? 'Filter timing events by load' : 'Filter timing events by pair' },
    h('option', { value: '', text: single ? 'All loads · medians' : 'All pairs · medians' }),
    ...run.pairs.map((p) => h('option', { value: p.index, text: `${single ? 'Load' : 'Pair'} #${p.index}` })));
  let sortKey = 'preferred';
  let sortDirection = 'ascending';
  const headers = new Map();
  const heading = (key, label, title) => {
    const text = h('span', { text: label });
    const th = h('th', { scope: 'col', class: ['name', 'kind'].includes(key) ? null : 'num' },
      h('button', { type: 'button', class: 'event-sort', title, on: { click: () => {
        sortDirection = sortKey === key && sortDirection === 'ascending' ? 'descending' : 'ascending';
        sortKey = key;
        apply();
      } } }, text, h('span', { class: 'sort-icon', 'aria-hidden': 'true' })));
    headers.set(key, { th, text });
    return th;
  };
  const columns = [
    heading('name', 'Event', 'Sort by event name. Preferred order: FCP, LCP, interactions, MAS, Gnav, then other events.'),
    heading('kind', 'Type', 'Sort by event type'),
    ...(single ? [] : [heading('before', 'Before', 'Sort by before time')]),
    heading('after', 'After', 'Sort by after time'),
    ...(single ? [] : [heading('delta', 'Median paired Δ', 'Sort by signed time difference')]),
    heading('duration', 'Duration', 'Sort by after duration, or before duration when after is unavailable'),
  ];
  const resetOrder = h('button', { type: 'button', class: 'btn btn-quiet event-order-reset', text: 'reset sort', on: { click: () => {
    sortKey = 'preferred';
    sortDirection = 'ascending';
    apply();
  } } });
  const description = h('p', { class: 'note event-context' });
  const time = (stat, label) => h('td', { class: 'num', 'data-label': label, title: stat ? `${stat.n} load${stat.n === 1 ? '' : 's'}` : null },
    stat ? core.formatEventMs(stat.ms) : '—');
  const duration = (row) => {
    const b = row.before?.dur;
    const a = row.after?.dur;
    if (b == null && a == null) return '—';
    return single || b == null ? core.formatEventMs(a) : a == null ? core.formatEventMs(b) : `${core.formatEventMs(b)} → ${core.formatEventMs(a)}`;
  };
  const apply = () => {
    const selected = pair.value ? Number(pair.value) : null;
    const available = selected == null ? rows : rows.flatMap((r) => {
      const values = r.pairs.find((p) => p.index === selected);
      return values ? [{ ...r, ...values }] : [];
    });
    const q = search.value.trim().toLowerCase();
    const shown = core.sortEvents(available.filter((r) => (!kind.value || r.kind === kind.value) && (!q || r.name.toLowerCase().includes(q))), sortKey, sortDirection);
    fill(body, shown.map((r) => h('tr', { 'data-kind': r.kind },
      h('th', { scope: 'row', class: 'event-name' }, mono(r.name)),
      h('td', { 'data-label': 'Type', text: core.EVENT_KIND_LABELS[r.kind] }),
      ...(single ? [] : [time(r.before, 'Before')]),
      time(r.after, 'After'),
      ...(single ? [] : [h('td', { class: 'num delta', 'data-label': 'Δ', text: r.delta ? core.formatEventMs(r.delta.ms, true) : '—' })]),
      h('td', { class: 'num', 'data-label': 'Duration', text: duration(r) }))));
    fill(count, `${shown.length} of ${available.length} events`);
    if (!single) fill(headers.get('delta').text, selected == null ? 'Median paired Δ' : 'Δ');
    for (const [key, { th }] of headers) {
      th.removeAttribute('aria-sort');
      if (key === sortKey) th.setAttribute('aria-sort', sortDirection);
      else if (key === 'name' && sortKey === 'preferred') th.setAttribute('aria-sort', 'other');
    }
    resetOrder.hidden = sortKey === 'preferred';
    fill(description, selected == null
      ? `Median time since navigation start.${single ? '' : ' Δ is the median paired difference.'}`
      : `${single ? 'Load' : 'Pair'} #${selected} · time since navigation start.${single ? '' : ' Δ = after − before.'}`);
    if (!shown.length) fill(body, h('tr', {}, h('td', {
      colspan: single ? 4 : 6, class: 'note',
      text: selected != null && !available.length ? `Timing data was not published for this ${single ? 'load' : 'pair'}.` : 'No events match.',
    })));
  };
  search.addEventListener('input', apply);
  kind.addEventListener('change', apply);
  pair.addEventListener('change', apply);
  apply();
  return section('Timing events',
    h('div', { class: 'event-filters' }, pair, search, kind, count),
    h('div', { class: 'event-order' }, description, resetOrder),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data events' },
      h('caption', { class: 'sr-only', text: 'Timing events. Default priority: FCP, LCP, interactions, MAS, Gnav, then other measures, marks and milestones. Select a column heading to sort; select it again to reverse. Duration sorts by after, or before when unavailable.' }),
      h('thead', {}, h('tr', {}, columns)),
      body)));
}

// ---------------------------------------------------------------- per-pair table

function jobText(job) {
  if (!job) return '—';
  const indexes = job.benchmarkIndexes;
  const benchmarkText = indexes && (indexes.before != null || indexes.after != null)
    ? `CPU benchmark ${indexes.before ?? '?'} / ${indexes.after ?? '?'}`
    : job.benchmarkIndex != null ? `CPU benchmark ${Math.round(job.benchmarkIndex)}` : null;
  return [
    job.runAttempt != null ? `attempt ${job.runAttempt}` : null,
    job.chromeVersion ? `Chrome ${job.chromeVersion}` : null,
    benchmarkText,
    job.order?.length ? `order ${job.order.join(' then ')}` : null,
    job.orderPolicy === 'baseline-first-contextual-hints' ? 'fixed order: contextual hints' : null,
    job.egressCountry,
  ].filter(Boolean).join(' · ') || '—';
}

function pairsSection(run) {
  if (!run.pairs.length) return null;
  const single = run.single;
  const keys = core.metricKeysFor(run);
  const tbody = h('tbody', {});
  for (const p of run.pairs) {
    const variants = single ? [['After', p.after]] : [['Before', p.before], ['After', p.after], ['Δ', p.delta]];
    variants.forEach(([name, values], vi) => {
      const tr = h('tr', { class: [vi === 0 && 'pair-start', name === 'Δ' && 'pair-delta', !p.complete && 'pair-incomplete'] });
      if (vi === 0) {
        tr.append(h('th', { scope: 'rowgroup', rowspan: variants.length, class: 'pair-id' },
          `#${p.index}`, !p.complete && !single ? h('span', { class: 'sub', text: 'Incomplete' }) : null));
      }
      tr.append(h('th', { scope: 'row', class: 'variant', text: name }));
      for (const key of keys) {
        const v = values?.[key];
        const text = name === 'Δ' ? core.formatDelta(key, v, false) : values ? core.formatMetric(key, v, false) : 'missing';
        tr.append(h('td', { class: ['num', !values && 'missing'], text }));
      }
      if (vi === 0) tr.append(h('td', { rowspan: variants.length, class: 'job' }, disclosure('Runner details', h('p', { text: jobText(p.job) }))));
      tbody.append(tr);
    });
  }
  return section(single ? 'Per-load numbers' : 'Per-pair numbers',
    h('div', { class: 'table-scroll' }, h('table', { class: 'data pairs' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: single ? 'Load' : 'Pair' }),
        h('th', { scope: 'col', text: 'Variant' }),
        keys.map((k) => h('th', { scope: 'col', class: 'num' }, METRICS[k].short, core.columnUnit(k) ? h('span', { class: 'th-unit', text: core.columnUnit(k) }) : null)),
        h('th', { scope: 'col', text: 'Job' }))),
      tbody)),
    run.incompletePairs ? h('p', { class: 'note', text: `${run.incompletePairs} incomplete pair${run.incompletePairs === 1 ? ' is' : 's are'} listed but excluded from medians and direction readings.` }) : null);
}

// ---------------------------------------------------------------- changes, provenance, artifact

function pathList(title, paths) {
  if (!paths.length) return null;
  return h('div', { class: 'kv-block' }, h('h4', { text: title }), h('ul', { class: 'paths' }, paths.map((p) => h('li', {}, mono(p)))));
}

function changesSection(run) {
  const c = run.changes;
  const nothing = !c.kinds.length && !c.hints && !c.patchPaths.length && !c.sourcePaths.length && !c.prSources?.length;
  if (nothing) return section('Changes', h('p', { class: 'note', text: 'No change inputs.' }));
  const hints = c.hints && h('div', { class: 'kv-block' }, h('h4', { text: 'Resource hints' }),
    h('dl', { class: 'stats' },
      [['Requested', c.hints.requested], ['Used', c.hints.used], ['Contextual', c.hints.contextual], ['Dropped', c.hints.dropped]]
        .map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { class: 'num', text: v == null ? '—' : String(v) })))));
  const prSources = c.prSources?.length ? h('div', { class: 'kv-block' }, h('h4', { text: 'Pinned pull request sources' }),
    c.prSources.map((pr) => {
      const link = core.safeExternalUrl(`https://github.com/${pr.repo}/pull/${pr.number}`);
      return h('div', { class: 'source-provenance' },
        h('p', {}, link ? extLink(link, `${pr.repo}#${pr.number}`) : `${pr.repo}#${pr.number}`,
          ` · ${pr.files.length} mapped file change(s)`),
        h('dl', { class: 'stats' }, [
          ['Base', pr.baseSha], ['Merge base', pr.mergeBaseSha], ['Pinned head', pr.headSha],
        ].map(([label, sha]) => h('div', {}, h('dt', { text: label }), h('dd', {}, mono(sha))))),
        h('ul', {}, pr.files.map((file) => h('li', {}, `${file.status} ${file.path ?? file.previousPath}`))));
    })) : null;
  return section('Changes',
    c.kinds.length ? h('div', { class: 'badges' }, c.kinds.map((k) => badge(CHANGE_KINDS[k] ?? k))) : null,
    h('div', { class: 'kv-grid' }, hints, pathList('Patched paths', c.patchPaths), pathList('Source override paths', c.sourcePaths), prSources),
    disclosure('Published metadata', h('p', { class: 'note', text: 'Only mapped paths, change status, commit IDs and hashes are published. Source code, snippets and headers stay in the raw workflow artifact, which any signed-in GitHub user can download until it expires.' })));
}

function interactionsSection(run) {
  if (!run.interactionsKey) return null;
  const steps = run.interactions ?? [];
  return section('Interaction scenario',
    h('p', { class: 'note', text: 'INP is the slowest interaction of the timespan that replays these steps after the cold load, identically in before and after. The load metrics above come from the navigation of the same run.' }),
    steps.length ? h('ol', { class: 'steps' }, steps.map((step) => h('li', {},
      h('strong', { text: step.label ?? (step.action === 'auto' ? 'Auto-discovered in-page interactions' : step.action) }),
      step.label || step.action === 'auto' ? [' ', h('span', { class: 'sub', text: step.action })] : null))) : null,
    h('p', { class: 'note' }, 'Scenario key ', mono(run.interactionsKey.slice(0, 12)), '; only runs with the same key are compared.'));
}

function kv(label, ...value) {
  const v = value.flat().filter((x) => x != null && x !== '');
  return h('div', {}, h('dt', { text: label }), h('dd', {}, v.length ? v : '—'));
}

function provenanceSection(run, detail) {
  const { runId, attempt } = core.splitRunId(run.id);
  const p = run.profile ?? {};
  const s = run.samples;
  const chromeVersions = detail ? [...new Set(detail.pairs.map((x) => x.job?.chromeVersion).filter(Boolean))] : [];
  const attempts = detail ? [...new Set(detail.pairs.map((x) => x.job?.runAttempt).filter((x) => x != null))] : [];
  const configHref = core.blobUrl(run.github.sha, run.config);
  const viewport = p.width && p.height ? `${p.width}×${p.height}${p.deviceScaleFactor ? ` @ ${p.deviceScaleFactor}×` : ''}` : null;
  const throttle = [p.throttlingMethod, p.requestLatencyMs != null ? `${p.requestLatencyMs} ms request latency` : p.rttMs != null ? `${p.rttMs} ms RTT` : null,
    p.downloadThroughputKbps != null ? `${core.formatThroughput(p.downloadThroughputKbps)} down` : core.formatThroughput(p.throughputKbps),
    p.uploadThroughputKbps != null ? `${core.formatThroughput(p.uploadThroughputKbps)} up` : null,
    p.cpuSlowdownMultiplier != null ? `${p.cpuSlowdownMultiplier}× CPU` : null].filter(Boolean).join(' · ');
  return section('Provenance',
    h('dl', { class: 'kv' },
      kv('GitHub Actions run', run.github.runUrl ? extLink(run.github.runUrl, `Run ${runId}, attempt ${attempt}`) : `Run ${runId}, attempt ${attempt} (no link published)`),
      run.conclusion ? kv('Workflow conclusion', run.conclusion) : null,
      attempts.length > 1 ? kv('Job attempts', `${attempts.sort((a, b) => a - b).join(', ')} (failed jobs were re-run)`) : null,
      kv('Commit', run.github.sha ? extLink(core.commitUrl(run.github.sha), run.github.sha.slice(0, 12), 'mono') : null),
      kv('Experiment', run.name),
      kv('Config', run.config ? (configHref ? extLink(configHref, run.config, 'mono') : mono(run.config)) : null),
      kv('Page', run.url ? (run.pageHref ? extLink(run.pageHref, run.url, 'break') : h('span', { class: 'break', text: run.url })) : null),
      kv('Created', timeEl(run.createdAt)),
      kv('Finished', run.finishedAt != null ? [timeEl(run.finishedAt), run.finishedAt >= run.createdAt ? ` (${core.formatDuration(run.finishedAt - run.createdAt)})` : null] : null),
      kv('Model', p.name),
      kv('Lighthouse', p.lighthouseVersion),
      kv('Chrome', chromeVersions.length > 1 ? `${chromeVersions.join(', ')} (differs between jobs)` : p.chromeVersion ?? chromeVersions[0]),
      kv('Device', [p.formFactor, viewport].filter(Boolean).join(' · ')),
      kv('Throttling', throttle),
      kv('Profile key', run.profileKey ? mono(run.profileKey) : null),
      kv('Egress', `${run.egress.country ?? 'unknown'} · ${run.where === 'local' ? 'local' : run.egress.verified ? 'verified' : 'not verified'}${run.egress.documentGeo ? ` · document geo ${run.egress.documentGeo}` : ''}`),
      kv('Samples', [
        s.requested != null ? `${s.requested} requested` : null,
        s.pairs != null ? `${s.pairs} complete pair${s.pairs === 1 ? '' : 's'}` : null,
        s.before != null ? `${s.before} before` : null,
        s.after != null ? `${s.after} after` : null,
        s.rejected != null ? `${s.rejected} rejected` : null,
      ].filter(Boolean).join(' · '))));
}

function artifactSection(run) {
  const a = run.artifact;
  const st = core.artifactState(a);
  const name = a?.name ? mono(a.name) : 'Artifact';
  let body;
  if (st === 'missing') body = h('p', { text: 'No full report artifact is available for this run.' });
  else if (st === 'expired') {
    body = callout('neutral', 'Artifact expired',
      h('p', {}, name, a.expiresAt != null ? [' expired on ', timeEl(a.expiresAt, core.formatLocalDay(a.expiresAt)), '.'] : ' has expired.'),
      disclosure('About expired reports', h('p', { text: 'Raw Lighthouse reports expire; published numbers remain.' })));
  } else if (st === 'unlinked') {
    body = h('p', {}, name, ' has no published link.', a.expiresAt != null ? [' Expires ', timeEl(a.expiresAt, core.formatLocalDay(a.expiresAt)), '.'] : null);
  } else {
    body = h('p', {}, extLink(a.url, a.name ? `Download ${a.name}` : 'Download artifact'),
      a.expiresAt != null ? [' · expires ', timeEl(a.expiresAt, core.formatLocalDay(a.expiresAt)), ` (${core.formatRelativeDays(a.expiresAt)})`] : null,
      h('span', { class: 'sub sub-line', text: 'Sign-in required.' }));
  }
  return section('Reports and artifact', body,
    disclosure('Artifact policy', h('p', { class: 'note', text: 'Raw reports are not published; they remain in GitHub Actions for a limited time.' })));
}

// ---------------------------------------------------------------- splunk csv analysis

const CWV_BADGE_TONE = { good: 'ok', ni: 'warn', poor: 'bad', none: 'neutral' };

function renderSplunkLauncher() {
  const customInput = h('input', {
    type: 'search',
    value: state.splunkCustomUrl,
    placeholder: 'www.adobe.com/products/photoshop.html',
    'aria-label': 'Custom Adobe page URL for Splunk query',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const customLinks = h('div', { class: 'splunk-range-links' });
  const customQueryPre = h('code', { class: 'mono break' });
  const updateCustom = () => {
    state.splunkCustomUrl = customInput.value;
    const target = state.splunkCustomUrl.trim() || 'www.adobe.com/acrobat/plans.html';
    const opts = { allLocales: state.splunkAllLocales };
    fill(customLinks, splunk.SPLUNK_TIME_RANGES.map((range) => extLink(
      splunk.buildSplunkUrl(target, range, opts),
      range.label,
      'btn splunk-range-btn',
      { newTab: true },
    )));
    customQueryPre.textContent = splunk.buildSplunkQuery(target, opts);
  };
  customInput.addEventListener('input', updateCustom);

  const localeToggle = h('label', { class: 'splunk-check' },
    h('input', {
      type: 'checkbox',
      checked: state.splunkAllLocales,
      on: {
        change: (e) => {
          state.splunkAllLocales = e.target.checked;
          renderSplunkLauncher();
        },
      },
    }),
    'Include all locales (www.adobe.com/*/…)');
  updateCustom();

  const header = h('header', { class: 'detail-head' },
    h('h2', { tabindex: '-1', text: 'Splunk pageperf Explorer & CSV Analyzer' }),
    h('p', { class: 'splunk-window', text: '1. Open a Splunk search below → 2. Export as CSV → 3. Drag & drop the CSV anywhere on this page' }),
    h('p', { class: 'detail-sub' },
      h('span', { text: 'All CSV parsing and charts run 100% locally in your browser — nothing is uploaded.' }),
      extLink('https://wiki.corp.adobe.com/pages/viewpage.action?pageId=3282103361&spaceKey=WP4&title=performance%2Bsplunk%2Bqueries', 'Splunk queries wiki', null, { newTab: true })),
    h('div', { class: 'badges' },
      h('button', { type: 'button', class: 'btn splunk-primary-btn', text: 'Upload Splunk CSV', on: { click: () => els.splunkFile.click() } }),
      badge('Or drop any .csv file anywhere', 'neutral')));

  const tableRows = splunk.FEATURED_ADOBE_PAGES.map((p) => {
    const opts = { allLocales: state.splunkAllLocales };
    const samplingCell = p.rate == null
      ? h('td', { class: 'num', title: 'No <meta name="pageperf" content="on"> found on live page' }, badge('Off', 'warn'))
      : h('td', { class: 'num', title: `<meta name="pageperf-rate" content="${p.rate}">` }, badge(`${p.rate}%`, 'neutral'));
    return h('tr', {},
      h('th', { scope: 'row' },
        h('span', { text: p.name }),
        mono(state.splunkAllLocales && p.path.startsWith('www.adobe.com/') ? `www.adobe.com/*/${p.path.slice('www.adobe.com/'.length)}` : p.path, 'sub')),
      h('td', { text: p.group }),
      samplingCell,
      h('td', { class: 'splunk-ranges-cell' },
        h('div', { class: 'splunk-range-links' },
          splunk.SPLUNK_TIME_RANGES.map((range) => extLink(
            splunk.buildSplunkUrl(p.path, range, opts),
            range.label,
            'btn splunk-range-btn',
            { newTab: true },
          )))));
  });

  const customSection = section('Custom page query',
    h('div', { class: 'splunk-custom-row' }, customInput, localeToggle, customLinks),
    disclosure('Generated Splunk SPL query', h('p', {}, customQueryPre)));

  const pagesSection = section('Adobe product & plans pages',
    h('p', { class: 'note', text: 'Only pages with <meta name="pageperf" content="on"> send Web Vitals to Splunk (pages marked Off do not currently log). Sampling comes from each page\'s <meta name="pageperf-rate"> tag (default 50%).' }),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Page' }),
        h('th', { scope: 'col', text: 'Category' }),
        h('th', { scope: 'col', class: 'num', text: 'Sampling', title: 'Client-side sampling from <meta name="pageperf-rate"> (LANA always logs sample=100 after this step)' }),
        h('th', { scope: 'col', text: 'Open in Splunk (raw export)' }))),
      h('tbody', {}, tableRows))));

  const discoverSection = section('Discover all active pageperf pages',
    h('p', { class: 'note', text: 'List the top URLs currently logging client=pageperf in Splunk, ranked by event volume:' }),
    h('div', { class: 'splunk-range-links' },
      splunk.SPLUNK_TIME_RANGES.map((range) => extLink(
        splunk.buildSplunkDiscoverUrl(range),
        `Top pages (${range.label})`,
        'btn splunk-range-btn',
        { newTab: true },
      ))));

  els.detail.replaceChildren(h('div', { class: 'detail-inner' },
    backButton(),
    header,
    discoverSection,
    customSection,
    pagesSection));
}

function cwvBadge(status) {
  return badge(splunk.CWV_LABELS[status] ?? '—', CWV_BADGE_TONE[status] ?? 'neutral');
}

function renderSplunkDetail(rep) {
  sectionIds = new Map();
  const analysis = splunk.analyzeSplunk(rep.parsed, rep.filters);
  if (analysis.kind === 'stats') {
    renderSplunkStatsDetail(rep, analysis);
    return;
  }
  const lcp = analysis.lcp;
  const cls = analysis.cls;
  const mobEntry = analysis.breakdowns.device.find((d) => d.key === 'mobile');
  const deskEntry = analysis.breakdowns.device.find((d) => d.key === 'desktop');
  const mob = mobEntry?.count ?? 0;
  const desk = deskEntry?.count ?? 0;
  const devTotal = desk + mob;
  const deskPct = devTotal ? Math.round((desk / devTotal) * 100) : 0;
  const mobPct = devTotal ? 100 - deskPct : 0;
  const ratioBar = devTotal
    ? svgEl('svg', { class: 'ratio-bar-svg', viewBox: '0 0 100 8', role: 'img', 'aria-label': `${deskPct}% desktop, ${mobPct}% mobile` },
      desk > 0 ? svgEl('rect', { class: 'ratio-seg-desktop', x: 0, y: 0, width: deskPct, height: 8, rx: mob === 0 ? 4 : 2 }) : null,
      mob > 0 ? svgEl('rect', { class: 'ratio-seg-mobile', x: deskPct, y: 0, width: mobPct, height: 8, rx: desk === 0 ? 4 : 2 }) : null)
    : null;
  const timeText = analysis.timeRange
    ? splunk.formatFriendlyRange(analysis.timeRange.min, analysis.timeRange.max)
    : null;
  const pageTitle = analysis.options.urls.length === 1
    ? analysis.options.urls[0]
    : `${analysis.options.urls.length} pages (${analysis.options.urls[0]}, …)`;
  const pageHref = analysis.options.urls.length === 1
    ? core.safeExternalUrl(analysis.options.urls[0].startsWith('https://') ? analysis.options.urls[0] : `https://${analysis.options.urls[0]}`)
    : null;
  document.title = `${pageTitle} · Splunk analysis`;

  const header = h('header', { class: 'detail-head' },
    h('h2', { tabindex: '-1', text: pageTitle }),
    timeText ? h('p', { class: 'splunk-window', text: timeText }) : null,
    h('p', { class: 'detail-sub' },
      h('span', {}, 'File ', mono(rep.fileName)),
      h('span', { text: analysis.coverage.samplingText }),
      pageHref ? extLink(pageHref, 'Open page') : null),
    h('div', { class: 'badges' },
      lcp ? badge(`P75 LCP ${splunk.formatMsOrSec(lcp.p75)} · ${splunk.CWV_LABELS[lcp.status]}`, CWV_BADGE_TONE[lcp.status]) : null,
      badge(`${analysis.matchedEvents} of ${analysis.totalEvents} events`),
      badge('Local browser analysis', 'neutral'),
      analysis.botCount ? badge(`${analysis.botCount} synthetic`, 'warn') : null,
      analysis.skippedRows ? badge(`${analysis.skippedRows} non-pageperf skipped`, 'neutral') : null,
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Upload another CSV', on: { click: () => els.splunkFile.click() } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Splunk queries', on: { click: openSplunkLauncher } })));

  const coverageBanner = callout(analysis.coverage.tone, analysis.coverage.title,
    h('p', { text: analysis.coverage.detail }));

  const kpis = h('div', { class: 'splunk-kpis' },
    h('div', { class: 'kpi-card' },
      h('span', { class: 'kpi-label', text: 'P75 LCP (CWV target ≤ 2.5 s)' }),
      h('div', { class: 'kpi-value' }, h('span', { text: lcp ? splunk.formatMsOrSec(lcp.p75) : '—' }), lcp ? cwvBadge(lcp.status) : null),
      h('span', { class: 'kpi-sub', text: lcp ? `P50 ${splunk.formatMsOrSec(lcp.p50)} · P95 ${splunk.formatMsOrSec(lcp.p95)} · max ${splunk.formatMsOrSec(lcp.max)}` : 'No LCP values' })),
    h('div', { class: 'kpi-card' },
      h('span', { class: 'kpi-label', text: 'Good LCP rate (≤ 2.5 s)' }),
      h('div', { class: 'kpi-value' }, h('span', { text: lcp ? `${lcp.goodPct.toFixed(1)}%` : '—' })),
      h('span', { class: 'kpi-sub', text: lcp ? `${lcp.good} good · ${lcp.ni} needs imp. · ${lcp.poor} poor` : '—' })),
    h('div', { class: 'kpi-card' },
      h('span', { class: 'kpi-label', text: 'P75 CLS (CWV target ≤ 0.10)' }),
      h('div', { class: 'kpi-value' }, h('span', { text: cls ? cls.p75.toFixed(3) : '—' }), cls ? cwvBadge(cls.status) : null),
      h('span', { class: 'kpi-sub', text: cls ? `P50 ${cls.p50.toFixed(3)} · P95 ${cls.p95.toFixed(3)} · max ${cls.max.toFixed(3)}` : 'No CLS values' })),
    h('div', { class: 'kpi-card' },
      h('span', { class: 'kpi-label', text: 'Desktop / Mobile ratio' }),
      h('div', { class: 'kpi-value' },
        h('span', { text: devTotal ? `${deskPct}% / ${mobPct}%` : `${analysis.matchedEvents}` })),
      ratioBar,
      h('span', { class: 'kpi-sub', text: `${desk} desktop${deskEntry?.p75 != null ? ` (${splunk.formatMsOrSec(deskEntry.p75)})` : ''} · ${mob} mobile${mobEntry?.p75 != null ? ` (${splunk.formatMsOrSec(mobEntry.p75)})` : ''}` })));

  const filterBar = splunkFilterBar(rep, analysis);
  const insightsSec = analysis.insights.length
    ? section('Diagnostic analysis',
      h('div', { class: 'splunk-insights' }, analysis.insights.map((ins) => callout(
        ins.tone,
        ins.title,
        h('p', { text: ins.detail }),
        ins.action === 'human-only' ? h('button', {
          type: 'button',
          class: 'btn',
          text: 'Show human-only traffic',
          on: { click: () => { rep.filters = { ...rep.filters, excludeBots: true }; renderSplunkDetail(rep); } },
        }) : null,
      ))),
      disclosure('Milo logWebVitals.js caveats',
        h('p', { class: 'note', text: 'pageperf logs Chrome-only, consent-gated (C0002), sampled beacons once 1,000 ms after the first LCP candidate. If hero media paints later, an earlier text element or "(Element Was Replaced / Missing)" may be recorded instead.' })))
    : null;

  const inner = h('div', { class: 'detail-inner' },
    backButton(),
    header,
    filterBar,
    coverageBanner,
    kpis,
    analysis.matchedEvents ? [
      lcpHistogramSection(analysis),
    lcpTrendSection(analysis),
    lcpTimelineSection(rep, analysis),
      elementsChartSection(analysis.breakdowns.element, 'Top LCP elements (P75 & share)'),
      insightsSec,
      breakdownsSection(rep, analysis),
      slowestEventsSection(analysis),
    ] : callout('warn', 'No events match the current filters',
      h('p', { text: `All ${analysis.totalEvents} events are hidden by the filters above.` }),
    h('button', { type: 'button', class: 'btn', text: 'Show all events', on: { click: () => { rep.filters = { ...splunk.EMPTY_SPLUNK_FILTERS, excludeBots: false }; renderSplunkDetail(rep); } } })));

  els.detail.replaceChildren(inner);
}

function renderSplunkStatsDetail(rep, analysis) {
  sectionIds = new Map();
  const header = h('header', { class: 'detail-head' },
    h('h2', { tabindex: '-1', text: rep.fileName }),
    h('p', { class: 'detail-sub' },
      h('span', { text: `${analysis.rowCount} element group${analysis.rowCount === 1 ? '' : 's'}` }),
      analysis.totalCount != null ? h('span', { text: `${analysis.totalCount} total events` }) : null),
    h('div', { class: 'badges' },
      badge('Aggregated stats CSV', 'neutral'),
      badge('Local browser analysis', 'neutral'),
      analysis.approxP75 != null ? badge(`Weighted P75 ${splunk.formatMsOrSec(analysis.approxP75)}`, CWV_BADGE_TONE[splunk.cwvLcpStatus(analysis.approxP75)]) : null,
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Upload another CSV', on: { click: () => els.splunkFile.click() } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Splunk queries', on: { click: openSplunkLauncher } })));

  const insightsSec = analysis.insights.length
    ? section('Diagnostic analysis',
      h('div', { class: 'splunk-insights' }, analysis.insights.map((ins) => callout(ins.tone, ins.title, h('p', { text: ins.detail })))))
    : null;

  const tableRows = analysis.rows.map((r) => h('tr', {},
    h('th', { scope: 'row', class: 'splunk-el' }, mono(r.element)),
    analysis.hasDevice ? h('td', { 'data-label': 'Device', text: r.device ?? '—' }) : null,
    h('td', { class: 'num', 'data-label': 'Count', text: r.count != null ? String(r.count) : '—' }),
    h('td', { class: 'num', 'data-label': 'Share', text: r.percent != null ? `${r.percent.toFixed(1)}%` : '—' }),
    h('td', { class: 'num', 'data-label': 'P50', text: splunk.formatMsOrSec(r.p50) }),
    h('td', { class: 'num', 'data-label': 'P75', text: splunk.formatMsOrSec(r.p75) }),
    h('td', { class: 'num', 'data-label': 'P95', text: splunk.formatMsOrSec(r.p95) }),
    h('td', { 'data-label': 'Status' }, cwvBadge(r.cwvStatus))));

  const chartItems = analysis.rows.map((r) => ({
    key: r.device ? `${r.element} (${r.device})` : r.element,
    count: r.count ?? 0,
    percent: r.percent ?? 0,
    p75: r.p75,
    status: r.cwvStatus,
  }));

  els.detail.replaceChildren(h('div', { class: 'detail-inner' },
    backButton(),
    header,
    elementsChartSection(chartItems, 'LCP elements (P75 & share)'),
    insightsSec,
    section('LCP element distribution',
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', text: 'LCP Element' }),
          analysis.hasDevice ? h('th', { scope: 'col', text: 'Device' }) : null,
          h('th', { scope: 'col', class: 'num', text: 'Count' }),
          h('th', { scope: 'col', class: 'num', text: 'Share %' }),
          h('th', { scope: 'col', class: 'num', text: 'P50 LCP' }),
          h('th', { scope: 'col', class: 'num', text: 'P75 LCP' }),
          h('th', { scope: 'col', class: 'num', text: 'P95 LCP' }),
          h('th', { scope: 'col', text: 'Status (P75)' }))),
        h('tbody', {}, tableRows))))));
}

function splunkFilterBar(rep, analysis) {
  const f = rep.filters;
  const update = (patch) => {
    rep.filters = { ...rep.filters, ...patch };
    renderSplunkDetail(rep);
  };
  const hasAny = !f.excludeBots || f.device || f.country || f.manifest || f.url;
  const counts = analysis.deviceScopeCounts ?? { all: analysis.totalEvents, desktop: 0, mobile: 0 };
  const deviceRadios = h('div', { class: 'device-radio-group', role: 'radiogroup', 'aria-label': 'Filter by device' },
    [
      ['', `All (${counts.all})`],
      ['desktop', `Desktop (${counts.desktop})`],
      ['mobile', `Mobile (${counts.mobile})`],
    ].map(([val, label]) => h('button', {
      type: 'button',
      role: 'radio',
      class: 'device-radio-btn',
      'aria-checked': f.device === val ? 'true' : 'false',
      text: label,
      on: { click: () => update({ device: val }) },
    })));
  return h('div', { class: 'splunk-filters', role: 'region', 'aria-label': 'Filter Splunk events' },
    analysis.botCount ? h('label', { class: 'splunk-check' },
      h('input', {
        type: 'checkbox',
        checked: f.excludeBots,
        on: { change: (e) => update({ excludeBots: e.target.checked }) },
      }),
      `Human-only traffic (excludes ${analysis.botCount} synthetic)`) : null,
    deviceRadios,
    analysis.options.countries.length > 1 ? h('select', {
      'aria-label': 'Filter by country',
      value: f.country,
      on: { change: (e) => update({ country: e.target.value }) },
    },
    h('option', { value: '', text: 'All countries' }),
    analysis.options.countries.map((c) => h('option', { value: c, text: c.toUpperCase() }))) : null,
    analysis.options.manifests.length > 1 ? h('select', {
      'aria-label': 'Filter by MEP manifest',
      value: f.manifest,
      on: { change: (e) => update({ manifest: e.target.value }) },
    },
    h('option', { value: '', text: 'All MEP manifests' }),
    analysis.options.manifests.map((m) => h('option', { value: m, text: m === 'none' ? 'No MEP manifest' : m }))) : null,
    analysis.options.urls.length > 1 ? h('select', {
      'aria-label': 'Filter by URL',
      value: f.url,
      on: { change: (e) => update({ url: e.target.value }) },
    },
    h('option', { value: '', text: 'All URLs' }),
    analysis.options.urls.map((u) => h('option', { value: u, text: u }))) : null,
    hasAny ? h('button', {
      type: 'button',
      class: 'btn btn-quiet',
      text: 'Reset filters',
      on: { click: () => { rep.filters = { ...splunk.EMPTY_SPLUNK_FILTERS }; renderSplunkDetail(rep); } },
    }) : null,
    h('span', { class: 'note', text: `${analysis.matchedEvents} of ${analysis.totalEvents} shown` }));
}

function lcpHistogramSection(analysis) {
  const lcp = analysis.lcp;
  if (!lcp) return null;
  const W = 680;
  const H = 220;
  const pad = { top: 24, right: 16, bottom: 34, left: 36 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...analysis.histogram.map((b) => b.count));
  const stepW = plotW / analysis.histogram.length;
  const barW = Math.max(12, stepW - 8);

  const svg = svgEl('svg', { class: 'splunk-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'LCP latency distribution histogram' });
  // Horizontal gridlines
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = pad.top + plotH * (1 - frac);
    const val = Math.round(maxCount * frac);
    svg.append(
      svgEl('line', { class: 'chart-grid', x1: pad.left, y1: y, x2: W - pad.right, y2: y }),
      svgEl('text', { class: 'chart-label', x: pad.left - 6, y: y + 3, 'text-anchor': 'end' }, String(val)),
    );
  }
  svg.append(svgEl('line', { class: 'chart-axis', x1: pad.left, y1: pad.top + plotH, x2: W - pad.right, y2: pad.top + plotH }));

  // Bars
  analysis.histogram.forEach((b, i) => {
    const bh = (b.count / maxCount) * plotH;
    const x = pad.left + i * stepW + (stepW - barW) / 2;
    const y = pad.top + plotH - bh;
    const rect = svgEl('rect', {
      class: 'chart-bar',
      'data-zone': b.zone,
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: Math.max(b.count ? 2 : 0, bh).toFixed(1),
      rx: 3,
    }, svgEl('title', {}, `${b.label}: ${b.count} event${b.count === 1 ? '' : 's'} (${b.pct.toFixed(1)}%)`));
    svg.append(rect);
    if (b.count > 0) {
      svg.append(svgEl('text', {
        class: 'chart-label-val',
        x: (x + barW / 2).toFixed(1),
        y: Math.max(12, y - 5).toFixed(1),
        'text-anchor': 'middle',
      }, String(b.count)));
    }
    svg.append(svgEl('text', {
      class: 'chart-label',
      x: (x + barW / 2).toFixed(1),
      y: pad.top + plotH + 16,
      'text-anchor': 'middle',
    }, b.label));
  });

  // CWV threshold markers between buckets 4/5 (2.5s) and 6/7 (4.0s)
  const goodX = pad.left + 5 * stepW;
  const poorX = pad.left + 7 * stepW;
  svg.append(
    svgEl('line', { class: 'chart-ref', 'data-zone': 'good', x1: goodX, y1: pad.top - 6, x2: goodX, y2: pad.top + plotH }),
    svgEl('text', { class: 'chart-label-ref', x: goodX, y: pad.top - 10, 'text-anchor': 'middle' }, '2.5s Good'),
    svgEl('line', { class: 'chart-ref', 'data-zone': 'poor', x1: poorX, y1: pad.top - 6, x2: poorX, y2: pad.top + plotH }),
    svgEl('text', { class: 'chart-label-ref', x: poorX, y: pad.top - 10, 'text-anchor': 'middle' }, '4.0s Poor'),
  );

  // Stacked CWV split bar
  const splitW = 680;
  const splitSvg = svgEl('svg', { class: 'splunk-chart-svg', viewBox: `0 0 ${splitW} 18`, role: 'img', 'aria-label': 'Core Web Vitals LCP pass-rate split' });
  const goodW = (lcp.goodPct / 100) * splitW;
  const niW = (lcp.niPct / 100) * splitW;
  const poorW = Math.max(0, splitW - goodW - niW);
  if (goodW > 0) splitSvg.append(svgEl('rect', { class: 'chart-bar', 'data-zone': 'good', x: 0, y: 2, width: goodW.toFixed(1), height: 12, rx: 2 }, svgEl('title', {}, `Good (≤ 2.5s): ${lcp.good} (${lcp.goodPct.toFixed(1)}%)`)));
  if (niW > 0) splitSvg.append(svgEl('rect', { class: 'chart-bar', 'data-zone': 'ni', x: goodW.toFixed(1), y: 2, width: niW.toFixed(1), height: 12 }, svgEl('title', {}, `Needs Improvement (2.5–4.0s): ${lcp.ni} (${lcp.niPct.toFixed(1)}%)`)));
  if (poorW > 0) splitSvg.append(svgEl('rect', { class: 'chart-bar', 'data-zone': 'poor', x: (goodW + niW).toFixed(1), y: 2, width: poorW.toFixed(1), height: 12, rx: 2 }, svgEl('title', {}, `Poor (> 4.0s): ${lcp.poor} (${lcp.poorPct.toFixed(1)}%)`)));

  return section('LCP distribution',
    h('div', { class: 'splunk-chart-wrap' },
      splitSvg,
      h('div', { class: 'chart-legend' },
        h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'good' }), `Good ≤ 2.5 s (${lcp.goodPct.toFixed(1)}%)`),
        h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'ni' }), `Needs Improvement (${lcp.niPct.toFixed(1)}%)`),
        h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'poor' }), `Poor > 4.0 s (${lcp.poorPct.toFixed(1)}%)`)),
      svg));
}

function lcpTrendSection(analysis) {
  const { bucketMs, buckets } = analysis.trend ?? {};
  if (!buckets || buckets.length < 2) return null;

  const W = 680;
  const H = 200;
  const pad = { top: 20, right: 20, bottom: 30, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const minT = buckets[0].mid;
  const maxT = buckets[buckets.length - 1].mid;
  const spanT = Math.max(1, maxT - minT);
  const maxP75 = Math.max(4500, ...buckets.map((b) => b.p75 ?? 0));
  const yMax = Math.ceil((maxP75 * 1.12) / 500) * 500;
  const xOf = (t) => pad.left + ((t - minT) / spanT) * plotW;
  const yOf = (ms) => pad.top + plotH - (ms / yMax) * plotH;

  const formatTick = (ms) => (ms === 0 ? '0' : ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`);
  const step = yMax <= 6000 ? 1500 : yMax <= 10000 ? 2500 : Math.ceil(yMax / 4 / 1000) * 1000;

  const svg = svgEl('svg', { class: 'splunk-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'LCP P75 and P50 trend line chart' });
  for (let ms = 0; ms <= yMax + 1; ms += step) {
    const y = yOf(ms);
    svg.append(
      svgEl('line', { class: 'chart-grid', x1: pad.left, y1: y.toFixed(1), x2: W - pad.right, y2: y.toFixed(1) }),
      svgEl('text', { class: 'chart-label', x: pad.left - 6, y: (y + 3).toFixed(1), 'text-anchor': 'end' }, formatTick(ms)),
    );
  }
  for (const [ms, zone, lbl] of [[splunk.LCP_GOOD_MS, 'good', '2.5s'], [splunk.LCP_POOR_MS, 'poor', '4.0s']]) {
    if (ms <= yMax) {
      const y = yOf(ms);
      svg.append(
        svgEl('line', { class: 'chart-ref', 'data-zone': zone, x1: pad.left, y1: y.toFixed(1), x2: W - pad.right, y2: y.toFixed(1) }),
        svgEl('text', { class: 'chart-label-ref', x: pad.left + 4, y: Math.max(pad.top + 10, y - 3).toFixed(1), 'text-anchor': 'start' }, lbl),
      );
    }
  }

  const p50Points = buckets.filter((b) => b.p50 != null).map((b) => `${xOf(b.mid).toFixed(1)},${yOf(b.p50).toFixed(1)}`).join(' ');
  const p75Points = buckets.filter((b) => b.p75 != null).map((b) => `${xOf(b.mid).toFixed(1)},${yOf(b.p75).toFixed(1)}`).join(' ');
  if (p50Points) svg.append(svgEl('polyline', { class: 'trend-line-p50', points: p50Points }));
  if (p75Points) svg.append(svgEl('polyline', { class: 'trend-line-p75', points: p75Points }));

  const hoverStrip = h('p', { class: 'note chart-hover-strip', 'aria-live': 'polite' });
  const bucketMins = Math.round(bucketMs / 60000);
  const bucketLabel = bucketMins >= 60 ? `${(bucketMins / 60).toFixed(1).replace(/\.0$/, '')} hr` : `${bucketMins} min`;
  const defaultPreview = `Hover a point to inspect the ${bucketLabel} bucket · ${buckets.length} time buckets shown.`;
  hoverStrip.textContent = defaultPreview;

  buckets.forEach((b) => {
    const cx = xOf(b.mid).toFixed(1);
    const cy = yOf(b.p75).toFixed(1);
    const rangeTxt = `${splunk.formatFriendlyTime(b.start)} – ${splunk.formatFriendlyTime(b.end, { withTz: true })}`;
    const summaryTxt = `${rangeTxt} · ${b.count} event${b.count === 1 ? '' : 's'} · P75 ${splunk.formatMsOrSec(b.p75)} · P50 ${splunk.formatMsOrSec(b.p50)} · P95 ${splunk.formatMsOrSec(b.p95)} · ${b.goodPct.toFixed(0)}% Good`;
    const dot = svgEl('circle', {
      class: 'trend-dot',
      'data-zone': b.status,
      tabindex: '0',
      cx,
      cy,
      r: 4.5,
      'aria-label': summaryTxt,
    }, svgEl('title', {}, summaryTxt));
    dot.addEventListener('mouseenter', () => { hoverStrip.textContent = summaryTxt; });
    dot.addEventListener('focus', () => { hoverStrip.textContent = summaryTxt; });
    svg.append(dot);
  });
  svg.addEventListener('mouseleave', () => { hoverStrip.textContent = defaultPreview; });

  svg.append(svgEl('line', { class: 'chart-axis', x1: pad.left, y1: pad.top + plotH, x2: W - pad.right, y2: pad.top + plotH }));
  const sameDay = core.formatLocalDay(minT) === core.formatLocalDay(maxT);
  svg.append(
    svgEl('text', { class: 'chart-label', x: pad.left, y: pad.top + plotH + 18, 'text-anchor': 'start' },
      sameDay ? splunk.formatFriendlyTime(minT) : `${core.formatLocalDay(minT)} ${splunk.formatFriendlyTime(minT)}`),
    svgEl('text', { class: 'chart-label', x: W - pad.right, y: pad.top + plotH + 18, 'text-anchor': 'end' },
      sameDay ? splunk.formatFriendlyTime(maxT, { withTz: true }) : `${core.formatLocalDay(maxT)} ${splunk.formatFriendlyTime(maxT, { withTz: true })}`),
  );

  return section('LCP trend',
    h('div', { class: 'splunk-chart-wrap' },
      svg,
      h('div', { class: 'chart-legend' },
        h('span', { class: 'legend-item' }, h('span', { class: 'legend-line', 'data-series': 'p75' }), 'P75 LCP'),
        h('span', { class: 'legend-item' }, h('span', { class: 'legend-line', 'data-series': 'p50' }), 'P50 LCP (median)'),
        h('span', { class: 'note', text: `${bucketLabel} buckets across all ${analysis.matchedEvents} filtered events.` })),
      hoverStrip));
}

function lcpTimelineSection(rep, analysis) {
  const pts = analysis.timeline;
  if (pts.length < 2 || !analysis.timeRange || analysis.timeRange.max <= analysis.timeRange.min) return null;
  const W = 680;
  const H = 228;
  const pad = { top: 20, right: 20, bottom: 32, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const fullTMin = analysis.timeRange.min;
  const fullTMax = analysis.timeRange.max;
  const rawMax = Math.max(4500, analysis.lcp?.max ?? 4500);
  const fullYMax = rawMax * 1.06;
  const hasExtremeOutliers = rawMax > 20000;
  const focusedYMax = hasExtremeOutliers
    ? Math.max(6000, Math.min(15000, Math.ceil(((analysis.lcp?.p95 ?? 5000) * 1.5) / 1000) * 1000))
    : fullYMax;

  const filterSig = JSON.stringify(rep.filters) + `:${pts.length}`;
  if (!rep.timelineView || rep.timelineView.sig !== filterSig) {
    rep.timelineView = {
      sig: filterSig,
      tMin: fullTMin,
      tMax: fullTMax,
      yMin: 0,
      yMax: focusedYMax,
      mode: 'box',
      pinnedIndex: null,
    };
  }
  const view = rep.timelineView;

  // Keep SVG dot count bounded for smooth 60fps pan/zoom even on 10k-row exports.
  const MAX_SVG_DOTS = 1200;
  let renderedPts = pts;
  let downsampled = false;
  if (pts.length > MAX_SVG_DOTS) {
    downsampled = true;
    const priority = [];
    const rest = [];
    for (const p of pts) {
      if (p.status !== 'good' || p.bot) priority.push(p);
      else rest.push(p);
    }
    const budget = Math.max(0, MAX_SVG_DOTS - priority.length);
    if (budget === 0) {
      const step = priority.length / MAX_SVG_DOTS;
      renderedPts = Array.from({ length: MAX_SVG_DOTS }, (_, i) => priority[Math.floor(i * step)]);
    } else if (rest.length <= budget) {
      renderedPts = pts;
      downsampled = false;
    } else {
      const step = rest.length / budget;
      const sampled = Array.from({ length: budget }, (_, i) => rest[Math.floor(i * step)]);
      renderedPts = [...priority, ...sampled].sort((a, b) => a.index - b.index);
    }
  }
  const ptByIndex = new Map(pts.map((p) => [p.index, p]));

  const wrap = h('div', { class: 'splunk-chart-wrap' });
  const hoverStrip = h('p', { class: 'note chart-hover-strip', 'aria-live': 'polite' });
  const inspector = h('div', { class: 'event-inspector', hidden: true, 'aria-live': 'polite' });
  const svg = svgEl('svg', { class: 'splunk-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'LCP over time scatter plot' });

  const formatTickMs = (ms) => (ms === 0 ? '0' : ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`);

  const niceTicks = (minV, maxV) => {
    const span = maxV - minV;
    const rough = span / 4;
    const mag = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
    const norm = rough / mag;
    const step = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag;
    const out = [];
    const start = Math.ceil(minV / step) * step;
    for (let v = start; v <= maxV + step * 0.001; v += step) out.push(Math.round(v));
    if (minV === 0 && out[0] !== 0) out.unshift(0);
    return out;
  };

  let lastHoverIndex = -1;
  const setHoverPreview = (pt) => {
    const idx = pt ? pt.index : -1;
    if (idx === lastHoverIndex) return;
    lastHoverIndex = idx;
    if (!pt) {
      hoverStrip.textContent = 'Hover a dot to preview · click a dot to inspect full details.';
      return;
    }
    hoverStrip.textContent = `${splunk.formatFriendlyTime(pt.timestamp, { withTz: true })} · LCP ${splunk.formatMsOrSec(pt.lcp)}${pt.cls != null ? ` · CLS ${pt.cls.toFixed(3)}` : ''} · ${pt.device} · ${pt.country.toUpperCase()}${pt.bot ? ` · ${pt.bot}` : ''} — click dot to inspect`;
  };

  let lastInspectorIndex = -1;
  const renderInspector = (pt) => {
    const idx = pt ? pt.index : -1;
    if (idx === lastInspectorIndex) return;
    lastInspectorIndex = idx;

    for (const d of dotEls) {
      if (pt && d.pt.index === pt.index) d.el.setAttribute('data-selected', 'true');
      else d.el.removeAttribute('data-selected');
    }
    if (!pt) {
      inspector.hidden = true;
      inspector.replaceChildren();
      return;
    }
    inspector.hidden = false;
    const vp = pt.windowWidth && pt.windowHeight ? `${pt.windowWidth}×${pt.windowHeight}` : null;
    const refererHref = pt.referer ? core.safeExternalUrl(pt.referer) : null;
    const foldText = pt.lcpSectionOne === true ? 'Section 1 (above fold)' : pt.lcpSectionOne === false ? 'Below Section 1 (off-fold)' : 'Unknown';
    const loggedInText = pt.loggedIn === true ? 'Signed in' : pt.loggedIn === false ? 'Signed out' : 'Unknown';
    const manifestText = pt.manifests?.length ? pt.manifests.map((m) => m.label).join(' · ') : 'None';

    inspector.replaceChildren(
      h('div', { class: 'event-inspector-head' },
        h('div', { class: 'event-inspector-title' },
          h('span', { text: `LCP ${splunk.formatMsOrSec(pt.lcp)}` }),
          cwvBadge(pt.status),
          pt.cls != null ? badge(`CLS ${pt.cls.toFixed(3)}`, CWV_BADGE_TONE[splunk.cwvClsStatus(pt.cls)]) : null,
          pt.bot ? badge(pt.bot, 'warn') : null,
          h('span', { class: 'sub', text: `${core.formatDateTime(pt.timestamp)} (${splunk.formatFriendlyTime(pt.timestamp, { withTz: true })})` })),
        h('button', {
          type: 'button',
          class: 'btn btn-quiet',
          text: 'Clear selection',
          on: { click: () => { view.pinnedIndex = null; renderInspector(null); } },
        })),
      pt.clues?.length ? h('div', { class: 'badges' }, pt.clues.map((c) => badge(c, pt.status === 'poor' ? 'warn' : 'neutral'))) : null,
      h('dl', { class: 'kv' },
        kv('LCP Element', mono(pt.lcpEl)),
        kv('Element Type & Fold', `${pt.lcpElType ?? '—'} · ${foldText}`),
        kv('Device & OS', [pt.device, vp, pt.os !== 'unknown' ? pt.os : null, pt.chromeVer ? `Chrome ${pt.chromeVer}` : null].filter(Boolean).join(' · ')),
        kv('Network & Country', [pt.country ? pt.country.toUpperCase() : null, pt.downlink != null ? `${pt.downlink} Mbps downlink` : 'Downlink unknown', loggedInText].filter(Boolean).join(' · ')),
        kv('MEP Manifests', manifestText),
        pt.referer ? kv('Referer', refererHref ? extLink(refererHref, pt.referer, 'break') : h('span', { class: 'break', text: pt.referer })) : null,
        pt.userAgent ? kv('User-Agent', h('span', { class: 'mono break', text: pt.userAgent })) : null));
  };

  // Build toolbar controls once.
  const btn6s = h('button', { type: 'button', class: 'tab-btn', text: '0–6 s', on: { click: () => setPreset(6000) } });
  const btn10s = h('button', { type: 'button', class: 'tab-btn', text: '0–10 s', on: { click: () => setPreset(10000) } });
  const btnFull = h('button', { type: 'button', class: 'tab-btn', text: 'Full range', on: { click: () => setPreset(fullYMax) } });
  const btnBox = h('button', { type: 'button', class: 'btn btn-quiet chart-tool-btn', title: 'Drag to select zoom box', text: 'Box zoom', on: { click: () => { view.mode = 'box'; updateToolbar(); bgRect.setAttribute('data-mode', 'box'); } } });
  const btnPan = h('button', { type: 'button', class: 'btn btn-quiet chart-tool-btn', title: 'Drag to pan chart (or hold Shift while dragging)', text: 'Pan', on: { click: () => { view.mode = 'pan'; updateToolbar(); bgRect.setAttribute('data-mode', 'pan'); } } });
  const btnZoomIn = h('button', { type: 'button', class: 'btn btn-quiet chart-tool-btn', title: 'Zoom in', 'aria-label': 'Zoom in timeline', text: '+', on: { click: () => zoomBy(0.6) } });
  const btnZoomOut = h('button', { type: 'button', class: 'btn btn-quiet chart-tool-btn', title: 'Zoom out', 'aria-label': 'Zoom out timeline', text: '−', on: { click: () => zoomBy(1.6) } });
  const btnReset = h('button', { type: 'button', class: 'btn btn-quiet chart-tool-btn', text: 'Reset', on: { click: () => setPreset(focusedYMax) } });
  const clippedBtn = h('button', { type: 'button', class: 'badge chart-clipped-badge', 'data-tone': 'warn', hidden: true, on: { click: () => setPreset(fullYMax) } });
  const toolbar = h('div', { class: 'chart-toolbar' },
    h('div', { class: 'chart-btn-group' }, btn6s, btn10s, btnFull),
    h('div', { class: 'chart-btn-group' }, btnBox, btnPan, btnZoomIn, btnZoomOut, btnReset),
    clippedBtn);

  // Build SVG structure & dot nodes once.
  const clipId = `splunk-tl-clip-${rep.id}`;
  const defs = svgEl('defs', {},
    svgEl('clipPath', { id: clipId },
      svgEl('rect', { x: pad.left, y: pad.top - 4, width: plotW, height: plotH + 8 })));
  const bgRect = svgEl('rect', { class: 'chart-plot-bg', 'data-mode': view.mode, x: pad.left, y: pad.top, width: plotW, height: plotH });
  const gridGroup = svgEl('g');
  const plotGroup = svgEl('g', { 'clip-path': `url(#${clipId})` });
  const refGroup = svgEl('g');
  plotGroup.append(refGroup);

  const dotEls = renderedPts.map((p) => {
    const el = svgEl('circle', {
      class: 'chart-dot',
      'data-zone': p.status,
      'data-bot': p.bot ? 'true' : null,
      'data-index': p.index,
      'data-selected': view.pinnedIndex === p.index ? 'true' : null,
      tabindex: '0',
      role: 'button',
      cx: 0,
      cy: 0,
      r: p.bot ? 4.5 : 4,
    });
    plotGroup.append(el);
    return { pt: p, el };
  });

  const selectBox = svgEl('rect', { class: 'chart-select-box', hidden: 'true', x: 0, y: 0, width: 0, height: 0 });
  const axisLine = svgEl('line', { class: 'chart-axis', x1: pad.left, y1: pad.top + plotH, x2: W - pad.right, y2: pad.top + plotH });
  const xStartLabel = svgEl('text', { class: 'chart-label', x: pad.left, y: pad.top + plotH + 18, 'text-anchor': 'start' });
  const xEndLabel = svgEl('text', { class: 'chart-label', x: W - pad.right, y: pad.top + plotH + 18, 'text-anchor': 'end' });
  svg.append(defs, bgRect, gridGroup, plotGroup, selectBox, axisLine, xStartLabel, xEndLabel);

  // Single delegated handlers for all dots.
  let dragState = null;
  const dotPointFromEvent = (e) => {
    const circle = e.target.closest?.('circle.chart-dot');
    if (!circle) return null;
    return ptByIndex.get(Number(circle.getAttribute('data-index'))) ?? null;
  };
  plotGroup.addEventListener('mouseover', (e) => {
    if (dragState) return;
    const pt = dotPointFromEvent(e);
    if (pt) setHoverPreview(pt);
  });
  plotGroup.addEventListener('focusin', (e) => {
    const pt = dotPointFromEvent(e);
    if (pt) setHoverPreview(pt);
  });
  plotGroup.addEventListener('click', (e) => {
    const pt = dotPointFromEvent(e);
    if (!pt) return;
    e.stopPropagation();
    view.pinnedIndex = view.pinnedIndex === pt.index ? null : pt.index;
    renderInspector(view.pinnedIndex == null ? null : pt);
  });
  plotGroup.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const pt = dotPointFromEvent(e);
    if (!pt) return;
    e.preventDefault();
    view.pinnedIndex = view.pinnedIndex === pt.index ? null : pt.index;
    renderInspector(view.pinnedIndex == null ? null : pt);
  });
  svg.addEventListener('mouseleave', () => {
    if (!dragState) setHoverPreview(null);
  });

  const clampView = () => {
    const minTSpan = Math.max(1000, (fullTMax - fullTMin) * 0.005);
    if (view.tMax - view.tMin < minTSpan) {
      const mid = (view.tMin + view.tMax) / 2;
      view.tMin = mid - minTSpan / 2;
      view.tMax = mid + minTSpan / 2;
    }
    if (view.tMin < fullTMin) {
      view.tMax = Math.min(fullTMax, view.tMax + (fullTMin - view.tMin));
      view.tMin = fullTMin;
    }
    if (view.tMax > fullTMax) {
      view.tMin = Math.max(fullTMin, view.tMin - (view.tMax - fullTMax));
      view.tMax = fullTMax;
    }
    const minYSpan = 200;
    if (view.yMax - view.yMin < minYSpan) {
      const mid = (view.yMin + view.yMax) / 2;
      view.yMin = Math.max(0, mid - minYSpan / 2);
      view.yMax = view.yMin + minYSpan;
    }
    if (view.yMin < 0) {
      view.yMax = Math.min(fullYMax, view.yMax - view.yMin);
      view.yMin = 0;
    }
    if (view.yMax > fullYMax) {
      view.yMin = Math.max(0, view.yMin - (view.yMax - fullYMax));
      view.yMax = fullYMax;
    }
  };

  const updateToolbar = () => {
    const is6 = Math.abs(view.yMax - 6000) < 50 && view.yMin === 0;
    const is10 = Math.abs(view.yMax - 10000) < 50 && view.yMin === 0;
    const isFull = Math.abs(view.yMax - fullYMax) < 50 && view.yMin === 0;
    btn6s.setAttribute('aria-selected', is6 ? 'true' : 'false');
    btn10s.setAttribute('aria-selected', is10 ? 'true' : 'false');
    btnFull.setAttribute('aria-selected', isFull ? 'true' : 'false');
    btnBox.setAttribute('aria-pressed', view.mode === 'box' ? 'true' : 'false');
    btnPan.setAttribute('aria-pressed', view.mode === 'pan' ? 'true' : 'false');
    const isZoomed = view.tMin > fullTMin + 1000 || view.tMax < fullTMax - 1000 || view.yMin > 10 || Math.abs(view.yMax - focusedYMax) > 100;
    btnReset.disabled = !isZoomed;

    let aboveCount = 0;
    for (let i = 0; i < pts.length; i += 1) {
      if (pts[i].lcp > view.yMax) aboveCount += 1;
    }
    if (aboveCount > 0) {
      clippedBtn.hidden = false;
      clippedBtn.textContent = `${aboveCount} outlier${aboveCount === 1 ? '' : 's'} > ${formatTickMs(view.yMax)} hidden · Show all`;
    } else {
      clippedBtn.hidden = true;
    }
  };

  const draw = () => {
    const tSpan = Math.max(1, view.tMax - view.tMin);
    const ySpan = Math.max(1, view.yMax - view.yMin);
    const xScale = plotW / tSpan;
    const yScale = plotH / ySpan;
    const xOf = (t) => pad.left + (t - view.tMin) * xScale;
    const yOf = (ms) => pad.top + plotH - (ms - view.yMin) * yScale;

    updateToolbar();

    // Update Y gridlines
    const gridNodes = [];
    for (const ms of niceTicks(view.yMin, view.yMax)) {
      const y = yOf(ms);
      if (y < pad.top - 2 || y > pad.top + plotH + 2) continue;
      gridNodes.push(
        svgEl('line', { class: 'chart-grid', x1: pad.left, y1: y.toFixed(1), x2: W - pad.right, y2: y.toFixed(1) }),
        svgEl('text', { class: 'chart-label', x: pad.left - 6, y: (y + 3).toFixed(1), 'text-anchor': 'end' }, formatTickMs(ms)),
      );
    }
    gridGroup.replaceChildren(...gridNodes);

    // Update CWV & P75 reference lines
    const refNodes = [];
    for (const [ms, zone, lbl] of [[splunk.LCP_GOOD_MS, 'good', '2.5s'], [splunk.LCP_POOR_MS, 'poor', '4.0s']]) {
      if (ms >= view.yMin && ms <= view.yMax) {
        const y = yOf(ms);
        refNodes.push(
          svgEl('line', { class: 'chart-ref', 'data-zone': zone, x1: pad.left, y1: y.toFixed(1), x2: W - pad.right, y2: y.toFixed(1) }),
          svgEl('text', { class: 'chart-label-ref', x: pad.left + 4, y: Math.max(pad.top + 10, y - 3).toFixed(1), 'text-anchor': 'start' }, lbl),
        );
      }
    }
    if (analysis.lcp?.p75 != null && analysis.lcp.p75 >= view.yMin && analysis.lcp.p75 <= view.yMax) {
      const p75Y = yOf(analysis.lcp.p75);
      refNodes.push(
        svgEl('line', { class: 'chart-ref', 'data-zone': 'p75', x1: pad.left, y1: p75Y.toFixed(1), x2: W - pad.right, y2: p75Y.toFixed(1) }),
        svgEl('text', { class: 'chart-label-ref', x: W - pad.right - 4, y: Math.max(pad.top + 10, p75Y - 4).toFixed(1), 'text-anchor': 'end' }, `P75 ${splunk.formatMsOrSec(analysis.lcp.p75)}`),
      );
    }
    refGroup.replaceChildren(...refNodes);

    // Fast attribute-only update of existing dot nodes.
    for (let i = 0; i < dotEls.length; i += 1) {
      const { pt, el } = dotEls[i];
      if (pt.timestamp < view.tMin || pt.timestamp > view.tMax || pt.lcp < view.yMin || pt.lcp > view.yMax) {
        el.setAttribute('hidden', 'true');
      } else {
        el.removeAttribute('hidden');
        el.setAttribute('cx', xOf(pt.timestamp).toFixed(1));
        el.setAttribute('cy', yOf(pt.lcp).toFixed(1));
      }
    }

    const sameDay = core.formatLocalDay(view.tMin) === core.formatLocalDay(view.tMax);
    xStartLabel.textContent = sameDay ? splunk.formatFriendlyTime(view.tMin) : `${core.formatLocalDay(view.tMin)} ${splunk.formatFriendlyTime(view.tMin)}`;
    xEndLabel.textContent = sameDay ? splunk.formatFriendlyTime(view.tMax, { withTz: true }) : `${core.formatLocalDay(view.tMax)} ${splunk.formatFriendlyTime(view.tMax, { withTz: true })}`;
  };

  let rafId = 0;
  const scheduleDraw = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      draw();
    });
  };

  const zoomBy = (factor, anchorTFrac = 0.5, anchorYFrac = 0.5, immediate = true) => {
    const tSpan = (view.tMax - view.tMin) * factor;
    const ySpan = (view.yMax - view.yMin) * factor;
    const anchorT = view.tMin + (view.tMax - view.tMin) * anchorTFrac;
    const anchorY = view.yMin + (view.yMax - view.yMin) * anchorYFrac;
    view.tMin = anchorT - tSpan * anchorTFrac;
    view.tMax = anchorT + tSpan * (1 - anchorTFrac);
    view.yMin = anchorY - ySpan * anchorYFrac;
    view.yMax = anchorY + ySpan * (1 - anchorYFrac);
    clampView();
    if (immediate) draw();
    else scheduleDraw();
  };

  const setPreset = (yMaxVal) => {
    view.tMin = fullTMin;
    view.tMax = fullTMax;
    view.yMin = 0;
    view.yMax = Math.min(fullYMax, Math.max(1000, yMaxVal));
    clampView();
    draw();
  };

  // Attach pointer & wheel listeners once.
  const toSvgCoords = (e) => {
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };
  bgRect.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = toSvgCoords(e);
    const isPan = view.mode === 'pan' || e.shiftKey;
    dragState = {
      mode: isPan ? 'pan' : 'box',
      startX: Math.max(pad.left, Math.min(W - pad.right, pos.x)),
      startY: Math.max(pad.top, Math.min(pad.top + plotH, pos.y)),
      origTMin: view.tMin,
      origTMax: view.tMax,
      origYMin: view.yMin,
      origYMax: view.yMax,
    };
    bgRect.setPointerCapture(e.pointerId);
  });
  bgRect.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const pos = toSvgCoords(e);
    const curX = Math.max(pad.left, Math.min(W - pad.right, pos.x));
    const curY = Math.max(pad.top, Math.min(pad.top + plotH, pos.y));
    if (dragState.mode === 'box') {
      const bx = Math.min(dragState.startX, curX);
      const by = Math.min(dragState.startY, curY);
      const bw = Math.abs(curX - dragState.startX);
      const bh = Math.abs(curY - dragState.startY);
      selectBox.removeAttribute('hidden');
      selectBox.setAttribute('x', bx.toFixed(1));
      selectBox.setAttribute('y', by.toFixed(1));
      selectBox.setAttribute('width', bw.toFixed(1));
      selectBox.setAttribute('height', bh.toFixed(1));
    } else {
      const dx = curX - dragState.startX;
      const dy = curY - dragState.startY;
      const origTSpan = dragState.origTMax - dragState.origTMin;
      const origYSpan = dragState.origYMax - dragState.origYMin;
      view.tMin = dragState.origTMin - (dx / plotW) * origTSpan;
      view.tMax = dragState.origTMax - (dx / plotW) * origTSpan;
      view.yMin = dragState.origYMin + (dy / plotH) * origYSpan;
      view.yMax = dragState.origYMax + (dy / plotH) * origYSpan;
      clampView();
      scheduleDraw();
    }
  });
  bgRect.addEventListener('pointerup', (e) => {
    if (!dragState) return;
    const pos = toSvgCoords(e);
    const curX = Math.max(pad.left, Math.min(W - pad.right, pos.x));
    const curY = Math.max(pad.top, Math.min(pad.top + plotH, pos.y));
    if (dragState.mode === 'box') {
      selectBox.setAttribute('hidden', 'true');
      if (Math.abs(curX - dragState.startX) >= 8 && Math.abs(curY - dragState.startY) >= 8) {
        const tSpan = Math.max(1, view.tMax - view.tMin);
        const ySpan = Math.max(1, view.yMax - view.yMin);
        const tFromX = (sx) => view.tMin + ((sx - pad.left) / plotW) * tSpan;
        const yFromY = (sy) => view.yMin + ((pad.top + plotH - sy) / plotH) * ySpan;
        view.tMin = tFromX(Math.min(dragState.startX, curX));
        view.tMax = tFromX(Math.max(dragState.startX, curX));
        view.yMin = Math.max(0, yFromY(Math.max(dragState.startY, curY)));
        view.yMax = Math.max(view.yMin + 200, yFromY(Math.min(dragState.startY, curY)));
        clampView();
        draw();
      }
    }
    dragState = null;
  });
  bgRect.addEventListener('dblclick', () => setPreset(focusedYMax));
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = toSvgCoords(e);
    const ax = Math.max(0, Math.min(1, (pos.x - pad.left) / plotW));
    const ay = Math.max(0, Math.min(1, (pad.top + plotH - pos.y) / plotH));
    zoomBy(e.deltaY < 0 ? 0.85 : 1.18, ax, ay, false);
  }, { passive: false });

  const legend = h('div', { class: 'chart-legend' },
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'good' }), 'Good (≤ 2.5 s)'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'ni' }), 'Needs Imp. (2.5–4.0 s)'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'poor' }), 'Poor (> 4.0 s)'),
    analysis.botCount ? h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', 'data-zone': 'bot' }), 'Synthetic / bot UA') : null,
    downsampled ? h('span', { class: 'note', text: `Plotting ${renderedPts.length} of ${pts.length} points (all slow/synthetic preserved).` }) : null,
    h('span', { class: 'note', text: 'Drag to zoom box · Shift+drag or Pan to move · Scroll to zoom · Double-click to reset.' }));

  const pinnedPt = view.pinnedIndex != null ? pts.find((p) => p.index === view.pinnedIndex) : null;
  setHoverPreview(null);
  renderInspector(pinnedPt ?? null);
  draw();
  wrap.replaceChildren(toolbar, svg, legend, hoverStrip, inspector);
  return section('LCP timeline', wrap);
}

function elementsChartSection(rows, title) {
  const shown = rows.filter((r) => r.p75 != null).slice(0, 8);
  if (!shown.length) return null;
  const W = 680;
  const rowH = 28;
  const pad = { top: 22, right: 86, bottom: 22, left: 210 };
  const H = pad.top + pad.bottom + shown.length * rowH;
  const plotW = W - pad.left - pad.right;
  const maxP75 = Math.max(4500, ...shown.map((r) => r.p75));
  const xOf = (ms) => pad.left + (ms / maxP75) * plotW;

  const svg = svgEl('svg', { class: 'splunk-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  const goodX = xOf(splunk.LCP_GOOD_MS);
  const poorX = xOf(splunk.LCP_POOR_MS);
  svg.append(
    svgEl('line', { class: 'chart-ref', 'data-zone': 'good', x1: goodX.toFixed(1), y1: pad.top - 4, x2: goodX.toFixed(1), y2: H - pad.bottom }),
    svgEl('text', { class: 'chart-label-ref', x: goodX.toFixed(1), y: pad.top - 8, 'text-anchor': 'middle' }, '2.5s'),
    svgEl('line', { class: 'chart-ref', 'data-zone': 'poor', x1: poorX.toFixed(1), y1: pad.top - 4, x2: poorX.toFixed(1), y2: H - pad.bottom }),
    svgEl('text', { class: 'chart-label-ref', x: poorX.toFixed(1), y: pad.top - 8, 'text-anchor': 'middle' }, '4.0s'),
  );

  shown.forEach((r, idx) => {
    const y = pad.top + idx * rowH;
    const bw = Math.max(3, (r.p75 / maxP75) * plotW);
    const shortLabel = r.key.length > 30 ? `${r.key.slice(0, 29)}…` : r.key;
    svg.append(
      svgEl('text', { class: 'chart-label', x: pad.left - 8, y: y + 16, 'text-anchor': 'end' }, shortLabel, svgEl('title', {}, r.key)),
      svgEl('rect', {
        class: 'chart-bar',
        'data-zone': r.status,
        x: pad.left,
        y: y + 5,
        width: bw.toFixed(1),
        height: 14,
        rx: 3,
      }, svgEl('title', {}, `${r.key}: P75 ${splunk.formatMsOrSec(r.p75)} · ${r.count} events (${r.percent.toFixed(1)}%)`)),
      svgEl('text', {
        class: 'chart-label-val',
        x: (pad.left + bw + 6).toFixed(1),
        y: y + 16,
      }, `${splunk.formatMsOrSec(r.p75)} (${r.percent.toFixed(0)}%)`),
    );
  });

  return section(title, svg);
}

function breakdownTable(rows, firstColLabel, { showElementMeta = false, limit = 30 } = {}) {
  if (!rows.length) return h('p', { class: 'note', text: 'No data in this breakdown.' });
  return h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: firstColLabel }),
      showElementMeta ? h('th', { scope: 'col', text: 'Type' }) : null,
      h('th', { scope: 'col', class: 'num', text: 'Count' }),
      h('th', { scope: 'col', class: 'num', text: 'Share %' }),
      h('th', { scope: 'col', class: 'num', text: 'P50 LCP' }),
      h('th', { scope: 'col', class: 'num', text: 'P75 LCP' }),
      h('th', { scope: 'col', class: 'num', text: 'P95 LCP' }),
      h('th', { scope: 'col', class: 'num', text: 'Good %' }),
      h('th', { scope: 'col', text: 'Status' }))),
    h('tbody', {}, rows.slice(0, limit).map((r) => h('tr', {},
      h('th', { scope: 'row', class: showElementMeta ? 'splunk-el' : null }, showElementMeta ? mono(r.key) : r.key),
      showElementMeta ? h('td', { text: `${r.extra?.type ?? '—'}${r.extra?.sectionOne === false ? ' (below fold)' : ''}` }) : null,
      h('td', { class: 'num', text: String(r.count) }),
      h('td', { class: 'num', text: `${r.percent.toFixed(1)}%` }),
      h('td', { class: 'num', text: splunk.formatMsOrSec(r.p50) }),
      h('td', { class: 'num', text: splunk.formatMsOrSec(r.p75) }),
      h('td', { class: 'num', text: splunk.formatMsOrSec(r.p95) }),
      h('td', { class: 'num', text: r.goodPct != null ? `${r.goodPct.toFixed(0)}%` : '—' }),
      h('td', {}, cwvBadge(r.status)))))));
}

function breakdownsSection(rep, analysis) {
  const tabs = [
    ['element', 'LCP Elements', () => breakdownTable(analysis.breakdowns.element, 'LCP Element', { showElementMeta: true })],
    ['device', 'Device', () => breakdownTable(analysis.breakdowns.device, 'Device')],
    ['country', 'Country', () => breakdownTable(analysis.breakdowns.country.map((r) => ({ ...r, key: r.key.toUpperCase() })), 'Country')],
    ['network', 'Network', () => breakdownTable(analysis.breakdowns.network, 'Downlink')],
    ['manifest', 'MEP Manifests', () => breakdownTable(analysis.breakdowns.manifest, 'Manifest & Selected')],
    ['os', 'OS & Auth', () => h('div', { class: 'splunk-chart-wrap' },
      breakdownTable(analysis.breakdowns.os, 'OS'),
      breakdownTable(analysis.breakdowns.loggedIn, 'Auth state'))],
    ...(analysis.breakdowns.url.length > 1 ? [['url', 'URLs', () => breakdownTable(analysis.breakdowns.url, 'URL')]] : []),
  ];
  const current = tabs.some(([k]) => k === rep.activeTab) ? rep.activeTab : 'element';
  const panel = h('div', {});
  const renderTab = (key) => {
    rep.activeTab = key;
    for (const btn of tabBar.querySelectorAll('.tab-btn')) {
      btn.setAttribute('aria-selected', btn.dataset.kind === key ? 'true' : 'false');
    }
    const found = tabs.find(([k]) => k === key) ?? tabs[0];
    panel.replaceChildren(found[2]());
  };
  const tabBar = h('div', { class: 'splunk-tabs', role: 'tablist', 'aria-label': 'Splunk breakdown dimensions' },
    tabs.map(([key, label]) => h('button', {
      type: 'button',
      class: 'tab-btn',
      role: 'tab',
      'data-kind': key,
      'aria-selected': key === current ? 'true' : 'false',
      on: { click: () => renderTab(key) },
    }, label)));
  renderTab(current);
  return section('Breakdowns', tabBar, panel);
}

function slowestEventsSection(analysis) {
  if (!analysis.slowest.length) return null;
  return section('Slowest events (tail inspection)',
    h('p', { class: 'note', text: `Top ${analysis.slowest.length} slowest loads in the filtered dataset.` }),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Time (local)' }),
        h('th', { scope: 'col', class: 'num', text: 'LCP' }),
        h('th', { scope: 'col', class: 'num', text: 'CLS' }),
        h('th', { scope: 'col', text: 'Device' }),
        h('th', { scope: 'col', text: 'Country' }),
        h('th', { scope: 'col', class: 'num', text: 'Downlink' }),
        h('th', { scope: 'col', text: 'LCP Element' }),
        h('th', { scope: 'col', text: 'Flags / Manifest' }))),
      h('tbody', {}, analysis.slowest.map((ev) => {
        const flags = [];
        if (ev.bot) flags.push(badge(ev.bot, 'warn'));
        if (ev.lcpSectionOne === false) flags.push(badge('below fold', 'neutral'));
        for (const m of ev.manifests) flags.push(badge(m.label, 'neutral'));
        return h('tr', {},
          h('td', { text: ev.timestamp != null ? core.formatDateTime(ev.timestamp) : '—' }),
          h('td', { class: 'num', text: splunk.formatMsOrSec(ev.lcp) }),
          h('td', { class: 'num', text: ev.cls != null ? ev.cls.toFixed(3) : '—' }),
          h('td', { text: ev.windowWidth && ev.windowHeight ? `${ev.device} (${ev.windowWidth}×${ev.windowHeight})` : ev.device }),
          h('td', { text: ev.country.toUpperCase() }),
          h('td', { class: 'num', text: ev.downlink != null ? `${ev.downlink} Mbps` : '—' }),
          h('td', { class: 'splunk-el' }, mono(ev.lcpEl)),
          h('td', {}, flags.length ? h('div', { class: 'badges' }, flags) : '—'));
      })))));
}

// ---------------------------------------------------------------- file upload & drag-drop

async function handleSplunkFiles(fileList) {
  const files = [...(fileList ?? [])];
  if (!files.length) return;
  let lastValid = null;
  let lastErr = null;
  for (const file of files) {
    if (!splunk.isCsvFile(file)) {
      lastErr = {
        fileName: file.name || 'Dropped file',
        message: `"${file.name || 'This file'}" is not a CSV file. Please upload or drop a Splunk CSV export (.csv).`,
      };
      continue;
    }
    try {
      const text = await file.text();
      const parsed = splunk.parseSplunkCsv(text, file.name || 'splunk-export.csv');
      const analysis = splunk.analyzeSplunk(parsed);
      const summaryTitle = analysis.kind === 'stats'
        ? (file.name || 'splunk-stats.csv')
        : analysis.options.urls.length === 1
          ? analysis.options.urls[0]
          : `${analysis.options.urls.length} pages (${analysis.options.urls[0]})`;
      const summaryWindow = analysis.kind === 'events' && analysis.timeRange
        ? splunk.formatFriendlyRange(analysis.timeRange.min, analysis.timeRange.max)
        : '';
      const rep = {
        id: `splunk-${++splunkSeq}`,
        fileName: file.name || 'splunk-export.csv',
        summaryTitle,
        summaryWindow,
        uploadedAt: Date.now(),
        parsed,
        filters: { ...splunk.EMPTY_SPLUNK_FILTERS },
        activeTab: 'element',
        summaryLcpP75: analysis.kind === 'stats' ? analysis.approxP75 : analysis.lcp?.p75 ?? null,
      };
      state.splunkReports.unshift(rep);
      lastValid = rep;
    } catch (e) {
      lastErr = {
        fileName: file.name || 'splunk-export.csv',
        message: e?.message ?? String(e),
      };
    }
  }
  if (lastValid) {
    state.splunkError = null;
    state.splunkLauncher = false;
    state.activeSplunkId = lastValid.id;
  } else if (lastErr) {
    state.splunkLauncher = false;
    state.splunkError = lastErr;
  }
  render();
  if (!wide.matches) window.scrollTo({ top: 0 });
  const heading = els.detail.querySelector('h2');
  (heading ?? els.detail).focus({ preventScroll: wide.matches });
}

// ---------------------------------------------------------------- wiring

let qTimer;
els.form.addEventListener('submit', (e) => e.preventDefault());
els.q.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(filtersChanged, 200);
});
for (const el of [els.status, els.profile, els.from, els.to]) el.addEventListener('change', filtersChanged);
els.clear.addEventListener('click', clearFilters);
window.addEventListener('popstate', () => {
  readLocation();
  render();
});
wide.addEventListener('change', render);

els.splunkUploadBtn.addEventListener('click', openSplunkLauncher);
els.splunkFile.addEventListener('change', (e) => {
  handleSplunkFiles(e.target.files);
  e.target.value = '';
});

let dragDepth = 0;
const hasDraggedFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
const hideDropOverlay = () => {
  dragDepth = 0;
  els.dropOverlay.hidden = true;
};

document.addEventListener('dragenter', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!hasDraggedFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
document.addEventListener('drop', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  hideDropOverlay();
  handleSplunkFiles(e.dataTransfer?.files);
});
window.addEventListener('blur', hideDropOverlay);

readLocation();
loadHistory();
