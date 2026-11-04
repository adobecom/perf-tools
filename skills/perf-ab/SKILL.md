---
name: perf-ab
description: Run before/after page-load performance comparisons with the `perf-ab` CLI (adobecom/perf-tools). Always runs real Lighthouse 13.6.0 with the mobile profile and real DevTools throttling (Moto G Power, Slow 4G, 4x CPU), by default on a GitHub Actions runner with verified US egress, or on this machine with --local when the user says to run it locally; cold (new Chrome + empty profile per run, no warm-ups), alternating runs; downloads the official Lighthouse reports, traces and before/after medians. Compares a production page (e.g. www.adobe.com) as-is against an injected head.html snippet (e.g. preload links), fetchpriority changes, guarded source patches, Milo / MAS PR files or branch values. Also analyzes DevTools trace JSON files attached by the user. Use when asked to "compare before and after", "A/B test", "perf test a milo/mas PR or branch", "measure the impact on LCP/TBT/PageSpeed score", "test preloads", "run traces", or when the user attaches Trace-*.json files to compare.
---

# Before/after comparison (`perf-ab`)

CLI from `adobecom/perf-tools` (needs Node 22.19+; Actions runs also need `gh` authenticated with Actions write access to `adobecom/perf-tools`, `--local` runs need Chrome). Check it is installed with `perf-ab --help`. If it is missing, replace `perf-ab` with `npx -y -p github:adobecom/perf-tools perf-ab` in every command below.

**This is how perf-ab measurements are done, and there is only one measurement.** Every `perf-ab` run is the Lighthouse run described below. The user never needs to say "Lighthouse" or pick a mode: never ask which measurement to use, and never offer another one. The only choice is where it runs:
- **GitHub Actions (default).** Plain `perf-ab <url> ...`. Use this unless the user asks to run locally.
- **This machine: add `--local`.** When the user says "run locally", "on my machine", "local run" or similar, append `--local` to the same command (same options, same output). It needs Chrome (`CHROME_PATH`, or a common macOS/Linux install location; the CLI errors clearly if none is found) but not `gh`. Pairs run one after another, so it is slower than Actions for large `-n`. A non-US location is accepted only here and is shown honestly (see "Local runs" below).

Do not write one-off measurement scripts, and never switch to `--local` on your own when an Actions run fails: report the failure and let the user decide.

Conditions (identical in both locations; do not substitute others):
- Real **Lighthouse 13.6.0**, mobile preset with real **DevTools throttling** (`throttlingMethod: devtools`): emulated Moto G Power (412x823, 1.75 DPR), Slow 4G applied by Chrome (562.5 ms request latency, 1474.56 kb/s down, 675 kb/s up) and a 4x CPU slowdown (`CPU_SLOWDOWN_MULTIPLIER`, `lib/pagespeed/stats.mjs`), with `maxWaitForLoad` raised to 120 s (default 45 s is too short for heavy pages under real throttling; it is part of the profile and `profileKey`). The load is really throttled, so `trace.json`, the metrics and the audits describe the same load; there is no simulated (Lantern) variant and no option for one. Metrics are Lighthouse's own: performance score, FCP, LCP, Speed Index, TBT, CLS.
- On Actions: the `perf-ab` workflow of `adobecom/perf-tools` (manual `workflow_dispatch`; the CLI dispatches it, waits and downloads the artifact). The job verifies **US egress** with neutral geolocation services before touching the site and fails closed if it is non-US or unknown; the page's `Server-Timing: geo;desc=XX` must also be US when present.
- Changes for "after" are applied by a per-run proxy on the runner that keeps HTTP/2 and real compressed sizes (unchanged responses are byte-identical; edited ones are re-compressed with Brotli quality 6). Its temporary certificate is trusted only by that Chrome process and never uploaded.

Cold-run policy: every measured run starts cold. Runs alternate before/after; each run, and each retry of it, launches a new Chrome process with an empty temporary profile (and a fresh proxy), so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over. There are no warm-up loads; every load is measured and counted. Lighthouse's storage reset stays on and a run whose first document response came from a cache is rejected. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

