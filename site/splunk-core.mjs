// Pure, DOM-free parser and analyzer for client-side Splunk pageperf CSV exports.
// Supports:
//   1. Raw Splunk events CSV (_time, _raw JSON or log_message with ¦-delimited fields)
//   2. Extracted-fields Splunk events CSV (pp_lcp / lcp, pp_lcpEl / lcpEl, etc.)
//   3. Aggregated Splunk stats CSV (pp_lcpEl / lcpEl, lcpCount / count, p50_lcp, p75_lcp, p95_lcp)

export class SplunkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SplunkError';
  }
}

export const LCP_GOOD_MS = 2500;
export const LCP_POOR_MS = 4000;
export const CLS_GOOD = 0.1;
export const CLS_POOR = 0.25;

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
  'text/x-csv',
  'application/x-csv',
]);

const NON_CSV_EXTENSIONS = /\.(json|jsonl|ndjson|txt|tsv|har|html?|xml|png|jpe?g|gif|webp|svg|pdf|zip|gz|xlsx?|docx?)$/i;

export function isCsvFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  const name = file.name.trim();
  const type = String(file.type ?? '').toLowerCase().split(';')[0].trim();
  if (/\.csv$/i.test(name)) return true;
  if (CSV_MIME_TYPES.has(type) && !NON_CSV_EXTENSIONS.test(name)) return true;
  return false;
}

export function parseCsv(text) {
  if (typeof text !== 'string') throw new SplunkError('File contents could not be read as text.');
  if (text.includes('\0')) throw new SplunkError('File appears to be binary rather than a CSV export.');
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cur);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (inQuotes) throw new SplunkError('Malformed CSV: unclosed quoted field.');
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length < 2) {
    throw new SplunkError('CSV needs a header row and at least one data row.');
  }
  const headers = rows[0].map((h) => h.trim());
  if (headers.length < 2 && !headers[0]) {
    throw new SplunkError('CSV header row is empty.');
  }
  return { headers, rows: rows.slice(1) };
}

const ENTITY_MAP = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
};

