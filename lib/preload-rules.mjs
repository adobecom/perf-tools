// Built-in exclusion rules of the preload generator. They always apply (page-load requests that matched a rule are
// listed as "excluded by rule" in the CLI output); `--exclude <path-prefix|host>` adds more.
//   - path prefix: starts with "/", matches that path and everything below it, on any origin
//   - host: matches that host and its subdomains
export const BUILT_IN_EXCLUDES = [
  { kind: 'path', value: '/experienceedge', reason: 'Adobe Experience Platform Edge (analytics/personalization)' },
  { kind: 'path', value: '/marketingtech', reason: 'marketing tech scripts are never preloaded' },
  { kind: 'host', value: 'bfp.adobe.com', reason: 'bfp.adobe.com is never preloaded' },
  // Milo MEP preview tooling (overlay, sidekick auth, MAS/CaaS inspectors): loaded on preview hosts such as
  // aem.page/aem.live, never for visitors. What it imports is excluded with it (perf-preload follows initiators).
  { kind: 'path', value: '/libs/features/mep/mep-next', reason: 'MEP preview tooling (preview hosts only)' },
];

export function parseExclude(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('/')) {
    const prefix = value.replace(/\/+$/, '').replace(/\/\*$/, '');
    if (!prefix || /[\s?#]/.test(prefix)) throw new Error(`--exclude ${raw}: expected a path prefix like /marketingtech or a host like bfp.adobe.com`);
    return { kind: 'path', value: prefix, reason: 'excluded by --exclude' };
  }
  if (!/^(?!-)[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) || /\.\./.test(value)) {
    throw new Error(`--exclude ${raw}: expected a path prefix like /marketingtech or a host like bfp.adobe.com`);
  }
  return { kind: 'host', value: value.toLowerCase(), reason: 'excluded by --exclude' };
}

// First rule that matches the URL, or null.
export function matchExclude(rules, url) {
  const u = url instanceof URL ? url : new URL(url);
  return rules.find((r) => (r.kind === 'path'
    ? u.pathname === r.value || u.pathname.startsWith(`${r.value}/`)
    : u.hostname === r.value || u.hostname.endsWith(`.${r.value}`))) ?? null;
}

export const describeRule = (r) => (r.kind === 'path' ? `${r.value}/*` : r.kind === 'initiator' ? `requested by excluded ${r.value}` : r.value);

// Third-party hosts that are always kept without --all-origins (the host and its subdomains): fonts and stylesheets
// that gate first paint. Exclusion rules still win.
export const BUILT_IN_ALLOWED_HOSTS = ['typekit.net'];

export const isAllowedHost = (hostname, hosts = BUILT_IN_ALLOWED_HOSTS) => hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
