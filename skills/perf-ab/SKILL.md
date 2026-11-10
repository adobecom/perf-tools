---
name: perf-ab
description: >-
  Compare page-load performance with perf-ab (adobecom/perf-tools): real Lighthouse 13.6.0, mobile Slow 4G, 4x CPU, cold alternating runs on verified-US GitHub Actions by default; --local only on request. Tests preload snippets, guarded patches, Milo/MAS PRs or branch values; measures INP with interaction steps and analyzes attached DevTools traces. Use for before/after comparisons, A/B tests, milo/mas PR or branch perf tests, LCP/TBT/PageSpeed impact, INP/responsiveness, preloads, "run traces", or attached Trace-*.json comparisons.
---

# Before/after comparison (`perf-ab`)

Needs Node 22.19+; Actions needs `gh` with Actions write access to `adobecom/perf-tools`; local needs Chrome (`CHROME_PATH` or a standard macOS/Linux install). Check `perf-ab --help`; if missing, replace the command with `npx -y -p github:adobecom/perf-tools perf-ab`.

**Always use the Lighthouse measurement below.** Do not ask the user to pick a measurement, offer another mode, or write one-off measurement scripts. Default: `perf-ab <url> ...` dispatches Actions, waits and downloads artifacts. Only when the user asks for a local run, append `--local` (same options/output, sequential pairs). Never fall back to local after an Actions failure; report it and let the user decide.

Conditions (identical in both locations; do not substitute others):
- **Lighthouse 13.6.0**, `throttlingMethod: devtools`, Moto G Power (412x823, DPR 1.75), Slow 4G (562.5 ms request latency, 1474.56 kb/s down, 675 kb/s up), **4x CPU** (`CPU_SLOWDOWN_MULTIPLIER`, `lib/pagespeed/stats.mjs`). No simulated/Lantern mode. Metrics and traces describe the same throttled load: score, FCP, LCP, Speed Index, TBT, CLS; INP only with interactions.
- Actions uses `adobecom/perf-tools`'s `perf-ab` workflow (`workflow_dispatch`). Neutral geo checks verify **US egress** before loading the page; unknown/non-US fails closed. Document `Server-Timing: geo;desc=XX` must also be US when present.
- A per-run proxy applies after changes, preserving HTTP/2 and compressed sizes: unchanged responses are byte-identical, edited ones use Brotli quality 6. Its certificate is trusted only by that Chrome process and never uploaded.

**Cold only:** counterbalance by global pair index: odd pairs before/after, even pairs after/before (Actions and local). Even counts balance exactly; odd counts differ by one. Contextual preload hints require baseline-first resolution and emit `fixed-order-contextual-hints`; static bursts remain counterbalanced. Inspect `pairs[].job.order` / `.orderPolicy`. Each load gets fresh Chrome, an empty profile and a fresh proxy. No browser caches, cookies, storage, service workers or connections carry over; no warm-ups. Keep Lighthouse storage reset on; reject a cached first document. Leave OS DNS/CDN caches alone; no purging or cache-busting. Repeat requests within one load are not prewarming.

`-n N`: N complete cold pairs on the same machine per pair (parallel Actions jobs, sequential locally). Medians and median paired delta use complete pairs only. Missing pairs mean `partial`, none mean `failed`; exit 1, report incomplete. Hardware varies: inspect runner, Chrome and `job.benchmarkIndexes` per variant. Show `environment-variability` beside metrics and call deltas indicative, not confirmed gains. Never hide/drop/rerun valid slow runs or add warm-ups.

Accept only error-free Lighthouse runs with finite FCP/LCP/Speed Index/CLS; score/TBT may be unavailable without network quiet/TTI. Interactions require every step, visible selectors, finite INP and no main-frame navigation. Run/infrastructure failure means nonzero exit and `status: "failed"`: report failure, not a partial result. No retries; diagnostics remain in `rejected/`.

Run async (queueing plus roughly 2-4 minutes per pair). **Run the requested count directly; default to `-n 5` when unspecified. No preliminary smoke run unless explicitly requested.** Inspect reports/render from that campaign.

