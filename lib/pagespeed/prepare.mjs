// Workflow "prepare" job: turns the workflow_dispatch inputs (passed only through environment variables) into the
// validated, encoded spec, the request id and the matrix of pair indexes. Exactly one of SPEC (CLI-encoded), CONFIG
// (repository experiments/**.json) or URL (measure one page unchanged) is required; RUNS overrides the run count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, REQUEST_ID, decodeSpec, encodeSpec, validateSpec } from './spec.mjs';
import { loadExperiment } from './experiment.mjs';
import { PR_REPOSITORIES, resolvePullRequests } from './pr-sources.mjs';

function workflowPrInputs(env) {
  const requests = [];
  for (const [key, repo] of [['MILO_PR', 'adobecom/milo'], ['MAS_PR', 'adobecom/mas']]) {
    const value = (env[key] ?? '').trim();
    if (!value) continue;
    if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new Error(`${key.toLowerCase()} must be a positive PR number`);
    requests.push({ repo, number: Number(value) });
  }
  return requests;
}

function mergePrRequests(configRequests, explicitRequests) {
  const requests = new Map((configRequests ?? []).map((r) => [r.repo, r]));
  for (const request of explicitRequests) requests.set(request.repo, request);
  if ([...requests.values()].some((r) => !Object.hasOwn(PR_REPOSITORIES, r.repo))) {
    throw new Error('pull request repository is not allowed');
  }
  return [...requests.values()];
}

export async function prepare(env, { root = process.cwd(), runId = env.GITHUB_RUN_ID, resolvePrs = resolvePullRequests } = {}) {
  const given = ['SPEC', 'CONFIG', 'URL'].filter((k) => (env[k] ?? '').trim());
  if (given.length !== 1) throw new Error(`exactly one of spec, config or url is required (got ${given.length ? given.join(', ').toLowerCase() : 'none'})`);
  const explicitPrs = workflowPrInputs(env);
  const runsIn = (env.RUNS ?? '').trim();
  if (runsIn && !/^(?:[1-9]|10)$/.test(runsIn)) throw new Error('runs must be an integer 1..10');
  const runs = runsIn ? Number(runsIn) : undefined;
  let spec;
  if (given[0] === 'SPEC') {
    if (explicitPrs.length) throw new Error('milo_pr/mas_pr workflow inputs cannot be combined with spec');
    spec = decodeSpec(env.SPEC.trim());
    if (runs && runs !== spec.runs) throw new Error('runs cannot override a CLI-encoded spec');
    if (spec.variants.after.localSources || spec.variants.after.sourcePrs) {
      throw new Error('spec may not supply pre-resolved PR source data');
    }
  } else if (given[0] === 'CONFIG') {
    const rel = env.CONFIG.trim();
    if (!CONFIG_PATH.test(rel)) throw new Error('config must be a repository path experiments/<name>.json');
    spec = loadExperiment(path.join(root, rel), { runs, config: rel });
    const requests = mergePrRequests(spec.variants.after.pullRequests, explicitPrs);
    if (requests.length) spec.variants.after.pullRequests = requests;
    else delete spec.variants.after.pullRequests;
  } else {
    const requests = mergePrRequests([], explicitPrs);
    const paired = requests.length > 0;
    spec = validateSpec({
      version: 1, runs: runs ?? 3, names: paired ? ['before', 'after'] : ['after'],
      variants: paired
        ? { before: { url: env.URL.trim() }, after: { url: env.URL.trim(), pullRequests: requests } }
        : { after: { url: env.URL.trim() } },
    });
  }
  const after = spec.variants.after;
  const requests = mergePrRequests(after.pullRequests, explicitPrs);
  if (requests.length) {
    if (after.localSources || after.sourcePrs) throw new Error('spec may not supply pre-resolved PR source data');
    const resolved = await resolvePrs(requests);
    delete after.pullRequests;
    if (Object.keys(resolved.localSources).length) after.localSources = resolved.localSources;
    after.sourcePrs = resolved.sourcePrs;
    if (!spec.names.includes('before')) {
      spec.names = ['before', 'after'];
      spec.variants.before = { url: after.url };
    }
  } else {
    delete after.pullRequests;
  }
  validateSpec(spec);
  const encoded = encodeSpec(spec);
  const requestId = (env.REQUEST_ID ?? '').trim() || `gh-run-${runId}`;
  if (!REQUEST_ID.test(requestId)) throw new Error('invalid request id');
  return { spec: encoded, requestId, runs: spec.runs, pairs: Array.from({ length: spec.runs }, (_, i) => i + 1), names: spec.names, url: spec.variants.after.url };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const p = await prepare(process.env);
    const lines = [`spec=${p.spec}`, `request_id=${p.requestId}`, `runs=${p.runs}`, `pairs=${JSON.stringify(p.pairs)}`];
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    console.log(`request ${p.requestId}: ${p.url}, ${p.runs} pair job(s) x ${p.names.join('/')}`);
  } catch (e) {
    console.error(`perf-ab prepare: ${e.message}`);
    process.exit(1);
  }
}
