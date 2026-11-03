// Workflow "prepare" job: turns the workflow_dispatch inputs (passed only through environment variables) into the
// validated, encoded spec, the request id and the matrix of pair indexes. Exactly one of SPEC (CLI-encoded), CONFIG
// (repository experiments/**.json) or URL (measure one page unchanged) is required; RUNS overrides the run count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, REQUEST_ID, decodeSpec, encodeSpec, validateSpec } from './spec.mjs';
import { loadExperiment } from './experiment.mjs';

export function prepare(env, { root = process.cwd(), runId = env.GITHUB_RUN_ID } = {}) {
  const given = ['SPEC', 'CONFIG', 'URL'].filter((k) => (env[k] ?? '').trim());
  if (given.length !== 1) throw new Error(`exactly one of spec, config or url is required (got ${given.length ? given.join(', ').toLowerCase() : 'none'})`);
  const runsIn = (env.RUNS ?? '').trim();
  if (runsIn && !/^(?:[1-9]|10)$/.test(runsIn)) throw new Error('runs must be an integer 1..10');
  const runs = runsIn ? Number(runsIn) : undefined;
  let spec;
  if (given[0] === 'SPEC') {
    spec = decodeSpec(env.SPEC.trim());
    if (runs && runs !== spec.runs) throw new Error('runs cannot override a CLI-encoded spec');
  } else if (given[0] === 'CONFIG') {
    const rel = env.CONFIG.trim();
    if (!CONFIG_PATH.test(rel)) throw new Error('config must be a repository path experiments/<name>.json');
    spec = loadExperiment(path.join(root, rel), { runs, config: rel });
  } else {
    spec = validateSpec({ version: 1, runs: runs ?? 3, names: ['after'], variants: { after: { url: env.URL.trim() } }, expect: {} });
  }
  const requestId = (env.REQUEST_ID ?? '').trim() || `gh-run-${runId}`;
  if (!REQUEST_ID.test(requestId)) throw new Error('invalid request id');
  return { spec: encodeSpec(spec), requestId, runs: spec.runs, pairs: Array.from({ length: spec.runs }, (_, i) => i + 1), names: spec.names, url: spec.variants.after.url };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const p = prepare(process.env);
    const lines = [`spec=${p.spec}`, `request_id=${p.requestId}`, `runs=${p.runs}`, `pairs=${JSON.stringify(p.pairs)}`];
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    console.log(`request ${p.requestId}: ${p.url}, ${p.runs} pair job(s) x ${p.names.join('/')}`);
  } catch (e) {
    console.error(`perf-ab prepare: ${e.message}`);
    process.exit(1);
  }
}
