// Read-only perf-ab history dashboard. Reads the sanitized static JSON published next to this page
// (data/index.json and data/runs/<id>.json) and renders it with DOM APIs only: no HTML strings, no writes.
import * as core from './dashboard-core.mjs';

const { METRICS, METRIC_KEYS, STATUS, VERDICT_LABEL, CHANGE_KINDS } = core;
const FETCH_TIMEOUT_MS = 15000;
const SVGNS = 'http://www.w3.org/2000/svg';
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
  body: document.getElementById('history-body'),
  detail: document.getElementById('detail'),
  layout: document.getElementById('layout'),
};

const state = {
  history: null, // { updatedAt, runs, skipped } once loaded
  loadError: null,
  filters: { ...core.EMPTY_FILTERS },
  run: '', // explicitly selected run id (deep link or click)
  details: new Map(), // id -> { status: 'loading' | 'ready' | 'error', data, error }
};
let sectionIds = new Map();

// ---------------------------------------------------------------- DOM helpers (text only)

const ATTRS = new Set([
  'id', 'role', 'title', 'colspan', 'rowspan', 'scope', 'type', 'datetime', 'tabindex', 'hidden', 'value', 'lang',
  'aria-label', 'aria-live', 'aria-busy', 'aria-current', 'aria-describedby', 'aria-labelledby', 'aria-hidden',
  'data-label', 'data-tone', 'data-run', 'data-state', 'data-verdict', 'data-dir',
]);

function h(tag, opts, ...children) {
  const el = document.createElement(tag);
  if (opts) setOpts(el, opts);
  add(el, children);
  return el;
}

function setOpts(el, opts) {
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'text') el.textContent = String(v);
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

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
  }
  add(el, children);
  return el;
}

// Links only to vetted https URLs; anything else is shown as plain text.
function extLink(href, text, cls) {
  const safe = core.safeExternalUrl(href);
  if (!safe) return h('span', { class: ['unlinked', cls] }, text);
  const a = h('a', { class: cls }, text);
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
  state.run = id;
  window.history.pushState(null, '', core.serializeState({ ...state.filters, run: id }) || window.location.pathname);
  render();
  if (!wide.matches) window.scrollTo({ top: 0 });
  const heading = els.detail.querySelector('h2');
  (heading ?? els.detail).focus({ preventScroll: wide.matches });
}

function backToList() {
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
  els.layout.dataset.view = state.run ? 'detail' : 'list';
  renderMeta();
  renderHistory();
  renderDetail();
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
  if (!all.length) {
    nodes.push(h('div', { class: 'empty' },
      h('p', { class: 'empty-title', text: 'No runs published yet' }),
      h('p', { text: 'Runs appear here after the perf-ab workflow finishes on GitHub Actions and the publisher adds its sanitized results to this site.' }),
      extLink(core.WORKFLOW_URL, 'Open the perf-ab workflow')));
  } else if (!runs.length) {
    nodes.push(h('div', { class: 'empty' },
      h('p', { class: 'empty-title', text: 'No runs match these filters' }),
      h('p', { text: `${all.length} published run${all.length === 1 ? ' is' : 's are'} hidden by the current filters.` }),
      h('button', { type: 'button', class: 'btn', text: 'Clear filters', on: { click: clearFilters } })));
  } else {
    nodes.push(historyTable(runs));
  }
  els.body.replaceChildren(...nodes);
}

