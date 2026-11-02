---
name: perf-ab
description: Run before/after page-load performance trace comparisons with the `perf-ab` CLI (adobecom/perf-tools). Loads a production page (e.g. www.adobe.com) as-is and with resources proxied from a Milo / MAS PR, branch or local checkout, or with an injected head.html snippet (e.g. preload links). Mobile (iPhone 16 Pro Max), 4x CPU, DevTools Slow 4G, cache disabled, alternating runs; prints median FCP/LCP/DCL/Load/TBT/CLS/compileModule plus modulepreload vs preload fetch counts. Also analyzes DevTools trace JSON files attached by the user. Use when asked to "compare before and after", "A/B trace", "perf test a milo/mas PR or branch", "measure the impact on LCP/TBT", "test preloads", "run traces", or when the user attaches Trace-*.json files to compare.
---

# Before/after trace comparison (`perf-ab`)

CLI from `adobecom/perf-tools` (needs Node 18+ and Google Chrome). Check it is installed with `perf-ab --help`. If it is missing, replace `perf-ab` with `npx -y -p github:adobecom/perf-tools perf-ab` in every command below.

It runs **headed Chrome** (many Adobe hosts reject headless). Keep the Chrome window visible and run the command async; it takes several minutes (about 25 s per run; every run starts a new browser, with no warm-up).

Fixed conditions, the same as manual DevTools runs: iPhone 16 Pro Max (440x956, 3x DPR, touch), 4x CPU, Slow 4G (180 KB/s down, 84 KB/s up, 562.5 ms latency), cache disabled, a new browser process with an empty profile for every run and retry. Do not substitute other throttling numbers.

Cold-run policy: every measured run starts cold. Each run, and each retry of it, launches a new browser process with an empty temporary profile, so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over from an earlier run. There are no warm-up loads; every load is measured and counted. Within a run the cache is also disabled. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

Output: per-run JSON lines, then a median table (before / after / delta). Traces are saved to `-o <dir>` (default `./traces`) as `before<i>.json` / `after<i>.json` and open in the DevTools Performance panel. Each trace records `metadata.perfAb` (`variant`, `run`, `attempt`, `browserPid`, `coldBrowser: true`, `warmup: false`). In folders from older perf-ab versions, `before0.json` / `after0.json` are warm-up loads, not measurements: never count them. `perf-ab <url>` alone (no variants) just measures one URL and saves `after<i>.json` traces.

## 1. Choose the mode

Production pages ignore `?milolibs=` / `?maslibs=`, so the primary modes proxy resources.

