import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { isTrustedCompletedRun, safeResultsEntry, selectFullArtifact, selectFullArtifacts, selectResultsArtifacts, fullArtifactForResults, publishRuns } from '../lib/pagespeed/publish.mjs';
import { normalizeResult, summaryFromDetail } from '../lib/pagespeed/history.mjs';

const run = {
  id: 41633898462,
  workflow_id: 123,
  status: 'completed',
  event: 'workflow_dispatch',
  head_branch: 'main',
};

test('only completed main-branch perf-ab dispatches are importable', () => {
  assert.equal(isTrustedCompletedRun(run, 123), true);
  assert.equal(isTrustedCompletedRun({ ...run, status: 'in_progress' }, 123), false);
  assert.equal(isTrustedCompletedRun({ ...run, id: 41631057971 }, 123), false);
  assert.equal(isTrustedCompletedRun({ ...run, event: 'pull_request' }, 123), false);
  assert.equal(isTrustedCompletedRun({ ...run, head_branch: 'feature' }, 123), false);
  assert.equal(isTrustedCompletedRun(run, 124), false);
});

test('combined artifacts require the root aggregate results.json, never an individual pair result', () => {
  assert.equal(safeResultsEntry(['results.json', 'pair1/results.json']), 'results.json');
  assert.equal(safeResultsEntry(['pair1/results.json', 'pair2/results.json']), null);
});

test('result-only artifacts are never used as report links, and full metadata matches the request', () => {
  const results = { id: 13228774534, name: 'perf-ab-mw0nfld0-cebtakma-results', expired: false };
  const full = { id: 13228639242, name: 'perf-ab-mw0nfld0-cebtakma', expires_at: '2027-02-01T12:13:27Z', expired: false };
  const unrelated = { id: 13228639243, name: 'perf-ab-another-request', expires_at: '2027-02-01T12:13:27Z', expired: false };
  assert.deepEqual(selectResultsArtifacts([results, full]).map((a) => a.name), [results.name]);
  assert.deepEqual(selectFullArtifacts([results, full]).map((a) => a.name), [full.name]);
  assert.equal(selectFullArtifact([results, unrelated], 'mw0nfld0-cebtakma'), null);
  assert.equal(fullArtifactForResults([results], results, 'mw0nfld0-cebtakma'), null);
  assert.equal(fullArtifactForResults([results, full, unrelated], results, 'mw0nfld0-cebtakma'), full);
});

test('published run artifact repair changes only the link metadata and remains idempotent', async (t) => {
  const runId = 41633898462;
  const run = {
    id: runId,
    workflow_id: 123,
    run_attempt: 1,
    status: 'completed',
    event: 'workflow_dispatch',
    head_branch: 'main',
    conclusion: 'success',
    created_at: '2026-11-02T12:00:00Z',
    updated_at: '2026-11-02T12:30:00Z',
    head_sha: 'faa7259b9ce33463c387752efcd0d3d0169291',
  };
  const oldArtifact = {
    id: 13228774534,
    name: 'perf-ab-mw0nfld0-cebtakma-results',
    expires_at: '2027-02-01T12:13:27Z',
    expired: false,
  };
  const fullArtifact = {
    id: 13228639242,
    name: 'perf-ab-mw0nfld0-cebtakma',
    expires_at: '2027-02-01T12:13:27Z',
    expired: false,
  };
  const metrics = { performance: 50, FCP: 3000, LCP: 4000, SI: 4200, TBT: 100, CLS: 0.01 };
  const original = normalizeResult({
    schema: 'perf-ab/pagespeed-v1',
    requestId: 'mw0nfld0-cebtakma',
    status: 'ok',
    names: ['before', 'after'],
    runsPerVariant: 3,
    url: 'https://www.adobe.com/acrobat/plans.html',
    profile: {
      name: 'Lighthouse mobile, DevTools throttling (Slow 4G, Moto G Power)', lighthouseVersion: '13.6.0', chromeVersion: '142.0.7444.59',
      formFactor: 'mobile', throttlingMethod: 'devtools', rttMs: 150, throughputKbps: 1638.4,
      requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675, cpuSlowdownMultiplier: 4, maxWaitForLoad: 120000, width: 412, height: 823, deviceScaleFactor: 1.75,
    },
    profileKey: 'lh13.6.0-mobile-devtools-rtt150-tput1638.4-lat562.5-down1474.56-up675-cpu4-load120000-412x823@1.75-mobile',
    egress: { ok: true, country: 'US' },
    documentGeo: [],
    pairs: [1, 2, 3].map((index) => ({ index, before: metrics, after: { ...metrics, LCP: 3900 }, job: {} })),
  }, run, oldArtifact);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const detailPath = path.join(root, 'site/data/runs', `${runId}-1.json`);
  fs.mkdirSync(path.dirname(detailPath), { recursive: true });
  fs.writeFileSync(detailPath, `${JSON.stringify(original, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'site/data/index.json'), `${JSON.stringify({
    schema: 'perf-ab/history-v1',
    updatedAt: run.updated_at,
    runs: [summaryFromDetail(original)],
  }, null, 2)}\n`);

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    let response;
    if (req.url === '/repos/adobecom/perf-tools/actions/workflows/perf-ab.yml') response = { id: 123 };
    else if (req.url === `/repos/adobecom/perf-tools/actions/runs/${runId}`) response = run;
    else if (req.url === `/repos/adobecom/perf-tools/actions/runs/${runId}/artifacts?per_page=100&page=1`) response = { artifacts: [oldArtifact, fullArtifact] };
    else {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  await publishRuns({
    root,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
    runIds: [String(runId)],
    now: Date.parse('2026-11-03T00:00:00Z'),
  });
  const repaired = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
  assert.deepEqual(repaired.artifact, {
    name: fullArtifact.name,
    url: `https://github.com/adobecom/perf-tools/actions/runs/${runId}/artifacts/${fullArtifact.id}`,
    expiresAt: '2027-02-01T12:13:27.000Z',
    expired: false,
  });
  assert.deepEqual(repaired.medians, original.medians);
  assert.deepEqual(repaired.pairs, original.pairs);
  const { artifact: repairedArtifact, ...repairedValues } = repaired;
  const { artifact: previousArtifact, ...previousValues } = original;
  assert.deepEqual(repairedValues, previousValues, 'metadata repair must preserve every other published detail field');
  assert.equal(previousArtifact.name, oldArtifact.name);

  await publishRuns({
    root,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
    runIds: [String(runId)],
    now: Date.parse('2026-11-03T00:00:00Z'),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(detailPath, 'utf8')), repaired);
});