function runFlags(r) {
  const flags = [];
  if (r.smoke) flags.push(badge('1-pair smoke', 'warn', 'Single pair: shows the pipeline works, not whether performance changed'));
  if (!r.us) flags.push(badge('Not US-verified', 'bad', 'Egress was not verified as US; not comparable with US runs'));
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
      historyDeltaCell(r, 'performance'));
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
      h('th', { scope: 'col', class: 'num', text: 'Δ Perf' }))),
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
  const id = selectedId();
  document.title = id ? `Run ${id} · perf-ab history` : 'perf-ab history · adobecom/perf-tools';
  d.removeAttribute('aria-busy');
  if (state.loadError) {
    d.replaceChildren(h('div', { class: 'detail-empty' }, h('p', { text: 'Run details appear once the history loads.' })));
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
      comparableSection(run),
      provenanceSection(run, null)]);
  } else {
    add(inner, [
      section('Medians', mediansTable(run, run.pairs)),
      plotsSection(run),
      pairsSection(run),
      changesSection(run),
      run.rejectedAttempts.length ? rejectedSection(run) : null,
      comparableSection(run),
      provenanceSection(run, run),
      artifactSection(run)]);
  }
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
    run.us ? badge('US verified', 'ok') : badge(`Not US-verified${run.egress.country ? ` (${run.egress.country})` : ''}`, 'bad'),
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
    out.push(callout('warn', 'Smoke run: one pair, no performance conclusion',
      h('p', { text: 'A single before/after pair cannot separate a real change from run-to-run noise, and one outlier sample can dominate it. Every direction reading below is inconclusive. Use this run to confirm the pipeline, then run the full pair count before judging the change.' })));
  } else if (s.pairs != null && s.pairs < core.MIN_PAIRS && run.medians.delta) {
    out.push(callout('warn', `Only ${s.pairs} complete pair${s.pairs === 1 ? '' : 's'}`,
      h('p', { text: `A direction is only named with at least ${core.MIN_PAIRS} complete pairs, so every metric is inconclusive.` })));
  }
  if (run.status === 'failed') {
    out.push(callout('bad', `Run failed${run.errorKindLabel ? `: ${run.errorKindLabel.toLowerCase()}` : ''}`,
      run.errorCodeLabel ? h('p', {}, h('strong', { text: run.errorCodeLabel }), run.errorCode !== run.errorCodeLabel ? [' ', mono(run.errorCode)] : null) : null,
      run.error ? h('p', { class: 'error-text', text: run.error }) : h('p', { text: 'The published data has no error message.' }),
      h('p', { text: 'Numbers from a failed run are not used in comparisons.' })));
  } else if (run.status === 'partial') {
    const incomplete = ready ? run.incompletePairs : null;
    out.push(callout('warn', 'Partial run',
      h('p', { text: `${s.pairs ?? 0} of ${s.requested ?? '?'} requested pairs completed${incomplete ? `; ${incomplete} pair${incomplete === 1 ? ' is' : 's are'} incomplete` : ''}. Medians and direction readings use complete pairs only.` })));
  } else if (run.status === 'unknown') {
    out.push(callout('warn', 'Unrecognized run status', h('p', { text: `The history reports status ${JSON.stringify(run.rawStatus)}; treat the numbers with care.` })));
  }
  if (!run.us) {
    const parts = [`egress country ${run.egress.country ?? 'unknown'}`, run.egress.verified ? 'verified' : 'not verified'];
    if (run.egress.documentGeo) parts.push(`document geo ${run.egress.documentGeo}`);
    out.push(callout('bad', 'Not measured from a verified US egress',
      h('p', { text: `${parts.join(', ')}. Adobe pages vary by region, so these numbers are not comparable with US runs.` })));
  }
  if (s.rejected) {
    out.push(callout('neutral', `${s.rejected} attempt${s.rejected === 1 ? ' was' : 's were'} rejected and retried`,
      h('p', { text: ready ? 'Rejected attempts are excluded from all numbers; see Rejected attempts below.' : 'Rejected attempts are excluded from all numbers.' })));
  }
  if (run.single) {
    out.push(callout('neutral', 'Single-URL run', h('p', { text: 'There is no before variant, so there are no deltas or direction readings.' })));
  }
  const cpu = core.cpuVariability(run.pairs ?? []);
  if (cpu?.varied || run.warnings?.some((w) => w.kind === 'environment-variability')) {
    const benchmarkRange = [cpu?.before, cpu?.after].filter(Boolean)
      .map((range) => `${Math.round(range.min)}–${Math.round(range.max)}`).join(' / ');
    out.push(callout('warn', 'Runner environment varied',
      h('p', { text: `${benchmarkRange ? `Lighthouse CPU benchmark scores varied across loads (${benchmarkRange}); ` : ''}runner variability can affect Lighthouse deltas. Treat them as indicative, not a confirmed gain.` })));
  }
  for (const warning of run.warnings?.filter((w) => w.kind === 'production-source-drift' || w.kind === 'production-source-unverified') ?? []) {
    const prUrl = warning.repo && warning.number ? core.safeExternalUrl(`https://github.com/${warning.repo}/pull/${warning.number}`) : null;
    out.push(callout(warning.kind === 'production-source-drift' ? 'warn' : 'neutral',
      warning.kind === 'production-source-drift' ? 'Production source differs from the PR merge base' : 'Production source drift was not checked',
      h('div', {},
        h('p', {}, warning.kind === 'production-source-drift'
          ? `${warning.path} differs from the pinned merge-base source; the after variant still uses the exact pinned PR head `
          : `No baseline response for ${warning.path} was observed, so its merge-base drift could not be checked `,
        prUrl ? extLink(prUrl, `${warning.repo}#${warning.number}`) : `${warning.repo}#${warning.number}`),
        warning.kind === 'production-source-drift'
          ? h('p', { class: 'note', text: `Merge-base SHA-256: ${warning.expectedMergeBaseSha256 ?? 'absent'} · production SHA-256: ${warning.productionSha256 ?? 'unavailable'}` })
          : null)));
  }
  return out;
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
  const rows = METRIC_KEYS.map((key) => {
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
  const note = complete == null
    ? 'Sample counts were not published for this run.'
    : `Medians over ${complete} complete pair${complete === 1 ? '' : 's'}. Δ is the median of per-pair differences (after − before), not the difference of the medians; Δ % is relative to the before median.`;
  return h('div', {},
    h('div', { class: 'table-scroll' }, h('table', { class: 'data medians' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Metric' }),
        h('th', { scope: 'col', class: 'num', text: 'Before' }),
        h('th', { scope: 'col', class: 'num', text: 'After' }),
        h('th', { scope: 'col', class: 'num', text: 'Median paired Δ' }),
        h('th', { scope: 'col', class: 'num', text: 'Δ %' }),
        h('th', { scope: 'col', text: 'Direction', title: 'Descriptive heuristic, not a statistical significance test' }))),
      h('tbody', {}, rows))),
    h('p', { class: 'note', text: note }),
    h('p', { class: 'note', text: `Direction is a descriptive heuristic, not a statistical significance test, and carries no confidence level. A metric reads Consistently better or worse only with at least ${core.MIN_PAIRS} complete pairs, a median Δ at or beyond its noise threshold and at least ${Math.round(core.AGREEMENT * 100)}% of pair differences on the median's side; a smaller median Δ reads Within noise and everything else Inconclusive. Noise thresholds: ${noiseThresholds()}. Lower is better except Performance.` }));
}

