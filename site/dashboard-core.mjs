// Pure, DOM-free logic for the read-only perf-ab history dashboard: schema checks, normalization, filters,
// formatting, verdicts and URL safety. Shared by site/app.js and the Node tests.

export const HISTORY_SCHEMA = 'perf-ab/history-v1';
export const RUN_SCHEMA = 'perf-ab/run-v1';
export const REPO_URL = 'https://github.com/adobecom/perf-tools';
export const WORKFLOW_URL = `${REPO_URL}/actions/workflows/perf-ab.yml`;

export const METRIC_KEYS = ['performance', 'FCP', 'LCP', 'SI', 'TBT', 'CLS'];
// INP only exists for runs with an interactions scenario (it needs real interactions); see metricKeysFor.
export const INP_KEY = 'INP';
export const ALL_METRIC_KEYS = [...METRIC_KEYS, INP_KEY];
// Raw units from the contract: performance is a 0-100 score, CLS is unitless, timings are milliseconds.
// `step` is the display resolution in raw units; smaller differences render as no change.
export const METRICS = {
  performance: { key: 'performance', short: 'Perf', label: 'Performance', unit: 'score', better: 'higher', step: 1 },
  FCP: { key: 'FCP', short: 'FCP', label: 'First Contentful Paint', unit: 's', better: 'lower', step: 10 },
  LCP: { key: 'LCP', short: 'LCP', label: 'Largest Contentful Paint', unit: 's', better: 'lower', step: 10 },
  SI: { key: 'SI', short: 'SI', label: 'Speed Index', unit: 's', better: 'lower', step: 10 },
  TBT: { key: 'TBT', short: 'TBT', label: 'Total Blocking Time', unit: 'ms', better: 'lower', step: 1 },
  CLS: { key: 'CLS', short: 'CLS', label: 'Cumulative Layout Shift', unit: '', better: 'lower', step: 0.001 },
  INP: { key: 'INP', short: 'INP', label: 'Interaction to Next Paint', unit: 'ms', better: 'lower', step: 1 },
};

export const STATUS = {
  ok: { label: 'Complete', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  unknown: { label: 'Unknown status', tone: 'neutral' },
};
export const STATUS_FILTERS = ['ok', 'partial', 'failed'];

export const ERROR_KINDS = {
  fatal: 'Fatal error',
  'rejected-after-retries': 'Rejected after retries',
  infrastructure: 'Infrastructure error',
};

// Publisher-owned enum; unknown codes are shown verbatim (they pass a strict [a-z0-9-] check).
export const ERROR_CODES = {
  'non-us-egress': 'Egress was not verified as US',
  'profile-mismatch': 'Lighthouse profile did not match the expected profile',
  'no-artifact': 'No results artifact',
  'workflow-failed': 'Workflow failed',
  'workflow-cancelled': 'Workflow was cancelled',
  'pairs-incomplete': 'Too few complete pairs',
  'lighthouse-failed': 'Lighthouse failed',
  'artifact-invalid': 'Results artifact was invalid',
};
const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const CHANGE_KINDS = {
  query: 'Query parameters',
  headInject: 'Injected head snippet',
  linkHeader: 'Link header edits',
  patches: 'Source patches',
  sources: 'Pinned PR source files',
};

// Direction heuristic (shown in the UI). It is descriptive, not a statistical test: a direction is only named
// with at least MIN_PAIRS complete pairs, a median paired delta of at least the metric's NOISE threshold, and
// AGREEMENT of the paired deltas on the median's side. Anything else is neutral.
export const MIN_PAIRS = 3;
export const AGREEMENT = 0.8;

// Practical noise thresholds in raw units, kept separate from the display resolution (`step`). They follow
// the perf-ab guidance that a few score points or FCP/LCP differences under ~100 ms are noise. INP is an assumption:
// lab INP under 4x CPU throttling moves by a few tens of ms between identical cold loads, so 40 ms is the floor.
export const NOISE = { performance: 3, FCP: 100, LCP: 100, SI: 100, TBT: 50, CLS: 0.01, INP: 40 };

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const RUN_ID = /^[0-9]{1,20}-[0-9]{1,6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function time(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- URL safety

// External links: https only, no credentials or port, and only this repository on github.com, an adobe.com
// subdomain or an adobecom aem.live host (the benchmark target policy). Anything else is shown as plain text.
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'github.com') {
    if (u.pathname === '/adobecom/perf-tools' || u.pathname.startsWith('/adobecom/perf-tools/')) return u.href;
    return /^\/adobecom\/(?:milo|mas)\/pull\/[1-9][0-9]*$/.test(u.pathname) ? u.href : null;
  }
  if (host === 'adobe.com' || host.endsWith('.adobe.com')) return u.href;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*--adobecom\.aem\.live$/.test(host)) return u.href;
  return null;
}

