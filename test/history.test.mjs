import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeHistory, missingArtifactDocument, normalizeResult, resultAttemptMatches, sanitizeTargetUrl, summaryFromDetail,
} from '../lib/pagespeed/history.mjs';
import * as dashboard from '../site/dashboard-core.mjs';

const profile = {
  name: 'Lighthouse mobile, DevTools throttling (Slow 4G, Moto G Power)',
  lighthouseVersion: '13.6.0',
  chromeVersion: '142.0.7444.59',
  formFactor: 'mobile',
  throttlingMethod: 'devtools',
  rttMs: 150,
  throughputKbps: 1638.4,
  requestLatencyMs: 562.5,
  downloadThroughputKbps: 1474.56,
  uploadThroughputKbps: 675,
  cpuSlowdownMultiplier: 4,
  width: 412,
  height: 823,
  deviceScaleFactor: 1.75,
};
const metrics = (LCP, performance = 50) => ({ performance, FCP: LCP - 1000, LCP, SI: LCP + 200, TBT: 100, CLS: 0.01 });
const ghRun = (overrides = {}) => ({
  id: 41633898462,
  run_attempt: 1,
  created_at: '2026-11-02T12:00:00Z',
  updated_at: '2026-11-02T12:30:00Z',
  conclusion: 'success',
  head_sha: 'faa7259b9ce33463c387752efcd0d3d0169291',
  ...overrides,
});
const artifact = { id: 13228007918, name: 'perf-ab-request-results', expires_at: '2026-12-03T11:54:24Z', expired: false };

function result(overrides = {}) {
  const pairs = [
    { index: 1, before: metrics(4000), after: metrics(4300), job: { benchmarkIndexes: { before: 2368.5, after: 3103 }, egressCountry: 'US' } },
    { index: 2, before: metrics(5000), after: metrics(4200), job: { benchmarkIndexes: { before: 2368.5, after: 2913.5 }, egressCountry: 'US' } },
    { index: 3, before: metrics(4500), after: metrics(4600), job: { benchmarkIndexes: { before: 1050, after: 2969 }, egressCountry: 'US' } },
  ];
  return {
    schema: 'perf-ab/pagespeed-v1',
    requestId: 'request-1234',
    status: 'ok',
    names: ['before', 'after'],
    runsPerVariant: 3,
    url: 'https://user:secret@www.adobe.com/products.html?api_key=SECRET#frag',
    variants: { before: { url: 'https://www.adobe.com/products.html?token=SECRET' }, after: { url: 'https://www.adobe.com/products.html?q=private' } },
    profile,
    profileKey: 'lh13.6.0-mobile-devtools-rtt150-tput1638.4-lat562.5-down1474.56-up675-cpu4-412x823@1.75-mobile',
    egress: { ok: true, country: 'US', checks: [{ ip: '192.0.2.1', city: 'private-city', region: 'private-region' }] },
    target: { addresses: ['10.0.0.1'] },
    documentGeo: [{ status: 'US', headers: { 'x-private': 'SECRET' } }],
    pairs,
    runs: [],
    samples: { requested: 3, before: 200, after: 200, pairs: 200, rejected: 0 },
    medians: { before: metrics(4500), after: metrics(4300), delta: { performance: 0, FCP: 0, LCP: -18, SI: 0, TBT: 0, CLS: 0 } },
    edits: { after: { headInject: true, priorities: [{ path: '/libs/a.js', priority: 'high' }], patches: [{ path: '/libs/a.js', find: 'PRIVATE_FIND', replace: 'PRIVATE_REPLACE' }], sources: { '/libs/b.js': 'https://secret.adobe.com/?api_key=SECRET' } } },
    hints: { requestedLinks: 57, perPair: [{ pair: 1, usedLinks: 57, contextual: 0, dropped: 0 }, { pair: 2, usedLinks: 57, contextual: 0, dropped: 0 }, { pair: 3, usedLinks: 57, contextual: 0, dropped: 0 }], contextual: ['https://private.example/?api_key=SECRET'] },
    rejected: [{ variant: 'after', run: 2, attempt: 1, reason: 'failed https://www.adobe.com/?secret=SECRET', kind: 'runtime' }],
    ...overrides,
  };
}