// ---------------------------------------------------------------- paired-sample plots

function plotsSection(run) {
  const usable = run.pairs.filter((p) => p.before || p.after);
  if (!usable.length) return section('Paired samples', h('p', { class: 'note', text: 'No per-pair samples were published for this run.' }));
  const legend = h('div', { class: 'legend', 'aria-hidden': 'true' },
    legendItem('before'), legendItem('after'), legendItem('better'), legendItem('worse'), legendItem('median'));
  return section('Paired samples',
    h('p', { class: 'note', text: `Each row is one pair (before and after measured back to back). ${usable.length} pair${usable.length === 1 ? '' : 's'} published; axes span the data and do not start at zero. A connecting line is coloured only when that pair moved beyond the metric's noise threshold.` }),
    legend,
    h('div', { class: 'plots' }, METRIC_KEYS.map((k) => pairPlot(k, run, usable))));
}

function noiseThresholds() {
  return METRIC_KEYS.map((k) => `${METRICS[k].short} ${core.formatNoise(k)}`).join(', ');
}

function legendItem(kind) {
  const glyph = svg('svg', { viewBox: '0 0 24 12', width: 24, height: 12, class: 'legend-glyph' });
  const labels = { before: 'Before', after: 'After', better: 'Pair better beyond noise', worse: 'Pair worse beyond noise', median: 'Median (before, after)' };
  if (kind === 'before') glyph.append(svg('circle', { cx: 12, cy: 6, r: 4, class: 'dot-before' }));
  if (kind === 'after') glyph.append(svg('circle', { cx: 12, cy: 6, r: 4, class: 'dot-after' }));
  if (kind === 'better' || kind === 'worse') glyph.append(svg('line', { x1: 2, y1: 6, x2: 22, y2: 6, class: `link dir-${kind}` }));
  if (kind === 'median') glyph.append(svg('line', { x1: 12, y1: 0, x2: 12, y2: 12, class: 'med-after' }));
  return h('span', { class: 'legend-item' }, glyph, labels[kind]);
}