Paired matrix: `-n N` measures N pairs (parallel Actions jobs, or one after another with `--local`); each is ONE complete cold before/after pair on the same machine. Medians per variant and the median per-pair delta use complete pairs only. A missing or failed pair makes the result `partial` (no pair: `failed`) and the command exits 1; report it as incomplete, never as a result. Runners are not identical hardware: each pair records its runner, Chrome version and the CPU benchmark of each variant's run (`job.benchmarkIndexes`), and comparisons are made within pairs. If `results.json` has an `environment-variability` warning, show it next to the numbers and call the deltas indicative, not a confirmed gain; never drop, hide or re-run slow valid runs and never add warm-ups to smooth it out.

Accepted runs only: Lighthouse must finish without a runtime error, every metric must be a finite number, and the render guard must pass (non-hidden body, plus `--expect-title` / `--expect-count`). A rejected attempt (for example NO_FCP or a broken render) is saved under `rejected/` and retried with a fresh browser, up to 3 attempts per run. If a run never succeeds, or any infrastructure step fails, the command exits non-zero and `results.json` has `status: "failed"`: report the failure, never a partial result.

Run it async; an Actions job takes several minutes (queueing plus about 2 to 4 minutes per pair, pairs run in parallel); a local run takes about that long per pair, one after another. **Start with a smoke test of one pair (`-n 1`)** and check the reports and the render before a full campaign (`-n 5`; real throttling is more variable than simulation, so do not use fewer for a result).

Reviewed optimizations live as versioned configs under `experiments/` (schema `perf-ab/experiment-v1`; see the README). Run them with `perf-ab --config experiments/acrobat-plans.json -n 1 -o ./ab-smoke`, then `-n 5`. The workflow reads the committed copy on `--ref` (default `main`): commit and push config changes first (the CLI refuses a config that differs from `origin/<ref>`). `--config` cannot be combined with a URL or change options. The same config can be started from the Actions "Run workflow" form (`config`, `runs`, and optional `milo_pr` / `mas_pr` fields).

Output (`-o <dir>`, default `./traces`; earlier results in that folder are removed first):
- `results.json` (aggregate): `status` (`ok` / `partial` / `failed`), `errorKind`, `samples` (`requested`, `pairs`, `before`, `after`, `rejected`), `medians` (`before`, `after`, `delta` = median per-pair delta), `pairs[]` (per-pair metrics, delta, `job` metadata), `profile`, `profileKey`, `egress`, `experiment`, `github`, `hints` (requested / used / contextual / dropped).
- `pair<i>/results.json`: the job's own result (`egress` checks, resolved `profile`, `lighthouseVersion`, `chromeVersion`, `cold` flags, `runs` with first document response and render check, `rejected`).
- `pair<i>/<variant><i>/`: `report.html` and `report.json` (the official Lighthouse reports; share these, never a hand-made summary), `trace.json` and `devtoolslog.json` (raw), `run.json` (render check, proxy request log with original and served encoded sizes, document geo).
- For PR-backed overrides, `run.json` records `sourcePrs[]` (resolved `baseSha`, `headSha`, `mergeBaseSha`, and mapped file paths/blob SHAs) and `servedSources[]` (only after sources that were actually served, with those commits plus the exact checkout blob and SHA-256). `results.json` also carries the pinned PR refs and production-vs-merge-base source hashes. A `production-source-drift` warning means the unchanged production control differs from the PR's pinned merge-base file; interpret the measurement as production versus the full pinned PR file, not just the intended code change.
- `pair<i>/rejected/<variant><i>-attempt<k>/`: the same for rejected attempts.
- The console prints each pair, the medians per variant, the median delta, the hint usage and the workflow run URL.
- Only compare results with the same `profileKey` (Lighthouse version, form factor, throttling method, RTT, throughput, request latency, download/upload throughput, CPU multiplier, load wait, viewport, DPR, mobile); results from the former simulated throttling have another key and are refused by the aggregate **and** the same `where`. Local and Actions results are never comparable, even with an identical `profileKey`, and neither are local results from different machines.

