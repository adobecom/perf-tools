// Verifies the measuring host's internet egress is in the US before any page is loaded. Neutral IP-geolocation
// services only (no request to the measured site, so nothing is warmed). Fails closed: at least one service must
// answer US and none may answer anything else; no answer at all is a failure, never an assumed US.
export const EGRESS_SERVICES = [
  { name: 'ipinfo.io', url: 'https://ipinfo.io/json', country: (j) => j.country },
  { name: 'ifconfig.co', url: 'https://ifconfig.co/json', country: (j) => j.country_iso },
  { name: 'ipapi.co', url: 'https://ipapi.co/json/', country: (j) => j.country_code ?? j.country },
];

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'perf-tools-egress-check' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function verifyUsEgress({ fetchJson = defaultFetchJson, services = EGRESS_SERVICES } = {}) {
  const checks = await Promise.all(services.map(async (s) => {
    try {
      const j = await fetchJson(s.url);
      const country = String(s.country(j) ?? '').toUpperCase() || null;
      return { service: s.name, country, ip: j.ip ?? null, region: j.region ?? j.region_name ?? null, city: j.city ?? null };
    } catch (e) {
      return { service: s.name, country: null, error: e.message };
    }
  }));
  const answered = checks.filter((c) => c.country);
  const nonUs = answered.filter((c) => c.country !== 'US');
  const ok = answered.length > 0 && nonUs.length === 0;
  const result = { ok, country: ok ? 'US' : null, checks };
  if (!ok) {
    const why = !answered.length ? 'egress country unknown (no geolocation service answered)'
      : `egress is not US: ${nonUs.map((c) => `${c.service}=${c.country}`).join(', ')}`;
    throw Object.assign(new Error(`US egress verification failed: ${why}. Refusing to measure.`), { fatal: true, egress: result });
  }
  return result;
}

// Geo hints the measured site itself reports on the main document response: CDN country headers and Server-Timing
// entries such as `geo;desc=US` (what www.adobe.com sends).
const GEO_HEADER = /geo|country|edgescape|akamai-x-cache-region|x-client-region|^server-timing$/i;
export function documentGeo(headers = {}) {
  const found = Object.fromEntries(Object.entries(headers).filter(([k]) => GEO_HEADER.test(k)).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const countries = [];
  for (const [k, v] of Object.entries(found)) {
    if (k === 'server-timing') {
      for (const entry of v.split(',')) {
        const [name, ...params] = entry.split(';').map((x) => x.trim());
        if (name.toLowerCase() !== 'geo') continue;
        for (const p of params) {
          const m = /^desc\s*=\s*"?([A-Za-z]{2})"?$/i.exec(p);
          if (m) countries.push(m[1].toUpperCase());
        }
      }
      continue;
    }
    for (const m of v.matchAll(/(?:^|[,;\s])(?:country_code|country)\s*[=:]\s*"?([A-Za-z]{2})\b/gi)) countries.push(m[1].toUpperCase());
    if (/country/i.test(k) && /^[A-Za-z]{2}$/.test(v.trim())) countries.push(v.trim().toUpperCase());
  }
  const nonUs = [...new Set(countries)].filter((c) => c !== 'US');
  return { headers: found, countries: [...new Set(countries)], status: !countries.length ? 'unavailable' : nonUs.length ? 'non-US' : 'US' };
}