function pairPlot(key, run, pairs) {
  const m = METRICS[key];
  const rows = pairs.filter((p) => p.before?.[key] != null || p.after?.[key] != null);
  const medB = run.medians.before?.[key] ?? null;
  const medA = run.medians.after?.[key] ?? null;
  const values = rows.flatMap((p) => [p.before?.[key], p.after?.[key]]);
  const domain = core.plotDomain(key, [...values, medB, medA]);
  const unit = core.columnUnit(key);
  const caption = h('figcaption', {}, h('span', { class: 'plot-title', text: m.label }), unit ? h('span', { class: 'plot-unit', text: unit }) : null);
  if (!domain) return h('figure', { class: 'plot' }, caption, h('p', { class: 'note', text: 'No samples for this metric.' }));
  const [lo, hi] = domain;
  const W = 320;
  const padL = 30;
  const padR = 12;
  const rowH = rows.length > 12 ? 11 : 18;
  const top = 8;
  const plotH = rows.length * rowH;
  const H = top + plotH + 24;
  const x = (v) => padL + ((v - lo) / (hi - lo || 1)) * (W - padL - padR);
  const { ticks, step } = core.niceTicks(lo, hi, 4);
  const label = `${m.label}: ${rows.length} pair${rows.length === 1 ? '' : 's'}; before median ${core.formatMetric(key, medB)}, after median ${core.formatMetric(key, medA)}.`;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'plot-svg', role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMin meet' });
  const grid = svg('g', { class: 'grid' });
  for (const t of ticks) {
    grid.append(svg('line', { x1: x(t), x2: x(t), y1: top - 4, y2: top + plotH, class: 'gridline' }),
      svg('text', { x: x(t), y: top + plotH + 16, class: 'tick', 'text-anchor': 'middle', text: core.formatTick(key, t, step) }));
  }
  root.append(grid);
  if (medB != null) root.append(svg('line', { x1: x(medB), x2: x(medB), y1: top - 4, y2: top + plotH, class: 'med-before' }));
  if (medA != null) root.append(svg('line', { x1: x(medA), x2: x(medA), y1: top - 4, y2: top + plotH, class: 'med-after' }));
  rows.forEach((p, i) => {
    const y = top + i * rowH + rowH / 2;
    const b = p.before?.[key];
    const a = p.after?.[key];
    const d = p.delta?.[key];
    const g = svg('g', { class: 'pair' },
      svg('title', { text: `Pair ${p.index}: before ${core.formatMetric(key, b)}, after ${core.formatMetric(key, a)}, Δ ${core.formatDelta(key, d)}` }));
    if (rowH >= 14) g.append(svg('text', { x: padL - 8, y: y + 3.5, class: 'row-label', 'text-anchor': 'end', text: String(p.index) }));
    if (b != null && a != null) g.append(svg('line', { x1: x(b), x2: x(a), y1: y, y2: y, class: `link dir-${core.pairDirection(key, d ?? a - b)}` }));
    const r = rowH >= 14 ? 4 : 3;
    if (b != null) g.append(svg('circle', { cx: x(b), cy: y, r, class: 'dot-before' }));
    if (a != null) g.append(svg('circle', { cx: x(a), cy: y, r, class: 'dot-after' }));
    root.append(g);
  });
  return h('figure', { class: 'plot' }, caption, root);
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
    job.egressCountry,
  ].filter(Boolean).join(' · ') || '—';
}

