import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateHref, buildSitePreloads, matchesPages, commonScope, rootLocale, headSnippet, LINK_COLUMNS } from '../lib/site-preloads.mjs';

const A = 'https://www.adobe.com';
const MAS = (q) => `${A}/mas/io/fragment?id=f1&api_key=k&${q}`;

test('href templates: Milo/MAS libs become placeholders, MAS fragments always carry locale and country slots', () => {
  assert.deepEqual(templateHref(`${A}/libs/utils/utils.js`, A), { href: '{milolibs}/utils/utils.js' });
  assert.deepEqual(templateHref('https://main--milo--adobecom.aem.live/libs/c2/styles/styles.css', 'https://main--da-dc--adobecom.aem.live'), { href: '{milolibs}/c2/styles/styles.css' });
  assert.deepEqual(templateHref(`${A}/mas/libs/commerce.js`, A), { href: '{maslibs}/commerce.js' });
  assert.deepEqual(templateHref('https://mwpw-1--mas--adobecom.aem.live/web-components/dist/mas.js', 'https://main--da-dc--adobecom.aem.live'), { href: '{maslibs}/mas.js' });
  const slots = `${A}/mas/io/fragment?id=f1&api_key=k&locale={locale}&country={country}`;
  assert.deepEqual(templateHref(MAS('locale=en_US&country=CH'), A), { href: slots });
  assert.deepEqual(templateHref(MAS('locale=en_US'), A), { href: slots }, 'a US recording still gets the country slot');
  assert.match(templateHref(MAS('locale=en_US&mask=x'), A).skip, /mask/);
  assert.deepEqual(templateHref(`${A}/dc-shared/placeholders.json`, A), { href: '/dc-shared/placeholders.json' });
  assert.match(templateHref(`${A}/x.json?country=CH&sheet=a`, A).skip, /country outside a MAS fragment URL/);
  assert.match(templateHref(`${A}/x.json?lang=de`, A).skip, /lang/);
  assert.deepEqual(templateHref('https://use.typekit.net/hah7vzn.css', A), { href: 'https://use.typekit.net/hah7vzn.css' });
  assert.deepEqual(templateHref('https://other--milo--adobecom.aem.live/libs/x.js', A), { href: '{milolibs}/x.js' });
});

test('pages patterns: "*" every page, "*" one segment part, "**" anything; common scope of recorded pages', () => {
  assert.ok(matchesPages('*', '/fr/anything'));
  assert.ok(matchesPages('/acrobat/**', '/acrobat/pricing/compare-versions'));
  assert.ok(!matchesPages('/acrobat/**', '/fr/acrobat/plans'));
  assert.ok(matchesPages('/acrobat/*', '/acrobat/plans') && !matchesPages('/acrobat/*', '/acrobat/pricing/x'));
  assert.ok(matchesPages('/a, /acrobat/plans', '/acrobat/plans'));
  assert.ok(!matchesPages('/acrobat/plans', '/acrobat/plans-x'));
  assert.equal(commonScope(['/acrobat/plans', '/acrobat/pricing/compare-versions']), '/acrobat/**');
  assert.equal(commonScope(['/acrobat/plans', '/express/x']), null);
});

const rec = (page, device, links) => ({ page: `${A}${page}.html`, device, links: links.map(([url, extra = {}], i) => ({ rel: 'preload', as: 'fetch', crossorigin: 'anonymous', fetchpriority: 'high', url, start: i * 10, ...extra })) });
const UTILS = [`${A}/libs/utils/utils.js`, { rel: 'modulepreload', as: undefined, crossorigin: '', fetchpriority: 'high' }];
const LOW_UTILS = [UTILS[0], { ...UTILS[1], fetchpriority: 'low' }];

