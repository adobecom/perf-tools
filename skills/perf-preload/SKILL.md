---
name: perf-preload
description: Generate static preload `<link>` tags for a page's LCP with the `perf-preload` CLI (adobecom/perf-tools). Records a production page several times through perf-ab (always real Lighthouse 13.6.0, mobile profile with real DevTools throttling; by default on a verified-US GitHub Actions runner, or locally with --local; every load cold with a fresh Chrome and empty profile, no warm-ups), finds the LCP element in each trace and the scripts, stylesheets, fonts, GET JSON/HTML data fetches and LCP image that finished loading before it, and writes a head.html snippet of `<link rel="modulepreload|preload">` tags. Then validates the snippet with perf-ab. Also analyzes DevTools trace JSON files attached by the user. Use when asked to "generate preloads", "what should be preloaded for LCP", "find the LCP critical resources", "build a preload list / head.html snippet", or "why is LCP late on this page".
---

# LCP preload generator (`perf-preload`)

CLI from `adobecom/perf-tools` (needs Node 22.19+; Actions runs also need `gh` authenticated with Actions write access to `adobecom/perf-tools`, `--local` runs need Chrome). Check it is installed with `perf-preload --help`. If it is missing, replace `perf-preload` with `npx -y -p github:adobecom/perf-tools perf-preload` (and `perf-ab` with `npx -y -p github:adobecom/perf-tools perf-ab`) in every command below.

It records through `perf-ab` (see the perf-ab skill): always Lighthouse 13.6.0, mobile, with real DevTools throttling (Slow 4G, 4x CPU). The user never needs to mention Lighthouse or a mode; the only choice is where it runs. By default that is the `perf-ab` GitHub Actions workflow with verified US egress (fails closed). When the user asks to run locally, add `--local` (same Lighthouse run on this machine; it needs Chrome, a non-US location is allowed but reported, and its results are not comparable with Actions results). Never switch to `--local` on your own after a failed Actions run. Every recorded load is cold: a new Chrome process with an empty profile per run and retry, no warm-up (OS DNS and CDN caches are not purged, and no cache-busting is added). It reads exactly the n accepted traces (`<out>/traces/pair<i>/after<i>/trace.json`) after checking `results.json` reports `status: "ok"`, the expected location (US egress on Actions, `where: "local"` with `--local`) and the profile. The throttling is applied by Chrome itself, so these traces are those of the throttled load: the LCP time and "finished before LCP" are throttled-load timings and agree with the Lighthouse metrics. Run the command async; it takes several minutes.

## 1. Generate

```sh
perf-preload "https://www.adobe.com/products/photoshop.html" -n 5 -o ./preloads
```

For each trace it finds the final LCP candidate (for an image LCP, its URL), then keeps the scripts, stylesheets, fonts, GET data fetches and the LCP image whose response finished before LCP. It skips the document and the resources the HTML parser already requests from the markup (those are discovered as early as possible already). A resource must appear in a majority of runs (`--min-runs`); each URL counts once per trace, however often it was requested. Only same-site URLs are kept unless `--all-origins`.

The page must be `https://` on a subdomain of `adobe.com` (the same target policy as perf-ab: no apex, credentials, ports, lookalikes or private destinations); anything else is refused before recording.

Data fetches: modern Chrome records `fetch()`, XHR and script-inserted `as="fetch"` preloads as resource type `Other`, so earlier versions silently omitted them (placeholders, `checkout-link.json`, personalization manifests, `.plain.html` fragments, `/mas/io/fragment`). They are now kept when the trace shows a `fetch`/`xmlhttprequest` initiator or a link fetch preload, method GET, a 2xx response and a JSON or HTML MIME type. Never kept: POST and other methods, beacons/pings, unrelated `Other` requests (documents, favicons, images fetched by script), and anything matched by an exclude rule (below). Legacy traces without `requestMethod`: only an explicit `Fetch`/`XHR` type is assumed to be GET, with a warning. The type of a URL comes from its real consumer, not from a script preload of it.

Exclude rules (built in, always on; the user never has to ask for them): never emit links for `/marketingtech/*` (any origin of the page), the host `bfp.adobe.com` (and subdomains) or any `/experienceedge` or `/experienceedge/*` path (`/experienceedgefoo` or `/foo/experienceedge` are unaffected). They are printed under "Excluded by rule" with the matching rule, so say so when reporting. Add more with the repeatable `--exclude <path-prefix|host>` (for example `--exclude /libs/martech`, `--exclude cdn.example.net`); it works the same with `--from`. Do not hand-edit the generated snippet to apply these rules, and do not drop the rules to "fix" an output: rerun with `--exclude` instead.

The snippet is the single source of preloads for the page: when the snippet is tested, `perf-ab --head-inject` unsets the document's `Link` response header preloads (see the perf-ab skill). So resources that production preloads through its `Link` header today are generated like any other resource and marked `^` in the table (a script-inserted preload keeps the `*` mark; a resource the HTML parser requests from the markup is still skipped). Do not remove `^` resources from the snippet just because production already preloads them.

