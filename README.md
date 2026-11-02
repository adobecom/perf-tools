# perf-tools

Page-load performance tools, consumed mainly as an **agent skill**. The first tool, `perf-ab`, is an A/B page-load trace runner built for **production URLs**: it loads a live page (for example `www.adobe.com`) twice, once as-is and once with selected resources proxied from a Milo / MAS PR, branch or local checkout, or with an injected `head.html` snippet such as preload links. Runs alternate, a median summary is printed, and DevTools-loadable traces are saved.

Fixed conditions, matching Chrome DevTools: mobile emulation (iPhone 16 Pro Max, 440x956, 3x DPR, touch, iOS UA), 4x CPU throttle, "Slow 4G" (180 KB/s down, 84 KB/s up, 562.5 ms latency), cache disabled.

## Quick start

Requires Node.js 18+ and Google Chrome.

1. Install the plugin, which contains the `perf-ab` skill.

   GitHub Copilot CLI:

   ```sh
   copilot plugin marketplace add adobecom/perf-tools
   copilot plugin install perf-tools@perf-tools
   ```

   Claude Code:

   ```sh
   claude plugin marketplace add adobecom/perf-tools
   claude plugin install perf-tools@perf-tools
   ```

   Update later with `copilot plugin update perf-tools` or `claude plugin update perf-tools@perf-tools`.

2. Optionally install the CLI globally. Without it, the skill runs `npx -y github:adobecom/perf-tools`, which is slower on first use.

   ```sh
   npm install -g github:adobecom/perf-tools
   ```

3. Ask your agent. A Chrome window opens during runs, so keep it visible; a comparison takes several minutes.

To develop the skill from a local clone, add the clone as a marketplace instead (`copilot plugin marketplace add <clone>`); Copilot CLI loads it live, so edits take effect in the next session. When releasing, bump `version` in `package.json`, `plugin.json` and `.claude-plugin/plugin.json` together; Claude Code keeps users on the installed version until it changes.

## Sample prompts

Milo / MAS PRs on a production page:

- "perf-ab Milo PR 7062 on https://www.adobe.com/acrobat/plans.html, 3 runs."
- "Compare Milo PR 7062 and MAS PR 1487 on https://www.adobe.com/acrobat/plans.html and tell me if LCP or TBT regress."
- "Measure the impact of my open Milo PR on the photoshop product page, 5 runs, and summarize the medians."

Local checkouts:

- "Run perf-ab on https://www.adobe.com/ with my local Milo checkout `~/git/milo/libs` overriding `/libs`, against stage as the baseline."

Preload links / `head.html` experiments:

- "Test the preload snippet in `snippet.html` on https://www.adobe.com/products/photoshop.html with the manifests in `./manifests`, 5 runs."
- "Inject this head snippet before the first script on the acrobat plans page and compare LCP and TBT."

Branch hosts (pages that honor `?milolibs=`):

- "A/B `my-feature` against `my-feature-stage` on https://www.stage.adobe.com/products/photoshop.html."

Analyzing traces you already have:

- "Compare these two DevTools traces (before.json, after.json): FCP, LCP, TBT and which preloads differ."
- "Check whether Trace-1.json actually loaded `/libs/` from the branch host."

The skill picks the right mode, verifies that the proxied files were really served, and reports medians with a noise warning for deltas under about 100 ms. See [`skills/perf-ab/SKILL.md`](skills/perf-ab/SKILL.md) for the full instructions the agent follows.

## CLI reference

Production pages ignore `?milolibs=` / `?maslibs=`, so `perf-ab` proxies the resources instead. Run `perf-ab --help` for all options.

```sh
# Milo / MAS PR delta: only the files changed by the PR are proxied
perf-ab "https://www.adobe.com/acrobat/plans.html" --milo-pr 7062 --mas-pr 1487 -n 3

# Local checkouts (--override-before does the same for the baseline)
perf-ab "https://www.adobe.com/" \
  --override /libs=~/git/milo/libs \
  --override /libs/deps/mas=~/git/mas/web-components/dist

# Injected head snippet plus locally served files
perf-ab "https://www.adobe.com/products/photoshop.html" \
  --head-inject snippet.html \
  --override /lcp-manifests=./manifests -n 5

# Branch hosts
perf-ab "https://www.stage.adobe.com/products/photoshop.html" -b my-feature-stage -a my-feature -n 5
```

### Testing preload links (`--head-inject`)

The snippet is inserted into the change variant's document before the first `<script>` in `<head>`; the baseline is the unmodified live page. Both documents go through the same simulated Slow 4G delay, and the preloaded files are fetched live through Chrome's throttling.

Example `snippet.html`, a classic inline script that fetches a per-page manifest and injects the links:

```html
<script>
  (() => {
    const key = location.pathname.replace(/\.html$/, '').replace(/^\/|\/$/g, '').replace(/\//g, '--') || 'index';
    fetch(`/lcp-manifests/${key}.json`).then((r) => (r.ok ? r.json() : [])).then((links) => {
      links.forEach(([rel, href, as, crossorigin]) => {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = href;
        if (as) link.as = as;
        if (crossorigin) link.crossOrigin = crossorigin;
        document.head.append(link);
      });
    }).catch(() => {});
  })();
</script>
```

A manifest per page, named after the path without query string (`/products/photoshop.html` becomes `manifests/products--photoshop.json`):

```json
[
  ["modulepreload", "/libs/blocks/marquee/marquee.js"],
  ["preload", "/libs/blocks/marquee/marquee.css", "style"],
  ["preload", "/libs/features/placeholders.json", "fetch", "anonymous"]
]
```

What to check afterwards:
- The first run prints where the snippet was injected.
- In the saved `after<n>.json` traces, the manifest request starts before any script request, and the preloaded resources start earlier than in `before<n>.json`.
- With `PERF_AB_DEBUG=1`, "preloaded but not used" console warnings mean the manifest lists resources the page doesn't need.
- Do not add `?mep=off` to the page URL: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

### Notes

- Runs headed by default: some hosts (for example `www.stage.adobe.com`) reject headless browsers.
- One warm-up load per variant is done first and not counted.
- Reported metrics: FCP, LCP, DCL, Load, TBT (from FCP), CLS, main-thread `v8.compileModule`, request count, `loadLink` script fetches as module (modulepreload) vs link (preload), duplicate script fetches.

## License

Apache-2.0, see [LICENSE](LICENSE).