test('merge: shared links become global rows, mobile/desktop splits keep their viewport, page links list their pages', () => {
  const { rows, global, pages } = buildSitePreloads([
    rec('/acrobat/plans', 'mobile', [UTILS, [`${A}/dc-shared/placeholders.json`], [MAS('locale=en_US&country=CH')], [`${A}/m.png`, { as: 'image', crossorigin: '' }]]),
    rec('/acrobat/plans', 'desktop', [UTILS, [`${A}/dc-shared/placeholders.json`], [MAS('locale=en_US&country=CH')], [`${A}/d.png`, { as: 'image', crossorigin: '' }]]),
    rec('/acrobat/acrobat-pro', 'mobile', [UTILS, [`${A}/dc-shared/placeholders.json`]]),
    rec('/acrobat/acrobat-pro', 'desktop', [LOW_UTILS, [`${A}/dc-shared/placeholders.json`]]),
  ]);
  assert.equal(global, '/acrobat/**');
  assert.deepEqual(pages, ['/acrobat/acrobat-pro', '/acrobat/plans']);
  assert.deepEqual(rows.map((r) => [r.pages, r.viewport, r.href, r.fetchpriority]), [
    ['/acrobat/**', 'all', '/dc-shared/placeholders.json', 'high'],
    ['/acrobat/**', 'mobile', '{milolibs}/utils/utils.js', 'high'],
    ['/acrobat/acrobat-pro', 'desktop', '{milolibs}/utils/utils.js', 'low'],
    ['/acrobat/plans', 'all', `${A}/mas/io/fragment?id=f1&api_key=k&locale={locale}&country={country}`, 'high'],
    ['/acrobat/plans', 'mobile', '/m.png', 'high'],
    ['/acrobat/plans', 'desktop', '{milolibs}/utils/utils.js', 'high'],
    ['/acrobat/plans', 'desktop', '/d.png', 'high'],
  ]);
  assert.deepEqual(Object.keys(rows[0]), LINK_COLUMNS);
  assert.throws(() => buildSitePreloads([rec('/fr/acrobat/plans', 'mobile', [])]), /localized pages/);
  assert.throws(() => buildSitePreloads([rec('/a', 'unknown', [])]), /unknown profile/);
  assert.throws(() => buildSitePreloads([rec('/a', 'mobile', []), rec('/a', 'mobile', [])]), /given twice/);
  assert.equal(buildSitePreloads([rec('/acrobat/plans', 'mobile', [UTILS])]).rows[0].pages, '/acrobat/plans', 'one page has no global scope');
  assert.equal(buildSitePreloads([rec('/acrobat/plans', 'mobile', [UTILS]), rec('/acrobat/x', 'mobile', [UTILS])], { global: '*' }).rows[0].pages, '*');
});

test('head snippet: the template\'s LINKS / LOCALES lines become one array literal per row; rows are validated', () => {
  const locale = rootLocale({ languages: { data: [{ prefix: 'fr', defaultMarket: 'fr', supportedRegions: 'fr' }, { prefix: '', defaultMarket: 'us', supportedRegions: 'us, ch, gb' }] } });
  assert.deepEqual(locale, { prefix: '', locale: 'en_US', defaultMarket: 'us', supportedRegions: 'us, ch, gb' });
  const template = '<script>\n  (() => {\n    const LINKS = [];\n    const LOCALES = [];\n  })();\n</script>\n';
  const { rows } = buildSitePreloads([rec('/acrobat/plans', 'mobile', [UTILS, [MAS('locale=en_US&country=CH')]])]);
  assert.equal(headSnippet(template, { rows, locales: [locale], note: '1 recording' }), [
    '<script>', '  (() => {', '    // 1 recording', '    const LINKS = [',
    '      ["/acrobat/plans", "mobile", "modulepreload", "{milolibs}/utils/utils.js", "", "", "high"],',
    `      ["/acrobat/plans", "mobile", "preload", "${A}/mas/io/fragment?id=f1&api_key=k&locale={locale}&country={country}", "fetch", "anonymous", "high"],`,
    '    ];', '    const LOCALES = [', '      ["", "en_US", "us", "us, ch, gb"],', '    ];', '  })();', '</script>', '',
  ].join('\n'));
  assert.throws(() => headSnippet(template, { rows }), /no root locale/);
  assert.throws(() => headSnippet(template, { rows: [{ ...rows[0], href: '{region}/x.js' }] }), /unknown placeholder \{region\}/);
  assert.match(headSnippet(template, { rows: [{ ...rows[0], href: '/x</script>.js' }] }), /\/x\\u003c\/script>\.js/);
  assert.match(headSnippet(template, { rows: [{ ...rows[0], href: '/x.js?a=$&' }] }), /"\/x\.js\?a=\$&"/, '"$&" stays literal');
  assert.throws(() => headSnippet('<script></script>', { rows: [] }), /exactly one "const LINKS = \[\];"/);
});