Limitations: the generated `as="fetch" crossorigin` assumes the consumer is a default `fetch()`/XHR (CORS, same-origin credentials). The tool does not infer or reproduce custom headers, authorization or non-default credentials (`credentials: 'include'`, `omit`), and a trace does not show them, so such URLs can still appear in the output. Review data links and remove any whose consumer sends custom headers or non-default credentials: the preload would not match, the file would download twice and the request could differ from the real one (check for "preloaded but not used" warnings).

Output:
- A table: median start / end (ms from navigation), resource type, URL. `*` marks resources that a script already preloads (for example Milo `preloadLcpCodeFiles`); a static tag still starts them earlier, because no script has to run first.
- `<out>/<page-key>.html` (`/products/photoshop.html` becomes `products--photoshop.html`) with tags sorted by start time: `modulepreload` for module scripts, `preload as=script|style|font|fetch|image`, `crossorigin` where the consumer's fetch mode needs it (fonts, fetches, cross-origin scripts; never stylesheets, which load without CORS), absolute URLs for stylesheets (a relative one can be mistaken for the stylesheet by site loaders that match `link[href]` without `rel`, leaving it unapplied), `fetchpriority="high"` for the LCP image. In the table, `!` marks URLs with country/locale query parameters (for example `/mas/io/fragment?...&locale=en_US&country=CH`): serve such a link only to visitors in the matching context, never hardcode it in a global `head.html`.
- The perf-ab download in `<out>/traces` (`results.json`, official Lighthouse reports and one cold `pair<i>/after<i>/trace.json` per run: perf-ab runs `-n` parallel matrix jobs of one load each; the accepted runs listed in `results.json` are counted, `rejected/` never) and a ready-made validate command. The generator reads LCP and the finish times from these throttled traces.

Existing traces (DevTools exports, perf-ab output, user attachments): `perf-preload --from Trace-1.json --from ./traces -o ./preloads`. Only cold traces taken under the same conditions are comparable. A default perf-ab output directory (with `results.json`, including the paired `pair<i>/` layout) contributes only its accepted runs' `trace.json` and is refused unless `status` is `ok`; for a before/after output only the unchanged "before" runs are used, never the changed "after" page. In other `--from` directories, legacy perf-ab warm-up traces (`before0.json` / `after0.json`) and traces with `metadata.perfAb.warmup: true` are skipped with a warning.

Other flags: `--local`, `--exclude <rule>`, `--no-lcp-image`, `--min-runs <k>`, `--all-origins` (all third parties; by default only the page's site and `*.typekit.net` are kept). See `perf-preload --help`.

## 2. Review the list before validating

Everything that finished before LCP is a candidate, not a requirement. Prune with the user:
- Keep: the LCP block's JS/CSS, the LCP image, fonts the LCP text uses, JSON/HTML fetches the LCP block awaits (placeholders, fragments, MAS cards). Country/locale-specific URLs (`!`) only for the matching context.
- Usually drop: analytics / martech / personalization not on the LCP path, resources that start long after the LCP block's code, and anything below the fold. Too many preloads compete with the LCP resources for the limited mobile bandwidth.
- The LCP image URL is viewport-specific (for example `width=750` on mobile). Keep it only if the snippet is served to mobile only or the page uses the same URL everywhere; otherwise use `--no-lcp-image`.
- Use the table to diagnose LCP: a large gap between navigation and the start of the LCP block's code means late discovery (preloads help); an LCP image that starts well after its block code finished means the block discovers it late; a long end - start means bandwidth or size.

## 3. Validate with perf-ab

```sh
perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject ./preloads/products--photoshop.html -n 1   # smoke pair first
perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject ./preloads/products--photoshop.html -n 5
```

Each `-n` pair is its own cold before/after job; the comparison uses complete pairs only (`status: "partial"` means some pairs are missing: report it as incomplete). Once the user approves a snippet, store it as a versioned experiment config under `experiments/` (see the perf-ab skill) so it can be re-run with `perf-ab --config`.

The snippet is injected before the first `<script>` in `<head>` of the "after" variant only; the baseline is the live page. Country/locale-specific hints are re-resolved against the US baseline's requests (unmatched ones are dropped and reported). Run the validation in the same place as the recording unless the user says otherwise (add `--local` to it when recording was local). Report the Lighthouse medians from `results.json` (score, LCP, FCP, TBT, CLS), `hints.linkHeaderStripped` / `linkHeaderEntries` (the production Link-header preloads unset in "after") and the official `report.html` files; treat small deltas as noise and rerun with more runs. Check `hints.usedLinks` vs `requestedLinks`, and in the "after" report's network requests each preloaded file should be fetched once, right after the document. Do not add `?mep=off`: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

## 4. Shipping the tags

Static tags need no JavaScript in `<head>`: the browser's preload scanner finds them as soon as the HTML arrives. On EDS, `head.html` is the same for every page, so:
- Resources shared by all pages (for example `utils.js`, `styles.css`, common fonts) can go into `head.html` directly.
- Page-specific tags need per-page injection (an edge worker or the server rendering the page), not `head.html`.