### Local runs (`--local`)

Same spec, job and aggregate code as Actions, so `results.json`, `pair<i>/...`, medians and the console summary have the same shape. Differences, all recorded in `results.json` and never hidden:
- `where: "local"` (`mode: "pagespeed-local-paired"`), `egress.where: "local"`, the real `egress.country` and `egress.ok: false` when it is not US. A non-US egress or non-US `Server-Timing: geo` adds `local-non-us-egress` / `local-non-us-document` warnings, and every local aggregate has a `local-results-not-comparable` warning. An unknown egress country still fails the run.
- Never call a local result "US" or verified, and always show the warnings next to the numbers. State that it is a local run from the reported country.
- `--local` never dispatches a workflow. `--milo-pr` / `--mas-pr` read the GitHub API from this machine with `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when available (never log or print it); a 403 means rate limiting, so ask the user to set a token or run `gh auth login`.
- `--config` uses the local copy of the config (no commit/push needed); PR inputs, head injection and patches work exactly as on Actions.

## 1. Choose the change

Without change options the URL is measured as-is (`after<i>/` only). With any change option, "before" is the unchanged production page and "after" has the changes.

### a. Preload links / head.html snippet

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html \
  --fetchpriority /libs/utils/utils.js=high -n 1 --expect-title "Acrobat plans" --expect-count merch-card=19
```

