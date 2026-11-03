// Whitelist-only conversion from private perf-ab artifacts to the public static history schema.
import { environmentWarnings } from './aggregate.mjs';
import { EXPECTED, METRIC_KEYS, pairStats, profileKey as makeProfileKey } from './stats.mjs';
import { PR_REPOSITORIES } from './pr-sources.mjs';

export const HISTORY_SCHEMA = 'perf-ab/history-v1';
export const RUN_SCHEMA = 'perf-ab/run-v1';
const RUN_ID = /^[0-9]{1,20}-[0-9]{1,6}$/;
const ERROR_CODES = new Set([
  'no-artifact', 'workflow-failed', 'workflow-cancelled', 'artifact-invalid',
  'non-us-egress', 'profile-mismatch', 'pairs-incomplete', 'lighthouse-failed',
]);
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'neutral', 'skipped', 'timed_out', 'action_required', 'stale']);
const CHANGE_KINDS = ['query', 'headInject', 'priorities', 'patches', 'sources'];

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 300) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const positiveNumber = (v) => (number(v) != null && v > 0 ? v : null);
const count = (v) => Number.isInteger(v) && v >= 0 ? v : null;
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function sanitizeTargetUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !host.endsWith('.adobe.com') || url.port || !host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length > 300 || !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)) return null;
  if (value.split('/').some((part) => part === '.' || part === '..')) return null;
  return value;
}

function safePagePath(value) {
  if (typeof value !== 'string' || value.length > 500 || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*$/.test(value)) return null;
  if (value.split('/').some((part) => part === '.' || part === '..')) return null;
  return value;
}

function safeMappedPath(value, repo) {
  const mapping = PR_REPOSITORIES[repo];
  const path = safePagePath(value);
  return mapping && path?.startsWith(`${mapping.to}/`) ? path : null;
}

function safePrSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter((pr) => object(pr) && Object.hasOwn(PR_REPOSITORIES, pr.repo)
    && Number.isInteger(pr.number) && pr.number > 0 && pr.number <= 999999
    && /^[a-f0-9]{40}$/i.test(pr.baseSha ?? '') && /^[a-f0-9]{40}$/i.test(pr.headSha ?? '')
    && /^[a-f0-9]{40}$/i.test(pr.mergeBaseSha ?? '')).map((pr) => ({
    repo: pr.repo,
    number: pr.number,
    baseRef: typeof pr.baseRef === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(pr.baseRef) && !pr.baseRef.includes('..') ? pr.baseRef : null,
    headRef: typeof pr.headRef === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(pr.headRef) && !pr.headRef.includes('..') ? pr.headRef : null,
    baseSha: pr.baseSha.toLowerCase(),
    headSha: pr.headSha.toLowerCase(),
    mergeBaseSha: pr.mergeBaseSha.toLowerCase(),
    files: (Array.isArray(pr.files) ? pr.files : []).slice(0, 300).filter((file) => object(file)
      && ['added', 'modified', 'removed', 'renamed'].includes(file.status)).map((file) => ({
      status: file.status,
      path: safeMappedPath(file.path, pr.repo),
      previousPath: safeMappedPath(file.previousPath, pr.repo),
      blobSha: /^[a-f0-9]{40}$/i.test(file.blobSha ?? '') ? file.blobSha.toLowerCase() : null,
    })).filter((file) => file.path || file.previousPath),
  }));
}

function safeSourceDrift(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).filter((row) => object(row) && Object.hasOwn(PR_REPOSITORIES, row.repo)
    && Number.isInteger(row.number) && row.number > 0 && row.number <= 999999).map((row) => ({
    path: safeMappedPath(row.path, row.repo),
    repo: row.repo,
    number: row.number,
    pair: count(row.pair),
    expectedMergeBaseSha256: /^[a-f0-9]{64}$/i.test(row.expectedMergeBaseSha256 ?? '') ? row.expectedMergeBaseSha256.toLowerCase() : null,
    productionSha256: /^[a-f0-9]{64}$/i.test(row.productionSha256 ?? '') ? row.productionSha256.toLowerCase() : null,
    productionStatus: count(row.productionStatus),
    status: ['matches-merge-base', 'drift', 'unverified'].includes(row.status) ? row.status : null,
  })).filter((row) => row.path && row.status);
}