function pairsSection(run) {
  if (!run.pairs.length) return null;
  const single = run.single;
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
      for (const key of METRIC_KEYS) {
        const v = values?.[key];
        const text = name === 'Δ' ? core.formatDelta(key, v, false) : values ? core.formatMetric(key, v, false) : 'missing';
        tr.append(h('td', { class: ['num', !values && 'missing'], text }));
      }
      if (vi === 0) tr.append(h('td', { rowspan: variants.length, class: 'job', text: jobText(p.job) }));
      tbody.append(tr);
    });
  }
  return section('Per-pair numbers',
    h('div', { class: 'table-scroll' }, h('table', { class: 'data pairs' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Pair' }),
        h('th', { scope: 'col', text: 'Variant' }),
        METRIC_KEYS.map((k) => h('th', { scope: 'col', class: 'num' }, METRICS[k].short, core.columnUnit(k) ? h('span', { class: 'th-unit', text: core.columnUnit(k) }) : null)),
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
  const nothing = !c.kinds.length && !c.hints && !c.priorityPaths.length && !c.patchPaths.length && !c.sourcePaths.length && !c.prSources?.length;
  if (nothing) return section('Changes', h('p', { class: 'note', text: 'The published data records no change inputs for this run.' }));
  const hints = c.hints && h('div', { class: 'kv-block' }, h('h4', { text: 'Resource hints' }),
    h('dl', { class: 'stats' },
      [['Requested', c.hints.requested], ['Used', c.hints.used], ['Contextual', c.hints.contextual], ['Dropped', c.hints.dropped]]
        .map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { class: 'num', text: v == null ? '—' : String(v) })))));
  const priorities = c.priorityPaths.length ? h('div', { class: 'kv-block' }, h('h4', { text: 'Fetch priorities' }),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Path' }), h('th', { scope: 'col', text: 'Priority' }))),
      h('tbody', {}, c.priorityPaths.map((p) => h('tr', {}, h('td', {}, mono(p.path)), h('td', { text: p.priority ?? '—' }))))))) : null;
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
    h('div', { class: 'kv-grid' }, hints, priorities, pathList('Patched paths', c.patchPaths), pathList('Source override paths', c.sourcePaths), prSources),
    h('p', { class: 'note', text: 'Only mapped file names, change status, commit IDs and hashes are published; source code, snippets, headers and credentials stay in the workflow artifact.' }));
}

function rejectedSection(run) {
  return section('Rejected attempts',
    h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Variant' }), h('th', { scope: 'col', class: 'num', text: 'Run' }),
        h('th', { scope: 'col', class: 'num', text: 'Attempt' }), h('th', { scope: 'col', text: 'Reason' }))),
      h('tbody', {}, run.rejectedAttempts.map((r) => h('tr', {},
        h('td', { text: r.variant ?? '—' }),
        h('td', { class: 'num', text: r.run == null ? '—' : String(r.run) }),
        h('td', { class: 'num', text: r.attempt == null ? '—' : String(r.attempt) }),
        h('td', { class: 'error-text', text: r.reason ?? '—' })))))));
}

