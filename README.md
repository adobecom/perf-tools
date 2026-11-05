# perf-tools

Page-load performance tools, consumed mainly as **agent skills**:

- `perf-ab` compares a live production page (for example `www.adobe.com`) as-is ("before") with the same page plus changes ("after"): an injected `head.html` snippet such as preload links (with their own `fetchpriority` attributes), guarded source patches, Milo / MAS PR files, or branch values. PR source files are read from an isolated checkout of the exact PR commit and served locally through the measuring proxy; the baseline stays production. With no changes it measures one URL.
- `perf-preload` loads a page several times, finds the LCP in each trace and the resources that finished before it, and writes static `<link rel="modulepreload|preload">` tags for `head.html`.

**One measurement: Lighthouse mobile with real DevTools throttling.** `perf-ab` (and `perf-preload`, which records through it) always runs real **Lighthouse 13.6.0** with its mobile preset: emulated Moto G Power (412x823 at 1.75 DPR) and `throttlingMethod: devtools`, i.e. the load itself is throttled by Chrome with Lighthouse's own "Slow 4G" values (request latency 562.5 ms = 150 ms x 3.75, 1474.56 kb/s down, 675 kb/s up) and a 4x CPU slowdown (Lighthouse's default mobile value, one constant, `CPU_SLOWDOWN_MULTIPLIER` in `lib/pagespeed/stats.mjs`). The trace, the metrics and the audits therefore describe the same throttled load; there is no Lantern simulation and no option to go back to it. Throttling is applied inside the browser, so it also covers the traffic that goes through the measuring proxy. Real throttling is more variable than simulation: use `-n 5` pairs for a full campaign. The only choice is *where* it runs:

