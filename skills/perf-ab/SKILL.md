---
name: perf-ab
description: Run before/after page-load performance comparisons with the `perf-ab` CLI (adobecom/perf-tools). By default it runs real Lighthouse 13.6.0 with the PageSpeed Insights mobile profile (lr-mobile, Moto G Power, simulated 150 ms RTT / 1638.4 kb/s, CPU x1.2) on a GitHub Actions runner with verified US egress, cold (new Chrome + empty profile per run, no warm-ups), alternating runs; downloads the official Lighthouse reports, traces and before/after medians. Compares a production page (e.g. www.adobe.com) as-is against an injected head.html snippet (e.g. preload links), fetchpriority changes, guarded source patches, Milo / MAS PR files or branch values. Also analyzes DevTools trace JSON files attached by the user. Use when asked to "compare before and after", "A/B test", "perf test a milo/mas PR or branch", "measure the impact on LCP/TBT/PageSpeed score", "test preloads", "run traces", or when the user attaches Trace-*.json files to compare.
---

# Before/after comparison (`perf-ab`)

CLI from `adobecom/perf-tools` (needs Node 22.19+ and `gh` authenticated with Actions write access to `adobecom/perf-tools`). Check it is installed with `perf-ab --help`. If it is missing, replace `perf-ab` with `npx -y -p github:adobecom/perf-tools perf-ab` in every command below.

**This is how perf-ab measurements are done.** Plain `perf-ab <url> ...` is the default and the only mode to use unless the user explicitly asks for the legacy local DevTools runner. Do not write one-off measurement scripts, and do not fall back to local runs when the default fails.

Default conditions (do not substitute others):
- Real **Lighthouse 13.6.0**, PageSpeed Insights mobile preset (`lr-mobile`): emulated Moto G Power (412x823, 1.75 DPR), **simulated** throttling, 150 ms TCP RTT, 1638.4 kb/s throughput, CPU slowdown 1.2. Metrics are Lighthouse's own: performance score, FCP, LCP, Speed Index, TBT, CLS.
- Executed on the `perf-ab` GitHub Actions workflow of `adobecom/perf-tools` (manual `workflow_dispatch`; the CLI dispatches it, waits and downloads the artifact). The job verifies **US egress** with neutral geolocation services before touching the site and fails closed if it is non-US or unknown; the page's `Server-Timing: geo;desc=XX` must also be US when present.
- Changes for "after" are applied by a per-run proxy on the runner that keeps HTTP/2 and real compressed sizes (unchanged responses are byte-identical; edited ones are re-compressed with Brotli quality 6). Its temporary certificate is trusted only by that Chrome process and never uploaded.

Cold-run policy: every measured run starts cold. Runs alternate before/after; each run, and each retry of it, launches a new Chrome process with an empty temporary profile (and a fresh proxy), so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over. There are no warm-up loads; every load is measured and counted. Lighthouse's storage reset stays on and a run whose first document response came from a cache is rejected. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

Accepted runs only: Lighthouse must finish without a runtime error, every metric must be a finite number, and the render guard must pass (non-hidden body, plus `--expect-title` / `--expect-count`). A rejected attempt (for example NO_FCP or a broken render) is saved under `rejected/` and retried with a fresh browser, up to 3 attempts per run. If a run never succeeds, or any infrastructure step fails, the command exits non-zero and `results.json` has `status: "failed"`: report the failure, never a partial result.

Run it async; a job takes several minutes (queueing plus about 1 to 2 minutes per run). **Start with a smoke test of one pair (`-n 1`)** and check the reports and the render before a full campaign (`-n 3` or more).

Output (`-o <dir>`, default `./traces`; earlier results in that folder are removed first):
- `results.json`: `status`, `egress` (country and per-service checks), `profile` (resolved Lighthouse settings), `lighthouseVersion`, `chromeVersion`, `cold` flags, `runs` (per-run metrics, first document response, render check), `medians` per variant, `delta`, `hints` (requested / used / contextual / dropped), `rejected`.
- `<variant><i>/`: `report.html` and `report.json` (the official Lighthouse reports; share these, never a hand-made summary), `trace.json` and `devtoolslog.json` (raw), `run.json` (render check, proxy request log with original and served encoded sizes, document geo).
- `rejected/<variant><i>-attempt<k>/`: the same for rejected attempts.
- The console prints the medians per variant, the hint usage and the workflow run URL.