function safeMetrics(value) {
  if (!object(value)) return null;
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const n = number(value[key]);
    if (n != null && n >= 0 && (key !== 'performance' || n <= 100)) metrics[key] = n;
  }
  return Object.keys(metrics).length ? metrics : null;
}

function safeDeltas(value) {
  if (!object(value)) return null;
  const deltas = {};
  for (const key of METRIC_KEYS) {
    const n = number(value[key]);
    if (n != null && (key !== 'performance' || Math.abs(n) <= 100)) deltas[key] = n;
  }
  return Object.keys(deltas).length ? deltas : null;
}

function completeMetrics(value) {
  return object(value) && METRIC_KEYS.every((key) => number(value[key]) != null);
}

function safeProfile(value) {
  if (!object(value)) return null;
  const profile = {
    name: text(value.name, 200),
    lighthouseVersion: text(value.lighthouseVersion, 40),
    chromeVersion: text(value.chromeVersion, 80),
    formFactor: text(value.formFactor, 40),
    throttlingMethod: text(value.throttlingMethod, 40),
    rttMs: number(value.rttMs),
    throughputKbps: number(value.throughputKbps),
    cpuSlowdownMultiplier: number(value.cpuSlowdownMultiplier),
    width: number(value.width),
    height: number(value.height),
    deviceScaleFactor: number(value.deviceScaleFactor),
  };
  return Object.values(profile).some((v) => v != null) ? profile : null;
}

function safeGithub(run) {
  const id = String(run.id ?? '');
  const attempt = count(run.run_attempt) ?? 1;
  const sha = typeof run.head_sha === 'string' && /^[a-f0-9]{7,40}$/i.test(run.head_sha) ? run.head_sha.toLowerCase() : null;
  return {
    runUrl: `https://github.com/adobecom/perf-tools/actions/runs/${id}/attempts/${attempt}`,
    sha,
  };
}

export function safeArtifact(artifact, runId) {
  if (!artifact) return null;
  const id = positiveNumber(artifact.id);
  const name = text(artifact.name, 200);
  const expiresAt = iso(artifact.expires_at);
  if (id == null || !name || !expiresAt) return null;
  return {
    name,
    url: `https://github.com/adobecom/perf-tools/actions/runs/${runId}/artifacts/${id}`,
    expiresAt,
    expired: artifact.expired === true,
  };
}

function safePair(raw, index) {
  if (!object(raw)) return null;
  const before = safeMetrics(raw.before);
  const after = safeMetrics(raw.after);
  const delta = {};
  for (const key of METRIC_KEYS) {
    if (before?.[key] != null && after?.[key] != null) delta[key] = after[key] - before[key];
  }
  const rawJob = object(raw.job) ? raw.job : {};
  const benchmarkIndexes = object(rawJob.benchmarkIndexes) ? rawJob.benchmarkIndexes : {};
  const oldBenchmark = object(rawJob.benchmark) ? rawJob.benchmark : object(raw.benchmark) ? raw.benchmark : {};
  const benchmarkBefore = positiveNumber(benchmarkIndexes.before ?? oldBenchmark.before);
  const benchmarkAfter = positiveNumber(benchmarkIndexes.after ?? oldBenchmark.after);
  const job = {
    runAttempt: count(rawJob.runAttempt),
    chromeVersion: text(rawJob.chromeVersion, 80),
    egressCountry: text(rawJob.egressCountry, 8)?.toUpperCase() ?? null,
    benchmarkIndexes: {
      before: benchmarkBefore,
      after: benchmarkAfter,
    },
    benchmarkIndex: positiveNumber(rawJob.benchmarkIndex),
  };
  return {
    index: count(raw.index) ?? index + 1,
    before,
    after,
    delta: Object.keys(delta).length ? delta : null,
    job,
  };
}