// Same-origin JSON detail documents only: data/runs/<runId>-<attempt>.json, relative to the page.
export function safeDetailPath(value) {
  return typeof value === 'string' && /^data\/runs\/[0-9]{1,20}-[0-9]{1,6}\.json$/.test(value) ? value : null;
}

export function safeSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null;
}

export const commitUrl = (sha) => (safeSha(sha) ? `${REPO_URL}/commit/${safeSha(sha)}` : null);

// Repository-relative file paths (configs, patches) as published; never absolute, never traversing.
export function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  if (!/^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(value)) return null;
  return value.split('/').some((seg) => seg === '.' || seg === '..') ? null : value;
}

export function blobUrl(sha, path) {
  const s = safeSha(sha);
  const p = safeRepoPath(path);
  return s && p ? `${REPO_URL}/blob/${s}/${p.split('/').map(encodeURIComponent).join('/')}` : null;
}

export function splitRunId(id) {
  const [runId, attempt] = String(id).split('-');
  return { runId, attempt: Number(attempt) };
}

export function displayUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const u = new URL(value);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------- normalization

function metricMap(v) {
  if (!isObject(v)) return null;
  const out = {};
  let any = false;
  for (const k of METRIC_KEYS) {
    out[k] = num(v[k]);
    if (out[k] != null) any = true;
  }
  if (num(v.INP) != null) {
    out.INP = v.INP;
    any = true;
  }
  return any ? out : null;
}

const SHA256 = /^[a-f0-9]{64}$/i;

// Interaction scenario steps as published: an action and an optional label, nothing else.
function normalizeSteps(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).filter((s) => isObject(s) && str(s.action, 20)).map((s) => ({ action: str(s.action, 20), label: str(s.label, 80) }));
}

function normalizeProfile(p) {
  if (!isObject(p)) return null;
  return {
    name: str(p.name, 200),
    lighthouseVersion: str(p.lighthouseVersion, 40),
    chromeVersion: str(p.chromeVersion, 80),
    formFactor: str(p.formFactor, 40),
    throttlingMethod: str(p.throttlingMethod, 40),
    rttMs: num(p.rttMs),
    throughputKbps: num(p.throughputKbps),
    requestLatencyMs: num(p.requestLatencyMs),
    downloadThroughputKbps: num(p.downloadThroughputKbps),
    uploadThroughputKbps: num(p.uploadThroughputKbps),
    maxWaitForLoad: num(p.maxWaitForLoad),
    cpuSlowdownMultiplier: num(p.cpuSlowdownMultiplier),
    width: num(p.width),
    height: num(p.height),
    deviceScaleFactor: num(p.deviceScaleFactor),
  };
}

// US verification: the egress probe confirmed country US, and the aggregated document geo the page itself
// reported is US or was not reported ('unavailable'). Local measurements are never US-verified for dashboard use.
function isUs(country, verified, documentGeo) {
  if (!verified || country !== 'US') return false;
  return documentGeo == null || /^unavailable$/i.test(documentGeo) || /^US(\b|-|$)/i.test(documentGeo);
}