## 1. Choose the change

Without change options the URL is measured as-is (`after<i>/` only). With any change option, "before" is the unchanged production page and "after" has the changes.

### a. Preload links / head.html snippet

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html \
  --fetchpriority /libs/utils/utils.js=high -n 1 --expect-title "Acrobat plans" --expect-count merch-card=19
```

- `--head-inject <file>` inserts the HTML into the "after" document before the first `<script>` in `<head>`. Build the snippet with the `perf-preload` skill.
- Hints whose URL carries country/locale parameters (e.g. MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the US baseline run's own requests; hints with no matching US request are dropped and reported in `results.json` `hints`. Never hand-edit `country=CH` into `country=US` where the real consumer omits the parameter. `/experienceedge` hints are always dropped.
- `--fetchpriority /path=high|low|auto` (repeatable) sets the priority on matching injected hints and on the document's `Link` response header entries (HTML hints cannot change requests the header already started).
- Do not use `?mep=off` on the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.
- Check: `hints.usedLinks` vs `requestedLinks`, and in the "after" report's network requests each preloaded file is fetched once and early.

### b. Guarded source patch

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --patch ./market-config.json -n 1
```

`{"replacements":[{"path":"/libs/utils/utils.js","find":"...","replace":"..."}]}`: each `find` must match the live file exactly once, otherwise the job fails (the live source changed). Applies to "after" only; everything else stays production. Combine with `--head-inject` / `--fetchpriority` to test a combined optimization.

### c. Milo / MAS PR delta

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 3
```

- Mapping: Milo `libs/**` becomes `/libs/**`; MAS `web-components/dist/**` becomes `/mas/libs/**`. Only same-repository PR branches work.
- "after" serves the PR head version of each changed file and "before" the same files from Milo `stage` / MAS `main`, both from `aem.live`; everything else comes live from production. Production libs may lag `stage` / `main`, so check the reports for a broken render.

### d. Branch values (pages that honor `?milolibs=`)

```sh
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 3
```

- Baseline: a branch equal to upstream `stage` named `<name>-stage`; change: the same `stage` commit plus the change commits. Both pushed and based on the same `stage` commit.
- `www.stage.adobe.com/creativecloud/plans.html` ignores `milolibs`; use `https://stage--cc--adobecom.aem.live/creativecloud/plans`.

Other flags: `--param`, `--suffix` (`--suffix ""` for raw values), `--before-query` / `--after-query`, `--repo`, `--ref`, `--timeout`. See `perf-ab --help`.

### Legacy local DevTools mode (explicit request only)

`perf-ab --local-devtools <url> ...` runs the old local runner on this machine: headed Chrome, iPhone 16 Pro Max, 4x CPU, DevTools "Slow 4G", cache disabled, a new browser per run and retry, no warm-ups. It is not PageSpeed and not US; use it only when the user asks for it by name, and label its numbers as legacy local DevTools results. It keeps its own options (`--override`, `--override-before`, `--pr-local`, `--device`, `--cpu`, `--channel`, `--headless`, `--settle`, `--lcp-wait`; see `perf-ab --local-devtools --help`), saves `before<i>.json` / `after<i>.json` with `metadata.perfAb`, and prints DevTools timings plus `fromCache`, `dupScripts`, `loadLinkModule` and `compileModule`. In folders from older versions, `before0.json` / `after0.json` are warm-up loads, never measurements.

## 2. Read the results

- First confirm `status: "ok"`, `egress.country: "US"`, `lighthouseVersion: "13.6.0"` and the profile, and open one `report.html` per variant to check the page rendered as expected.
- Use the **medians** in `results.json` (and the per-run values to spot outliers). With 1 to 3 runs per variant, treat small differences (a few score points, FCP / LCP under about 100 ms) as noise.
- Lighthouse metrics are modeled (simulated throttling) from the observed load; `trace.json` / `devtoolslog.json` are the raw observed load. Never mix raw trace timings with the Lighthouse values in one comparison.
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
- Results from the default (US Lighthouse) mode and the legacy local DevTools mode are not comparable.