function mergeRunBenchmarks(pairs, rawRuns) {
  const byIndex = new Map();
  for (const run of rawRuns ?? []) {
    if (!object(run) || !Number.isInteger(run.run) || !['before', 'after'].includes(run.variant)) continue;
    const benchmark = positiveNumber(run.benchmarkIndex);
    if (benchmark == null) continue;
    const pair = byIndex.get(run.run) ?? {};
    pair[run.variant] = benchmark;
    byIndex.set(run.run, pair);
  }
  return pairs.map((pair) => {
    const actual = byIndex.get(pair.index);
    if (!actual) return pair;
    return {
      ...pair,
      job: {
        ...pair.job,
        benchmarkIndexes: {
          before: actual.before ?? pair.job.benchmarkIndexes.before,
          after: actual.after ?? pair.job.benchmarkIndexes.after,
        },
      },
    };
  });
}

function groupLegacyRuns(rawRuns) {
  const grouped = new Map();
  for (const raw of rawRuns) {
    if (!object(raw) || !Number.isInteger(raw.run) || raw.run < 1 || !['before', 'after'].includes(raw.variant)) continue;
    const pair = grouped.get(raw.run) ?? { index: raw.run, before: null, after: null, job: {} };
    pair[raw.variant] = raw.metrics;
    const key = raw.variant;
    const existing = object(pair.job.benchmarkIndexes) ? pair.job.benchmarkIndexes : {};
    pair.job.benchmarkIndexes = { ...existing, [key]: number(raw.benchmarkIndex) };
    pair.job.chromeVersion ??= text(raw.chromeVersion, 80);
    pair.job.runAttempt ??= count(raw.attempt);
    grouped.set(raw.run, pair);
  }
  return [...grouped.values()].sort((a, b) => a.index - b.index);
}

function safeChanges(raw) {
  const variants = object(raw.edits) ? Object.values(raw.edits).filter(object) : [];
  const hints = object(raw.hints) ? raw.hints : null;
  const priorities = variants.flatMap((v) => Array.isArray(v.priorities) ? v.priorities : []);
  const patchPaths = variants.flatMap((v) => Array.isArray(v.patches) ? v.patches : []);
  const sourcePaths = variants.flatMap((v) => object(v.sources) ? Object.keys(v.sources) : []);
  const prSources = safePrSources(raw.sourcePrs);
  const sourceDrift = safeSourceDrift(raw.sourceDrift);
  const kinds = new Set();
  for (const kind of Array.isArray(raw.kinds) ? raw.kinds : []) {
    if (CHANGE_KINDS.includes(kind)) kinds.add(kind);
  }
  if (hints || variants.some((v) => v.headInject === true)) kinds.add('headInject');
  if (priorities.length) kinds.add('priorities');
  if (patchPaths.length) kinds.add('patches');
  if (sourcePaths.length || prSources.length) kinds.add('sources');
  const resultVariants = Array.isArray(raw.variants) ? raw.variants : object(raw.variants) ? Object.values(raw.variants) : [];
  if (resultVariants.some((v) => {
    if (!object(v) || typeof v.url !== 'string') return false;
    try { return !!new URL(v.url).search; } catch { return false; }
  })) kinds.add('query');

  const perPair = Array.isArray(hints?.perPair) ? hints.perPair.filter(object)
    : Array.isArray(hints?.pairs) ? hints.pairs.filter(object) : [];
  const middleCount = (values) => {
    const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  };
  const hintPairs = perPair.map((p, index) => ({
    pair: count(p.pair) ?? index + 1,
    used: count(p.usedLinks ?? p.used),
    contextual: count(p.contextual),
    dropped: count(p.dropped),
  }));
  const hintCounts = hints ? {
    requested: count(hints.requested ?? hints.requestedLinks),
    used: count(hints.used ?? hints.usedLinks) ?? middleCount(hintPairs.map((p) => p.used)),
    contextual: count(hints.contextualCount) ?? middleCount(hintPairs.map((p) => p.contextual))
      ?? (Array.isArray(hints.contextual) ? hints.contextual.length : 0),
    dropped: count(hints.droppedCount) ?? middleCount(hintPairs.map((p) => p.dropped))
      ?? (Array.isArray(hints.dropped) ? hints.dropped.length : 0),
    pairs: hintPairs,
  } : null;
  const priorityPaths = priorities.map((p) => object(p) ? {
    path: safePagePath(p.path),
    priority: ['high', 'low', 'auto'].includes(p.priority) ? p.priority : null,
  } : null).filter((p) => p?.path);
  return {
    kinds: [...kinds].filter((kind) => CHANGE_KINDS.includes(kind)),
    hints: hintCounts && Object.values(hintCounts).some((v) => v != null) ? hintCounts : null,
    priorityPaths: [...new Map(priorityPaths.map((p) => [p.path, p])).values()],
    patchPaths: [...new Set(patchPaths.map((p) => safePagePath(object(p) ? p.path : p)).filter(Boolean))],
    sourcePaths: [...new Set(sourcePaths.map(safePagePath).filter(Boolean))],
    prSources,
    sourceDrift,
  };
}

