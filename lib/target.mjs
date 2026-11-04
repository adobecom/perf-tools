// Benchmark target policy, shared by every perf-tools entry point: the page being measured (before/after, every
// main-frame redirect hop and the final URL) must be https on a subdomain of adobe.com (*.adobe.com), on the default
// port, without userinfo, and must resolve to public addresses only. Third-party subresources (fonts, analytics, CDNs)
// are not restricted by the domain rule; connections the measuring proxy opens are only refused for non-public
// (private/loopback/link-local/reserved) destinations.
import dns from 'node:dns';
import net from 'node:net';

export const TARGET_DOMAIN = 'adobe.com';
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

const targetError = (m) => Object.assign(new Error(m), { fatal: true, code: 'ETARGET' });

// True for a DNS name of the form <label>.(...).adobe.com. The bare apex, IP literals, trailing dots, empty or
// malformed labels and lookalikes such as adobe.com.evil.example or evil-adobe.com are rejected.
export function isAdobeHost(hostname) {
  const h = String(hostname ?? '');
  if (!h || h !== h.toLowerCase() || net.isIP(h.replace(/^\[|\]$/g, ''))) return false;
  const labels = h.split('.');
  if (labels.length < 3 || labels.slice(-2).join('.') !== TARGET_DOMAIN) return false;
  return labels.every((l) => LABEL.test(l));
}

// Validates a page URL and returns the parsed URL.
export function assertTargetUrl(input, { label = 'page URL' } = {}) {
  let u;
  try { u = new URL(String(input)); } catch { throw targetError(`${label} is not a valid URL: ${input}`); }
  if (u.protocol !== 'https:') throw targetError(`${label} must use https: ${input}`);
  if (u.username || u.password) throw targetError(`${label} must not contain credentials/userinfo: ${input}`);
  if (u.port) throw targetError(`${label} must use the default https port: ${input}`);
  if (!isAdobeHost(u.hostname)) throw targetError(`${label} host ${u.hostname} is not a *.${TARGET_DOMAIN} benchmark target: ${input}`);
  return u;
}

// Separate lists: a BlockList IPv6 rule such as ::/8 would also match every IPv4 address (via IPv4-mapped form).
const v4Block = new net.BlockList();
const v6Block = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) v4Block.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) v6Block.addSubnet(a, p, 'ipv6');

// True only for a globally routable unicast address (IPv4-mapped IPv6 is judged by its embedded IPv4 address).
export function isPublicAddress(address) {
  const a = String(address ?? '').replace(/^\[|\]$/g, '');
  const family = net.isIP(a);
  if (!family) return false;
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return !v4Block.check(mapped[1], 'ipv4');
  return family === 4 ? !v4Block.check(a, 'ipv4') : !v6Block.check(a, 'ipv6');
}

// Resolves a target host and fails unless every address is public (no private/loopback/reserved destinations).
export async function assertPublicHost(hostname, { lookup = dns.promises.lookup } = {}) {
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); } catch (e) { throw targetError(`cannot resolve ${hostname}: ${e.code ?? e.message}`); }
  if (!addresses?.length) throw targetError(`${hostname} did not resolve`);
  const bad = addresses.filter((x) => !isPublicAddress(x.address));
  if (bad.length) throw targetError(`${hostname} resolves to non-public address(es) ${bad.map((x) => x.address).join(', ')}`);
  return addresses.map((x) => x.address);
}

// A dns.lookup-compatible function for net/tls/http2 connect that refuses non-public destinations at connect time
// (also covering DNS answers that change after the up-front check).
export function publicOnlyLookup({ lookup = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = (addresses ?? []).filter((x) => !isPublicAddress(x.address));
      if (!addresses?.length || bad.length) {
        return callback(Object.assign(new Error(`refusing to connect to ${hostname}: non-public address ${bad.map((x) => x.address).join(', ') || '(none)'}`), { code: 'ETARGETPRIVATE' }));
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// The URLs of every main-frame document request (the navigation and each redirect hop) and response in a
// DevTools protocol log, in order.
export function mainFrameDocumentUrls(devtoolsLog = []) {
  const main = new Set(devtoolsLog.filter((e) => e.method === 'Page.frameNavigated' && !e.params?.frame?.parentId).map((e) => e.params.frame.id));
  const docs = devtoolsLog.filter((e) => e.method === 'Network.requestWillBeSent' && e.params?.type === 'Document');
  if (!main.size && docs[0]?.params?.frameId) main.add(docs[0].params.frameId);
  const urls = [];
  for (const e of devtoolsLog) {
    const p = e.params ?? {};
    if (!main.has(p.frameId) || p.type !== 'Document') continue;
    if (e.method === 'Network.requestWillBeSent') {
      if (p.redirectResponse?.url) urls.push(p.redirectResponse.url);
      urls.push(p.request?.url);
    } else if (e.method === 'Network.responseReceived') urls.push(p.response?.url);
  }
  return [...new Set(urls.filter(Boolean))];
}

// Validates every main-frame URL of a measured load: navigation, redirects and final URL. Throws a fatal ETARGET.
export function assertMainFrameTargets(urls, opts) {
  for (const u of urls) assertTargetUrl(u, { label: 'main-frame URL (redirect/final)', ...opts });
  return urls;
}
