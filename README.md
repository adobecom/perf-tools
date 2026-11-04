# perf-tools

Page-load performance tools, consumed mainly as **agent skills**:

- `perf-ab` compares a live production page (for example `www.adobe.com`) as-is ("before") with the same page plus changes ("after"): an injected `head.html` snippet such as preload links, `fetchpriority` on the injected hints, guarded source patches, Milo / MAS PR files, or branch values. PR source files are read from an isolated checkout of the exact PR commit and served locally through the measuring proxy; the baseline stays production. With no changes it measures one URL.
- `perf-preload` loads a page several times, finds the LCP in each trace and the resources that finished before it, and writes static `<link rel="modulepreload|preload">` tags for `head.html`.

**One measurement: Lighthouse mobile with real DevTools throttling.** `perf-ab` (and `perf-preload`, which records through it) always runs real **Lighthouse 13.6.0** with its mobile preset: emulated Moto G Power (412x823 at 1.75 DPR) and `throttlingMethod: devtools`, i.e. the load itself is throttled by Chrome with Lighthouse's own "Slow 4G" values (request latency 562.5 ms = 150 ms x 3.75, 1474.56 kb/s down, 675 kb/s up) and a 4x CPU slowdown (Lighthouse's default mobile value, one constant, `CPU_SLOWDOWN_MULTIPLIER` in `lib/pagespeed/stats.mjs`). `maxWaitForLoad` is 120 s instead of Lighthouse's 45 s, because heavy pages such as creativecloud/plans do not reach the load event in 45 s under real throttling and every attempt would be rejected (`MAX_WAIT_FOR_LOAD_MS`; part of the profile check and of the `profileKey`). The trace, the metrics and the audits therefore describe the same throttled load; there is no Lantern simulation and no option to go back to it. Throttling is applied inside the browser, so it also covers the traffic that goes through the measuring proxy. Real throttling is more variable than simulation: use `-n 5` pairs for a full campaign. The only choice is *where* it runs:

- **GitHub Actions (default).** The CLI dispatches the `perf-ab` workflow of `adobecom/perf-tools` with `gh`, waits and downloads the artifact. Before anything touches the measured site, the job checks its egress with neutral geolocation services and **fails closed** unless every answer is US; the page's own `Server-Timing: geo;desc=XX` is checked as well and a non-US value fails the job. There is no silent fallback to a local run: missing `gh` access, non-US or unknown egress, render failures that outlast the retries, or infrastructure errors end with a non-zero exit and `results.json` `status: "failed"`.
- **This machine (`--local`).** The identical spec and job code, the same Lighthouse profile and cold-run policy, run on your computer with your Chrome, pairs one after another, then combined by the same aggregator, so the output has the same shape. Use it only when asked for explicitly. A known non-US egress or non-US `Server-Timing: geo` is allowed here but never hidden: `results.json` records `where: "local"`, the real egress country with `egress.ok: false`, `local-non-us-egress` / `local-non-us-document` warnings and a `local-results-not-comparable` warning, and the CLI prints them. An unknown egress still fails. `--local` never dispatches a workflow. Its PR inputs (`--milo-pr` / `--mas-pr`) read the GitHub API from this machine, authenticated with `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when one is available (never logged); without a token the unauthenticated 60 requests/hour limit applies and a 403 says so. Local results are never labeled US and are not comparable with Actions results even when `profileKey` matches (CPU, network and region differ). Country/locale-specific hints are re-resolved against the local baseline, so with a non-US egress they resolve to that country, not to US.

Metrics are Lighthouse's own audits and score (performance, FCP, LCP, SI, TBT, CLS), never DevTools timings converted into scores.

The "after" changes are applied by a per-run measuring proxy on the runner. It terminates TLS only for the measured host, with a throwaway certificate trusted by that one Chrome process (SPKI exception, no system trust), keeps HTTP/2, and tunnels every other origin untouched. Unchanged responses are forwarded byte-for-byte with their original compression; edited ones are re-compressed with Brotli quality 6, close to production's, so the throttled transfer sizes are realistic. The temporary key never enters the artifact directory and is deleted afterwards; the job also scans the artifact for key material before upload.

Paired matrix: `-n N` dispatches N parallel matrix jobs (`fail-fast: false`). Each job measures **one complete cold pair**, before then after, on the same runner VM, so a pair never mixes two machines. The aggregate job combines the pairs: the medians per variant and the **median of the per-pair deltas** use complete pairs only, never unmatched samples. A missing or failed pair is kept as a diagnostic but makes the result `partial` (or `failed` when no pair completed), and the CLI exits 1. `-n 1` is a single-job smoke test. Each pair records its runner, Chrome version, the Lighthouse CPU benchmark index of each variant's run (`benchmarkIndexes.before` / `.after`) and the workflow run attempt; runners are not identical hardware, which is why deltas are computed within a pair. If the benchmark varies by 1.2x or more across runs or within a pair, `results.json` gets an `environment-variability` warning (also printed by the CLI): the deltas are then indicative, not a confirmed gain. Slow but valid runs are never dropped or retried to hide this.

Cold-run policy: every measured run starts cold. Runs alternate before/after; each run, and each retry of it, launches a new Chrome process with an empty temporary profile (and a fresh proxy), so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over. There are no warm-up loads; every load is measured and counted. Lighthouse's normal storage reset stays on, and the job rejects a run whose first document response came from a cache. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

A run is accepted only when Lighthouse finished without a runtime error, every metric is a finite number, and the render guard passed (non-hidden body, plus `--expect-title` / `--expect-count` when given). Rejected attempts are kept under `rejected/` as diagnostics and retried with a fresh browser (3 attempts per run); they never count as results.

## Quick start

Needs Node.js 22.19+ (Lighthouse 13.6.0). Actions runs (default) also need the GitHub CLI `gh`, authenticated with Actions write access to `adobecom/perf-tools` (or `--repo`). `--local` runs need Google Chrome instead of `gh`: it is found through `CHROME_PATH`, then the usual macOS (`/Applications/Google Chrome.app`, `~/Applications`) and Linux (`/usr/bin/google-chrome*`, `/opt/google/chrome`, chromium) locations, and the run stops with a clear error when none exists.

In the GitHub Copilot app:

1. [Add the `adobecom/perf-tools` marketplace](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dadobecom%252Fperf-tools).
2. [Install the `perf-tools` plugin](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dperf-tools%2540perf-tools).

In the Copilot CLI:

```sh
copilot plugin install adobecom/perf-tools
```

Then ask for preloads or a comparison in a new session.

## Sample prompts

- "Generate preloads for https://www.adobe.com/products/photoshop.html"
- "Test the generated preloads on https://www.adobe.com/products/photoshop.html"
- "Test Milo PR 7062 on https://www.adobe.com/acrobat/plans.html"

## CLI reference

Run `perf-preload --help` and `perf-ab --help` for all options.

```sh
# LCP preloads: 5 cold Lighthouse loads on Actions, writes ./preloads/products--photoshop.html and ./preloads/traces
perf-preload "https://www.adobe.com/products/photoshop.html" -n 5 -o ./preloads

# The same on this machine
perf-preload "https://www.adobe.com/products/photoshop.html" -n 5 -o ./preloads --local

# The same from existing DevTools traces
perf-preload --from Trace-1.json --from Trace-2.json -o ./preloads
```

```sh
# Versioned experiment config (committed and pushed; the workflow reads the copy on --ref, default main)
perf-ab --config experiments/acrobat-plans.json -n 1 -o ./ab-smoke   # smoke: one pair
perf-ab --config experiments/acrobat-plans.json -n 5 -o ./ab-full    # full: five pairs, five parallel jobs

# One URL as-is
perf-ab "https://www.adobe.com/acrobat/plans.html" -n 5

# Smoke test first: one cold before/after pair
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html -n 1 \
  --expect-title "Acrobat plans" --expect-count merch-card=19 -o ./ab-smoke

# Injected head snippet with priorities (applied to the injected hints)
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html \
  --fetchpriority /libs/utils/utils.js=high --fetchpriority /libs/deps/mas/commerce.js=auto -n 5

# Guarded source patch of live files (each "find" must match exactly once, or the job fails)
perf-ab "https://www.adobe.com/acrobat/plans.html" --patch ./market-config.json -n 5

# Milo / MAS PR delta: only the files changed by the PR are served (production pages ignore ?milolibs=)
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 5

# Branch values (pages that honor ?milolibs=)
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 5