export function decodeEntities(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/&(lt|gt|amp|quot|apos|#39|#x27);/gi, (_, key) => ENTITY_MAP[key.toLowerCase()] ?? _);
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

function parseNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

function splitKeyValues(text, separator) {
  const out = {};
  if (!text) return out;
  for (const part of text.split(separator)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function parseMessageFields(message) {
  const out = {};
  if (!message) return out;
  // Values like manifest1selected=countryip(it,pt,es) contain internal commas; split only before `<key>=`.
  const parts = message.split(/,(?=[A-Za-z0-9_.-]+=)/);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export function detectBot(userAgent) {
  if (!userAgent) return null;
  if (/NALA-Acom/i.test(userAgent)) return 'NALA-Acom';
  if (/Tokowaka/i.test(userAgent)) return 'Tokowaka';
  if (/Chrome-Lighthouse|Lighthouse/i.test(userAgent)) return 'Lighthouse';
  if (/HeadlessChrome/i.test(userAgent)) return 'HeadlessChrome';
  if (/PageSpeed/i.test(userAgent)) return 'PageSpeed';
  if (/\b(bot|crawler|spider|synthetic)\b/i.test(userAgent)) return 'Bot';
  return null;
}

function extractUrlFromReferer(referer) {
  if (!referer) return null;
  try {
    const u = new URL(decodeEntities(referer));
    return `${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function inferElementType(el, explicitType) {
  if (explicitType) return explicitType;
  if (!el || el === '(Element Was Replaced / Missing)') return 'replaced';
  const tag = /^<([a-z0-9-]+)[\s>]/i.exec(el);
  if (tag) return tag[1].toLowerCase();
  if (/\.(mp4|webm|mov)(\?|$)/i.test(el)) return 'video';
  if (/\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i.test(el) || /media_[a-f0-9]+/i.test(el)) return 'media';
  return 'other';
}

function normalizeLcpElement(rawEl, rawType) {
  const decoded = decodeEntities(rawEl ?? '').trim();
  if (!decoded || /^element was replaced/i.test(decoded) || /^element was replaced/i.test(rawType ?? '')) {
    return '(Element Was Replaced / Missing)';
  }
  return decoded;
}

function extractManifests(msg) {
  const slots = new Map();
  for (const [k, v] of Object.entries(msg)) {
    const m = /^manifest(\d+)(path|selected)$/i.exec(k);
    if (!m) continue;
    const slot = Number(m[1]);
    const entry = slots.get(slot) ?? { slot, path: null, selected: null };
    entry[m[2].toLowerCase()] = v;
    slots.set(slot, entry);
  }
  return [...slots.values()]
    .sort((a, b) => a.slot - b.slot)
    .filter((m) => m.path || m.selected)
    .map((m) => ({
      slot: m.slot,
      path: m.path ?? '(unknown manifest)',
      selected: m.selected ?? '(unknown)',
      label: m.path ? (m.selected ? `${m.path} (${m.selected})` : m.path) : m.selected,
    }));
}

function buildEvent(fields) {
  const lcp = parseNum(fields.lcp);
  const cls = parseNum(fields.cls);
  const inp = parseNum(fields.inp);
  const fcp = parseNum(fields.fcp);
  const ttfb = parseNum(fields.ttfb);
  if (lcp == null && cls == null && inp == null && fcp == null) return null;

  const lcpElTypeRaw = fields.lcpElType ? decodeEntities(fields.lcpElType).trim() : '';
  const lcpEl = normalizeLcpElement(fields.lcpEl, lcpElTypeRaw);
  const lcpElType = inferElementType(lcpEl, lcpElTypeRaw);
  const windowWidth = parseNum(fields.windowWidth);
  const windowHeight = parseNum(fields.windowHeight);
  const os = fields.os ? fields.os.trim().toLowerCase() : null;
  const tablet = parseBool(fields.tablet);
  const device = windowWidth != null
    ? (windowWidth < 768 ? 'mobile' : 'desktop')
    : (os === 'android' || os === 'ios' ? 'mobile' : os ? 'desktop' : 'unknown');
  const referer = fields.referer ? decodeEntities(fields.referer).trim() : null;
  const url = (fields.url ? fields.url.trim() : null) || extractUrlFromReferer(referer) || '(unknown URL)';
  const userAgent = fields.userAgent ? decodeEntities(fields.userAgent).trim() : null;
  const bot = detectBot(userAgent);

  return {
    timestamp: fields.timestamp ?? null,
    client: fields.client || 'pageperf',
    lcp: lcp != null && lcp >= 0 ? lcp : null,
    cls: cls != null && cls >= 0 ? cls : null,
    inp: inp != null && inp >= 0 ? inp : null,
    fcp: fcp != null && fcp >= 0 ? fcp : null,
    ttfb: ttfb != null && ttfb >= 0 ? ttfb : null,
    lcpEl,
    lcpElType,
    lcpSectionOne: parseBool(fields.lcpSectionOne),
    url,
    referer,
    country: fields.country ? fields.country.trim().toLowerCase() : 'unknown',
    os: os || 'unknown',
    tablet,
    windowWidth,
    windowHeight,
    device,
    downlink: parseNum(fields.downlink),
    chromeVer: fields.chromeVer ? fields.chromeVer.trim() : null,
    loggedIn: parseBool(fields.loggedIn),
    isFrag: parseBool(fields.isFrag),
    isMep: parseBool(fields.isMep),
    sample: parseNum(fields.sample),
    manifests: fields.manifests ?? [],
    userAgent,
    bot,
  };
}

function parseRawEventRow(rawText, fallbackTime) {
  let logMessage = rawText;
  let timestamp = parseTimestamp(fallbackTime);
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.log_message === 'string') logMessage = obj.log_message;
      if (timestamp == null && typeof obj.log_timestamp === 'string') {
        timestamp = parseTimestamp(obj.log_timestamp);
      }
    } catch {
      // Fall back to treating rawText directly as log_message.
    }
  }
  const sep = logMessage.includes('¦') ? '¦' : '|';
  const outer = splitKeyValues(logMessage, sep);
  const msgText = outer.message ?? (logMessage.includes('lcp=') ? logMessage : '');
  const msg = parseMessageFields(msgText);
  if (!Object.keys(msg).length) return null;

  return buildEvent({
    timestamp,
    client: outer.client,
    userAgent: outer['user-agent'] ?? outer.userAgent,
    referer: outer.referer,
    sample: outer.sample,
    lcp: msg.lcp,
    cls: msg.cls,
    inp: msg.inp,
    fcp: msg.fcp,
    ttfb: msg.ttfb,
    lcpEl: msg.lcpEl,
    lcpElType: msg.lcpElType,
    lcpSectionOne: msg.lcpSectionOne,
    url: msg.url,
    country: msg.country,
    os: msg.os,
    tablet: msg.tablet,
    windowWidth: msg.windowWidth,
    windowHeight: msg.windowHeight,
    downlink: msg.downlink,
    chromeVer: msg.chromeVer,
    loggedIn: msg.loggedIn,
    isFrag: msg.isFrag,
    isMep: msg.isMep,
    manifests: extractManifests(msg),
  });
}

function findHeaderIndex(lowerHeaders, candidates) {
  for (const c of candidates) {
    const idx = lowerHeaders.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseStatsCsv(headers, rows, fileName) {
  const lower = headers.map((h) => h.toLowerCase());
  const elIdx = findHeaderIndex(lower, ['pp_lcpel', 'lcpel', 'element']);
  const countIdx = findHeaderIndex(lower, ['lcpcount', 'count', 'events', 'n']);
  const pctIdx = findHeaderIndex(lower, ['percent', 'pct', 'share', 'v']);
  const p50Idx = findHeaderIndex(lower, ['p50_lcp', 'p50(pp_lcp)', 'p50(lcp)', 'p50', 'median']);
  const p75Idx = findHeaderIndex(lower, ['p75_lcp', 'p75(pp_lcp)', 'p75(lcp)', 'p75']);
  const p95Idx = findHeaderIndex(lower, ['p95_lcp', 'p95(pp_lcp)', 'p95(lcp)', 'p95']);
  const devIdx = findHeaderIndex(lower, ['device']);
  if (elIdx < 0 || (countIdx < 0 && p75Idx < 0 && pctIdx < 0)) return null;

  const parsedRows = [];
  for (const r of rows) {
    const el = normalizeLcpElement(r[elIdx], '');
    const count = countIdx >= 0 ? parseNum(r[countIdx]) : null;
    const percent = pctIdx >= 0 ? parseNum(r[pctIdx]) : null;
    const p50 = p50Idx >= 0 ? parseNum(r[p50Idx]) : null;
    const p75 = p75Idx >= 0 ? parseNum(r[p75Idx]) : null;
    const p95 = p95Idx >= 0 ? parseNum(r[p95Idx]) : null;
    const device = devIdx >= 0 && r[devIdx]?.trim() ? r[devIdx].trim().toLowerCase() : null;
    if (count == null && percent == null && p75 == null && p50 == null) continue;
    parsedRows.push({
      element: el,
      type: inferElementType(el, ''),
      device,
      count,
      percent,
      p50,
      p75,
      p95,
      cwvStatus: cwvLcpStatus(p75),
    });
  }
  if (!parsedRows.length) return null;

  const totalCount = parsedRows.reduce((sum, r) => sum + (r.count ?? 0), 0);
  if (totalCount > 0) {
    for (const r of parsedRows) {
      if (r.percent == null && r.count != null) {
        r.percent = (r.count / totalCount) * 100;
      }
    }
  }
  parsedRows.sort((a, b) => (b.count ?? b.percent ?? 0) - (a.count ?? a.percent ?? 0));

  return {
    kind: 'stats',
    fileName: fileName || 'splunk-stats.csv',
    rowCount: parsedRows.length,
    totalCount: totalCount || null,
    hasDevice: parsedRows.some((r) => r.device != null),
    rows: parsedRows,
  };
}

function parseExtractedEventsCsv(headers, rows, fileName) {
  const lower = headers.map((h) => h.toLowerCase());
  const lcpIdx = findHeaderIndex(lower, ['pp_lcp', 'lcp']);
  const clsIdx = findHeaderIndex(lower, ['pp_cls', 'cls']);
  if (lcpIdx < 0 && clsIdx < 0) return null;

  const col = (...names) => findHeaderIndex(lower, names);
  const idxMap = {
    time: col('_time', 'log_timestamp', 'timestamp'),
    lcp: lcpIdx,
    cls: clsIdx,
    inp: col('pp_inp', 'inp'),
    fcp: col('pp_fcp', 'fcp'),
    ttfb: col('pp_ttfb', 'ttfb'),
    lcpEl: col('pp_lcpel', 'lcpel'),
    lcpElType: col('pp_lcpeltype', 'lcpeltype'),
    lcpSectionOne: col('pp_lcpsectionone', 'lcpsectionone'),
    url: col('pp_url', 'url'),
    referer: col('referer'),
    country: col('pp_country', 'country'),
    os: col('pp_os', 'os'),
    tablet: col('pp_tablet', 'tablet'),
    windowWidth: col('pp_windowwidth', 'windowwidth'),
    windowHeight: col('pp_windowheight', 'windowheight'),
    downlink: col('pp_downlink', 'downlink'),
    chromeVer: col('pp_chromever', 'chromever'),
    loggedIn: col('pp_loggedin', 'loggedin'),
    isFrag: col('pp_isfrag', 'isfrag'),
    isMep: col('pp_ismep', 'ismep'),
    userAgent: col('user-agent', 'user_agent', 'useragent'),
    sample: col('sample'),
  };
  const get = (r, idx) => (idx >= 0 ? r[idx] : undefined);

  const events = [];
  let skippedRows = 0;
  for (const r of rows) {
    const manifests = [];
    for (let i = 0; i < lower.length; i += 1) {
      const m = /^(?:pp_)?manifest(\d+)path$/.exec(lower[i]);
      if (!m || !r[i]?.trim()) continue;
      const selIdx = lower.indexOf(`manifest${m[1]}selected`) >= 0
        ? lower.indexOf(`manifest${m[1]}selected`)
        : lower.indexOf(`pp_manifest${m[1]}selected`);
      const path = r[i].trim();
      const selected = selIdx >= 0 && r[selIdx]?.trim() ? r[selIdx].trim() : null;
      manifests.push({ slot: Number(m[1]), path, selected, label: selected ? `${path} (${selected})` : path });
    }
    const ev = buildEvent({
      timestamp: parseTimestamp(get(r, idxMap.time)),
      lcp: get(r, idxMap.lcp),
      cls: get(r, idxMap.cls),
      inp: get(r, idxMap.inp),
      fcp: get(r, idxMap.fcp),
      ttfb: get(r, idxMap.ttfb),
      lcpEl: get(r, idxMap.lcpEl),
      lcpElType: get(r, idxMap.lcpElType),
      lcpSectionOne: get(r, idxMap.lcpSectionOne),
      url: get(r, idxMap.url),
      referer: get(r, idxMap.referer),
      country: get(r, idxMap.country),
      os: get(r, idxMap.os),
      tablet: get(r, idxMap.tablet),
      windowWidth: get(r, idxMap.windowWidth),
      windowHeight: get(r, idxMap.windowHeight),
      downlink: get(r, idxMap.downlink),
      chromeVer: get(r, idxMap.chromeVer),
      loggedIn: get(r, idxMap.loggedIn),
      isFrag: get(r, idxMap.isFrag),
      isMep: get(r, idxMap.isMep),
      userAgent: get(r, idxMap.userAgent),
      sample: get(r, idxMap.sample),
      manifests,
    });
    if (ev) events.push(ev);
    else skippedRows += 1;
  }
  if (!events.length) return null;
  return { kind: 'events', source: 'fields', fileName: fileName || 'splunk-events.csv', totalRows: rows.length, skippedRows, events };
}

export function parseSplunkCsv(text, fileName = 'splunk-export.csv') {
  const { headers, rows } = parseCsv(text);
  const lower = headers.map((h) => h.toLowerCase());
  const rawIdx = findHeaderIndex(lower, ['_raw', 'log_message', 'raw']);
  const timeIdx = findHeaderIndex(lower, ['_time', 'log_timestamp', 'timestamp']);

  if (rawIdx >= 0) {
    const events = [];
    let skippedRows = 0;
    for (const r of rows) {
      const rawVal = r[rawIdx];
      if (!rawVal) { skippedRows += 1; continue; }
      const ev = parseRawEventRow(rawVal, timeIdx >= 0 ? r[timeIdx] : undefined);
      if (ev) events.push(ev);
      else skippedRows += 1;
    }
    if (!events.length) {
      throw new SplunkError('Found "_raw" column, but no pageperf Web Vitals events (lcp/cls) were detected.');
    }
    return { kind: 'events', source: 'raw', fileName, totalRows: rows.length, skippedRows, events };
  }

  const extracted = parseExtractedEventsCsv(headers, rows, fileName);
  if (extracted) return extracted;

  const stats = parseStatsCsv(headers, rows, fileName);
  if (stats) return stats;

  throw new SplunkError(
    `Unrecognized Splunk CSV columns (${headers.slice(0, 8).join(', ')}${headers.length > 8 ? ', …' : ''}). `
    + 'Expected raw events (_time, _raw), extracted pageperf fields (pp_lcp, pp_lcpEl), or aggregated stats (pp_lcpEl, lcpCount, p75_lcp).'
  );
}

// ---------------------------------------------------------------- metrics & percentiles

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function cwvLcpStatus(ms) {
  if (ms == null) return 'none';
  if (ms <= LCP_GOOD_MS) return 'good';
  if (ms <= LCP_POOR_MS) return 'ni';
  return 'poor';
}

export function cwvClsStatus(val) {
  if (val == null) return 'none';
  if (val <= CLS_GOOD) return 'good';
  if (val <= CLS_POOR) return 'ni';
  return 'poor';
}

export const CWV_LABELS = Object.freeze({
  good: 'Good',
  ni: 'Needs Improvement',
  poor: 'Poor',
  none: '—',
});

function summarizeValues(values, statusFn, goodMax, poorMin) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  let good = 0;
  let ni = 0;
  let poor = 0;
  let sum = 0;
  for (const v of sorted) {
    sum += v;
    if (v <= goodMax) good += 1;
    else if (v <= poorMin) ni += 1;
    else poor += 1;
  }
  const p50 = percentile(sorted, 50);
  const p75 = percentile(sorted, 75);
  const p95 = percentile(sorted, 95);
  return {
    n,
    min: sorted[0],
    p50,
    p75,
    p90: percentile(sorted, 90),
    p95,
    max: sorted[n - 1],
    mean: sum / n,
    status: statusFn(p75),
    good,
    ni,
    poor,
    goodPct: (good / n) * 100,
    niPct: (ni / n) * 100,
    poorPct: (poor / n) * 100,
  };
}

const LCP_BUCKETS = [
  { label: '0–0.5s', min: 0, max: 500, zone: 'good' },
  { label: '0.5–1s', min: 500, max: 1000, zone: 'good' },
  { label: '1–1.5s', min: 1000, max: 1500, zone: 'good' },
  { label: '1.5–2s', min: 1500, max: 2000, zone: 'good' },
  { label: '2–2.5s', min: 2000, max: 2500, zone: 'good' },
  { label: '2.5–3s', min: 2500, max: 3000, zone: 'ni' },
  { label: '3–4s', min: 3000, max: 4000, zone: 'ni' },
  { label: '4–6s', min: 4000, max: 6000, zone: 'poor' },
  { label: '6–10s', min: 6000, max: 10000, zone: 'poor' },
  { label: '10s+', min: 10000, max: Infinity, zone: 'poor' },
];

function buildHistogram(lcpValues) {
  const counts = LCP_BUCKETS.map((b) => ({ ...b, count: 0, pct: 0 }));
  const total = lcpValues.length;
  for (const v of lcpValues) {
    const bucket = counts.find((b) => v >= b.min && v < b.max) ?? counts[counts.length - 1];
    bucket.count += 1;
  }
  if (total > 0) {
    for (const b of counts) b.pct = (b.count / total) * 100;
  }
  return counts;
}

function groupBreakdown(events, total, keyFn, extraFn) {
  const map = new Map();
  for (const ev of events) {
    const keys = keyFn(ev);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      let group = map.get(key);
      if (!group) {
        group = { key, events: [], extra: extraFn ? extraFn(ev, key) : null };
        map.set(key, group);
      }
      group.events.push(ev);
    }
  }
  const rows = [];
  for (const { key, events: items, extra } of map.values()) {
    const lcps = items.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b);
    const clss = items.map((e) => e.cls).filter((v) => v != null).sort((a, b) => a - b);
    const p50 = percentile(lcps, 50);
    const p75 = percentile(lcps, 75);
    const p95 = percentile(lcps, 95);
    const goodCount = lcps.filter((v) => v <= LCP_GOOD_MS).length;
    rows.push({
      key,
      extra,
      count: items.length,
      percent: total ? (items.length / total) * 100 : 0,
      lcpN: lcps.length,
      p50,
      p75,
      p95,
      goodPct: lcps.length ? (goodCount / lcps.length) * 100 : null,
      clsP75: percentile(clss, 75),
      status: cwvLcpStatus(p75),
    });
  }
  rows.sort((a, b) => b.count - a.count || (b.p75 ?? 0) - (a.p75 ?? 0) || a.key.localeCompare(b.key));
  return rows;
}

function downlinkBand(downlink) {
  if (downlink == null) return 'Unknown';
  if (downlink < 1.5) return 'Slow (< 1.5 Mbps)';
  if (downlink < 5) return 'Moderate (1.5–5 Mbps)';
  return 'Fast (≥ 5 Mbps)';
}

function isTextElement(type) {
  return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'a', 'li', 'blockquote'].includes(type);
}

function buildInsights(events, lcpSummary, clsSummary, byElement, byDevice, byNetwork, allEventsCount, botCount, excludedBots) {
  const insights = [];
  if (!lcpSummary) return insights;

  if (lcpSummary.status === 'good') {
    insights.push({
      tone: 'ok',
      title: `P75 LCP is Good at ${formatMsOrSec(lcpSummary.p75)}`,
      detail: `${lcpSummary.goodPct.toFixed(1)}% of page loads (${lcpSummary.good}/${lcpSummary.n}) meet Google's ≤ 2.5 s Core Web Vitals threshold.`,
    });
  } else if (lcpSummary.status === 'ni') {
    insights.push({
      tone: 'warn',
      title: `P75 LCP Needs Improvement at ${formatMsOrSec(lcpSummary.p75)}`,
      detail: `${lcpSummary.goodPct.toFixed(1)}% of loads are ≤ 2.5 s; ${lcpSummary.poorPct.toFixed(1)}% exceed 4.0 s.`,
    });
  } else {
    insights.push({
      tone: 'bad',
      title: `P75 LCP is Poor at ${formatMsOrSec(lcpSummary.p75)}`,
      detail: `Only ${lcpSummary.goodPct.toFixed(1)}% of loads meet the 2.5 s threshold (${lcpSummary.poor} of ${lcpSummary.n} are > 4.0 s).`,
    });
  }

  // Heavy-tail detection
  const tailGap = (lcpSummary.p95 ?? 0) - (lcpSummary.p75 ?? 0);
  const tailRatio = lcpSummary.p75 ? lcpSummary.p95 / lcpSummary.p75 : 1;
  if (lcpSummary.n >= 5 && (tailGap >= 1500 || tailRatio >= 2)) {
    const slowest = [...events].filter((e) => e.lcp != null).sort((a, b) => b.lcp - a.lcp);
    const top10 = slowest.slice(0, Math.max(1, Math.ceil(slowest.length * 0.1)));
    const clues = [];
    const slowNet = top10.filter((e) => e.downlink != null && e.downlink < 1.5).length;
    if (slowNet > 0) clues.push(`${slowNet}/${top10.length} slowest loads had downlink < 1.5 Mbps`);
    const mobTail = top10.filter((e) => e.device === 'mobile').length;
    if (mobTail > 0 && mobTail / top10.length >= 0.4) clues.push(`${mobTail}/${top10.length} were mobile`);
    const belowFold = top10.filter((e) => e.lcpSectionOne === false).length;
    if (belowFold > 0) clues.push(`${belowFold}/${top10.length} painted outside Section 1`);
    insights.push({
      tone: 'warn',
      title: `Heavy tail: P95 jumps to ${formatMsOrSec(lcpSummary.p95)} (max ${formatMsOrSec(lcpSummary.max)})`,
      detail: `The slowest 5% of loads wait ${formatMsOrSec(lcpSummary.p95)} or longer — ${formatMsOrSec(tailGap)} slower than P75.${clues.length ? ` Tail drivers: ${clues.join('; ')}.` : ''}`,
    });
  }

  // Text vs media LCP
  const textEvents = events.filter((e) => isTextElement(e.lcpElType));
  const textPct = events.length ? (textEvents.length / events.length) * 100 : 0;
  if (textPct >= 50) {
    const topEl = byElement[0];
    insights.push({
      tone: 'neutral',
      title: `Text elements drive ${textPct.toFixed(1)}% of LCP events`,
      detail: `${topEl ? `Top element (${topEl.key}) accounts for ${topEl.percent.toFixed(1)}%. ` : ''}In Milo, text wins LCP either because the hero text is the largest element above the fold, or because hero media painted after logWebVitals.js sent its single beacon (1,000 ms after first LCP).`,
    });
  }

  // Below-the-fold LCP
  const secFalse = events.filter((e) => e.lcpSectionOne === false && e.lcp != null);
  const secTrue = events.filter((e) => e.lcpSectionOne === true && e.lcp != null);
  if (secFalse.length > 0 && secTrue.length > 0) {
    const p75False = percentile(secFalse.map((e) => e.lcp).sort((a, b) => a - b), 75);
    const p75True = percentile(secTrue.map((e) => e.lcp).sort((a, b) => a - b), 75);
    if (p75False > p75True + 300) {
      insights.push({
        tone: 'neutral',
        title: `${secFalse.length} loads (${((secFalse.length / events.length) * 100).toFixed(1)}%) reported LCP below Section 1`,
        detail: `Off-fold LCP hits P75 ${formatMsOrSec(p75False)} vs ${formatMsOrSec(p75True)} in Section 1 (often from deep-links, early scrolling, or sticky/late banners).`,
      });
    }
  }

  // Replaced elements
  const replaced = events.filter((e) => e.lcpEl === '(Element Was Replaced / Missing)').length;
  if (replaced > 0) {
    insights.push({
      tone: 'neutral',
      title: `${replaced} event${replaced === 1 ? '' : 's'} had a replaced/missing LCP element`,
      detail: 'A DOM node was swapped or removed (e.g., MEP personalization or fragment hydration) before PerformanceObserver read entry.element.',
    });
  }

  // Synthetic / bot traffic
  if (botCount > 0 && !excludedBots) {
    const humanOnly = events.filter((e) => !e.bot);
    const humanLcp = percentile(humanOnly.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b), 75);
    const humanClsMax = Math.max(0, ...humanOnly.map((e) => e.cls ?? 0));
    const clsNote = clsSummary && clsSummary.max > CLS_POOR && humanClsMax <= CLS_GOOD
      ? ` The ${clsSummary.max.toFixed(3)} CLS spike comes entirely from synthetic traffic.`
      : '';
    insights.push({
      tone: 'warn',
      action: 'human-only',
      title: `${botCount} synthetic/automation event${botCount === 1 ? '' : 's'} detected in ${allEventsCount} rows`,
      detail: `Includes test/edge runners (e.g. NALA-Acom or Tokowaka).${humanLcp != null ? ` Human-only P75 LCP is ${formatMsOrSec(humanLcp)}.` : ''}${clsNote} Toggle "Human-only traffic" to isolate real-user visits.`,
    });
  }

  // Mobile vs desktop gap
  const mob = byDevice.find((d) => d.key === 'mobile');
  const desk = byDevice.find((d) => d.key === 'desktop');
  if (mob && desk && mob.count >= 3 && desk.count >= 3 && Math.abs((mob.p75 ?? 0) - (desk.p75 ?? 0)) >= 400) {
    const slower = mob.p75 > desk.p75 ? 'Mobile' : 'Desktop';
    insights.push({
      tone: mob.p75 > LCP_GOOD_MS ? 'warn' : 'neutral',
      title: `${slower} is slower at P75 (Mobile ${formatMsOrSec(mob.p75)} vs Desktop ${formatMsOrSec(desk.p75)})`,
      detail: `Split is ${desk.count} desktop / ${mob.count} mobile events.`,
    });
  }

  // CLS check
  if (clsSummary && (clsSummary.p75 > CLS_GOOD || clsSummary.poor > 0)) {
    insights.push({
      tone: clsSummary.p75 > CLS_POOR ? 'bad' : 'warn',
      title: `CLS shows layout shift spikes (P75 ${clsSummary.p75.toFixed(3)}, max ${clsSummary.max.toFixed(3)})`,
      detail: `${clsSummary.poor} event${clsSummary.poor === 1 ? '' : 's'} exceeded the 0.25 Poor CLS threshold.`,
    });
  }

  // Slow network impact
  const slowNetBand = byNetwork.find((n) => n.key.startsWith('Slow'));
  if (slowNetBand && slowNetBand.p75 != null && slowNetBand.p75 > LCP_POOR_MS) {
    insights.push({
      tone: 'neutral',
      title: `Slow connections (< 1.5 Mbps) drive high LCP (${formatMsOrSec(slowNetBand.p75)} at P75)`,
      detail: `${slowNetBand.count} event${slowNetBand.count === 1 ? '' : 's'} recorded downlink < 1.5 Mbps.`,
    });
  }

  return insights;
}

export const EMPTY_SPLUNK_FILTERS = Object.freeze({
  excludeBots: false,
  device: '',
  country: '',
  manifest: '',
  url: '',
});

export function analyzeSplunk(parsed, filters = EMPTY_SPLUNK_FILTERS) {
  if (!parsed) return null;
  if (parsed.kind === 'stats') {
    const total = parsed.totalCount ?? parsed.rows.reduce((s, r) => s + (r.percent ?? 0), 0);
    const weightedP75s = parsed.rows.filter((r) => r.p75 != null && r.count != null);
    const topRow = parsed.rows[0];
    const maxP95 = Math.max(0, ...parsed.rows.map((r) => r.p95 ?? 0));
    const insights = [];
    if (topRow) {
      insights.push({
        tone: topRow.cwvStatus === 'good' ? 'ok' : topRow.cwvStatus === 'ni' ? 'warn' : 'bad',
        title: `Top LCP element (${topRow.percent != null ? `${topRow.percent.toFixed(1)}%` : `${topRow.count} events`}) has P75 ${formatMsOrSec(topRow.p75)}`,
        detail: `${topRow.element}${topRow.p95 != null ? ` · P95 reaches ${formatMsOrSec(topRow.p95)}` : ''}.`,
      });
    }
    if (maxP95 > LCP_POOR_MS) {
      insights.push({
        tone: 'warn',
        title: `Tail latency reaches ${formatMsOrSec(maxP95)} at P95`,
        detail: 'Export raw events (| table _time, _raw) from Splunk for per-device, country, downlink, and MEP manifest breakdowns.',
      });
    }
    return {
      kind: 'stats',
      fileName: parsed.fileName,
      rowCount: parsed.rowCount,
      totalCount: parsed.totalCount,
      hasDevice: parsed.hasDevice,
      rows: parsed.rows,
      insights,
      approxP75: weightedP75s.length && total ? weightedP75s.reduce((s, r) => s + r.p75 * r.count, 0) / weightedP75s.reduce((s, r) => s + r.count, 0) : topRow?.p75 ?? null,
    };
  }

  const all = parsed.events;
  const botCount = all.filter((e) => e.bot).length;
  const f = { ...EMPTY_SPLUNK_FILTERS, ...filters };

  // Collect available filter options from the full dataset
  const urls = [...new Set(all.map((e) => e.url))].sort();
  const countries = [...new Set(all.map((e) => e.country))].sort();
  const manifestSet = new Set();
  for (const e of all) {
    if (!e.manifests.length) manifestSet.add('none');
    else for (const m of e.manifests) manifestSet.add(m.label);
  }
  const manifests = [...manifestSet].sort((a, b) => (a === 'none' ? -1 : b === 'none' ? 1 : a.localeCompare(b)));

  const events = all.filter((e) => {
    if (f.excludeBots && e.bot) return false;
    if (f.device && e.device !== f.device) return false;
    if (f.country && e.country !== f.country) return false;
    if (f.url && e.url !== f.url) return false;
    if (f.manifest) {
      if (f.manifest === 'none') {
        if (e.manifests.length > 0) return false;
      } else if (!e.manifests.some((m) => m.label === f.manifest)) {
        return false;
      }
    }
    return true;
  });

  const lcpSummary = summarizeValues(events.map((e) => e.lcp), cwvLcpStatus, LCP_GOOD_MS, LCP_POOR_MS);
  const clsSummary = summarizeValues(events.map((e) => e.cls), cwvClsStatus, CLS_GOOD, CLS_POOR);
  const inpSummary = summarizeValues(events.map((e) => e.inp), (v) => (v == null ? 'none' : v <= 200 ? 'good' : v <= 500 ? 'ni' : 'poor'), 200, 500);
  const histogram = buildHistogram(events.map((e) => e.lcp).filter((v) => v != null));

  const timestamps = events.map((e) => e.timestamp).filter((t) => t != null);
  const timeRange = timestamps.length
    ? { min: Math.min(...timestamps), max: Math.max(...timestamps) }
    : null;

  const timeline = events
    .filter((e) => e.timestamp != null && e.lcp != null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e, index) => ({
      ...e,
      index,
      status: cwvLcpStatus(e.lcp),
      clues: eventDriverClues(e),
    }));

  const byElement = groupBreakdown(
    events,
    events.length,
    (e) => e.lcpEl,
    (e) => ({ type: e.lcpElType, sectionOne: e.lcpSectionOne }),
  );
  const byDevice = groupBreakdown(events, events.length, (e) => e.device);
  const byCountry = groupBreakdown(events, events.length, (e) => e.country);
  const byNetwork = groupBreakdown(events, events.length, (e) => downlinkBand(e.downlink));
  const byOs = groupBreakdown(events, events.length, (e) => e.os);
  const byManifest = groupBreakdown(
    events,
    events.length,
    (e) => (e.manifests.length ? e.manifests.map((m) => m.label) : ['No MEP manifest']),
  );
  const byLoggedIn = groupBreakdown(events, events.length, (e) => (e.loggedIn === true ? 'Signed in' : e.loggedIn === false ? 'Signed out' : 'Unknown'));
  const byUrl = groupBreakdown(events, events.length, (e) => e.url);

  const slowest = [...events]
    .filter((e) => e.lcp != null || (e.cls != null && e.cls > CLS_GOOD))
    .sort((a, b) => (b.lcp ?? 0) - (a.lcp ?? 0))
    .slice(0, 20);

  const insights = buildInsights(events, lcpSummary, clsSummary, byElement, byDevice, byNetwork, all.length, botCount, f.excludeBots);

  const sampleRates = [...new Set(all.map((e) => e.sample).filter((s) => s != null))];
  const realCount = events.filter((e) => !e.bot).length;
  const samplingText = sampleRates.length
    ? `${sampleRates.join('/')}% sampling`
    : 'Unknown sampling rate';

  let trustTone = 'ok';
  let trustLabel = `Good sample (${realCount} real-user events)`;
  if (realCount < 30) {
    trustTone = 'warn';
    trustLabel = `Small sample (${realCount} real-user event${realCount === 1 ? '' : 's'} — directional only)`;
  } else if (realCount < 100) {
    trustTone = 'warn';
    trustLabel = `Moderate sample (${realCount} real-user events — P75 is directional, P95 is noisy)`;
  }

  const coverageParts = [
    `Source: Milo pageperf (Chrome-only, C0002 performance-cookie consented, ${samplingText}). Safari, Firefox, and non-consented visits are not included.`,
  ];
  if (botCount && !f.excludeBots) {
    coverageParts.push(`${botCount} of ${events.length} rows are synthetic/automation traffic.`);
  }
  if (parsed.totalRows === 10000) {
    trustTone = 'warn';
    coverageParts.push('Exactly 10,000 rows in CSV — Splunk may have truncated the export at its default row limit.');
  }
  const coverage = {
    tone: trustTone,
    title: `${trustLabel} · ${samplingText} · Chrome + consented only`,
    detail: coverageParts.join(' '),
    samplingText,
    realCount,
  };

  return {
    kind: 'events',
    source: parsed.source,
    fileName: parsed.fileName,
    totalRows: parsed.totalRows,
    skippedRows: parsed.skippedRows,
    totalEvents: all.length,
    matchedEvents: events.length,
    botCount,
    sampleRates,
    coverage,
    timeRange,
    options: { urls, countries, manifests },
    lcp: lcpSummary,
    cls: clsSummary,
    inp: inpSummary,
    histogram,
    timeline,
    breakdowns: {
      element: byElement,
      device: byDevice,
      country: byCountry,
      network: byNetwork,
      os: byOs,
      manifest: byManifest,
      loggedIn: byLoggedIn,
      url: byUrl,
    },
    slowest,
    insights,
  };
}

export function eventDriverClues(ev) {
  if (!ev) return [];
  const clues = [];
  if (ev.downlink != null && ev.downlink < 1.5) clues.push(`Slow connection (downlink ${ev.downlink} Mbps)`);
  if (ev.lcpSectionOne === false) clues.push('Painted below Section 1 (deep link, early scroll, or late banner)');
  if (ev.lcpEl === '(Element Was Replaced / Missing)') clues.push('LCP element replaced/missing during hydration');
  if (/mas-|merch-card|slot=/i.test(ev.lcpEl ?? '')) clues.push('MAS / merch-card element (waits on fragment or price resolution)');
  if (ev.device === 'mobile') {
    const vp = ev.windowWidth && ev.windowHeight ? ` (${ev.windowWidth}×${ev.windowHeight})` : '';
    clues.push(`Mobile viewport${vp}`);
  }
  if (ev.bot) clues.push(`Synthetic / automation UA (${ev.bot})`);
  if (ev.manifests?.length) clues.push(`MEP active: ${ev.manifests.map((m) => m.label).join(', ')}`);
  if (ev.cls != null && ev.cls > CLS_POOR) clues.push(`High CLS (${ev.cls.toFixed(3)})`);
  return clues;
}

export function formatMsOrSec(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}\u00a0s`;
  return `${Math.round(ms)}\u00a0ms`;
}

function formatDurationFriendly(ms) {
  if (ms == null || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} sec`;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 48) {
    if (mins === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${hours} hr ${mins} min`;
  }
  const days = (ms / 86400000).toFixed(1).replace(/\.0$/, '');
  return `${days} days`;
}

export function formatFriendlyTime(ms, { withTz = false, timeZone } = {}) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(withTz ? { timeZoneName: 'short' } : {}),
  }).format(new Date(ms));
}

export function formatFriendlyRange(minMs, maxMs, timeZone) {
  if (minMs == null || maxMs == null) return '';
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const startDay = dayKeyFmt.format(new Date(minMs));
  const endDay = dayKeyFmt.format(new Date(maxMs));
  const dur = formatDurationFriendly(maxMs - minMs);
  const durSuffix = dur ? ` (${dur})` : '';

  if (Math.abs(maxMs - minMs) < 60000) {
    return `${dateFmt.format(new Date(minMs))} · ${formatFriendlyTime(minMs, { withTz: true, timeZone })}`;
  }
  if (startDay === endDay) {
    return `${dateFmt.format(new Date(minMs))} · ${formatFriendlyTime(minMs, { timeZone })} – ${formatFriendlyTime(maxMs, { withTz: true, timeZone })}${durSuffix}`;
  }
  return `${dateFmt.format(new Date(minMs))}, ${formatFriendlyTime(minMs, { timeZone })} – ${dateFmt.format(new Date(maxMs))}, ${formatFriendlyTime(maxMs, { withTz: true, timeZone })}${durSuffix}`;
}