- `--head-inject <file>` inserts the HTML into the "after" document before the first `<script>` in `<head>`. Build the snippet with the `perf-preload` skill.
- Hints whose URL carries country/locale parameters (e.g. MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the US baseline run's own requests; hints with no matching US request are dropped and reported in `results.json` `hints`. Never hand-edit `country=CH` into `country=US` where the real consumer omits the parameter. `/experienceedge` hints are always dropped.
- **The injected snippet is the only source of preloads for the after page.** With `--head-inject` (or a config's `headInject`, on Actions and with `--local`), perf-ab unsets every `rel=preload` / `rel=modulepreload` entry of the after document's `Link` response header (other `Link` entries stay; before is untouched). Nothing to pass; without `--head-inject` nothing is unset. Report it: `results.json` `hints.linkHeaderStripped` (count) and `hints.linkHeaderEntries` (the entries) are also printed in the console. Say the comparison is production headers + HTML vs snippet-only.
- `--fetchpriority /path=high|low|auto` (repeatable) sets the priority on matching injected hints (and on `Link` header entries only when no snippet is injected, since the header preloads are unset otherwise).
- Do not use `?mep=off` on the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.
- Check: `hints.usedLinks` vs `requestedLinks`, and in the "after" report's network requests each preloaded file is fetched once and early.

### b. Guarded source patch

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --patch ./market-config.json -n 1
```

`{"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}`: each `find` must match the live file exactly once, otherwise the job fails (the live source changed). Applies to "after" only; everything else stays production. Combine with `--head-inject` / `--fetchpriority` to test a combined optimization.

### c. Milo / MAS PR delta

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 5
```

- Mapping: Milo `libs/**` becomes `/libs/**`; MAS `web-components/dist/**` becomes `/mas/libs/**`. Only PRs whose base and head repositories are respectively `adobecom/milo` and `adobecom/mas` are accepted.
- The workflow resolves the PR diff and pins its base, head, and merge-base commits before matrix workers start. Each runner fetches the exact commit into an isolated local checkout and serves only changed mapped files through the existing measuring proxy. No branch code is executed and the measured page never fetches a PR branch or `aem.live` URL.
- "Before" remains the unchanged production page; "after" uses the pinned PR version only for changed mapped files. All other responses remain production. Added, removed, and renamed files are represented explicitly. The source branch moving after resolution cannot change the run.
- In the Actions **Run workflow** form, select `config` or provide `url`, then optionally enter `milo_pr` and/or `mas_pr` with positive PR numbers. With a config, a nonempty form field overrides that repository's `after.pullRequests` entry for this run; an empty field leaves the config value unchanged. With a URL and any PR number, the workflow creates the production-before / PR-after pair. Do not combine PR number fields with the encoded CLI `spec` input.
- Inspect `run.json` `sourcePrs` and `servedSources` to confirm exact PR commits and source-file hashes. The `production-source-drift` warning identifies when production differs from the pinned merge base; the after side still uses the exact PR head, so do not describe that result as a market-fix-only comparison when unrelated source drift exists.

### d. Branch values (pages that honor `?milolibs=`)

```sh
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 5
```

- Baseline: a branch equal to upstream `stage` named `<name>-stage`; change: the same `stage` commit plus the change commits. Both pushed and based on the same `stage` commit.
- `www.stage.adobe.com/creativecloud/plans.html` ignores `milolibs`; use `https://stage--cc--adobecom.aem.live/creativecloud/plans`.

Other flags: `--local`, `--param`, `--suffix` (`--suffix ""` for raw values), `--before-query` / `--after-query`, `--repo`, `--ref`, `--timeout`. See `perf-ab --help`.

## 2. Read the results

- First confirm `status: "ok"` (not `partial`), `samples.pairs` equals `samples.requested`, `where` and `egress.country` (Actions: `US`; `--local`: the real country with its warnings), `lighthouseVersion: "13.6.0"` and the profile, and open one `report.html` per variant to check the page rendered as expected.
- Use the **medians** and the median per-pair `delta` in `results.json` (and `pairs[]` to spot outliers; do not drop or re-run outliers to change a result). With fewer than 5 runs per variant, treat small differences (a few score points, FCP / LCP under about 100 ms) as noise.
- The load was really throttled, so the Lighthouse metrics, `trace.json` and `devtoolslog.json` describe the same load and can be read together.
- Sanity checks: CLS and TBT should not regress, the request counts in `run.json` should be about the same, and `rejected` should be empty or explained.
- Repeat on a second, heavier page before a go / no-go. Check Safari and Firefox manually.

## 3. Analyzing DevTools traces the user attaches (Trace-*.json)

Parse with Python (`json.load(...)['traceEvents']`):

- The navigation start is `navigationStart` with a `documentLoaderURL` starting with `http`; `t0` is its `ts`. Take FCP / LCP / DCL / Load from `firstContentfulPaint`, `largestContentfulPaint::Candidate`, `domContentLoadedEventEnd` and `loadEventEnd`, filtered to the same `frame`.
- The renderer main thread is the `thread_name` event named `CrRendererMain`. TBT is the sum of (`RunTask` dur minus 50 ms) for tasks over 50 ms after FCP. Main-thread compile is the sum of `v8.compileModule` durations.
- Network: `ResourceSendRequest` / `ResourceReceiveResponse` / `ResourceFinish` joined on `requestId`. Preload vs modulepreload: `args.data.initiator.fetchType` is `link` for preload and `script` for modulepreload, with `stackTrace[0].functionName === 'loadLink'` (older traces use `initiator.stack.callFrames[0]`).
- Check the trace `metadata` (throttling, device) and the `documentLoaderURL` first. Confirm both traces used the same host and conditions before attributing differences to the change. Compare cold loads only: a DevTools trace recorded after an earlier load of the page in the same browser profile is warm (check `fromCache` / transfer sizes), and old perf-ab `*0.json` traces are warm-ups.

## Gotchas

- Only `https://*.adobe.com` pages can be benchmarked (no apex, credentials, ports, lookalike domains or hosts resolving to private addresses); redirects and the final URL are checked too, and a violation fails the run without retries. Third-party subresources load normally.
- Never compare a `milolibs` (`*.aem.live`) run with a plain-stage run: it is a separate origin with a cold CDN edge.
- **Verify `?milolibs=` is honored** before trusting a branch-value result: in the "after" report, `/libs/` requests must go to `<branch>--milo--adobecom.aem.live` and the document status must be 200. Otherwise you are measuring A vs A.
- This `aem.live` check applies only to the separate branch-value mode above. `--milo-pr` / `--mas-pr` use pinned runner-local source checkouts and keep production as the before control.
- Local (`--local`) and Actions results are not comparable; do not put them in one comparison.