test('sanitizes target URLs to strict HTTPS adobe subdomains without credentials or query data', () => {
  assert.equal(sanitizeTargetUrl('https://user:pass@www.adobe.com/a?api_key=secret#frag'), 'https://www.adobe.com/a');
  for (const url of [
    'http://www.adobe.com/', 'https://adobe.com/', 'https://evil-adobe.com/', 'https://www.adobe.com:8443/',
    'https://www.adobe.com.evil.example/',
  ]) assert.equal(sanitizeTargetUrl(url), null, url);
});

test('normalizes paired results, recomputes paired medians and trusts validated sample rows only', () => {
  const detail = normalizeResult(result({
    sourcePrs: [{
      repo: 'adobecom/milo', number: 7095, baseRef: 'stage', headRef: 'MWPW-213916',
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40),
      files: [{ status: 'modified', path: '/libs/utils/utils.js', blobSha: 'd'.repeat(40) }],
    }],
    sourceDrift: [{
      path: '/libs/utils/utils.js', repo: 'adobecom/milo', number: 7095, pair: 1,
      expectedMergeBaseSha256: 'e'.repeat(64), productionSha256: 'f'.repeat(64), productionStatus: 200, status: 'drift',
    }],
    warnings: [{ kind: 'production-source-drift', path: '/libs/utils/utils.js', repo: 'adobecom/milo', number: 7095, pair: 1 }],
  }), ghRun(), artifact, Date.parse('2026-11-03T00:00:00Z'));
  assert.equal(detail.status, 'ok');
  assert.equal(detail.url, 'https://www.adobe.com/products.html');
  assert.equal(detail.medians.before.LCP, 4500);
  assert.equal(detail.medians.after.LCP, 4300);
  assert.equal(detail.medians.delta.LCP, 100, 'median paired delta is not the difference between group medians');
  assert.deepEqual(detail.samples, { requested: 3, before: 3, after: 3, pairs: 3, rejected: 1 });
  assert.deepEqual(detail.pairs.map((p) => p.job.benchmarkIndexes), [
    { before: 2368.5, after: 3103 }, { before: 2368.5, after: 2913.5 }, { before: 1050, after: 2969 },
  ]);
  assert.equal(detail.warnings[0].kind, 'environment-variability');
  assert.equal(detail.changes.patchPaths[0], '/libs/a.js');
  assert.equal(detail.changes.sourcePaths[0], '/libs/b.js');
  assert.equal(detail.changes.prSources[0].headSha, 'b'.repeat(40));
  assert.equal(detail.changes.prSources[0].files[0].path, '/libs/utils/utils.js');
  assert.equal(detail.changes.sourceDrift[0].status, 'drift');
  assert.equal(detail.warnings.find((w) => w.kind === 'production-source-drift').repo, 'adobecom/milo');
  assert.equal(detail.changes.hints.used, 57, 'per-pair counts are not summed');
  assert.equal(detail.changes.hints.contextual, 0);
  assert.deepEqual(detail.changes.hints.pairs.map((p) => p.used), [57, 57, 57]);

  const parsed = dashboard.parseRun(detail, detail.id);
  assert.equal(parsed.medians.delta.LCP, 100);
  assert.equal(parsed.us, true);
  assert.equal(dashboard.cpuVariability(parsed.pairs).varied, true);
  assert.equal(parsed.changes.prSources[0].headSha, 'b'.repeat(40));
  assert.equal(parsed.changes.sourceDrift[0].status, 'drift');
  assert.equal(parsed.warnings.find((w) => w.kind === 'production-source-drift').path, '/libs/utils/utils.js');
});