- **GitHub Actions (default).** The CLI dispatches the `perf-ab` workflow of `adobecom/perf-tools` with `gh`, waits and downloads the artifact. Before anything touches the measured site, the job checks its egress with neutral geolocation services and **fails closed** unless every answer is US; the page's own `Server-Timing: geo;desc=XX` is checked as well and a non-US value fails the job. There is no silent fallback to a local run: missing `gh` access, non-US or unknown egress, render failures that outlast the retries, or infrastructure errors end with a non-zero exit and `results.json` `status: "failed"`.
- **This machine (`--local`).** The identical spec and job code, the same Lighthouse profile and cold-run policy, run on your computer with your Chrome, pairs one after another, then combined by the same aggregator, so the output has the same shape. Use it only when asked for explicitly. Local runs do no egress check: `results.json` records `where: "local"` and a `local-results-not-comparable` warning (a non-US `Server-Timing: geo` on the measured document adds `local-non-us-document`), and the CLI prints them. `--local` never dispatches a workflow. Its PR inputs (`--milo-pr` / `--mas-pr`) read the GitHub API from this machine, authenticated with `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when one is available (never logged); without a token the unauthenticated 60 requests/hour limit applies and a 403 says so. Local results are never labeled US and are not comparable with Actions results even when `profileKey` matches (CPU, network and region differ). Country/locale-specific hints are re-resolved against the local baseline, so they resolve to the country of this machine.

Metrics are Lighthouse's own audits and score (performance, FCP, LCP, SI, TBT, CLS), never DevTools timings converted into scores. With interaction steps (`--interactions`, see "INP" below) INP (Interaction to Next Paint) is added, from the Lighthouse timespan that replays them.

The "after" changes are applied by a per-run measuring proxy on the runner. It terminates TLS only for the measured host, with a throwaway certificate trusted by that one Chrome process (SPKI exception, no system trust), keeps HTTP/2, and tunnels every other origin untouched. Unchanged responses are forwarded byte-for-byte with their original compression; edited ones are re-compressed with Brotli quality 6, close to production's, so the throttled transfer sizes are realistic. The temporary key never enters the artifact directory and is deleted afterwards; the job also scans the artifact for key material before upload.

Paired matrix: `-n N` dispatches N parallel matrix jobs (`fail-fast: false`). Each job measures **one complete cold pair**, before then after, on the same runner VM, so a pair never mixes two machines. The aggregate job combines the pairs: the medians per variant and the **median of the per-pair deltas** use complete pairs only, never unmatched samples. A missing or failed pair is kept as a diagnostic but makes the result `partial` (or `failed` when no pair completed), and the CLI exits 1. `-n 1` is a single-job smoke test. Each pair records its runner, Chrome version, the Lighthouse CPU benchmark index of each variant's run (`benchmarkIndexes.before` / `.after`) and the workflow run attempt; runners are not identical hardware, which is why deltas are computed within a pair. If the benchmark varies by 1.2x or more across runs or within a pair, `results.json` gets an `environment-variability` warning (also printed by the CLI): the deltas are then indicative, not a confirmed gain. Slow but valid runs are never dropped or retried to hide this.

Cold-run policy: every measured run starts cold. Runs alternate before/after; each run launches a new Chrome process with an empty temporary profile (and a fresh proxy), so no HTTP cache, V8 code cache, cookies, storage, service workers, open connections or Chrome DNS cache carry over. There are no warm-up loads; every load is measured and counted. Lighthouse's normal storage reset stays on, and the job rejects a run whose first document response came from a cache. The OS DNS cache and shared CDN / edge caches are outside the browser and are left alone: do not purge them and do not add cache-busting query parameters. Requests that one page load makes for the same resource are part of that load, not prewarming.

A run is accepted only when Lighthouse finished without a runtime error and every metric is a finite number. A failed run is not retried: it fails and the error is reported (rejected attempts are kept under `rejected/` as diagnostics). Runs with interaction steps additionally need every step to run and INP to be finite (see "INP" below).

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
perf-ab --config experiments/<name>.json -n 1 -o ./ab-smoke   # smoke: one pair
perf-ab --config experiments/<name>.json -n 5 -o ./ab-full    # full: five pairs, five parallel jobs

# One URL as-is
perf-ab "https://www.adobe.com/acrobat/plans.html" -n 5

# The same plus INP: replay declarative interaction steps (see "INP" below)
perf-ab "https://www.adobe.com/acrobat/plans.html" --interactions ./plans-tabs.json -n 5

# Smoke test first: one cold before/after pair
perf-ab "https://www.adobe.com/acrobat/plans.html" --head-inject ./preloads/acrobat--plans.html -n 1 \
  -o ./ab-smoke

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

For a one-pair smoke run from **Actions → perf-ab → Run workflow**, select `main`, set `config` to `experiments/<name>.json`, optionally set `milo_pr` / `mas_pr` (they override the config's PR for that repository for that run), and set `runs` to `1`.

Output (`-o`, default `./traces`), downloaded from the workflow artifact `perf-ab-<request id>`:
- `results.json` (aggregate, `mode: "pagespeed-us-paired"` on Actions, `"pagespeed-local-paired"` with `--local`, plus `where: "actions" | "local"`): `status` (`ok` / `partial` / `failed`) and `errorKind`, `samples` (`requested`, `pairs`, `before`, `after`, `rejected`), `medians` (`before`, `after`, `delta` = median per-pair delta), `pairs[]` (per-pair metrics, delta and `job`: runner, Chrome version, per-variant `benchmarkIndexes`, run attempt), `warnings[]` (e.g. `environment-variability`), `profile` and `profileKey`, `egress`, `experiment` (config name and path, when used), `github` (run URL, SHA), hint report.
- `pair<i>/results.json`: that job's own result (egress checks, resolved Lighthouse profile, Lighthouse and Chrome versions, cold-run flags, per-run metrics, rejected attempts).
- `pair<i>/<variant><i>/`: `report.html` and `report.json` (the official Lighthouse reports), `trace.json`, `devtoolslog.json`, `run.json` (first document response, proxy request log with original and served compressed sizes, document geo). With `--interactions` also `interaction/` (the timespan's report, trace and DevTools log) and `flow-report.html`.
- `pair<i>/rejected/<variant><i>-attempt<k>/`: the same for rejected attempts.

Any earlier results, run and pair folders and `rejected/` in `-o` are removed before the download, so nothing stale is mixed in.

`profileKey` (for example `lh13.6.0-mobile-devtools-rtt150-tput1638.4-lat562.5-down1474.56-up675-cpu4-412x823@1.75-mobile`) names the complete compared preset: Lighthouse version, form factor, throttling method, RTT, throughput, request latency, download and upload throughput, CPU multiplier, viewport, device scale factor and mobile flag. Results measured earlier with simulated throttling (`...-simulate-...-cpu1.2-...`) have a different key: the aggregate refuses them (`profile mismatch`), the history publisher marks them `profile-mismatch`, and the dashboard keeps already published ones under their own key, so they are never mixed with these. Only results with the same key are comparable, and only when they were measured in the same place: `where: "local"` results are never comparable with Actions results (and local results from different machines are not comparable with each other), because the key does not capture hardware, network or region. Chrome version and CPU benchmark stay per-pair metadata.

The workflow is `.github/workflows/perf-ab.yml`: manual `workflow_dispatch` only, `contents: read`, jobs `prepare` → `measure` (matrix, one pair per job) → `aggregate`. Its form inputs are `config` (an `experiments/*.json` path), `url` (one page), optional `milo_pr` and `mas_pr` numbers, `runs` (pairs, 1-10; empty = the config's default) and, for the CLI, `spec` (gzip+base64 JSON) and `request_id`. Artifacts, kept 90 days: `perf-ab-<request id>-pair<i>` (one per job), `perf-ab-<request id>` (all pairs plus the aggregate; what the CLI downloads) and `perf-ab-<request id>-results` (the aggregate `results.json` only, for downstream consumers). Without a CLI request id, the id is `gh-run-<run id>`.

### Public history dashboard

Browse the read-only dashboard at <https://adobecom.github.io/perf-tools/>. It does not dispatch runs or expose a write API; start measurements through the `perf-ab` GitHub Actions workflow or the CLI. `.github/workflows/pages.yml` publishes sanitized run summaries and per-pair metrics as durable static JSON on `main`. Raw Lighthouse reports and traces remain in the GitHub Actions artifacts, which require sign-in and expire; the dashboard records each artifact's actual expiration date.

To backfill completed measurements, manually run the `perf-ab Pages` workflow from `main`. Leave its `run_ids` input empty to sweep completed eligible `perf-ab` runs, or enter comma-separated run IDs to import specific runs. Only completed runs from the trusted `main` workflow are considered. The dashboard exposes summaries and approved metadata only; it never publishes raw reports, traces, request data, or secrets.

To reset the published history, set `site/data/history-policy.json` to `{"schema":"perf-ab/history-policy-v1","cutoff":"<UTC timestamp>"}`, clear `runs` in `site/data/index.json`, and remove only the per-run JSON files referenced by the previous index. The cutoff is inclusive and uses each workflow run's creation time, so neither a sweep nor an explicit run-ID import can restore earlier runs. Existing summaries are filtered too. Removing the policy restores the previous behavior; lowering its cutoff and running a sweep can restore eligible history from retained Actions artifacts. This reset affects only published site data: it does not delete Git history, Actions runs, or their artifacts.

### Experiment configs (`--config`)

A reviewed optimization can be stored as a versioned config, so the same changes can be re-run from the CLI or the Actions form. A config holds a URL, an injected `head.html` snippet (with its own `fetchpriority` attributes) and pinned Milo / MAS PR references. Example `experiments/<name>.json`:

```json
{
  "schema": "perf-ab/experiment-v1",
  "name": "acrobat-plans",
  "url": "https://www.adobe.com/acrobat/plans.html",
  "runs": 3,
  "expect": { "title": "Acrobat plans", "counts": { "body:has(merch-card)": 1 } },
  "after": {
    "headInject": "<name>/head.html",
    "pullRequests": [{ "repo": "adobecom/milo", "number": 7095 }]
  }
}
```

`interactions` (inline steps or a file reference, see "INP" below) applies to both variants. File references (`headInject`, `patches`, `interactions`) are relative to the config and must stay inside its directory (no `..` or absolute paths); `pullRequests` accepts only same-repository Milo and MAS PR references and maps `libs/**` to `/libs/**` and `web-components/dist/**` to `/mas/libs/**`. The workflow resolves exact base/head/merge-base SHAs and the PR diff once before matrix fan-out. Only mapped changed files are read from an isolated local object checkout; source checkouts are never used as executable workspaces and branch URLs are never fetched in the measured page load. Production remains the unchanged before control. The result records mapped-file and commit provenance, plus a warning when a baseline source differs from the pinned PR merge base. `after.sources` remains available for explicitly configured HTTPS overrides; unknown fields are rejected, and `/experienceedge` hints are refused. Hints with country/locale parameters are re-resolved against the US baseline at run time, as with `--head-inject`. Commit and push a config before using it: the workflow reads the committed copy, and the CLI refuses to dispatch when the local file differs from `origin/<ref>`.

### INP (`--interactions`)

Lighthouse navigation mode has no user input, so it cannot report **INP** (Interaction to Next Paint); TBT is only a load-time proxy. With interaction steps, every cold run becomes one Lighthouse **user flow** instead of a single navigation: the cold navigation (same config, profile check and cold guarantees as above, so performance, FCP, LCP, SI, TBT and CLS are exactly the usual ones), the render check, then one **timespan** in which the steps run (same mobile emulation and DevTools throttling, with touch emulation on for `tap`). INP is Lighthouse's own `interaction-to-next-paint` audit of that timespan: the slowest interaction, in ms (Lighthouse only reports it with real, unsimulated throttling, which perf-ab always uses). Requests without interaction steps keep the unchanged navigation path.

**Pass-partout: `--interactions auto`.** When you have no page-specific selectors (or want the same scenario on any page), `auto` finds the page's own in-page interactions by itself: tabs that are not selected, expand/collapse toggles (`aria-expanded`, `<details>`), plain buttons and one modal opener (`aria-haspopup="dialog"`, Milo `a.modal` / `data-modal-*`), including inside open shadow roots. Discovery runs again before every tap, so it follows the page as earlier taps change it (switching a tab hides the other panels' toggles and shows new ones). Per step it taps at most `max` targets (default 4), spread over the kinds (at most `ceil(max / kinds)` of each, tabs, toggles, buttons in that order) and the modal opener last, so its overlay never covers the others. It is conservative: it never taps a link that goes somewhere (an `<a>` with a real `href`), a `submit`/`reset` button or a button inside a form, consent/cookie banners, or a button whose name says buy, cart, checkout, order, pay, subscribe, sign in/up/out, log in/out, register, submit, send, delete, remove, cancel, download, install, upgrade, contact, call, chat, accept, reject, agree or decline; it needs no selectors, and an `exclude` list (CSS selectors, up to 10) removes anything else, e.g. an element that navigates. `auto` can be one step of a larger scenario (for example `waitFor` the page's main block first) and takes `max`, `kinds` (a subset of `tab`, `expandable`, `button`, `popup`), `exclude`, `scope` (a CSS selector to stay inside, default the whole body), `ms` and `label`. Before and after exercise **the same elements**: within a pair the "after" load taps exactly the sequence (kind, role, name, occurrence) its "before" load tapped, and the run fails with the error reported when one of them does not exist there. The scenario key identifies the rule set (its options and the discovery version), not the elements, so each run records the elements it tapped (`run.json` `interaction.steps[].label` / `signature`, `results.json` `runs[].interaction.targetsKey`); when different pairs of one request resolved different elements (a page that varies between loads), the aggregate adds an `interaction-targets-differ` warning (each delta still compares the same elements, but the pairs are not replicates; pin the scenario with explicit steps for a stable campaign). `auto` is a way to get a first INP reading on any page; an explicit scenario remains the tool for a reviewed, repeatable campaign.

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --interactions auto -n 5            # INP of whatever the page offers, no selectors
perf-ab --config experiments/<name>.json -n 1 --local                                   # a config with "interactions": "auto"
```

The steps are declarative and identical for before and after (no arbitrary code). Pass a JSON file with `--interactions <file.json>`, or set `interactions` in a config (inline array, a relative file reference like the other file references, or the word `auto`):

```json
[
  { "action": "waitFor", "selector": "button#tab-compare-plans-2" },
  { "action": "tap", "selector": "button#tab-compare-plans-2", "label": "Business tab" },
  { "action": "press", "key": "Escape", "ms": 500 }
]
```

| action | fields | meaning |
| --- | --- | --- |
| `tap` | `selector`, `ms`? | touch tap on the visible element (`ms` = settle pause afterwards, default 1000) |
| `click` | `selector`, `ms`? | mouse click on the visible element |
| `type` | `selector`, `text`, `ms`? | focuses the element (no extra tap) and types key by key (50 ms apart; every character is its own interaction) |
| `press` | `key`, `selector`?, `ms`? | key press (`Enter`, `ArrowDown`, a character); `selector` is focused first |
| `waitFor` | `selector`, `ms`? | wait until visible (`ms` = timeout, default 30 s, max 60 s) |
| `scroll` | `selector`?, `ms`? | scroll the element into view, or one viewport down (`ms` = settle pause, default 500) |
| `pause` | `ms` | wait 1 ms to 10 s |
| `auto` | `max`?, `kinds`?, `exclude`?, `scope`?, `ms`? | find and tap the page's own tabs, toggles, safe buttons and a modal opener (see above) |

`tap`, `click`, `type`, `press` and `auto` are the interactions INP measures; the others only prepare them. Selectors are CSS (Puppeteer selectors such as `::-p-text(Buy now)` also work), up to 300 characters; at most 20 steps; every field is bounded and unknown fields are refused; at least one interaction step is required. `label` (up to 80 characters) names a step in the dashboard; selectors, typed text and keys are never published.

A run is accepted only when every interaction step finds its selector visible (else the run fails and the error is reported), Chrome registered an interaction (INP is finite), and the **main frame did not navigate** and no new tab opened during the steps (a scenario that leaves the page, such as a CTA that goes to checkout, is invalid and fails; iframes, e.g. a commerce modal, may navigate). Interactions alone are not a change: without other options the URL is measured as-is (INP of the page's own scenario); with any change option both variants replay the same steps.

`results.json` gains `interactions` (the steps) and `interactionsKey` (sha256 of the steps without labels): runs with different keys are never combined (the aggregate refuses a pair with another scenario) or compared (the dashboard's comparable-runs list). INP gets medians and a median paired delta like the other metrics, from complete pairs only; a pair without a finite INP is incomplete. Per run, `run.json` and `pair<i>/results.json` record `interaction`: the steps that ran, the number of interactions Chrome saw and a breakdown of the slowest one (input delay, processing time, presentation delay, and its step when unambiguous); diagnostics only, never used for medians.

Extra files per run next to the navigation's `report.html` / `report.json` / `trace.json` / `devtoolslog.json`: `interaction/report.html`, `interaction/report.json`, `interaction/trace.json`, `interaction/devtoolslog.json` (the timespan) and `flow-report.html` (the Lighthouse flow report with both steps).

Lab INP under 4x CPU throttling is noisy, and with fewer than 50 interactions INP is the single worst one, so keep scenarios short and representative and use `-n 5` for a campaign. The dashboard reads a median INP change under 40 ms as within noise (`NOISE.INP` in `site/dashboard-core.mjs`, an assumption that is easy to tune). Example: `experiments/acrobat-plans-inp.json` (the Acrobat plans tab switches).

```sh
perf-ab "https://www.adobe.com/acrobat/plans.html" --interactions ./plans-tabs.json -n 5            # INP of this page's explicit scenario, as-is
perf-ab "https://www.adobe.com/acrobat/plans.html" --interactions ./plans-tabs.json --milo-pr 7062 -n 5   # the same steps, before/after a PR
perf-ab --config experiments/acrobat-plans-inp.json -n 1 -o ./inp-smoke --local                      # smoke: one pair
```

### Testing preload links (`--head-inject`)

The snippet is inserted into the "after" document before the first `<script>` in `<head>`; "before" is the unmodified live page.

**The snippet is the only source of preloads for the "after" page.** Whenever `--head-inject` (or a config's `headInject`) is applied, on Actions and with `--local`, every `rel=preload` / `rel=modulepreload` entry of the after document's `Link` response header is unset; other `Link` entries (preconnect, canonical, ...) stay and the before document is never touched. The comparison is therefore production headers + HTML against the snippet alone. `results.json` `hints.linkHeaderStripped` and `hints.linkHeaderEntries` record how many entries were removed and which, `hints.perPair[].linkHeaderStripped` repeats the count per job, and the console prints both. Without `--head-inject` nothing is unset. Hints whose URL carries country/locale parameters (for example MAS `/mas/io/fragment?...&country=CH`) are re-resolved against the requests of the first US baseline run of the same job; hints with no matching US request are dropped and reported, and `/experienceedge` hints are always dropped.

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