function safeRejected(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).filter(object).map((entry) => ({
    variant: ['before', 'after'].includes(entry.variant) ? entry.variant : null,
    run: count(entry.run),
    attempt: count(entry.attempt),
    reason: ERROR_CODES.has(entry.code) ? entry.code : entry.kind === 'fatal' ? 'workflow-failed' : 'lighthouse-failed',
  }));
}

function statusAndError(raw, run) {
  if (run.conclusion === 'cancelled') return { status: 'failed', conclusion: 'cancelled', errorCode: 'workflow-cancelled' };
  if (run.conclusion && run.conclusion !== 'success' && raw.status !== 'partial') {
    return { status: 'failed', conclusion: CONCLUSIONS.has(run.conclusion) ? run.conclusion : null, errorCode: 'workflow-failed' };
  }
  if (['ok', 'partial', 'failed'].includes(raw.status)) return {
    status: raw.status,
    conclusion: CONCLUSIONS.has(run.conclusion) ? run.conclusion : null,
    errorCode: raw.status === 'failed' ? 'lighthouse-failed' : raw.status === 'partial' ? 'pairs-incomplete' : null,
  };
  return { status: 'failed', conclusion: CONCLUSIONS.has(run.conclusion) ? run.conclusion : null, errorCode: 'artifact-invalid' };
}

function expectedProfile(profile) {
  if (!profile) return false;
  return Object.entries(EXPECTED).every(([key, value]) => {
    if (key === 'mobile') return (profile.formFactor === 'mobile') === value;
    return profile[key] === value;
  });
}

function profileKeyFrom(raw, profile) {
  const candidate = text(raw.profileKey, 200);
  if (candidate && /^[A-Za-z0-9._@+-]+$/.test(candidate)) return candidate;
  if (!profile || profile.lighthouseVersion !== EXPECTED.lighthouseVersion) return null;
  return makeProfileKey({
    ...profile,
    mobile: profile.formFactor === 'mobile',
  });
}