test('imports legacy result arrays by run index and does not duplicate scalar CPU into both variants', () => {
  const old = result({
    pairs: undefined,
    runs: [
      { variant: 'before', run: 1, metrics: metrics(4000), benchmarkIndex: 2368.5 },
      { variant: 'after', run: 1, metrics: metrics(3900), benchmarkIndex: 3103 },
      { variant: 'before', run: 2, metrics: metrics(5000), benchmarkIndex: 2368.5 },
      { variant: 'after', run: 2, metrics: metrics(4900), benchmarkIndex: 2913.5 },
      { variant: 'before', run: 3, metrics: metrics(4500), benchmarkIndex: 1050 },
      { variant: 'after', run: 3, metrics: metrics(4400), benchmarkIndex: 2969 },
    ],
    samples: { requested: 3 },
  });
  const detail = normalizeResult(old, ghRun(), artifact);
  assert.equal(detail.pairs.length, 3);
  assert.deepEqual(detail.pairs.map((p) => p.job.benchmarkIndexes), [
    { before: 2368.5, after: 3103 }, { before: 2368.5, after: 2913.5 }, { before: 1050, after: 2969 },
  ]);
  assert.equal(detail.warnings.length, 1);
  const onlyBefore = normalizeResult(result({
    pairs: [{ index: 1, before: metrics(4000), after: metrics(3900), job: { benchmarkIndex: 1750 } }],
    runs: [],
    names: ['before', 'after'],
  }), ghRun(), artifact);
  assert.deepEqual(onlyBefore.pairs[0].job.benchmarkIndexes, { before: null, after: null });
  assert.equal(resultAttemptMatches({ github: { runAttempt: 2 } }, 2), true);
  assert.equal(resultAttemptMatches({ github: { runAttempt: 1 } }, 2), false);
  assert.equal(resultAttemptMatches({ github: {} }, 1), true);
  assert.equal(resultAttemptMatches({ github: {} }, 2), false);
});

test('explicit non-US page geo fails the run; an omitted geo header keeps verified runner egress', () => {
  const nonUs = normalizeResult(result({ documentGeo: [{ status: 'non-US', headers: { secret: 'x' } }] }), ghRun(), artifact);
  assert.equal(nonUs.status, 'failed');
  assert.equal(nonUs.errorCode, 'non-us-egress');
  assert.equal(nonUs.egress.verified, false);

  const unavailable = normalizeResult(result({ documentGeo: [{ status: 'unavailable', headers: { secret: 'x' } }] }), ghRun(), artifact);
  assert.equal(unavailable.egress.documentGeo, 'unavailable');
  assert.equal(unavailable.egress.verified, true);
  assert.equal(dashboard.parseRun(unavailable).us, true);
});

test('a successful artifact with the wrong Lighthouse profile is not published as successful', () => {
  const mismatched = normalizeResult(result({ profile: { ...profile, lighthouseVersion: '13.5.0' } }), ghRun(), artifact);
  assert.equal(mismatched.status, 'failed');
  assert.equal(mismatched.errorCode, 'profile-mismatch');
  const simulated = normalizeResult(result({ profile: { ...profile, throttlingMethod: 'simulate', cpuSlowdownMultiplier: 1.2, requestLatencyMs: undefined } }), ghRun(), artifact);
  assert.equal(simulated.errorCode, 'profile-mismatch', 'former simulated-throttling results are never published as comparable');
});

test('public documents contain no raw artifact diagnostics, request secrets, IPs, or edit payloads', () => {
  const detail = normalizeResult(result(), ghRun(), artifact);
  const serialized = JSON.stringify(detail);
  for (const secret of ['SECRET', 'PRIVATE_FIND', 'PRIVATE_REPLACE', 'private-city', 'private-region', '192.0.2.1', '10.0.0.1', 'private.example']) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
  assert.equal(detail.rejectedAttempts[0].reason, 'lighthouse-failed');
  assert.equal(detail.artifact.expiresAt, '2026-12-03T11:54:24.000Z');
  const summary = summaryFromDetail(detail);
  assert.equal(summary.artifact, undefined);
  assert.equal(summary.pairs, undefined);
});