export function normalizeSummary(raw) {
  if (!isObject(raw)) throw new SchemaError('run entry is not an object');
  const id = typeof raw.id === 'string' && RUN_ID.test(raw.id) ? raw.id : null;
  if (!id) throw new SchemaError(`run id ${JSON.stringify(raw.id ?? null).slice(0, 60)} is not "<runId>-<attempt>"`);
  const createdAt = time(raw.createdAt);
  if (createdAt == null) throw new SchemaError(`run ${id}: createdAt is not an ISO date`);
  const status = raw.status === 'ok' || raw.status === 'partial' || raw.status === 'failed' ? raw.status : 'unknown';
  const egress = isObject(raw.egress) ? raw.egress : {};
  const country = str(egress.country, 8)?.toUpperCase() ?? null;
  const where = raw.where === 'local' || egress.where === 'local' ? 'local' : 'actions';
  const documentGeo = str(egress.documentGeo, 40);
  const s = isObject(raw.samples) ? raw.samples : {};
  const samples = { requested: int(s.requested), before: int(s.before), after: int(s.after), pairs: int(s.pairs), rejected: int(s.rejected) };
  const m = isObject(raw.medians) ? raw.medians : {};
  const github = isObject(raw.github) ? raw.github : {};
  const url = str(raw.url, 2048);
  const errorKind = str(raw.errorKind, 60);
  const errorCode = typeof raw.errorCode === 'string' && ERROR_CODE.test(raw.errorCode) ? raw.errorCode : null;
  const medians = { before: metricMap(m.before), after: metricMap(m.after), delta: metricMap(m.delta) };
  return {
    id,
    name: str(raw.name, 120),
    config: str(raw.config, 300),
    createdAt,
    finishedAt: time(raw.finishedAt),
    status,
    rawStatus: str(raw.status, 40),
    errorKind,
    errorKindLabel: errorKind ? ERROR_KINDS[errorKind] ?? errorKind : null,
    errorCode,
    errorCodeLabel: errorCode ? ERROR_CODES[errorCode] ?? errorCode : null,
    error: str(raw.error, 300),
    conclusion: str(raw.conclusion, 40),
    url,
    pageHref: safeExternalUrl(url),
    profileKey: str(raw.profileKey, 200),
    profile: normalizeProfile(raw.profile),
    interactionsKey: typeof raw.interactionsKey === 'string' && SHA256.test(raw.interactionsKey) ? raw.interactionsKey.toLowerCase() : null,
    where,
    egress: { country, verified: egress.verified === true, documentGeo },
    us: where !== 'local' && isUs(country, egress.verified === true, documentGeo),
    samples,
    smoke: samples.requested === 1,
    medians,
    single: !medians.before && !!medians.after,
    github: { runUrl: safeExternalUrl(github.runUrl), sha: safeSha(github.sha) },
    detailPath: safeDetailPath(raw.detailPath),
  };
}

export function parseHistory(json) {
  if (!isObject(json)) throw new SchemaError('data/index.json is not a JSON object');
  if (json.schema !== HISTORY_SCHEMA) {
    throw new SchemaError(`data/index.json declares schema ${JSON.stringify(json.schema ?? null).slice(0, 60)}; this dashboard reads ${HISTORY_SCHEMA}`);
  }
  if (!Array.isArray(json.runs)) throw new SchemaError('data/index.json has no runs array');
  const runs = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of json.runs) {
    try {
      const run = normalizeSummary(raw);
      if (seen.has(run.id)) throw new SchemaError(`duplicate run id ${run.id}`);
      seen.add(run.id);
      runs.push(run);
    } catch (e) {
      if (!(e instanceof SchemaError)) throw e;
      skipped.push(e.message);
    }
  }
  runs.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return { updatedAt: time(json.updatedAt), runs, skipped };
}

function normalizePair(raw, i) {
  if (!isObject(raw)) return null;
  const before = metricMap(raw.before);
  const after = metricMap(raw.after);
  let delta = metricMap(raw.delta);
  if (!delta && before && after) {
    delta = Object.fromEntries(ALL_METRIC_KEYS.filter((k) => k !== INP_KEY || (before[k] != null && after[k] != null))
      .map((k) => [k, before[k] != null && after[k] != null ? after[k] - before[k] : null]));
  }
  const job = isObject(raw.job) ? raw.job : null;
  const bench = [raw.benchmark, job?.benchmark, job?.benchmarkIndexes].find(isObject);
  const benchmark = bench && { before: positive(bench.before), after: positive(bench.after) };
  return {
    index: int(raw.index) ?? i + 1,
    before,
    after,
    delta: before && after ? delta : null,
    complete: !!(before && after),
    job: job && {
      runAttempt: int(job.runAttempt),
      order: Array.isArray(job.order) && job.order.every((n) => typeof n === 'string') && ['before,after', 'after,before', 'after'].includes(job.order.join(',')) ? [...job.order] : null,
      orderPolicy: ['counterbalanced', 'baseline-first-contextual-hints', 'single-variant'].includes(job.orderPolicy) ? job.orderPolicy : null,
      chromeVersion: str(job.chromeVersion, 80),
      egressCountry: str(job.egressCountry, 8)?.toUpperCase() ?? null,
      benchmarkIndex: num(job.benchmarkIndex),
      benchmarkIndexes: isObject(job.benchmarkIndexes) ? {
        before: positive(job.benchmarkIndexes.before),
        after: positive(job.benchmarkIndexes.after),
      } : null,
    },
    benchmark: benchmark && (benchmark.before != null || benchmark.after != null)
      ? benchmark
      : positive(job?.benchmarkIndex) != null ? { before: positive(job.benchmarkIndex), after: null } : null,
  };
}