function makeDocument(raw, run, artifact, now = Date.now()) {
  const id = `${run.id}-${count(run.run_attempt) ?? 1}`;
  const sourceUrl = raw.url ?? raw.variants?.after?.url;
  const url = sanitizeTargetUrl(sourceUrl);
  const profile = safeProfile(raw.profile);
  let pairs;
  if (Array.isArray(raw.pairs)) pairs = raw.pairs.slice(0, 100).map(safePair).filter(Boolean);
  else pairs = groupLegacyRuns(raw.runs ?? []).slice(0, 100).map(safePair);
  pairs = mergeRunBenchmarks(pairs, raw.runs);

  const names = Array.isArray(raw.names) ? raw.names : ['before', 'after'];
  const stats = pairStats(pairs.map((pair) => ({
    before: pair.before,
    after: pair.after,
  })), names);
  const supplied = object(raw.medians) ? raw.medians : {};
  const paired = names.includes('before');
  const medians = {
    before: pairs.length ? stats.medians.before : safeMetrics(supplied.before),
    after: pairs.length ? stats.medians.after : safeMetrics(supplied.after),
    delta: pairs.length ? stats.medians.delta : safeDeltas(supplied.delta),
  };
  const samplesRaw = object(raw.samples) ? raw.samples : {};
  const completePairs = pairs.filter((pair) => completeMetrics(pair.after) && (!paired || completeMetrics(pair.before))).length;
  const samples = {
    requested: count(samplesRaw.requested ?? raw.runsPerVariant),
    before: pairs.filter((pair) => completeMetrics(pair.before)).length,
    after: pairs.filter((pair) => completeMetrics(pair.after)).length,
    pairs: completePairs,
    rejected: Array.isArray(raw.rejected) ? safeRejected(raw.rejected).length : count(samplesRaw.rejected),
  };

  const egressSource = object(raw.egress) ? raw.egress : {};
  const country = text(egressSource.country, 8)?.toUpperCase() ?? null;
  const geoRows = Array.isArray(raw.documentGeo) ? raw.documentGeo : [];
  const hasNonUsGeo = geoRows.some((x) => x?.status === 'non-US');
  const hasUsGeo = geoRows.some((x) => x?.status === 'US');
  const egress = {
    country,
    verified: egressSource.ok === true && country === 'US' && !hasNonUsGeo,
    documentGeo: hasNonUsGeo ? 'non-US' : hasUsGeo ? 'US' : 'unavailable',
  };
  const state = statusAndError(raw, run);
  const hasRequiredMedians = !!medians.after && (!paired || (!!medians.before && !!medians.delta));
  if (state.status === 'ok' && (!hasRequiredMedians || samples.pairs === 0)) {
    state.status = 'failed';
    state.errorCode = 'artifact-invalid';
  } else if (state.status === 'ok' && samples.requested != null && samples.pairs < samples.requested) {
    state.status = 'partial';
    state.errorCode = 'pairs-incomplete';
  }
  if (hasNonUsGeo) {
    state.status = 'failed';
    state.errorCode = 'non-us-egress';
  } else if (!expectedProfile(profile)) {
    state.status = 'failed';
    state.errorCode = 'profile-mismatch';
  } else if (!egress.verified) {
    state.status = 'failed';
    state.errorCode = 'non-us-egress';
  }
  const github = safeGithub(run);
  const artifactInfo = safeArtifact(artifact, run.id);
  const changes = safeChanges(raw);
  const publicWarnings = environmentWarnings(pairs).map((warning) => ({
    kind: 'environment-variability',
    benchmark: {
      min: number(warning.benchmark?.min),
      max: number(warning.benchmark?.max),
      ratio: number(warning.benchmark?.ratio),
      threshold: number(warning.benchmark?.threshold),
    },
    pairs: warning.pairs.map((p) => ({
      pair: count(p.pair),
      before: number(p.before),
      after: number(p.after),
      ratio: number(p.ratio),
    })),
  }));
  for (const warning of Array.isArray(raw.warnings) ? raw.warnings : []) {
    if (!object(warning) || !['production-source-drift', 'production-source-unverified'].includes(warning.kind)
      || !Object.hasOwn(PR_REPOSITORIES, warning.repo) || !Number.isInteger(warning.number)
      || warning.number < 1 || warning.number > 999999) continue;
    const warningPath = safeMappedPath(warning.path, warning.repo);
    if (!warningPath) continue;
    publicWarnings.push({
      kind: warning.kind,
      path: warningPath,
      repo: warning.repo,
      number: warning.number,
      pair: count(warning.pair),
      expectedMergeBaseSha256: /^[a-f0-9]{64}$/i.test(warning.expectedMergeBaseSha256 ?? '') ? warning.expectedMergeBaseSha256.toLowerCase() : null,
      productionSha256: /^[a-f0-9]{64}$/i.test(warning.productionSha256 ?? '') ? warning.productionSha256.toLowerCase() : null,
    });
  }

  const detail = {
    schema: RUN_SCHEMA,
    id,
    name: text(raw.experiment?.name ?? raw.name, 120),
    config: safeRepoPath(raw.experiment?.config ?? raw.config),
    createdAt: iso(run.created_at) ?? iso(run.run_started_at) ?? new Date(now).toISOString(),
    finishedAt: iso(run.updated_at) ?? iso(raw.finishedAt),
    status: state.status,
    ...(state.conclusion ? { conclusion: state.conclusion } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    url,
    profileKey: profileKeyFrom(raw, profile),
    profile,
    egress,
    samples,
    medians,
    github,
    detailPath: `data/runs/${id}.json`,
    pairs,
    rejectedAttempts: safeRejected(raw.rejected),
    changes,
    warnings: publicWarnings,
    artifact: artifactInfo && {
      name: artifactInfo.name,
      url: artifactInfo.url,
      expiresAt: artifactInfo.expiresAt,
      expired: artifactInfo.expired || Date.parse(artifactInfo.expiresAt) <= now,
    },
  };
  return detail;
}

export function missingArtifactDocument(run, now = Date.now()) {
  const base = makeDocument({}, run, null, now);
  base.status = 'failed';
  base.errorCode = run.conclusion === 'cancelled' ? 'workflow-cancelled' : 'no-artifact';
  return base;
}

export function normalizeResult(raw, run, artifact, now = Date.now()) {
  if (!object(raw) || raw.schema !== 'perf-ab/pagespeed-v1') throw new Error('unsupported perf-ab result schema');
  const detail = makeDocument(raw, run, artifact, now);
  if (!detail.url) {
    detail.status = 'failed';
    detail.errorCode = 'artifact-invalid';
  }
  return detail;
}

export function resultAttemptMatches(raw, runAttempt) {
  const resultAttempt = count(raw?.github?.runAttempt);
  return resultAttempt == null ? runAttempt === 1 : resultAttempt === runAttempt;
}

export function summaryFromDetail(detail) {
  const {
    schema, pairs, rejectedAttempts, changes, warnings, artifact, ...summary
  } = detail;
  return summary;
}

function sanitizeExistingSummary(raw) {
  if (!object(raw) || typeof raw.id !== 'string' || !RUN_ID.test(raw.id)) return null;
  const createdAt = iso(raw.createdAt);
  if (!createdAt) return null;
  const url = sanitizeTargetUrl(raw.url);
  const profile = safeProfile(raw.profile);
  const mediansRaw = object(raw.medians) ? raw.medians : {};
  const samplesRaw = object(raw.samples) ? raw.samples : {};
  const github = object(raw.github) ? raw.github : {};
  const errorCode = ERROR_CODES.has(raw.errorCode) ? raw.errorCode : null;
  return {
    id: raw.id,
    name: text(raw.name, 120),
    config: safeRepoPath(raw.config),
    createdAt,
    finishedAt: iso(raw.finishedAt),
    status: ['ok', 'partial', 'failed'].includes(raw.status) ? raw.status : 'unknown',
    ...(CONCLUSIONS.has(raw.conclusion) ? { conclusion: raw.conclusion } : {}),
    ...(errorCode ? { errorCode } : {}),
    url,
    profileKey: typeof raw.profileKey === 'string' && /^[A-Za-z0-9._@+-]{1,200}$/.test(raw.profileKey) ? raw.profileKey : null,
    profile,
    egress: {
      country: text(raw.egress?.country, 8)?.toUpperCase() ?? null,
      verified: raw.egress?.verified === true && raw.egress?.country === 'US',
      documentGeo: ['US', 'non-US', 'unavailable'].includes(raw.egress?.documentGeo) ? raw.egress.documentGeo : 'unavailable',
    },
    samples: Object.fromEntries(['requested', 'before', 'after', 'pairs', 'rejected'].map((key) => [key, count(samplesRaw[key])])),
    medians: {
      before: safeMetrics(mediansRaw.before),
      after: safeMetrics(mediansRaw.after),
      delta: safeDeltas(mediansRaw.delta),
    },
    github: {
      runUrl: typeof github.runUrl === 'string' && /^https:\/\/github\.com\/adobecom\/perf-tools\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(github.runUrl) ? github.runUrl : null,
      sha: typeof github.sha === 'string' && /^[a-f0-9]{7,40}$/i.test(github.sha) ? github.sha.toLowerCase() : null,
    },
    detailPath: `data/runs/${raw.id}.json`,
  };
}

function sanitizeExistingDetail(raw, summary) {
  if (!object(raw) || raw.schema !== RUN_SCHEMA || raw.id !== summary.id) return null;
  const pairs = Array.isArray(raw.pairs) ? raw.pairs.slice(0, 100).map(safePair).filter(Boolean) : [];
  const changes = safeChanges({ edits: { existing: {
    headInject: raw.changes?.kinds?.includes('headInject'),
    priorities: raw.changes?.priorityPaths,
    patches: raw.changes?.patchPaths,
    sources: Object.fromEntries((raw.changes?.sourcePaths ?? []).map((p) => [p, true])),
  } }, hints: raw.changes?.hints, kinds: raw.changes?.kinds, sourcePrs: raw.changes?.prSources, sourceDrift: raw.changes?.sourceDrift });
  const detail = {
    ...summary,
    schema: RUN_SCHEMA,
    pairs,
    rejectedAttempts: safeRejected(raw.rejectedAttempts),
    changes,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w) => w?.kind === 'environment-variability').slice(0, 10).map((w) => ({
      kind: 'environment-variability',
      benchmark: { min: number(w.benchmark?.min), max: number(w.benchmark?.max), ratio: number(w.benchmark?.ratio), threshold: number(w.benchmark?.threshold) },
      pairs: Array.isArray(w.pairs) ? w.pairs.slice(0, 100).map((p) => ({ pair: count(p.pair), before: number(p.before), after: number(p.after), ratio: number(p.ratio) })) : [],
    })) : [],
    artifact: null,
  };
  if (object(raw.artifact)) {
    const match = /\/artifacts\/([0-9]+)$/.exec(raw.artifact.url ?? '');
    const id = match ? Number(match[1]) : null;
    const expiresAt = iso(raw.artifact.expiresAt);
    const name = text(raw.artifact.name, 200);
    if (Number.isSafeInteger(id) && id > 0 && name && expiresAt) detail.artifact = {
      name,
      url: `https://github.com/adobecom/perf-tools/actions/runs/${summary.id.split('-')[0]}/artifacts/${id}`,
      expiresAt,
      expired: raw.artifact.expired === true,
    };
  }
  return detail;
}