# Any of the above on this machine instead of Actions (same Lighthouse run, pairs one after another)
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 -n 5 --local
```

`--config` with `--local` measures the local copy of the config, so it does not need to be committed or pushed; PR and branch inputs are resolved the same way as on Actions.

The manual `perf-ab` GitHub Actions form also has optional **Milo PR** and **MAS PR** number fields. Choose a versioned config or enter a URL, then optionally set either PR number. A supplied workflow PR number overrides that repository's PR reference in the config; an omitted number leaves the config value unchanged. With a URL, a PR input creates a production-before / PR-after pair. Do not combine PR number fields with the CLI `spec` input. The workflow accepts only same-repository PRs from `adobecom/milo` and `adobecom/mas`; it resolves the head, base and merge-base once in `prepare`, pins the diff for every matrix job, and does not execute code from the source checkout. Added, removed and renamed mapped files are handled explicitly; non-mapped test and documentation changes are not served.

For a one-pair Acrobat smoke run from **Actions → perf-ab → Run workflow**, select `main`, set `config` to `experiments/acrobat-plans.json`, optionally set `milo_pr` to `7095` (it overrides the config's PR for that run), leave `mas_pr` empty, and set `runs` to `1`.

Output (`-o`, default `./traces`), downloaded from the workflow artifact `perf-ab-<request id>`:
- `results.json` (aggregate, `mode: "pagespeed-us-paired"` on Actions, `"pagespeed-local-paired"` with `--local`, plus `where: "actions" | "local"`): `status` (`ok` / `partial` / `failed`) and `errorKind`, `samples` (`requested`, `pairs`, `before`, `after`, `rejected`), `medians` (`before`, `after`, `delta` = median per-pair delta), `pairs[]` (per-pair metrics, delta and `job`: runner, Chrome version, per-variant `benchmarkIndexes`, run attempt), `warnings[]` (e.g. `environment-variability`), `profile` and `profileKey`, `egress`, `experiment` (config name and path, when used), `github` (run URL, SHA), hint report.
- `pair<i>/results.json`: that job's own result (egress checks, resolved Lighthouse profile, Lighthouse and Chrome versions, cold-run flags, per-run metrics, rejected attempts).
- `pair<i>/<variant><i>/`: `report.html` and `report.json` (the official Lighthouse reports), `trace.json`, `devtoolslog.json`, `run.json` (render check, first document response, proxy request log with original and served compressed sizes, document geo).
- `pair<i>/rejected/<variant><i>-attempt<k>/`: the same for rejected attempts.

Any earlier results, run and pair folders and `rejected/` in `-o` are removed before the download, so nothing stale is mixed in.

`profileKey` (for example `lh13.6.0-mobile-devtools-rtt150-tput1638.4-lat562.5-down1474.56-up675-cpu4-load120000-412x823@1.75-mobile`) names the complete compared preset: Lighthouse version, form factor, throttling method, RTT, throughput, request latency, download and upload throughput, CPU multiplier, load wait, viewport, device scale factor and mobile flag. Results measured earlier with simulated throttling (`...-simulate-...-cpu1.2-...`) have a different key: the aggregate refuses them (`profile mismatch`), the history publisher marks them `profile-mismatch`, and the dashboard keeps already published ones under their own key, so they are never mixed with these. Only results with the same key are comparable, and only when they were measured in the same place: `where: "local"` results are never comparable with Actions results (and local results from different machines are not comparable with each other), because the key does not capture hardware, network or region. Chrome version and CPU benchmark stay per-pair metadata.

The workflow is `.github/workflows/perf-ab.yml`: manual `workflow_dispatch` only, `contents: read`, jobs `prepare` → `measure` (matrix, one pair per job) → `aggregate`. Its form inputs are `config` (an `experiments/*.json` path), `url` (one page), optional `milo_pr` and `mas_pr` numbers, `runs` (pairs, 1-10; empty = the config's default) and, for the CLI, `spec` (gzip+base64 JSON) and `request_id`. Artifacts, kept 90 days: `perf-ab-<request id>-pair<i>` (one per job), `perf-ab-<request id>` (all pairs plus the aggregate; what the CLI downloads) and `perf-ab-<request id>-results` (the aggregate `results.json` only, for downstream consumers). Without a CLI request id, the id is `gh-run-<run id>`.

### Public history dashboard

Browse the read-only dashboard at <https://adobecom.github.io/perf-tools/>. It does not dispatch runs or expose a write API; start measurements through the `perf-ab` GitHub Actions workflow or the CLI. `.github/workflows/pages.yml` publishes sanitized run summaries and per-pair metrics as durable static JSON on `main`. Raw Lighthouse reports and traces remain in the GitHub Actions artifacts, which require sign-in and expire; the dashboard records each artifact's actual expiration date.

To backfill completed measurements, manually run the `perf-ab Pages` workflow from `main`. Leave its `run_ids` input empty to sweep completed eligible `perf-ab` runs, or enter comma-separated run IDs to import specific runs. Only completed runs from the trusted `main` workflow are considered. The dashboard exposes summaries and approved metadata only; it never publishes raw reports, traces, request data, or secrets.

To reset the published history, set `site/data/history-policy.json` to `{"schema":"perf-ab/history-policy-v1","cutoff":"<UTC timestamp>"}`, clear `runs` in `site/data/index.json`, and remove only the per-run JSON files referenced by the previous index. The cutoff is inclusive and uses each workflow run's creation time, so neither a sweep nor an explicit run-ID import can restore earlier runs. Existing summaries are filtered too. Removing the policy restores the previous behavior; lowering its cutoff and running a sweep can restore eligible history from retained Actions artifacts. This reset affects only published site data: it does not delete Git history, Actions runs, or their artifacts.

### Experiment configs (`--config`)

A reviewed optimization can be stored as a versioned config, so the same changes can be re-run from the CLI or the Actions form. `experiments/acrobat-plans.json` holds the latest approved Acrobat plans optimizations: 57 static hints, the CSS/JS priorities, and the mapped `utils.js` source from [adobecom/milo#7095](https://github.com/adobecom/milo/pull/7095), pinned to the PR commit resolved when the campaign starts.

```json
{
  "schema": "perf-ab/experiment-v1",
  "name": "acrobat-plans-latest",
  "url": "https://www.adobe.com/acrobat/plans.html",
  "runs": 3,
  "expect": { "title": "Acrobat plans", "counts": { "body:has(merch-card)": 1 } },
  "after": {
    "headInject": "acrobat-plans/head.html",
    "priorities": { "/libs/utils/utils.js": "high" },
    "pullRequests": [{ "repo": "adobecom/milo", "number": 7095 }]
  }
}
```

File references (`headInject`, `patches`) are relative to the config and must stay inside its directory (no `..` or absolute paths); `pullRequests` accepts only same-repository Milo and MAS PR references and maps `libs/**` to `/libs/**` and `web-components/dist/**` to `/mas/libs/**`. The workflow resolves exact base/head/merge-base SHAs and the PR diff once before matrix fan-out. Only mapped changed files are read from an isolated local object checkout; source checkouts are never used as executable workspaces and branch URLs are never fetched in the measured page load. Production remains the unchanged before control. The result records mapped-file and commit provenance, plus a warning when a baseline source differs from the pinned PR merge base. `after.sources` remains available for explicitly configured HTTPS overrides; unknown fields are rejected, and `/experienceedge` hints are refused. Hints with country/locale parameters are re-resolved against the US baseline at run time, as with `--head-inject`. Commit and push a config before using it: the workflow reads the committed copy, and the CLI refuses to dispatch when the local file differs from `origin/<ref>`.

### Testing preload links (`--head-inject`)

The snippet is inserted into the "after" document before the first `<script>` in `<head>`; "before" is the unmodified live page.

**The snippet is the only source of preloads for the "after" page.** Whenever `--head-inject` (or a config's `headInject`) is applied, on Actions and with `--local`, every `rel=preload` / `rel=modulepreload` entry of the after document's `Link` response header is unset; other `Link` entries (preconnect, canonical, ...) stay and the before document is never touched. The comparison is therefore production headers + HTML against the snippet alone. `results.json` `hints.linkHeaderStripped` and `hints.linkHeaderEntries` record how many entries were removed and which, `hints.perPair[].linkHeaderStripped` repeats the count per job, and the console prints both. Without `--head-inject` nothing is unset. Hints whose URL carries country/locale parameters (for example MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the requests of the first US baseline run of the same job; hints with no matching US request are dropped and reported, and `/experienceedge` hints are always dropped. `--fetchpriority` sets the priority on matching injected tags; since the header preloads are unset together with `--head-inject`, it only edits `Link` header entries when no snippet is injected.

`perf-preload` writes the snippet as static tags, sorted by start time in the recorded traces. For example:

```html
<link rel="modulepreload" href="/creativecloud/scripts/utils.js">
<link rel="modulepreload" href="/libs/blocks/hero-marquee/hero-marquee.js">
<link rel="preload" href="https://www.adobe.com/libs/blocks/hero-marquee/hero-marquee.css" as="style">
<link rel="modulepreload" href="/libs/features/placeholders.js">
```

Stylesheet preloads use absolute URLs, even same-origin ones: some site loaders look up `link[href="<path>"]` without checking `rel`, treat a relative preload as the stylesheet and never apply it. They never get `crossorigin`, because `<link rel="stylesheet">` and `@import` fetch without CORS; fonts, fetches and cross-origin scripts do.

Besides scripts, stylesheets, fonts and the LCP image, `perf-preload` keeps GET JSON/HTML data fetches (`fetch()`, XHR, script `as="fetch"` preloads) that finished before LCP; Chrome records these as type `Other`, which earlier versions omitted. POST, beacons and unrelated `Other` requests are never preloaded. Each URL counts once per trace for `--min-runs`. Data preloads are emitted as `as="fetch" crossorigin`, which assumes the consumer uses a default `fetch()`/XHR (CORS, same-origin credentials). The tool does not infer or reproduce custom headers, authorization or non-default credentials (for example `credentials: 'include'`), and cannot detect them from a trace: such URLs may still be listed, so review the output and remove links whose consumer uses them. URLs with country/locale parameters (for example MAS `/mas/io/fragment?...&country=CH`) are marked `!`: serve them only to the matching context, never hardcode them for every geo.

Static tags need no script in `<head>`: the preload scanner finds them as soon as the HTML arrives. `head.html` is shared by all pages, so only resources common to every page belong there; page-specific tags need per-page injection (an edge worker or server-side). The LCP image URL is viewport-specific; use `perf-preload --no-lcp-image` when the tags are not mobile-only.

What to check afterwards:
- `results.json` `hints`: requested vs used links, contextual re-resolutions and dropped hints.
- In the "after" Lighthouse report (`network-requests`), each preloaded file is downloaded once and starts right after the document.
- Do not add `?mep=off` to the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

### Preload generation rules

Built in, always on, nothing to pass each time. `perf-preload` never emits a link for:
- any URL under `/marketingtech/*`, on any origin of the page,
- the host `bfp.adobe.com` (and its subdomains),
- any `/experienceedge` or `/experienceedge/*` path (any method, type or MIME).

Matches are not silently dropped: the output lists them under "Excluded by rule" with the rule that matched and prints the active "Exclude rules". Add more with the repeatable `--exclude <path-prefix|host>` (for example `--exclude /libs/martech --exclude cdn.example.net`); the same rules apply when analyzing existing traces with `--from`.

The generated snippet is the single source of preloads for the page, because `perf-ab --head-inject` unsets the document's Link-header preloads (see above). Resources that the production `Link` header preloads today (recorded by Chrome with initiator "other") are therefore generated like any other resource and marked `^` in the table; resources preloaded by page scripts keep the `*` note. Resources the HTML parser already requests from the markup are still skipped.

### Benchmark targets

Benchmark targets are restricted (`lib/target.mjs`, enforced by the CLIs and the job, on Actions and locally): the page URL (before and after) must be `https://` on a subdomain of `adobe.com` (for example `www.adobe.com`; the bare apex and lookalikes such as `www.adobe.com.evil.example` are refused), with no credentials and no explicit port. The page host must resolve only to public addresses (private, loopback, link-local and other reserved ranges are refused, at the up-front check and again at connect time). Every main-frame document of a run (redirect hops and the final URL) must pass the same check, or the run fails with no retry. Third-party subresources (fonts, analytics, CDNs) are loaded normally; only tunnels to non-public addresses are refused.

### Notes

- Tests: `npm test` (the Lighthouse end-to-end tests, including the `--local` path, run against a local HTTP/2 fixture and are skipped without a local Chrome; the dashboard browser test needs Playwright Chromium, a dev dependency).
- When releasing, bump `version` in `package.json`, `plugin.json` and `.claude-plugin/plugin.json` together.
- No warm-up loads (see the cold-run policy above). `before0.json` / `after0.json` in trace folders from older versions are warm-ups, and `perf-preload --from <dir>` skips them.

## License

Apache-2.0, see [LICENSE](LICENSE).