Store reviewed optimizations in `experiments/` (`perf-ab/experiment-v1`, see README). Run `perf-ab --config experiments/<name>.json -n 5 -o ./ab`. Actions reads the committed config on `--ref` (default `main`); it must be committed/pushed and match `origin/<ref>`. Local uses the working copy. Never combine `--config` with a URL or change options.

Output: `-o <dir>` (default `./traces`) **removes prior results there**.
- `results.json`: status/error, requested/complete/rejected samples, before/after medians, median paired delta, `pairs[]`/job metadata, `profile`/`profileKey`, `egress`, `experiment`, `github`, `hints`.
- `pair<i>/results.json`: egress/profile, Lighthouse/Chrome versions, cold flags, runs/first document and rejections.
- `pair<i>/<variant><i>/`: official `report.html|report.json` (share these, not replacement reports), `trace.json`, `devtoolslog.json`, `run.json` (document geo, proxy requests and encoded sizes). Interactions add `interaction/` reports/traces/logs and `flow-report.html`. Rejections use `pair<i>/rejected/<variant><i>-attempt<k>/`.
- PR provenance: `run.json` `sourcePrs[]` has base/head/merge-base SHAs and mapped blobs; `servedSources[]` has actually served after sources, checkout blobs and SHA-256. Aggregate records pinned refs and production/merge-base hashes. Inspect these; `production-source-drift` means production vs full PR head, not just the intended fix.
- Console prints pairs, medians, paired delta, hints and workflow URL.

Compare only the same `profileKey` (Lighthouse, device, throttling, network/CPU, load wait, viewport/DPR) **and** `where`. Former simulated profiles are refused. Never compare local vs Actions or different local machines, even with identical profiles.

### Local runs (`--local`)

Same spec/job/aggregate and output shape; no workflow dispatch or egress check. Records `where: "local"`, `mode: "pagespeed-local-paired"`, `egress.where: "local"` and no egress country. Always show `local-results-not-comparable`; a non-US document geo adds `local-non-us-document`. Label local results with the reported country if available, never verified US. PR API reads use `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; never print tokens. On rate limiting, request authentication. PRs, injection and patches work as on Actions.

## 1. Choose the change

Without change options the URL is measured as-is (`after<i>/` only). With any change option, "before" is the unchanged production page and "after" has the changes.

### a. Preload links / head.html snippet

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html \
  -n 5
```