test('history cutoff excludes old runs from sweeps and explicit imports, while keeping future runs eligible', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-cutoff-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'site/data');
  fs.mkdirSync(data, { recursive: true });
  const cutoff = '2026-11-03T15:59:33.532Z';
  fs.writeFileSync(path.join(data, 'history-policy.json'), JSON.stringify({
    schema: 'perf-ab/history-policy-v1',
    cutoff,
  }));
  fs.writeFileSync(path.join(data, 'index.json'), JSON.stringify({
    schema: 'perf-ab/history-v1',
    updatedAt: cutoff,
    runs: [{ id: '41631057972-1', createdAt: '2026-11-03T11:52:43.000Z', status: 'ok' }],
  }));

  const oldRun = {
    ...run,
    id: 41631057972,
    run_attempt: 1,
    created_at: '2026-11-03T11:52:43Z',
    updated_at: '2026-11-03T11:54:30Z',
    conclusion: 'success',
  };
  const futureRun = {
    ...run,
    id: 41700000001,
    run_attempt: 1,
    created_at: '2026-11-03T16:00:00Z',
    updated_at: '2026-11-03T16:01:00Z',
    conclusion: 'success',
  };
  let sweepRuns = [oldRun, futureRun];
  const byId = new Map([[oldRun.id, oldRun], [futureRun.id, futureRun]]);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://127.0.0.1');
    let response;
    if (url.pathname === '/repos/adobecom/perf-tools/actions/workflows/perf-ab.yml') response = { id: 123 };
    else if (url.pathname === '/repos/adobecom/perf-tools/actions/workflows/perf-ab.yml/runs') response = { workflow_runs: sweepRuns };
    else {
      const match = /^\/repos\/adobecom\/perf-tools\/actions\/runs\/(\d+)(\/artifacts)?$/.exec(url.pathname);
      if (match && match[2]) response = { artifacts: [] };
      else if (match) response = byId.get(Number(match[1]));
    }
    if (!response) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const options = { root, apiUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: Date.parse(cutoff) };

  const swept = await publishRuns({ ...options, sweep: true });
  assert.equal(swept.excludedExisting, 1);
  assert.deepEqual(swept.excludedRunIds, [String(oldRun.id)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8')).runs.map((entry) => entry.id), ['41700000001-1']);

  const explicit = await publishRuns({ ...options, runIds: [String(oldRun.id)] });
  assert.deepEqual(explicit.excludedRunIds, [String(oldRun.id)]);
  assert.equal(explicit.total, 1);

  fs.writeFileSync(path.join(data, 'index.json'), JSON.stringify({
    schema: 'perf-ab/history-v1',
    updatedAt: cutoff,
    runs: [],
  }));
  sweepRuns = [oldRun];
  const resetSweep = await publishRuns({ ...options, sweep: true });
  assert.deepEqual(resetSweep.excludedRunIds, [String(oldRun.id)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8')).runs, []);
  await publishRuns({ ...options, sweep: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8')).runs, []);
});

test('invalid history policy fails before contacting GitHub', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-invalid-policy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'site/data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/data/history-policy.json'), '{');
  await assert.rejects(publishRuns({ root, token: 'test-token' }), /history policy is not valid JSON/);
});
