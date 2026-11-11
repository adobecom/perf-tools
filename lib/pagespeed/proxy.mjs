// Per-run measuring proxy (HTTP CONNECT). Only the measured page's host is terminated locally, with a throwaway
// certificate the launched Chrome trusts through an SPKI exception (no system trust change), and forwarded to the
// real origin over HTTP/2, so the protocol and connection behaviour stay real. Chrome applies the DevTools network and CPU throttling itself, so it covers the proxied traffic too. Every other
// host is a blind TCP tunnel. Responses are streamed through untouched, original compressed bytes included; only
// the responses selected by `select` are buffered and handed to `transform`. When the transform leaves the body
// unchanged the original wire bytes are sent; when it changes, the body is re-encoded with the original encoding
// (Brotli at quality 6, which reproduces production asset sizes; quality 11 would add incidental savings).
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { X509Certificate, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { publicOnlyLookup } from '../target.mjs';
import { brotliDecompressSync, brotliCompressSync, gunzipSync, gzipSync, inflateSync, deflateSync, constants } from 'node:zlib';

const DECODE = { br: brotliDecompressSync, gzip: gunzipSync, deflate: inflateSync };
const ENCODE = {
  br: (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
  gzip: gzipSync,
  deflate: deflateSync,
};

export const spkiOf = (certPem) => createHash('sha256')
  .update(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

export async function startProxy({ host, key, cert, upstreamOrigin = `https://${host}`, upstreamOptions = {}, select = () => null, transform, allowLocalTargets = false, lookup = publicOnlyLookup() }) {
  // Non-public destinations (private, loopback, link-local, reserved) are refused for the page origin and for tunnels,
  // at connect time, unless a local test fixture explicitly allows them.
  const connectLookup = allowLocalTargets ? undefined : lookup;
  const upstreamConnectOptions = connectLookup ? { lookup: connectLookup, ...upstreamOptions } : upstreamOptions;
  const sockets = new Set();
  const errors = [];
  const requests = [];
  // Timing of every tunnel (DNS lookup and TCP connect to the real host, measured by the proxy) and how long this
  // process's event loop was blocked: the proxy shares it with Lighthouse, so a blocked loop delays every connection.
  const tunnels = [];
  const stalls = [];
  const TICK = 20;
  let tick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - tick - TICK;
    if (lag >= 50) stalls.push({ at: Date.now() - Math.round(lag), ms: Math.round(lag) });
    tick = now;
  }, TICK);
  lagTimer.unref();
  let upstream;
  const tls = http2.createSecureServer({ key, cert });
  tls.on('sessionError', (e) => errors.push(`TLS session: ${e.message}`));
  tls.on('tlsClientError', (e) => errors.push(`TLS client: ${e.message}`));
  tls.on('stream', (stream, reqHeaders) => {
    stream.on('error', (e) => errors.push(`client stream: ${e.message}`));
    const pathAndQuery = reqHeaders[':path'];
    const kind = select(pathAndQuery, reqHeaders);
    const entry = { path: pathAndQuery, method: reqHeaders[':method'], dest: reqHeaders['sec-fetch-dest'] ?? null, alpn: stream.session?.alpnProtocol ?? null, kind };
    requests.push(entry);
    const alive = () => !stream.closed && !stream.destroyed;
    if (!upstream || upstream.closed || upstream.destroyed) {
      // Chrome never accepts HTTP/2 server push, so the upstream session refuses it too: CDNs such as Fastly push the
      // document's Link rel=preload entries to clients that allow it, which would add traffic Chrome never sees.
      upstream = http2.connect(upstreamOrigin, { ...upstreamConnectOptions, settings: { ...upstreamConnectOptions.settings, enablePush: false } });
      upstream.on('error', (e) => {
        errors.push(`upstream session: ${e.message}`);
        // The page origin resolving to a non-public address at connect time fails the run, not just a note.
        if (e.code === 'ETARGETPRIVATE') errors.fatal ??= Object.assign(new Error(e.message), { fatal: true, code: 'ETARGET' });
      });
    }
    const headers = { ...reqHeaders, ':authority': new URL(upstreamOrigin).host, ':scheme': 'https' };
    delete headers['proxy-connection'];
    let remote;
    try {
      remote = upstream.request(headers);
    } catch (e) {
      errors.push(`upstream request ${pathAndQuery}: ${e.message}`);
      if (alive()) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    stream.on('aborted', () => remote.close());
    remote.on('error', (e) => {
      if (alive()) {
        errors.push(`upstream stream ${pathAndQuery}: ${e.message}`);
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
    });
    stream.pipe(remote);
    remote.on('response', (resHeaders) => {
      entry.status = resHeaders[':status'];
      entry.upstreamHeaders = Object.fromEntries(Object.entries(resHeaders).filter(([k]) => !k.startsWith(':')));
      if (!kind) {
        if (alive()) { stream.respond(resHeaders); remote.pipe(stream); }
        return;
      }
      const chunks = [];
      remote.on('data', (c) => chunks.push(c));
      remote.on('end', async () => {
        try {
          const wire = Buffer.concat(chunks);
          const encoding = resHeaders['content-encoding'];
          if (encoding && !DECODE[encoding]) throw new Error(`unsupported content-encoding ${encoding}`);
          const original = (encoding ? DECODE[encoding](wire) : wire).toString('utf8');
          const { [':status']: status, ...plain } = resHeaders;
          const out = await transform({ kind, path: pathAndQuery, status, headers: plain, body: original, encodedBytes: wire.length });
          const changedBody = Buffer.isBuffer(out.body) || out.body !== original;
          const outEncoding = Object.hasOwn(out, 'encoding') ? out.encoding : encoding;
          if (outEncoding && !ENCODE[outEncoding]) throw new Error(`unsupported output encoding ${outEncoding}`);
          const output = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body);
          const body = !changedBody && outEncoding === encoding ? wire : outEncoding ? ENCODE[outEncoding](output) : output;
          const finalHeaders = { ...out.headers, ':status': out.status ?? status, 'content-length': String(body.length) };
          if (outEncoding) finalHeaders['content-encoding'] = outEncoding; else delete finalHeaders['content-encoding'];
          if (changedBody) { delete finalHeaders.etag; delete finalHeaders['content-md5']; }
          Object.assign(entry, { edited: changedBody || JSON.stringify(out.headers) !== JSON.stringify(plain), originalEncodedBytes: wire.length, servedEncodedBytes: body.length, encoding: outEncoding ?? null });
          if (alive()) { stream.respond(finalHeaders); stream.end(body); }
        } catch (e) {
          entry.error = e.message;
          errors.push(`transform ${pathAndQuery}: ${e.message}`);
          if (e.fatal) errors.fatal = e;
          if (alive()) { stream.respond({ ':status': 502, 'content-type': 'text/plain' }); stream.end('perf-ab experiment transform failed'); }
        }
      });
    });
  });

  const proxy = http.createServer((_req, res) => { res.writeHead(400); res.end('HTTPS CONNECT required'); });
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); };
  proxy.on('connection', (socket) => { track(socket); socket.on('error', () => socket.destroy()); });
  proxy.on('connect', (req, socket, head) => {
    let target;
    try { target = new URL(`https://${req.url}`); } catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const port = Number(target.port || 443);
    if (target.hostname === host && port === 443) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      tls.emit('connection', socket);
      return;
    }
    if (!allowLocalTargets && (port !== 443 || target.hostname === 'localhost' || net.isIP(target.hostname))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const started = performance.now();
    const tunnel = { host: target.hostname, at: Date.now(), lookupMs: null, connectMs: null };
    tunnels.push(tunnel);
    const remote = net.connect({ port, host: target.hostname, ...(connectLookup ? { lookup: connectLookup } : {}) });
    track(remote);
    remote.once('lookup', () => { tunnel.lookupMs = Math.round(performance.now() - started); });
    remote.on('connect', () => {
      tunnel.connectMs = Math.round(performance.now() - started);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    let established = false;
    remote.once('connect', () => { established = true; });
    remote.on('error', (e) => {
      errors.push(`tunnel ${target.hostname}: ${e.message}`);
      remote.destroy();
      if (established || socket.destroyed) socket.destroy();
      else socket.end(e.code === 'ETARGETPRIVATE' ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('close', () => remote.destroy());
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  return {
    port: proxy.address().port,
    spki: spkiOf(cert),
    errors,
    requests,
    timing: () => ({ tunnels: tunnels.map((t) => ({ ...t })), stalls: stalls.slice(0, 500) }),
    async close() {
      clearInterval(lagTimer);
      upstream?.destroy();
      for (const s of sockets) s.destroy();
      await new Promise((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
