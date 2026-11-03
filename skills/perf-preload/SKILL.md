---
name: perf-preload
description: Generate static preload `<link>` tags for a page's LCP with the `perf-preload` CLI (adobecom/perf-tools). Loads a production page several times (iPhone 16 Pro Max, 4x CPU, DevTools Slow 4G, cache disabled), finds the LCP element in each trace and the scripts, stylesheets, fonts, GET JSON/HTML data fetches and LCP image that finished loading before it, and writes a head.html snippet of `<link rel="modulepreload|preload">` tags. Then validates the snippet with perf-ab. Also analyzes DevTools trace JSON files attached by the user. Use when asked to "generate preloads", "what should be preloaded for LCP", "find the LCP critical resources", "build a preload list / head.html snippet", or "why is LCP late on this page".
---

# LCP preload generator (`perf-preload`)

CLI from `adobecom/perf-tools` (needs Node 18+ and Google Chrome). Check it is installed with `perf-preload --help`. If it is missing, replace `perf-preload` with `npx -y -p github:adobecom/perf-tools perf-preload` (and `perf-ab` with `npx -y -p github:adobecom/perf-tools perf-ab`) in every command below.

It records through `perf-ab`, so it runs **headed Chrome** under the same fixed conditions, and every recorded load is cold: a new browser process with an empty profile per run and retry, no warm-up (OS DNS and CDN caches are not purged, and no cache-busting is added). Keep the Chrome window visible and run the command async; 3 runs take about 2 minutes.

## 1. Generate

```sh
perf-preload "https://www.adobe.com/products/photoshop.html" -n 3 -o ./preloads
```

For each trace it finds the final LCP candidate (for an image LCP, its URL), then keeps the scripts, stylesheets, fonts, GET data fetches and the LCP image whose response finished before LCP. It skips the document and the resources the HTML parser already requests from the markup (those are discovered as early as possible already). A resource must appear in a majority of runs (`--min-runs`); each URL counts once per trace, however often it was requested. Only same-site URLs are kept unless `--all-origins`.

Data fetches: modern Chrome records `fetch()`, XHR and script-inserted `as="fetch"` preloads as resource type `Other`, so earlier versions silently omitted them (placeholders, `checkout-link.json`, personalization manifests, `.plain.html` fragments, `/mas/io/fragment`). They are now kept when the trace shows a `fetch`/`xmlhttprequest` initiator or a link fetch preload, method GET, a 2xx response and a JSON or HTML MIME type. Never kept: POST and other methods, beacons/pings, unrelated `Other` requests (documents, favicons, images fetched by script), and any `/experienceedge` or `/experienceedge/*` path, whatever its method, type or MIME (`/experienceedgefoo` or `/foo/experienceedge` are unaffected). Legacy traces without `requestMethod`: only an explicit `Fetch`/`XHR` type is assumed to be GET, with a warning. The type of a URL comes from its real consumer, not from a script preload of it.

Limitations: the generated `as="fetch" crossorigin` assumes the consumer is a default `fetch()`/XHR (CORS, same-origin credentials). The tool does not infer or reproduce custom headers, authorization or non-default credentials (`credentials: 'include'`, `omit`), and a trace does not show them, so such URLs can still appear in the output. Review data links and remove any whose consumer sends custom headers or non-default credentials: the preload would not match, the file would download twice and the request could differ from the real one (check for "preloaded but not used" warnings).

Output:
- A table: median start / end (ms from navigation), resource type, URL. `*` marks resources that a script already preloads (for example Milo `preloadLcpCodeFiles`); a static tag still starts them earlier, because no script has to run first.
- `<out>/<page-key>.html` (`/products/photoshop.html` becomes `products--photoshop.html`) with tags sorted by start time: `modulepreload` for module scripts, `preload as=script|style|font|fetch|image`, `crossorigin` where the consumer's fetch mode needs it (fonts, fetches, cross-origin scripts; never stylesheets, which load without CORS), absolute URLs for stylesheets (a relative one can be mistaken for the stylesheet by site loaders that match `link[href]` without `rel`, leaving it unapplied), `fetchpriority="high"` for the LCP image. In the table, `!` marks URLs with country/locale query parameters (for example `/mas/io/fragment?...&locale=en_US&country=CH`): serve such a link only to visitors in the matching context, never hardcode it in a global `head.html`.
- Traces in `<out>/traces` (`after1..n.json`, one cold load each; all are counted) and a ready-made validate command.

Existing traces (DevTools exports, perf-ab output, user attachments): `perf-preload --from Trace-1.json --from ./traces -o ./preloads`. Only cold traces taken under the same conditions are comparable. In a `--from` directory, legacy perf-ab warm-up traces (`before0.json` / `after0.json`) and traces with `metadata.perfAb.warmup: true` are skipped with a warning.

Other flags: `--no-lcp-image`, `--min-runs <k>`, `--all-origins`, `--device`, `--cpu`, `--channel`, `--headless`. See `perf-preload --help`.

## 2. Review the list before validating

Everything that finished before LCP is a candidate, not a requirement. Prune with the user:
- Keep: the LCP block's JS/CSS, the LCP image, fonts the LCP text uses, JSON/HTML fetches the LCP block awaits (placeholders, fragments, MAS cards). Country/locale-specific URLs (`!`) only for the matching context.
- Usually drop: analytics / martech / personalization not on the LCP path, resources that start long after the LCP block's code, and anything below the fold. Too many preloads compete with the LCP resources for Slow 4G bandwidth.
- The LCP image URL is viewport-specific (for example `width=750` on mobile). Keep it only if the snippet is served to mobile only or the page uses the same URL everywhere; otherwise use `--no-lcp-image`.
- Use the table to diagnose LCP: a large gap between navigation and the start of the LCP block's code means late discovery (preloads help); an LCP image that starts well after its block code finished means the block discovers it late; a long end - start means bandwidth or size.

## 3. Validate with perf-ab

```sh
perf-ab "https://www.adobe.com/products/photoshop.html" --head-inject ./preloads/products--photoshop.html -n 5
```

The snippet is injected before the first `<script>` in `<head>` of the change variant only; the baseline is the live page. Report the median LCP / FCP / TBT deltas and treat deltas under about 100 ms as noise (rerun with more runs). In the `after<i>.json` traces the preloaded files should start right after the document, earlier than in `before<i>.json`. With `PERF_AB_DEBUG=1`, "preloaded but not used" console warnings mean a tag should be removed. Do not add `?mep=off`: it disables the existing `preloadLcpCodeFiles`, which is part of the baseline.

## 4. Shipping the tags

Static tags need no JavaScript in `<head>`: the browser's preload scanner finds them as soon as the HTML arrives. On EDS, `head.html` is the same for every page, so:
- Resources shared by all pages (for example `utils.js`, `styles.css`, common fonts) can go into `head.html` directly.
- Page-specific tags need per-page injection (an edge worker or the server rendering the page), not `head.html`.