// ---------- the inline loader (prelink/site-head.html) in a minimal fake browser ----------

const TEMPLATE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prelink', 'site-head.html'), 'utf8');
const ROWS = [
  { pages: '/acrobat/**', viewport: 'all', rel: 'modulepreload', href: '{milolibs}/utils/utils.js', as: '', crossorigin: '', fetchpriority: 'high' },
  { pages: '/acrobat/**', viewport: 'all', rel: 'preload', href: '{milolibs}/c2/styles/styles.css', as: 'style', crossorigin: '', fetchpriority: '' },
  { pages: '/acrobat/**', viewport: 'mobile', rel: 'modulepreload', href: '{maslibs}/commerce.js', as: '', crossorigin: '', fetchpriority: 'low' },
  { pages: '/acrobat/plans', viewport: 'desktop', rel: 'preload', href: '/d.png', as: 'image', crossorigin: '', fetchpriority: 'high' },
  { pages: '/acrobat/plans', viewport: 'all', rel: 'preload', href: `${A}/mas/io/fragment?id=f1&api_key=k&locale={locale}&country={country}`, as: 'fetch', crossorigin: 'anonymous', fetchpriority: 'high' },
  { pages: '*', viewport: 'all', rel: 'preload', href: '/x.json?country={country}', as: 'fetch', crossorigin: 'anonymous', fetchpriority: 'high' },
];
const LOCALES = [{ prefix: '', locale: 'en_US', defaultMarket: 'us', supportedRegions: 'us, ch, gb, au, pr' }];
const LOADER = headSnippet(TEMPLATE, { rows: ROWS, locales: LOCALES }).replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');

// Runs synchronously, as the inline script runs while the head is parsed.
function load(url, { width = 412, geo = 'US', meta = { 'mas-geo-detection': 'on' }, cookie = '', session = {}, ua = 'Mozilla/5.0 Chrome' } = {}) {
  const head = [];
  vm.runInNewContext(LOADER, {
    window: { location: new URL(url) },
    URL,
    URLSearchParams,
    navigator: { userAgent: ua },
    sessionStorage: { getItem: (k) => session[k] ?? null },
    performance: { getEntriesByType: () => [{ serverTiming: geo ? [{ name: 'geo', description: geo }] : [] }] },
    matchMedia: (q) => ({ matches: q.includes('min-width: 1200px') ? width >= 1200 : width <= 599 }),
    document: {
      cookie,
      querySelectorAll: () => [],
      createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
      head: {
        querySelector: (sel) => { const n = sel.match(/name="([^"]+)"/)[1]; return n in meta ? { content: meta[n] } : null; },
        append: (l) => head.push(l),
      },
    },
  });
  return { links: head.map((l) => `${l.rel} ${l.attrs.href}${l.as ? ` as=${l.as}` : ''}${l.crossOrigin ? ' crossorigin' : ''}${l.attrs.fetchpriority ? ` ${l.attrs.fetchpriority}` : ''}`) };
}

const frag = (q) => `preload ${A}/mas/io/fragment?id=f1&api_key=k&${q} as=fetch crossorigin high`;