const strList = (v, max = 50) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, max) : []);

export function parseRun(json, expectedId) {
  if (!isObject(json)) throw new SchemaError('run detail is not a JSON object');
  if (json.schema !== RUN_SCHEMA) {
    throw new SchemaError(`run detail declares schema ${JSON.stringify(json.schema ?? null).slice(0, 60)}; this dashboard reads ${RUN_SCHEMA}`);
  }
  const summary = normalizeSummary(json);
  if (expectedId && summary.id !== expectedId) throw new SchemaError(`run detail is for ${summary.id}, expected ${expectedId}`);
  const pairs = Array.isArray(json.pairs) ? json.pairs.slice(0, 500).map(normalizePair).filter(Boolean) : [];
  const c = isObject(json.changes) ? json.changes : {};
  const h = isObject(c.hints) ? c.hints : null;
  const a = isObject(json.artifact) ? json.artifact : null;
  const warnings = Array.isArray(json.warnings) ? json.warnings.filter((w) => ['environment-variability', 'production-source-drift', 'production-source-unverified'].includes(w?.kind)).slice(0, 30).map((w) => {
    if (w.kind !== 'environment-variability') return {
      kind: w.kind,
      path: str(w.path, 300),
      repo: ['adobecom/milo', 'adobecom/mas'].includes(w.repo) ? w.repo : null,
      number: int(w.number),
      pair: int(w.pair),
      expectedMergeBaseSha256: typeof w.expectedMergeBaseSha256 === 'string' && /^[a-f0-9]{64}$/i.test(w.expectedMergeBaseSha256) ? w.expectedMergeBaseSha256.toLowerCase() : null,
      productionSha256: typeof w.productionSha256 === 'string' && /^[a-f0-9]{64}$/i.test(w.productionSha256) ? w.productionSha256.toLowerCase() : null,
    };
    return {
      kind: 'environment-variability',
      benchmark: isObject(w.benchmark) ? {
        min: positive(w.benchmark.min),
        max: positive(w.benchmark.max),
        ratio: positive(w.benchmark.ratio),
        threshold: positive(w.benchmark.threshold),
      } : null,
    };
  }) : [];
  return {
    ...summary,
    interactions: summary.interactionsKey ? normalizeSteps(json.interactions) : [],
    pairs,
    incompletePairs: summary.single ? 0 : pairs.filter((p) => !p.complete).length,
    rejectedAttempts: Array.isArray(json.rejectedAttempts) ? json.rejectedAttempts.filter(isObject).slice(0, 200).map((r) => ({
      variant: str(r.variant, 20), run: int(r.run), attempt: int(r.attempt), reason: str(r.reason, 300),
    })) : [],
    changes: {
      kinds: strList(c.kinds, 10),
      hints: h && {
        requested: int(h.requested), used: int(h.used), contextual: int(h.contextual), dropped: int(h.dropped),
        pairs: Array.isArray(h.pairs) ? h.pairs.slice(0, 100).filter(isObject).map((p) => ({
          pair: int(p.pair), used: int(p.used), contextual: int(p.contextual), dropped: int(p.dropped),
        })) : [],
      },
      patchPaths: strList(c.patchPaths, 100),
      sourcePaths: strList(c.sourcePaths, 100),
      prSources: Array.isArray(c.prSources) ? c.prSources.slice(0, 20).filter(isObject).map((pr) => {
        if (!['adobecom/milo', 'adobecom/mas'].includes(pr.repo) || !Number.isInteger(pr.number) || pr.number < 1
          || !safeSha(pr.baseSha) || !safeSha(pr.headSha) || !safeSha(pr.mergeBaseSha)) return null;
        const validPath = (p) => {
          const value = str(p, 300);
          const prefix = pr.repo === 'adobecom/milo' ? '/libs/' : '/mas/libs/';
          return value?.startsWith(prefix) ? value : null;
        };
        return {
          repo: pr.repo, number: pr.number,
          baseRef: str(pr.baseRef, 120), headRef: str(pr.headRef, 120),
          baseSha: pr.baseSha.toLowerCase(), headSha: pr.headSha.toLowerCase(), mergeBaseSha: pr.mergeBaseSha.toLowerCase(),
          files: Array.isArray(pr.files) ? pr.files.slice(0, 300).filter(isObject).map((file) => ({
            status: ['added', 'modified', 'removed', 'renamed'].includes(file.status) ? file.status : null,
            path: validPath(file.path), previousPath: validPath(file.previousPath),
            blobSha: safeSha(file.blobSha),
          })).filter((file) => file.status && (file.path || file.previousPath)) : [],
        };
      }).filter(Boolean) : [],
      sourceDrift: Array.isArray(c.sourceDrift) ? c.sourceDrift.slice(0, 300).filter(isObject).map((row) => ({
        path: str(row.path, 300),
        repo: ['adobecom/milo', 'adobecom/mas'].includes(row.repo) ? row.repo : null,
        number: int(row.number), pair: int(row.pair),
        expectedMergeBaseSha256: typeof row.expectedMergeBaseSha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.expectedMergeBaseSha256) ? row.expectedMergeBaseSha256.toLowerCase() : null,
        productionSha256: typeof row.productionSha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.productionSha256) ? row.productionSha256.toLowerCase() : null,
        productionStatus: int(row.productionStatus),
        status: ['matches-merge-base', 'drift', 'unverified'].includes(row.status) ? row.status : null,
      })).filter((row) => row.path && row.repo && row.status) : [],
    },
    artifact: a && { name: str(a.name, 200), url: safeExternalUrl(a.url), expiresAt: time(a.expiresAt), expired: a.expired === true },
    warnings,
  };
}

