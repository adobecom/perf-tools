# MAS performance tickets

## Done - verified MAS/merch implementations (19)

| Jira | Full Jira title | Jira status | Scope / disposition |
| --- | --- | --- | --- |
| [MWPW-193415](https://jira.corp.adobe.com/browse/MWPW-193415) | [wcs] switch to pre-formatted price | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-196496](https://jira.corp.adobe.com/browse/MWPW-196496) | Slim down merch-card-collection bundle: drop unneeded service & hydrate/variant imports | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-200568](https://jira.corp.adobe.com/browse/MWPW-200568) | Optimize MAS/Commerce request chain for js files for LCP Improvement | Done | MAS/merch; Verified merged implementation; resolution: Fixed |
| [MWPW-202276](https://jira.corp.adobe.com/browse/MWPW-202276) | M@S: Merge mas-fields.js and commerce.js | Done | MAS/merch; Verified merged implementation; resolution: Fixed |
| [MWPW-202286](https://jira.corp.adobe.com/browse/MWPW-202286) | [M@S][Loot Loaders] Don't load merch-card and Lit in LCP blocks for mas-field content | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-202435](https://jira.corp.adobe.com/browse/MWPW-202435) | Tech debt: avoid relocating mas-field CTA content outside the mas-field wrapper | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-204069](https://jira.corp.adobe.com/browse/MWPW-204069) | [MAS] Make Fragment Prefetchable | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-209962](https://jira.corp.adobe.com/browse/MWPW-209962) | Make market.js a static dependency of merch.js to reduce LCP | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-209997](https://jira.corp.adobe.com/browse/MWPW-209997) | [Merch] Inline debounce in libs/blocks/merch/autoblock.js to remove utils/action.js from the merch.js critical-path module waterfall | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-210864](https://jira.corp.adobe.com/browse/MWPW-210864) | [Perf] M@S: Investigate the idle gap before FCP on Acrobat plans | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-210865](https://jira.corp.adobe.com/browse/MWPW-210865) | [Perf][M@S] Do not load Spectrum when Merch card collection is used as a blade | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-210970](https://jira.corp.adobe.com/browse/MWPW-210970) | HP \| MAS \| Fix fragment cache bug causing an extra 5 s delay | Closed | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-211199](https://jira.corp.adobe.com/browse/MWPW-211199) | [Homepage][Perf] Eliminate waterfall gap before checkout-link.json, attributes.js, and action.js | Done | MAS/merch; Verified merged implementation; resolution: Fixed |
| [MWPW-211778](https://jira.corp.adobe.com/browse/MWPW-211778) | [Perf][M@S] Merch cards appear to wait for IMS (bfp + token check) before rendering on Acrobat plans | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-212965](https://jira.corp.adobe.com/browse/MWPW-212965) | Performance - Merge market.js into utils.js | Done | MAS/merch; Verified merged implementation; resolution: Done |
| [MWPW-213120](https://jira.corp.adobe.com/browse/MWPW-213120) | [Perf][M@S] Plans cards take ~4s from merch-card-collection load to render | Done | MAS/merch; Verified merged implementation; resolution: Done |

## In progress (13)

| Jira | Full Jira title | Jira status | Scope / disposition |
| --- | --- | --- | --- |
| [MWPW-204860](https://jira.corp.adobe.com/browse/MWPW-204860) | Remove Lit dependency from merch-card.js to improve page performance | In Development | MAS/merch candidate |
| [MWPW-204875](https://jira.corp.adobe.com/browse/MWPW-204875) | Preload IMS | Deployed in Prod | MAS/merch candidate; merged IMS preload was reverted |
| [MWPW-209647](https://jira.corp.adobe.com/browse/MWPW-209647) | M@S: Reduce commerce.js and merch.js download size | Analyzing | MAS/merch candidate |
| [MWPW-209648](https://jira.corp.adobe.com/browse/MWPW-209648) | M@S: Cosmocats-led investigation into further performance improvements | Analyzing | MAS/merch candidate |
| [MWPW-212268](https://jira.corp.adobe.com/browse/MWPW-212268) | [Due Diligence] Remove checkout-link.json | In Development | MAS/merch candidate |
| [MWPW-212818](https://jira.corp.adobe.com/browse/MWPW-212818) | Stop bundling shared helpers in both merch-card.js and commerce.js | In Development | MAS/merch candidate |
| [MWPW-212819](https://jira.corp.adobe.com/browse/MWPW-212819) | Move M@S web-component CSS out of JS template literals and minify it at build time (Lit-independent) | In Development | MAS/merch candidate |
| [MWPW-212977](https://jira.corp.adobe.com/browse/MWPW-212977) | [UPP][Perf] M@S fragment preload: use utils.js market helpers instead of preloading market.js | In Test | MAS consumer repo (outside MAS/Milo) |
| [MWPW-212978](https://jira.corp.adobe.com/browse/MWPW-212978) | [Due Diligence] Slice merch-card.js for LCP: decide which card templates load individually | Ready for Sprint | MAS/merch candidate |
| [MWPW-213687](https://jira.corp.adobe.com/browse/MWPW-213687) | [Due Diligence] Trace-driven LCP preload manifests (PoC) | In Development | Performance tooling |
| [MWPW-214359](https://jira.corp.adobe.com/browse/MWPW-214359) | [Perf] Acrobat plans: first card re-renders late and delays LCP | In Development | MAS/merch candidate |

## To do (16)

| Jira | Full Jira title | Jira status | Scope / disposition |
| --- | --- | --- | --- |
| [MWPW-213117](https://jira.corp.adobe.com/browse/MWPW-213117) | [Perf] Block JS files fetched twice (preload as=script + import()) on C2/Acrobat pages | Draft | Pure Milo / generic page performance |
| [MWPW-213713](https://jira.corp.adobe.com/browse/MWPW-213713) | [DC][Perf] M@S fragment preload: use utils.js market helpers instead of preloading market.js | Draft | MAS consumer repo (outside MAS/Milo) |
| [MWPW-213714](https://jira.corp.adobe.com/browse/MWPW-213714) | [CC][Perf] M@S fragment preload: use utils.js market helpers instead of preloading market.js | Draft | MAS consumer repo (outside MAS/Milo) |
| [MWPW-213916](https://jira.corp.adobe.com/browse/MWPW-213916) | [Perf] Reuse supported-markets config in language banner to avoid duplicate fetch | Open | Pure Milo / generic page performance |
| [MWPW-214382](https://jira.corp.adobe.com/browse/MWPW-214382) | [MAS] Mini compare chart: align short description rendering with the Pro card fix | Draft | MAS/merch candidate |
| [MWPW-214389](https://jira.corp.adobe.com/browse/MWPW-214389) | Reduce cookie consent banner height to prevent it becoming mobile LCP | Draft | Pure Milo / generic page performance |
| [MWPW-214393](https://jira.corp.adobe.com/browse/MWPW-214393) | Investigate the performance cost of the two Typekit domains (use.typekit.net and p.typekit.net) on Acrobat plans | Draft | Pure Milo / generic page performance |
| [MWPW-214394](https://jira.corp.adobe.com/browse/MWPW-214394) | Make Target (interact) logic independent of utils.js so it can fire earlier | Draft | Pure Milo / generic page performance |
| [MWPW-214410](https://jira.corp.adobe.com/browse/MWPW-214410) | Avoid forced style recalc in merch-card resyncOnReflow on mas:resolved (MAS) | Draft | MAS/merch candidate |
| [MWPW-214411](https://jira.corp.adobe.com/browse/MWPW-214411) | Avoid forced style recalc at the start of merch-card-collection updated() (MAS) | Draft | MAS/merch candidate |
| [MWPW-214412](https://jira.corp.adobe.com/browse/MWPW-214412) | Remove forced style recalcs from applyPreservedStyles in merch autoblock heading override (Milo autoblock.js) | Draft | MAS/merch candidate |
| [MWPW-214416](https://jira.corp.adobe.com/browse/MWPW-214416) | [Perf] Tabs init re-runs merch-card connectedCallback on already-hydrated cards (long tasks on /acrobat/plans) | Draft | MAS/merch candidate |
| [WPS-36552](https://jira.corp.adobe.com/browse/WPS-36552) | /mas/io/fragment: tiered distribution | To Do | Platform/infrastructure |