test('invalid/missing results stay explicit rather than becoming successful zero-valued records', () => {
  assert.throws(() => normalizeResult({ schema: 'wrong' }, ghRun(), artifact), /unsupported perf-ab result schema/);
  const missing = missingArtifactDocument(ghRun({ conclusion: 'failure' }));
  assert.equal(missing.status, 'failed');
  assert.equal(missing.errorCode, 'no-artifact');
  assert.equal(missing.medians.after, null);

  const noMetrics = normalizeResult(result({
    pairs: [{ index: 1, before: metrics(4000), after: null }],
    runs: [],
    medians: { before: metrics(4000), after: metrics(3900), delta: { LCP: -100 } },
    samples: { requested: 3, before: 3, after: 3, pairs: 3 },
  }), ghRun(), artifact);
  assert.equal(noMetrics.status, 'failed');
  assert.equal(noMetrics.errorCode, 'artifact-invalid');
  assert.equal(noMetrics.medians.after, null);

  const fewerPairs = normalizeResult(result({
    samples: { requested: 5, before: 3, after: 3, pairs: 3 },
  }), ghRun(), artifact);
  assert.equal(fewerPairs.status, 'partial');
  assert.equal(fewerPairs.errorCode, 'pairs-incomplete');
  assert.equal(fewerPairs.samples.pairs, 3);
});

test('merge preserves immutable prior runs, deduplicates attempts, and re-sanitizes existing details', () => {
  const first = normalizeResult(result(), ghRun(), artifact);
  const other = normalizeResult(result({ url: 'https://www.adobe.com/other.html?key=private' }), ghRun({ id: 41633898463 }), artifact);
  const existing = { schema: 'perf-ab/history-v1', updatedAt: '2026-11-02T00:00:00Z', runs: [summaryFromDetail(first)] };
  const unsafeExisting = {
    ...first,
    arbitrarySecret: 'must-not-survive',
    changes: { ...first.changes, find: 'must-not-survive' },
  };
  const merged = mergeHistory(existing, [other, { ...first, name: 'changed-copy' }], Date.parse('2026-11-03T00:00:00Z'), { [first.id]: unsafeExisting });
  assert.deepEqual(merged.index.runs.map((r) => r.id), ['41633898463-1', '41633898462-1']);
  assert.equal(merged.index.runs.find((r) => r.id === first.id).name, first.name, 'existing run-attempt record is immutable');
  assert.ok(!JSON.stringify([...merged.details.values()]).includes('must-not-survive'));
  assert.equal(merged.details.get(first.id).id, first.id);
  assert.throws(() => mergeHistory({ schema: 'wrong', runs: [] }, []), /unsupported schema/);
});

test('re-sanitizing a published detail is idempotent and preserves per-pair hint summaries', () => {
  const first = normalizeResult(result({
    hints: {
      requestedLinks: 57,
      contextualCount: 2,
      droppedCount: 0,
      perPair: [1, 2, 3].map((pair) => ({ pair, usedLinks: 57, contextual: 2, dropped: 0 })),
    },
  }), ghRun(), artifact);
  const reSanitize = (detail) => mergeHistory(
    { schema: 'perf-ab/history-v1', runs: [summaryFromDetail(detail)] },
    [],
    Date.parse('2026-11-03T00:00:00Z'),
    { [detail.id]: detail },
  ).details.get(detail.id);
  const once = reSanitize(first);
  const twice = reSanitize(once);
  assert.deepEqual(twice, once);
  assert.equal(once.changes.hints.contextual, 2);
  assert.deepEqual(once.changes.hints.pairs, [
    { pair: 1, used: 57, contextual: 2, dropped: 0 },
    { pair: 2, used: 57, contextual: 2, dropped: 0 },
    { pair: 3, used: 57, contextual: 2, dropped: 0 },
  ]);
  assert.deepEqual(once.changes.kinds, ['headInject', 'priorities', 'patches', 'sources', 'query']);
});
