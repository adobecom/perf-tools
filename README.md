# perf-tools

Page-load performance tools, consumed mainly as **agent skills**:

- `perf-ab` compares a live production page (for example `www.adobe.com`) as-is ("before") with the same page plus changes ("after"): an injected `head.html` snippet such as preload links, `fetchpriority` on hints and on the document's `Link` response header, guarded source patches, Milo / MAS PR files, or branch values. PR source files are read from an isolated checkout of the exact PR commit and served locally through the measuring proxy; the baseline stays production. With no changes it measures one URL.
- `perf-preload` loads a page several times, finds the LCP in each trace and the resources that finished before it, and writes static `<link rel="modulepreload|preload">` tags for `head.html`.

**Default measurement: PageSpeed Insights mobile, from the US.** `perf-ab` (and `perf-preload`, which records through it) runs real **Lighthouse 13.6.0** with the PageSpeed mobile preset (`lr-mobile`: emulated Moto G Power, 412x823 at 1.75 DPR, **simulated** throttling with 150 ms TCP RTT and 1638.4 kb/s throughput, CPU slowdown 1.2) on the `perf-ab` GitHub Actions workflow of `adobecom/perf-tools`. The CLI dispatches the workflow with `gh`, waits and downloads the artifact. Before anything touches the measured site, the job checks its egress with neutral geolocation services and **fails closed** unless every answer is US; the page's own `Server-Timing: geo;desc=XX` is checked as well and a non-US value fails the job. There is **no local fallback**: missing `gh` access, non-US or unknown egress, render failures that outlast the retries, or infrastructure errors end with a non-zero exit and `results.json` `status: "failed"`. Metrics are Lighthouse's own audits and score (performance, FCP, LCP, SI, TBT, CLS), never DevTools timings converted into scores.

The "after" changes are applied by a per-run measuring proxy on the runner. It terminates TLS only for the measured host, with a throwaway certificate trusted by that one Chrome process (SPKI exception, no system trust), keeps HTTP/2, and tunnels every other origin untouched. Unchanged responses are forwarded byte-for-byte with their original compression; edited ones are re-compressed with Brotli quality 6, close to production's, so Lighthouse's simulation sees realistic transfer sizes. The temporary key never enters the artifact directory and is deleted afterwards; the job also scans the artifact for key material before upload.

Paired matrix: `-n N` dispatches N parallel matrix jobs (`fail-fast: false`). Each job measures **one complete cold pair**, before then after, on the same runner VM, so a pair never mixes two machines. The aggregate job combines the pairs: the medians per variant and the **median of the per-pair deltas** use complete pairs only, never unmatched samples. A missing or failed pair is kept as a diagnostic but makes the result `partial` (or `failed` when no pair completed), and the CLI exits 1. `-n 1` is a single-job smoke test. Each pair records its runner, Chrome version, the Lighthouse CPU benchmark index of each variant's run (`benchmarkIndexes.before` / `.after`) and the workflow run attempt; runners are not identical hardware, which is why deltas are computed within a pair. If the benchmark varies by 1.2x or more across runs or within a pair, `results.json` gets an `environment-variability` warning (also printed by the CLI): the deltas are then indicative, not a confirmed gain. Slow but valid runs are never dropped or retried to hide this.

Cold-run policy: every measured run starts cold. Runs alternate before/after; each run, and each retry of it, launches a new Chrome process with an empty temporary profile (and a fresh proxy), so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over. There are no warm-up loads; every load is measured and counted. Lighthouse's normal storage reset stays on, and the job rejects a run whose first document response came from a cache. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

A run is accepted only when Lighthouse finished without a runtime error, every metric is a finite number, and the render guard passed (non-hidden body, plus `--expect-title` / `--expect-count` when given). Rejected attempts are kept under `rejected/` as diagnostics and retried with a fresh browser (3 attempts per run); they never count as results.

## Quick start

Needs Node.js 22.19+ (Lighthouse 13.6.0) and the GitHub CLI `gh`, authenticated with Actions write access to `adobecom/perf-tools` (or `--repo`). Google Chrome is only needed locally for the legacy `--local-devtools` mode.

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
# LCP preloads: 3 cold US Lighthouse loads, writes ./preloads/products--photoshop.html and ./preloads/traces
perf-preload "https://www.adobe.com/products/photoshop.html" -n 3 -o ./preloads