test('loader: no request; www.adobe.com libs, mobile rows, US visitor gets the MAS URL without country', async () => {
  assert.doesNotMatch(TEMPLATE, /fetch\(/, 'the data is inline: no manifest request');
  const { links } = await load(`${A}/acrobat/plans.html`);
  assert.deepEqual(links, [
    `modulepreload ${A}/libs/utils/utils.js high`,
    'preload //www.adobe.com/libs/c2/styles/styles.css as=style',
    `modulepreload ${A}/mas/libs/commerce.js low`,
    frag('locale=en_US'),
    `preload ${A}/x.json?country=US as=fetch crossorigin high`,
  ]);
});

test('loader: MAS market rules (geo, params, cookies, supported regions, en_GB overrides, bots, unknown country)', async () => {
  const mas = async (opts, url = `${A}/acrobat/plans.html`) => (await load(url, opts)).links.find((l) => l.includes('/mas/io/')) ?? null;
  assert.equal(await mas({ geo: 'CH' }), frag('locale=en_US&country=CH'));
  assert.equal(await mas({ geo: 'GB' }), frag('locale=en_GB'), 'en_GB already resolves GB');
  assert.equal(await mas({ geo: 'AU' }), frag('locale=en_GB&country=AU'));
  assert.equal(await mas({ geo: 'ZZ' }), frag('locale=en_US'), 'unsupported market -> default market us');
  assert.equal(await mas({ geo: 'US' }, `${A}/acrobat/plans.html?country=ch`), frag('locale=en_US&country=CH'), '?country wins');
  assert.equal(await mas({ geo: 'US', cookie: 'a=1; country=ch' }), frag('locale=en_US&country=CH'), 'country cookie before geo');
  assert.equal(await mas({ geo: 'US', cookie: 'ims_country_code=CH', meta: { 'mas-geo-detection': 'on', 'mas-ims-login': 'on' } }), frag('locale=en_US&country=CH'));
  assert.equal(await mas({ geo: 'US', cookie: 'ims_country_code=CH' }), frag('locale=en_US'), 'IMS country only with mas-ims-login');
  assert.equal(await mas({ geo: 'US', cookie: 'ims_country_code=CH', meta: { 'mas-geo-detection': 'on', 'mas-ims-login': 'true' } }), frag('locale=en_US'), 'Milo accepts mas-ims-login "on" only');
  assert.equal(await mas({ geo: 'PR' }), frag('locale=en_US'), 'MAS prices and requests Puerto Rico as US');
  assert.equal(await mas({ geo: null, session: { akamai: 'ch' } }), frag('locale=en_US&country=CH'), 'session akamai without Server-Timing');
  assert.equal(await mas({ geo: null }), null, 'no synchronous country: Milo would look it up over the network');
  assert.equal(await mas({ geo: 'CH', meta: {} }), frag('locale=en_US'), 'no geo detection: the page locale country');
  assert.equal(await mas({ geo: 'CH', ua: 'Mozilla/5.0 GPTBot' }), frag('locale=en_US'), 'bots get the page country');
  assert.equal(await mas({ geo: 'CH' }, `${A}/acrobat/plans.html?instant=x`), null, 'MAS options change the request');
});

test('loader: viewport, pages, locale prefixes and milolibs/maslibs on preview hosts', async () => {
  const desktop = (await load(`${A}/acrobat/plans.html`, { width: 1350 })).links;
  assert.ok(desktop.includes(`preload ${A}/d.png as=image high`) && !desktop.some((l) => l.includes('commerce.js')));
  const tablet = (await load(`${A}/acrobat/plans.html`, { width: 900 })).links;
  assert.ok(!tablet.some((l) => l.includes('d.png') || l.includes('commerce.js')), 'tablets get "all" rows only');
  assert.deepEqual((await load(`${A}/express/x.html`)).links, [`preload ${A}/x.json?country=US as=fetch crossorigin high`]);
  assert.deepEqual((await load(`${A}/fr/acrobat/plans.html`)).links, [], 'a locale prefix without a locales row resolves no locale');
  const preview = (await load('https://main--da-dc--adobecom.aem.live/acrobat/plans?milolibs=mwpw-1&maslibs=mwpw-2')).links;
  assert.deepEqual(preview.slice(0, 3), [
    'modulepreload https://mwpw-1--milo--adobecom.aem.live/libs/utils/utils.js high',
    'preload //mwpw-1--milo--adobecom.aem.live/libs/c2/styles/styles.css as=style',
    'modulepreload https://mwpw-2--mas--adobecom.aem.live/web-components/dist/commerce.js low',
  ]);
  const local = (await load('https://main--da-dc--adobecom.aem.live/acrobat/plans?milolibs=local&maslibs=local')).links;
  assert.ok(!local.some((l) => l.includes('utils.js') || l.includes('commerce.js')), 'local libs are never preloaded');
  assert.ok((await load(`${A}/acrobat/plans.html?milolibs=mwpw-1`)).links[0].startsWith(`modulepreload ${A}/libs/`), 'production ignores milolibs');
});