export function mergeHistory(existing, imported, now = Date.now(), existingDetails = {}) {
  if (existing != null && (!object(existing) || existing.schema !== HISTORY_SCHEMA || !Array.isArray(existing.runs))) {
    throw new Error('existing public history has an unsupported schema or shape');
  }
  const documents = new Map();
  if (existing) {
    for (const old of existing.runs) {
      const summary = sanitizeExistingSummary(old);
      if (!summary || documents.has(summary.id)) continue;
      documents.set(summary.id, { detail: null, summary });
    }
  }
  for (const detail of imported) {
    if (!object(detail) || detail.schema !== RUN_SCHEMA || !RUN_ID.test(detail.id ?? '')) throw new Error('publisher received an invalid run detail');
    if (!documents.has(detail.id)) {
      const cleanSummary = sanitizeExistingSummary(summaryFromDetail(detail));
      if (cleanSummary) documents.set(detail.id, { detail, summary: cleanSummary });
    }
  }
  const summaries = [...documents.values()].map(({ summary }) => summary)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  const output = {
    index: { schema: HISTORY_SCHEMA, updatedAt: new Date(now).toISOString(), runs: summaries },
    details: new Map(),
  };
  for (const [id, entry] of documents) {
    if (entry.detail) {
      output.details.set(id, entry.detail);
      continue;
    }
    const existingDetail = existingDetails[id];
    output.details.set(id, existingDetail ? sanitizeExistingDetail(existingDetail, entry.summary) : null);
  }
  return output;
}