export function artifactState(artifact, now = Date.now()) {
  if (!artifact) return 'missing';
  if (artifact.expired || (artifact.expiresAt != null && artifact.expiresAt <= now)) return 'expired';
  return artifact.url ? 'available' : 'unlinked';
}

// ---------------------------------------------------------------- filters and URL state

export const EMPTY_FILTERS = Object.freeze({ q: '', status: '', profile: '', from: '', to: '' });

export function parseFilters(search) {
  const p = new URLSearchParams(search);
  const date = (v) => (v && DATE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : '');
  const status = p.get('status') ?? '';
  const run = p.get('run') ?? '';
  return {
    q: (p.get('q') ?? '').trim().slice(0, 200),
    status: STATUS_FILTERS.includes(status) ? status : '',
    profile: (p.get('profile') ?? '').slice(0, 200),
    from: date(p.get('from')),
    to: date(p.get('to')),
    run: RUN_ID.test(run) ? run : '',
  };
}

export function serializeState({ q = '', status = '', profile = '', from = '', to = '', run = '' } = {}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (status) p.set('status', status);
  if (profile) p.set('profile', profile);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (run) p.set('run', run);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// A run (or summary) has INP when it replayed an interactions scenario or published an INP median.
export const hasInp = (run) => !!run && (!!run.interactionsKey || run.medians?.after?.INP != null || run.medians?.delta?.INP != null);

// The metrics to show for one run, or for a list of runs when any of them has INP.
export const metricKeysFor = (runOrRuns) => ((Array.isArray(runOrRuns) ? runOrRuns.some(hasInp) : hasInp(runOrRuns)) ? ALL_METRIC_KEYS : METRIC_KEYS);

export const hasFilters = (f) => !!(f.q || f.status || f.profile || f.from || f.to);

export function applyFilters(runs, f, timeZone) {
  const q = (f.q ?? '').toLowerCase();
  return runs.filter((r) => {
    if (q && !`${r.url ?? ''} ${r.name ?? ''} ${r.id}`.toLowerCase().includes(q)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.profile && r.profileKey !== f.profile) return false;
    const day = formatLocalDay(r.createdAt, timeZone);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return true;
  });
}

export function profileLabel(r) {
  const p = r.profile;
  const parts = [p?.name, p?.lighthouseVersion && `Lighthouse ${p.lighthouseVersion}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : r.profileKey ?? 'Unknown profile';
}

export function profileOptions(runs) {
  const map = new Map();
  for (const r of runs) {
    if (!r.profileKey || map.has(r.profileKey)) continue;
    map.set(r.profileKey, `${profileLabel(r)} — ${r.profileKey}`);
  }
  return [...map].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- verdicts

// Sign at display resolution: only decides whether a delta prints as ±0.
function displaySign(key, d) {
  if (d == null || Math.abs(d) < METRICS[key].step / 2) return 0;
  return d > 0 ? 1 : -1;
}

// Sign beyond the practical noise threshold: the only sign used for verdicts and chart colours.
function noiseSign(key, d) {
  if (d == null || !Number.isFinite(d) || Math.abs(d) < NOISE[key]) return 0;
  return d > 0 ? 1 : -1;
}

const improves = (key, side) => (METRICS[key].better === 'higher' ? side > 0 : side < 0);

// Returns { verdict: 'better'|'worse'|'inconclusive'|'noise'|'none', agree, total }. `agree` counts complete
// pairs on the median's side of zero; it describes consistency and is not a confidence level.
export function classify(key, medianDelta, pairs = []) {
  const deltas = pairs.filter((p) => p.complete && p.delta && p.delta[key] != null).map((p) => p.delta[key]);
  const total = deltas.length;
  if (medianDelta == null) return { verdict: 'none', agree: 0, total };
  const side = Math.sign(medianDelta);
  const agree = side === 0 ? deltas.filter((d) => displaySign(key, d) === 0).length : deltas.filter((d) => Math.sign(d) === side).length;
  if (total < MIN_PAIRS) return { verdict: 'inconclusive', agree, total };
  if (noiseSign(key, medianDelta) === 0) return { verdict: 'noise', agree, total };
  if (agree / total < AGREEMENT) return { verdict: 'inconclusive', agree, total };
  return { verdict: improves(key, side) ? 'better' : 'worse', agree, total };
}

// CPU benchmark scores of the before and after loads (higher is faster). When a pair's after/before ratio or
// the spread across all loads exceeds CPU_VARIATION, machine speed may explain the deltas.
export const CPU_VARIATION = 1.2;

export function cpuVariability(pairs = []) {
  const rows = pairs.filter((p) => p.benchmark).map((p) => ({ index: p.index, before: p.benchmark.before, after: p.benchmark.after }));
  const range = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null);
    return v.length ? { min: Math.min(...v), max: Math.max(...v), n: v.length } : null;
  };
  const before = range('before');
  const after = range('after');
  if (!before && !after) return null;
  for (const r of rows) r.ratio = r.before != null && r.after != null ? r.after / r.before : null;
  const pairRatio = Math.max(1, ...rows.filter((r) => r.ratio != null).map((r) => Math.max(r.ratio, 1 / r.ratio)));
  const lo = Math.min(before?.min ?? Infinity, after?.min ?? Infinity);
  const hi = Math.max(before?.max ?? 0, after?.max ?? 0);
  const spread = hi / lo;
  return { before, after, pairs: rows, pairRatio, spread, varied: pairRatio >= CPU_VARIATION || spread >= CPU_VARIATION };
}

// Direction reading for one metric of a run. Failed, unrecognized-status or non-US runs never name a direction,
// and a direction is held at inconclusive when the CPU benchmark varied between loads.
export function runVerdict(run, key, pairs = []) {
  const c = classify(key, run.medians?.delta?.[key] ?? null, pairs);
  if (c.verdict === 'none') return c;
  const excluded = run.status === 'failed' ? 'failed run' : run.status === 'unknown' ? 'unrecognized status' : !run.us ? 'not US-verified' : null;
  if (excluded) return { ...c, verdict: 'inconclusive', excluded };
  if ((c.verdict === 'better' || c.verdict === 'worse') && cpuVariability(pairs)?.varied) {
    return { ...c, verdict: 'inconclusive', confound: 'cpu', heldFrom: c.verdict };
  }
  return c;
}

// True when After − Before of the medians and the median paired delta point in opposite directions.
export function mediansDisagree(key, before, after, delta) {
  if (before == null || after == null || delta == null) return false;
  const a = displaySign(key, after - before);
  const b = displaySign(key, delta);
  return a !== 0 && b !== 0 && a !== b;
}

export const VERDICT_LABEL = {
  better: 'Consistently better',
  worse: 'Consistently worse',
  inconclusive: 'Inconclusive',
  noise: 'Within noise',
  none: '—',
};

export function formatNoise(key) {
  const n = NOISE[key];
  if (METRICS[key].unit === 's' || METRICS[key].unit === 'ms') return `${NF0.format(n)}\u00a0ms`;
  if (key === 'performance') return `${n} points`;
  return String(n);
}

// Direction of one pair for chart colouring; differences inside the noise threshold are 'flat'.
export function pairDirection(key, delta) {
  const s = noiseSign(key, delta);
  if (s === 0) return 'flat';
  return improves(key, s) ? 'better' : 'worse';
}

// ---------------------------------------------------------------- formatting

const MINUS = '\u2212';
const nf = (digits) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF0 = nf(0);
const NF1 = nf(1);
const NF2 = nf(2);
const NF3 = nf(3);

function magnitude(key, v) {
  const unit = METRICS[key].unit;
  if (unit === 's') return NF2.format(v / 1000);
  if (unit === '') return NF3.format(v);
  return NF0.format(v);
}

export function unitSuffix(key) {
  const unit = METRICS[key].unit;
  return unit === 's' || unit === 'ms' ? `\u00a0${unit}` : '';
}

export function formatMetric(key, v, withUnit = true) {
  if (v == null) return '—';
  return `${magnitude(key, v)}${withUnit ? unitSuffix(key) : ''}`;
}

export function formatDelta(key, d, withUnit = true) {
  if (d == null) return '—';
  const unit = withUnit ? unitSuffix(key) : '';
  if (displaySign(key, d) === 0) return `±0${unit}`;
  return `${d > 0 ? '+' : MINUS}${magnitude(key, Math.abs(d))}${unit}`;
}

// Column header unit for tables whose cells omit units.
export function columnUnit(key) {
  const unit = METRICS[key].unit;
  return unit === 'score' ? '0–100' : unit;
}

// Median paired delta relative to the before median; only for timings, where a ratio is meaningful.
export function formatPercent(key, d, before) {
  if (d == null || before == null || before <= 0 || METRICS[key].unit === 'score' || METRICS[key].unit === '') return '';
  const pct = (d / before) * 100;
  if (Math.abs(pct) < 0.05) return '±0.0%';
  return `${pct > 0 ? '+' : MINUS}${NF1.format(Math.abs(pct))}%`;
}

export function formatTick(key, v, step) {
  const unit = METRICS[key].unit;
  if (unit === 's') return (step >= 100 ? NF1 : NF2).format(v / 1000);
  if (unit === '') return (step >= 0.01 ? NF2 : NF3).format(v);
  return NF0.format(v);
}

export function axisUnit(key) {
  const unit = METRICS[key].unit;
  return unit === 'score' ? 'score' : unit || 'unitless';
}

export function formatDateTime(t, timeZone) {
  if (t == null) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(t));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${values.timeZoneName}`;
}

export const formatDay = (t) => (t == null ? '—' : new Date(t).toISOString().slice(0, 10));
export function formatLocalDay(t, timeZone) {
  if (t == null) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatRelativeDays(t, now = Date.now()) {
  if (t == null) return '';
  const days = Math.round((t - now) / 86400000);
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
}

export function formatDuration(ms) {
  if (ms == null || ms < 0) return null;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatThroughput(kbps) {
  return kbps == null ? null : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(kbps)} kb/s`;
}

export function sampleSummary(r) {
  const s = r.samples;
  if (s.pairs == null && s.requested == null) return 'No counts';
  const pairs = s.pairs ?? 0;
  if (s.requested == null) return `${pairs} pair${pairs === 1 ? '' : 's'}`;
  return `${pairs}/${s.requested} pair${s.requested === 1 ? '' : 's'}`;
}

// Axis helpers for the paired-sample plots. The domain spans the data; dot plots need no zero baseline.
export function niceTicks(min, max, count = 4) {
  if (!(Number.isFinite(min) && Number.isFinite(max)) || max < min) return { ticks: [], step: 0 };
  if (max === min) return { ticks: [min], step: 0 };
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw * 0.999) ?? 10 * pow;
  const ticks = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) ticks.push(Number((Math.round(v / step) * step).toPrecision(12)));
  return { ticks, step };
}

export function plotDomain(key, values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.08, METRICS[key].step * 5);
  lo -= pad;
  hi += pad;
  if (key === 'performance') { lo = Math.max(0, lo); hi = Math.min(100, hi); }
  if (METRICS[key].better === 'lower') lo = Math.max(0, lo);
  return [lo, hi];
}

export function median(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