# The same from existing DevTools traces
perf-preload --from Trace-1.json --from Trace-2.json -o ./preloads
```

```sh
# Versioned experiment config (committed and pushed; the workflow reads the copy on --ref, default main)
perf-ab --config experiments/acrobat-plans.json -n 1 -o ./ab-smoke   # smoke: one pair
perf-ab --config experiments/acrobat-plans.json -n 3 -o ./ab-full    # full: three pairs, three parallel jobs

# One URL as-is
perf-ab "https://www.adobe.com/acrobat/plans.html" -n 3

# Smoke test first: one cold before/after pair
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html -n 1 \
  --expect-title "Acrobat plans" --expect-count merch-card=19 -o ./ab-smoke

# Injected head snippet with priorities (applied to the hints and to the document's Link response header)
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html \
  --fetchpriority /libs/utils/utils.js=high --fetchpriority /libs/deps/mas/commerce.js=auto -n 3

# Guarded source patch of live files (each "find" must match exactly once, or the job fails)
perf-ab "https://www.adobe.com/acrobat/plans.html" --patch ./market-config.json -n 3

# Milo / MAS PR delta: only the files changed by the PR are served (production pages ignore ?milolibs=)
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 3

# Branch values (pages that honor ?milolibs=)
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 3
```

The manual `perf-ab` GitHub Actions form also has optional **Milo PR** and **MAS PR** number fields. Choose a versioned config or enter a URL, then optionally set either PR number. A supplied workflow PR number overrides that repository's PR reference in the config; an omitted number leaves the config value unchanged. With a URL, a PR input creates a production-before / PR-after pair. Do not combine PR number fields with the CLI `spec` input. The workflow accepts only same-repository PRs from `adobecom/milo` and `adobecom/mas`; it resolves the head, base and merge-base once in `prepare`, pins the diff for every matrix job, and does not execute code from the source checkout. Added, removed and renamed mapped files are handled explicitly; non-mapped test and documentation changes are not served.

For a one-pair Acrobat smoke run from **Actions → perf-ab → Run workflow**, select `main`, set `config` to `experiments/acrobat-plans.json`, optionally set `milo_pr` to `7095` (it overrides the config's PR for that run), leave `mas_pr` empty, and set `runs` to `1`.

Output (`-o`, default `./traces`), downloaded from the workflow artifact `perf-ab-<request id>`:
- `results.json` (aggregate, `mode: "pagespeed-us-paired"`): `status` (`ok` / `partial` / `failed`) and `errorKind`, `samples` (`requested`, `pairs`, `before`, `after`, `rejected`), `medians` (`before`, `after`, `delta` = median per-pair delta), `pairs[]` (per-pair metrics, delta and `job`: runner, Chrome version, per-variant `benchmarkIndexes`, run attempt), `warnings[]` (e.g. `environment-variability`), `profile` and `profileKey`, `egress`, `experiment` (config name and path, when used), `github` (run URL, SHA), hint report.
- `pair<i>/results.json`: that job's own result (egress checks, resolved Lighthouse profile, Lighthouse and Chrome versions, cold-run flags, per-run metrics, rejected attempts).
- `pair<i>/<variant><i>/`: `report.html` and `report.json` (the official Lighthouse reports), `trace.json`, `devtoolslog.json`, `run.json` (render check, first document response, proxy request log with original and served compressed sizes, document geo).
- `pair<i>/rejected/<variant><i>-attempt<k>/`: the same for rejected attempts.

Any earlier results, run and pair folders and `rejected/` in `-o` are removed before the download, so nothing stale is mixed in.

`profileKey` (for example `lh13.6.0-mobile-simulate-rtt150-tput1638.4-cpu1.2-412x823@1.75-mobile`) names the complete compared preset: Lighthouse version, form factor, throttling method, RTT, throughput, CPU multiplier, viewport, device scale factor and mobile flag. Only results with the same key are comparable. Chrome version and CPU benchmark stay per-pair metadata.

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

Legacy local mode, only on explicit request: `perf-ab --local-devtools <url> ...` runs the old local DevTools trace runner on this machine (headed Chrome, iPhone 16 Pro Max, 4x CPU, DevTools "Slow 4G", cache disabled; not PageSpeed and not US). It keeps its old options (`--override`, `--override-before`, `--pr-local`, `--device`, `--cpu`, `--headless`, ...), saves `before<i>.json` / `after<i>.json` traces and prints DevTools timings. Its numbers are not comparable with the default mode. `perf-preload --local-devtools` records with it.

### Testing preload links (`--head-inject`)

The snippet is inserted into the "after" document before the first `<script>` in `<head>`; "before" is the unmodified live page. Hints whose URL carries country/locale parameters (for example MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the requests of the first US baseline run of the same job; hints with no matching US request are dropped and reported, and `/experienceedge` hints are always dropped. `--fetchpriority` also rewrites matching entries of the document's `Link` response header, because hints in the HTML cannot change requests the header already started.

`perf-preload` writes the snippet as static tags, sorted by start time in the recorded traces. For example:

```html
<link rel="modulepreload" href="/creativecloud/scripts/utils.js">
<link rel="modulepreload" href="/libs/blocks/hero-marquee/hero-marquee.js">
<link rel="preload" href="https://www.adobe.com/libs/blocks/hero-marquee/hero-marquee.css" as="style">
<link rel="modulepreload" href="/libs/features/placeholders.js">
```

Stylesheet preloads use absolute URLs, even same-origin ones: some site loaders look up `link[href="<path>"]` without checking `rel`, treat a relative preload as the stylesheet and never apply it. They never get `crossorigin`, because `<link rel="stylesheet">` and `@import` fetch without CORS; fonts, fetches and cross-origin scripts do.

Besides scripts, stylesheets, fonts and the LCP image, `perf-preload` keeps GET JSON/HTML data fetches (`fetch()`, XHR, script `as="fetch"` preloads) that finished before LCP; Chrome records these as type `Other`, which earlier versions omitted. POST, beacons, unrelated `Other` requests and any `/experienceedge` or `/experienceedge/*` path are never preloaded. Each URL counts once per trace for `--min-runs`. Data preloads are emitted as `as="fetch" crossorigin`, which assumes the consumer uses a default `fetch()`/XHR (CORS, same-origin credentials). The tool does not infer or reproduce custom headers, authorization or non-default credentials (for example `credentials: 'include'`), and cannot detect them from a trace: such URLs may still be listed, so review the output and remove links whose consumer uses them. URLs with country/locale parameters (for example MAS `/mas/io/fragment?...&country=CH`) are marked `!`: serve them only to the matching context, never hardcode them for every geo.

Static tags need no script in `<head>`: the preload scanner finds them as soon as the HTML arrives. `head.html` is shared by all pages, so only resources common to every page belong there; page-specific tags need per-page injection (an edge worker or server-side). The LCP image URL is viewport-specific; use `perf-preload --no-lcp-image` when the tags are not mobile-only.

What to check afterwards:
- `results.json` `hints`: requested vs used links, contextual re-resolutions and dropped hints.
- In the "after" Lighthouse report (`network-requests`), each preloaded file is downloaded once and starts right after the document.
- Do not add `?mep=off` to the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

### Benchmark targets

Benchmark targets are restricted (`lib/target.mjs`, enforced by the CLIs, the workflow job and the legacy runner): the page URL (before and after) must be `https://` on a subdomain of `adobe.com` (for example `www.adobe.com`; the bare apex and lookalikes such as `www.adobe.com.evil.example` are refused), with no credentials and no explicit port. The page host must resolve only to public addresses (private, loopback, link-local and other reserved ranges are refused, at the up-front check and again at connect time). Every main-frame document of a run (redirect hops and the final URL) must pass the same check, or the run fails with no retry. Third-party subresources (fonts, analytics, CDNs) are loaded normally; only tunnels to non-public addresses are refused.

### Notes

- Tests: `npm test` (the Lighthouse end-to-end test runs against a local HTTP/2 fixture and is skipped without a local Chrome). The legacy runner accepts a loopback fixture page only with `PERF_TOOLS_LOOPBACK_FIXTURE=1`, which is for tests only.
- When releasing, bump `version` in `package.json`, `plugin.json` and `.claude-plugin/plugin.json` together.
- No warm-up loads (see the cold-run policy above). Legacy traces carry `metadata.perfAb`; `before0.json` / `after0.json` in folders from older versions are warm-ups, and `perf-preload --from <dir>` skips them.

## License

Apache-2.0, see [LICENSE](LICENSE).