### a. Milo / MAS PR delta (production URL)

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 3
```

- Mapping: Milo `libs/**` becomes `/libs/**`; MAS `web-components/dist/**` becomes `/mas/libs/**` (other MAS paths are skipped).
- **after** serves the PR head version of each changed file; **before** (control) serves the same files from Milo `stage` / MAS `main`. Everything else comes live from production.
- The delta is the cumulative diff of PR head vs `stage` / `main`, so stacked and already-merged PRs work.
- By default the changed files are re-routed to `<branch>--<repo>--adobecom.aem.live`, so they go through Chrome's real Slow 4G throttle. `--pr-local` fulfills them from local copies with a simulated throttle instead.
- Verify: the summary prints "N overridden files served" per variant and lists files requested in only one variant. A WARNING means a PR yielded no overridable files. Production libs may lag `stage` / `main`, so check screenshots (`PERF_AB_SHOT=/tmp/shot`) for a broken render.

### b. Local checkouts or any directory

```sh
perf-ab "https://www.adobe.com/" \
  --override /libs=~/git/milo/libs \
  --override /libs/deps/mas=~/git/mas/web-components/dist
```

- `--override <pathPrefix>=<dir>` serves files from `<dir>` for requests whose path starts with the prefix, change variant only. Missing local files fall through to the live site. `--override-before` does the same for the baseline (e.g. a `stage` checkout).
- Overrides are fulfilled in-page on the same origin with a simulated Slow 4G cost (RTT + brotli size at 180 KB/s), the same for both variants.

### c. Preload links / head.html snippet

```sh
perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject ./preloads/products--photoshop.html -n 5
```

- `--head-inject <file>` inserts the HTML into the change variant's document before the first `<script>` in `<head>` (falls back to before `</head>`). The baseline is the unmodified live page. Both documents go through the same simulated Slow 4G delay.
- To build the snippet, use the `perf-preload` skill: it writes static `<link>` tags for the resources loaded before LCP. Static tags need no script in `<head>`.
- Combine with `--override` to serve any file the snippet requests without publishing it.
- Do not use `?mep=off` on the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline behavior.
- Check: the first run prints where the snippet was injected; in the traces the snippet's fetch starts before other script requests and the preloaded resources start earlier than in `before<i>.json`; with `PERF_AB_DEBUG=1`, look for "preloaded but not used" console warnings.

### d. Branch hosts (pages that honor `?milolibs=`)

```sh
perf-ab "https://www.stage.adobe.com/products/photoshop.html?mep=off&mas.preview=off" \
  -b my-feature-stage -a my-feature -n 5
```

- Baseline: a branch equal to upstream `stage` with no changes, named `<name>-stage`. Change: the same `stage` commit plus the change commits, named `<name>`. Both pushed and based on the same `stage` commit (check with `git merge-base` / `git log origin/stage..<branch>`), otherwise code differences pollute the result.
- Each branch is served via `?milolibs=<branch>--milo--adobecom`.
- `www.stage.adobe.com/creativecloud/plans.html` ignores `milolibs` (the cc site only honors it on `aem.page` / `aem.live` / `localhost` hosts). Use `https://stage--cc--adobecom.aem.live/creativecloud/plans` instead (no `.html`).

Other flags: `--param`, `--suffix` (use `--suffix ""` to pass raw values), `--before-query` / `--after-query`, `--device`, `--cpu`, `--channel`, `--settle`, `--lcp-wait`. See `perf-ab --help`. Failed runs retry up to 3 times, each retry in a new browser; if a browser cannot be closed the measurement stops.

## 2. Read the results

- Use **medians**, discard clear outliers, and treat FCP / LCP deltas under about 100 ms as noise.
- Sanity checks: `fromCache` must be 0, `requests` should be about the same in both variants, `dupScripts` should be 0, and CLS and TBT should not regress.
- For a modulepreload experiment: `loadLinkModule` > 0 in "after" and 0 in "before" (modulepreload is a `fetchType: script` request initiated from `loadLink`; preload is `fetchType: link`). `compileModule` should drop.
- Repeat on a second, heavier page and on desktop before a go / no-go. Check Safari and Firefox manually.

## 3. Analyzing DevTools traces the user attaches (Trace-*.json)

Parse with Python (`json.load(...)['traceEvents']`):

- The navigation start is `navigationStart` with a `documentLoaderURL` starting with `http`; `t0` is its `ts`. Take FCP / LCP / DCL / Load from `firstContentfulPaint`, `largestContentfulPaint::Candidate`, `domContentLoadedEventEnd` and `loadEventEnd`, filtered to the same `frame`.
- The renderer main thread is the `thread_name` event named `CrRendererMain`. TBT is the sum of (`RunTask` dur minus 50 ms) for tasks over 50 ms after FCP. Main-thread compile is the sum of `v8.compileModule` durations.
- Network: `ResourceSendRequest` / `ResourceReceiveResponse` / `ResourceFinish` joined on `requestId`. Preload vs modulepreload: `args.data.initiator.fetchType` is `link` for preload and `script` for modulepreload, with `stackTrace[0].functionName === 'loadLink'` (older traces use `initiator.stack.callFrames[0]`).
- Check the trace `metadata` (throttling, device) and the `documentLoaderURL` first. Confirm both traces used the same host and conditions before attributing differences to the change. Compare cold loads only: a DevTools trace recorded after an earlier load of the page in the same browser profile is warm (check `fromCache` / transfer sizes), and old perf-ab `*0.json` traces are warm-ups.

## Gotchas

- Never compare a `milolibs` (`*.aem.live`) run with a plain-stage run: it is a separate origin with a cold CDN edge.
- **Verify `?milolibs=` is honored** before trusting a branch-host result: in a saved trace, `/libs/` requests must go to `<branch>--milo--adobecom.aem.live` and the document status must be 200. If `/libs/` stays on the same host in both variants you are measuring A vs A. A 404 document also produces plausible-looking numbers.
- Overridden files are served in-page, so do not mix a PR-delta or override run with a branch-host run when comparing numbers.