function comparableSection(run) {
  const { comparable, excluded } = core.comparableRuns(state.history.runs, run);
  const selfOk = run.us && run.status !== 'failed' && run.status !== 'unknown' && run.profileKey;
  const intro = `Same page and profile key${run.profileKey ? ` (${run.profileKey})` : ''}, verified US egress, not failed. Runs with another profile, region or Lighthouse version are never mixed in.`;
  const notes = [h('p', { class: 'note', text: intro })];
  if (!selfOk) notes.push(h('p', { class: 'note', text: 'This run itself does not meet these conditions, so it is listed for reference only.' }));
  if (excluded) notes.push(h('p', { class: 'note', text: `${excluded} other run${excluded === 1 ? '' : 's'} of this page excluded.` }));
  if (!comparable.length) return section('Comparable runs', notes, h('p', { text: 'No other comparable runs of this page are published yet.' }));
  const rows = [run, ...comparable].sort((a, b) => b.createdAt - a.createdAt).map((r) => {
    const self = r.id === run.id;
    const link = self ? h('span', { text: 'This run' }) : h('a', { 'data-run': r.id }, mono(r.id));
    if (!self) {
      link.href = runHref(r.id);
      link.addEventListener('click', (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        selectRun(r.id);
      });
    }
    return h('tr', { class: self ? 'is-self' : null },
      h('td', {}, timeEl(r.createdAt, core.formatLocalDay(r.createdAt))),
      h('td', {}, link),
      h('td', {}, statusBadge(r)),
      h('td', { class: ['num', (r.samples.pairs ?? 0) < core.MIN_PAIRS && 'weak'], text: pairsText(r) }),
      h('td', { class: 'num', text: core.formatMetric('LCP', r.medians.after?.LCP) }),
      h('td', { class: 'num', text: core.formatDelta('LCP', r.medians.delta?.LCP) }),
      h('td', { class: 'num', text: core.formatMetric('performance', r.medians.after?.performance) }),
      h('td', { class: 'num', text: core.formatDelta('performance', r.medians.delta?.performance) }));
  });
  return section('Comparable runs', notes,
    h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'Date' }), h('th', { scope: 'col', text: 'Run' }), h('th', { scope: 'col', text: 'Status' }),
        h('th', { scope: 'col', class: 'num', text: 'Pairs' }),
        h('th', { scope: 'col', class: 'num', text: 'LCP after' }), h('th', { scope: 'col', class: 'num', text: 'Δ LCP' }),
        h('th', { scope: 'col', class: 'num', text: 'Perf after' }), h('th', { scope: 'col', class: 'num', text: 'Δ Perf' }))),
      h('tbody', {}, rows))));
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
  const throttle = [p.throttlingMethod, p.rttMs != null ? `${p.rttMs} ms RTT` : null, core.formatThroughput(p.throughputKbps),
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
      kv('Egress', `${run.egress.country ?? 'unknown'} · ${run.egress.verified ? 'verified' : 'not verified'}${run.egress.documentGeo ? ` · document geo ${run.egress.documentGeo}` : ''}`),
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
      h('p', {}, name, a.expiresAt != null ? [' expired on ', timeEl(a.expiresAt, core.formatDay(a.expiresAt)), '.'] : ' has expired.'),
      h('p', { text: 'The raw Lighthouse reports are gone; the published numbers on this page remain.' }));
  } else if (st === 'unlinked') {
    body = h('p', {}, name, ' has no published link.', a.expiresAt != null ? [' Expires ', timeEl(a.expiresAt, core.formatDay(a.expiresAt)), '.'] : null);
  } else {
    body = h('p', {}, extLink(a.url, a.name ? `Download ${a.name}` : 'Download artifact'),
      a.expiresAt != null ? [' · expires ', timeEl(a.expiresAt, core.formatDay(a.expiresAt)), ` (${core.formatRelativeDays(a.expiresAt)})`] : null,
      h('span', { class: 'sub sub-line', text: 'GitHub sign-in required.' }));
  }
  return section('Reports and artifact', body,
    h('p', { class: 'note', text: 'Raw Lighthouse reports are never published on this site. They live only in the workflow artifact, which GitHub keeps for a limited time.' }));
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

readLocation();
loadHistory();