- `--head-inject <file>` inserts the HTML into the "after" document before the first `<script>` in `<head>`. Build the snippet with the `perf-preload` skill.
- Hints whose URL carries country/locale parameters (e.g. MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the US baseline run's own requests; hints with no matching US request are dropped and reported in `results.json` `hints`. Never hand-edit `country=CH` into `country=US` where the real consumer omits the parameter. `/experienceedge` hints are always dropped.
- **The injected snippet is the only source of preloads for the after page.** With `--head-inject` (or a config's `headInject`, on Actions and with `--local`), perf-ab unsets every `rel=preload` / `rel=modulepreload` entry of the after document's `Link` response header (other `Link` entries stay; before is untouched). Nothing to pass; without `--head-inject` nothing is unset. Report it: `results.json` `hints.linkHeaderStripped` (count) and `hints.linkHeaderEntries` (the entries) are also printed in the console. Say the comparison is production headers + HTML vs snippet-only.
- Set `fetchpriority` directly on the `<link>` tags in the snippet; there is no CLI override.
- Do not use `?mep=off` on the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.
- Check: `hints.usedLinks` vs `requestedLinks`, and in the "after" report's network requests each preloaded file is fetched once and early.

#### `Link` response header prelinks

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" \
  --link-add '</acrobat/preloads/plans.json>; rel=preload; as=fetch; crossorigin=anonymous' -n 5
```

- `--link-add <entry>`, `--link-remove <url|*>` and `--link-replace <entry>` (all repeatable; config: `after.linkHeader` with `add` / `remove` / `replace` lists) edit the after document's `Link` response header through the proxy, in the order remove, replace, add. Use them to test a prelink before the site sends it. `*` removes every `rel=preload` / `rel=modulepreload` entry, so `--link-remove '*'` plus `--link-add` replaces the whole preload set.
- Entries are matched by resolved URL and guarded: a removed URL must exist, a replaced URL must exist exactly once with a different value, an added URL must not exist yet; otherwise the job fails (production changed). Do not retry by guessing; read the production header (`curl -sI <url> | grep -i '^link'`) and adjust.
- With `--head-inject`, header preloads are unset first, then the edits apply: snippet + added entries are the only preloads. `--link-remove '*'` is rejected there (redundant).
- An `as=fetch` prelink is only reused by `fetch(url)` with `crossorigin=anonymous`; check in the "after" report that the prelinked file is fetched once.
- Report `results.json` `linkHeader` (`production`, `served`, `removed`, `replaced`, `added`; also printed in the console) and say the comparison is the production header vs the edited header.

### b. Guarded source patch

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --patch ./market-config.json -n 5
```

`{"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}`: each `find` must match the live file exactly once, otherwise the job fails (the live source changed). Applies to "after" only; everything else stays production. Combine with `--head-inject` to test a combined optimization.

### c. Milo / MAS PR delta

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 5
```

- Milo `libs/**` maps to `/libs/**`; MAS `web-components/dist/**` to `/mas/libs/**`. Both base/head repos must be `adobecom/milo` or `adobecom/mas`, respectively.
- Pins base/head/merge-base before workers start; serves changed mapped files from isolated exact-commit checkouts through the proxy, including additions/removals/renames. Before and all other files stay production. No branch code executes; no PR-branch/`aem.live` page fetches; later branch movement cannot affect a run. Verify provenance and drift as above.
- Actions form: `config` or `url`, `runs`, optional positive `milo_pr`/`mas_pr`. Nonempty PR fields override that repo's config `after.pullRequests`; empty preserves it. URL plus PR makes a production/PR pair. Never combine PR fields with encoded CLI `spec`.

### d. Branch values (pages that honor `?milolibs=`)

```sh
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 5
```

- Baseline: a branch equal to upstream `stage` named `<name>-stage`; change: the same `stage` commit plus the change commits. Both pushed and based on the same `stage` commit.
- `www.stage.adobe.com/creativecloud/plans.html` ignores `milolibs`; use `https://stage--cc--adobecom.aem.live/creativecloud/plans`.

### e. INP (interaction steps)

INP needs interactions; navigation TBT is only a proxy. Steps alone measure as-is; with any change, both variants replay the same steps.

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --interactions ./plans-tabs.json -n 5
perf-ab --config experiments/acrobat-plans-inp.json -n 5 --local      # a config can carry "interactions" (inline array or file)
```

**No selectors: `--interactions auto`** (config: `"interactions": "auto"`). Rediscovers before each tap: unselected tabs, expand/collapse, plain buttons, one modal opener last; default max 4. Skips navigating links, form/submit buttons, consent banners and purchase/sign-in/download/contact-like actions. The first variant discovers targets; the second replays its exact elements, including in after/before pairs. A missing target rejects the run. Configurable step: `{"action":"auto","max":6,"kinds":["tab","expandable"],"exclude":[".promo"],"scope":"main"}`; fields after `action` optional, usable after preparation steps. Use auto for initial exploration, explicit steps for reviewed campaigns. Report `run.json` `interaction.steps[].label`; show `interaction-targets-differ` as non-replicate pairs and switch to explicit steps. An auto main-frame navigation is fatal; exclude that element.

Step file: JSON array, max 20, bounded fields, no code. Actions: `tap|click|type|press|auto` measure INP; `waitFor|scroll|pause` prepare. Fields: `selector`, `text`, `key`, `ms`, `label` as applicable. Example: `[{"action":"waitFor","selector":"button#tab-compare-plans-2"},{"action":"tap","selector":"button#tab-compare-plans-2","label":"Business tab"}]`. `ms`: interaction settle (default 1000), waitFor timeout (default 30000), pause length (1-10000).

- Each cold user flow: normal navigation metrics, then a mobile/touch timespan. INP is its Lighthouse `interaction-to-next-paint` (ms).
- Use tabs/accordions/modals; invisible selectors, main-frame navigation or a new tab fail the scenario. Iframe navigation is allowed.
- Aggregate `interactions`/`interactionsKey` identifies the scenario; compare only matching keys. INP medians/paired delta require complete pairs; missing INP is incomplete, differing replay steps are refused. `run.json` `interaction` and pair `runs[].interaction` identify the slowest step and input/processing/presentation delays.
- Under 50 interactions, lab INP is the worst interaction. Keep scenarios short/representative; use `-n 5`, treat deltas under ~40 ms as noise, never conclude from one pair.

Other flags: `--local`, `--param`, `--suffix` (`--suffix ""` for raw values), `--repo`, `--ref`, `--timeout`. See `perf-ab --help`.

## 2. Read the results

- Verify `status: "ok"`, `samples.pairs === samples.requested`, location/US egress on Actions, Lighthouse 13.6.0 and profile; inspect one official report per variant for correct rendering.
- Always share the Actions run's clickable **Results UI link**: `https://adobecom.github.io/perf-tools/?run=<runId>-<runAttempt>` using `results.github.runId` and `results.github.runAttempt ?? 1`, plus `results.github.runUrl`. Say `perf-ab Pages` automatically publishes completed `main` runs after completion.
- Report aggregate medians/median paired delta, warnings and hint usage. Inspect `pairs[]` without dropping/rerunning outliers. Under 5 runs, a few score points or FCP/LCP deltas under ~100 ms are noise.
- Read INP beside load metrics; inspect `flow-report.html` or `interaction/report.html`. Metrics and traces describe the same throttled load.
- Check CLS/TBT regressions, comparable request counts and explained rejections. Repeat on a heavier second page before go/no-go; check Safari/Firefox manually.

## 3. Analyzing DevTools traces the user attaches (Trace-*.json)

Parse with Python (`json.load(...)['traceEvents']`):

- The navigation start is `navigationStart` with a `documentLoaderURL` starting with `http`; `t0` is its `ts`. Take FCP / LCP / DCL / Load from `firstContentfulPaint`, `largestContentfulPaint::Candidate`, `domContentLoadedEventEnd` and `loadEventEnd`, filtered to the same `frame`.
- The renderer main thread is the `thread_name` event named `CrRendererMain`. TBT is the sum of (`RunTask` dur minus 50 ms) for tasks over 50 ms after FCP. Main-thread compile is the sum of `v8.compileModule` durations.
- Network: `ResourceSendRequest` / `ResourceReceiveResponse` / `ResourceFinish` joined on `requestId`. Preload vs modulepreload: `args.data.initiator.fetchType` is `link` for preload and `script` for modulepreload, with `stackTrace[0].functionName === 'loadLink'` (older traces use `initiator.stack.callFrames[0]`).
- Check the trace `metadata` (throttling, device) and the `documentLoaderURL` first. Confirm both traces used the same host and conditions before attributing differences to the change. Compare cold loads only: a DevTools trace recorded after an earlier load of the page in the same browser profile is warm (check `fromCache` / transfer sizes), and old perf-ab `*0.json` traces are warm-ups.

## Gotchas

- Only `https://*.adobe.com` and `https://<ref>--<repo>--adobecom.aem.live` pages can be benchmarked (no apex, credentials, ports, other aem.live owners, aem.page, lookalike domains or hosts resolving to private addresses); redirects and the final URL are checked too, and a violation fails the run without retries. Third-party subresources load normally. On aem.live pages Milo comes from `main--milo--adobecom.aem.live`, so `--milo-pr` / `--mas-pr` do not apply there; use `-b main -a <branch>`.
- Never compare a `milolibs` (`*.aem.live`) run with a plain-stage run: it is a separate origin with a cold CDN edge.
- **Verify `?milolibs=` is honored** before trusting a branch-value result: in the "after" report, `/libs/` requests must go to `<branch>--milo--adobecom.aem.live` and the document status must be 200. Otherwise you are measuring A vs A.
- This `aem.live` check applies only to the separate branch-value mode above. `--milo-pr` / `--mas-pr` use pinned runner-local source checkouts and keep production as the before control.
- Local (`--local`) and Actions results are not comparable; do not put them in one comparison.
