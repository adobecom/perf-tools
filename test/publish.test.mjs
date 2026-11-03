import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedCompletedRun, safeResultsEntry } from '../lib/pagespeed/publish.mjs';

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
