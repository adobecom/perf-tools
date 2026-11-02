# perf-tools

Page-load performance tools, consumed mainly as **agent skills**:

- `perf-preload` loads a page several times, finds the LCP in each trace and the resources that finished before it, and writes static `<link rel="modulepreload|preload">` tags for `head.html`.
- `perf-ab` is an A/B page-load trace runner built for **production URLs**: it loads a live page (for example `www.adobe.com`) twice, once as-is and once with selected resources proxied from a Milo / MAS PR, branch or local checkout, or with an injected `head.html` snippet such as preload links. Runs alternate, a median summary is printed, and DevTools-loadable traces are saved.

Fixed conditions, matching Chrome DevTools: mobile emulation (iPhone 16 Pro Max, 440x956, 3x DPR, touch, iOS UA), 4x CPU throttle, "Slow 4G" (180 KB/s down, 84 KB/s up, 562.5 ms latency), cache disabled.

## Quick start

In the GitHub Copilot app:

1. [Add the `adobecom/perf-tools` marketplace](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dadobecom%252Fperf-tools).
2. [Install the `perf-tools` plugin](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dperf-tools%2540perf-tools).

Then ask for preloads or a comparison in a new session. Needs Node.js 18+ and Google Chrome.

## Sample prompts

Preload generation (`perf-preload`):

- "Generate preloads for https://www.adobe.com/products/photoshop.html, 3 runs, then validate them with perf-ab."
- "What does the LCP of the acrobat plans page depend on, and what should we preload?"
- "Build a preload list from these traces (Trace-1.json, Trace-2.json)."

Milo / MAS PRs on a production page:

- "perf-ab Milo PR 7062 on https://www.adobe.com/acrobat/plans.html, 3 runs."
- "Compare Milo PR 7062 and MAS PR 1487 on https://www.adobe.com/acrobat/plans.html and tell me if LCP or TBT regress."
- "Measure the impact of my open Milo PR on the photoshop product page, 5 runs, and summarize the medians."

Local checkouts:

- "Run perf-ab on https://www.adobe.com/ with my local Milo checkout `~/git/milo/libs` overriding `/libs`, against stage as the baseline."

Preload links / `head.html` experiments:

- "Test the preload snippet in `snippet.html` on https://www.adobe.com/products/photoshop.html, 5 runs."
- "Inject this head snippet before the first script on the acrobat plans page and compare LCP and TBT."

Branch hosts (pages that honor `?milolibs=`):

- "A/B `my-feature` against `my-feature-stage` on https://www.stage.adobe.com/products/photoshop.html."

Analyzing traces you already have:

- "Compare these two DevTools traces (before.json, after.json): FCP, LCP, TBT and which preloads differ."
- "Check whether Trace-1.json actually loaded `/libs/` from the branch host."

The skill picks the right mode, verifies that the proxied files were really served, and reports medians with a noise warning for deltas under about 100 ms. See [`skills/perf-preload/SKILL.md`](skills/perf-preload/SKILL.md) and [`skills/perf-ab/SKILL.md`](skills/perf-ab/SKILL.md) for the full instructions the agent follows.

## CLI reference

Run `perf-preload --help` and `perf-ab --help` for all options.

```sh
# LCP preloads: 3 recorded runs, writes ./preloads/products--photoshop.html and ./preloads/traces
perf-preload "https://www.adobe.com/products/photoshop.html" -n 3 -o ./preloads

# The same from existing DevTools traces
perf-preload --from Trace-1.json --from Trace-2.json -o ./preloads
```

Production pages ignore `?milolibs=` / `?maslibs=`, so `perf-ab` proxies the resources instead.

```sh
# Milo / MAS PR delta: only the files changed by the PR are proxied
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 3

# Local checkouts (--override-before does the same for the baseline)
perf-ab "https://www.adobe.com/" \
  --override /libs=~/git/milo/libs \
  --override /libs/deps/mas=~/git/mas/web-components/dist

# Injected head snippet (for example from perf-preload)
perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject ./preloads/products--photoshop.html -n 5

# Branch hosts
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 5
```

### Testing preload links (`--head-inject`)

The snippet is inserted into the change variant's document before the first `<script>` in `<head>`; the baseline is the unmodified live page. Both documents go through the same simulated Slow 4G delay, and the preloaded files are fetched live through Chrome's throttling.

`perf-preload` writes the snippet as static tags, sorted by start time in the recorded traces. For example:

```html
<link rel="modulepreload" href="/creativecloud/scripts/utils.js">
<link rel="modulepreload" href="/libs/blocks/hero-marquee/hero-marquee.js">
<link rel="preload" href="/libs/blocks/hero-marquee/hero-marquee.css" as="style">
<link rel="modulepreload" href="/libs/features/placeholders.js">
```

Static tags need no script in `<head>`: the preload scanner finds them as soon as the HTML arrives. `head.html` is shared by all pages, so only resources common to every page belong there; page-specific tags need per-page injection (an edge worker or server-side). The LCP image URL is viewport-specific; use `perf-preload --no-lcp-image` when the tags are not mobile-only.

What to check afterwards:
- The first run prints where the snippet was injected.
- In the saved `after<n>.json` traces, the preloaded resources start right after the document, earlier than in `before<n>.json`.
- With `PERF_AB_DEBUG=1`, "preloaded but not used" console warnings mean the snippet lists resources the page doesn't need.
- Do not add `?mep=off` to the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

### Notes

- When releasing, bump `version` in `package.json`, `plugin.json` and `.claude-plugin/plugin.json` together.
- Runs headed by default: some hosts (for example `www.stage.adobe.com`) reject headless browsers.
- One warm-up load per variant is done first and not counted.
- Reported metrics: FCP, LCP, DCL, Load, TBT (from FCP), CLS, main-thread `v8.compileModule`, request count, `loadLink` script fetches as module (modulepreload) vs link (preload), duplicate script fetches.

## License

Apache-2.0, see [LICENSE](LICENSE).
