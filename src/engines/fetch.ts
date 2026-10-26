import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Fetcher } from '../host.ts';
import { fail } from '../http.ts';
import type { FetchRequest, FetchResponse } from '../types.ts';
import { extractTitle, htmlToMarkdown, htmlToText } from './html.ts';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/* ---------- Which addresses may be fetched ---------- */

const BLOCKED_V4 = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
] as const) BLOCKED_V4.addSubnet(subnet, prefix, 'ipv4');

const BLOCKED_V6 = new BlockList();
for (const [subnet, prefix] of [
  ['::1', 128], // loopback
  ['::', 128], // unspecified
  ['fc00::', 7], // unique local, including AWS's IPv6 metadata address
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // well-known NAT64 prefix
  ['::ffff:0:0', 96], // IPv4-mapped, whatever it maps to
] as const) BLOCKED_V6.addSubnet(subnet, prefix, 'ipv6');

/** An IPv6 literal without URL.hostname's brackets */
const bareHost = (hostname: string): string => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

function defaultIsAddressAllowed(address: string, family: 4 | 6): boolean {
  return family === 4 ? !BLOCKED_V4.check(address, 'ipv4') : !BLOCKED_V6.check(address, 'ipv6');
}

async function defaultResolveHost(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

/* ---------- Charset ---------- */

function detectCharset(contentType: string | null, body: Buffer): string {
  const declared = contentType ? /charset\s*=\s*"?([^;"]+)/i.exec(contentType) : null;
  if (declared) return declared[1].trim();
  const head = body.subarray(0, 2048).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head);
  if (meta) return meta[1];
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  return 'utf-8';
}

function decode(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/* ---------- One hop ---------- */

interface Hop { status: number; contentType: string | null; cacheControl: string | null; location: string | null; body: Buffer; truncated: boolean }

function oneHop(url: URL, pinned: { address: string; family: 4 | 6 }, opts: { timeoutMs: number; maxBytes: number; userAgent: string; signal: AbortSignal }): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === 'https:';
    const combined = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    const req = (https ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port || (https ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'User-Agent': opts.userAgent, Accept: 'text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'identity' },
        signal: combined,
        ...(https ? { servername: bareHost(url.hostname) } : {}),
        // Pins the connection to the validated address
        lookup: ((_hostname: string, lookupOpts: { all?: boolean } | number | undefined, cb: (err: Error | null, address: unknown, family?: number) => void) => {
          if (typeof lookupOpts === 'object' && lookupOpts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;
        const cacheControl = typeof res.headers['cache-control'] === 'string' ? res.headers['cache-control'] : null;
        if (location && REDIRECT_STATUSES.has(status)) {
          res.resume();
          resolve({ status, contentType, cacheControl, location, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (ok || truncated) resolve({ status, contentType, cacheControl, location: null, body: Buffer.concat(chunks), truncated });
          else reject(new Error('the connection closed before the response finished'));
        };
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (total + chunk.length > opts.maxBytes) {
            chunks.push(chunk.subarray(0, opts.maxBytes - total));
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on('end', () => finish(true));
        res.on('close', () => finish(res.complete === true));
        res.on('error', (err) => { if (!settled && !truncated) reject(err); });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const isCacheable = (cacheControl: string | null): boolean => !cacheControl || !/\b(no-store|private)\b/i.test(cacheControl);

export interface HttpFetcherOptions {
  /** Per hop, default 10 000 */
  timeoutMs?: number;
  /** Of the raw response body, default 5 000 000 */
  maxBytes?: number;
  userAgent?: string;
  /** Test-only */
  resolveHost?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** Test-only */
  isAddressAllowed?: (address: string, family: 4 | 6) => boolean;
}

/** Fetches one page, checking every address each hop resolves to and pinning the connection to the one that passed */
export function httpFetcher(options: HttpFetcherOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const userAgent = options.userAgent ?? 'standalone-service-fetch/1.0 (+https://github.com/; respects robots.txt: no)';
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const isAddressAllowed = options.isAddressAllowed ?? defaultIsAddressAllowed;

  async function pin(rawHostname: string): Promise<{ address: string; family: 4 | 6 }> {
    const hostname = bareHost(rawHostname);
    const ipFamily = isIP(hostname);
    const records = ipFamily ? [{ address: hostname, family: (ipFamily === 6 ? 6 : 4) as 4 | 6 }] : await resolveHost(hostname);
    if (records.length === 0) throw fail('invalid_request', `could not resolve ${hostname}`);
    for (const r of records) {
      if (!isAddressAllowed(r.address, r.family)) throw fail('invalid_request', `refuses to fetch ${hostname}: it resolves to a private, loopback or otherwise non-public address`);
    }
    return records.find((r) => r.family === 4) ?? records[0];
  }

  return {
    async fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResponse & { cacheable?: boolean }> {
      let current = new URL(request.url);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw fail('invalid_request', 'only http and https URLs are fetched');

      let hop: Hop | undefined;
      for (let redirect = 0; ; redirect++) {
        const pinned = await pin(current.hostname);
        hop = await oneHop(current, pinned, { timeoutMs, maxBytes, userAgent, signal });
        if (!hop.location) break;
        if (redirect >= MAX_REDIRECTS) throw new Error(`too many redirects (over ${MAX_REDIRECTS})`);
        const next = new URL(hop.location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw fail('invalid_request', 'a redirect led to a non-http(s) URL');
        current = next;
      }

      const contentType = hop.contentType;
      const isHtml = contentType != null && /text\/html|application\/xhtml\+xml/i.test(contentType);
      const decoded = decode(hop.body, detectCharset(contentType, hop.body));

      const format = request.format ?? 'markdown';
      let title: string | null = null;
      let content: string;
      if (isHtml) {
        title = extractTitle(decoded);
        content = format === 'html' ? decoded : format === 'text' ? htmlToText(decoded).text : htmlToMarkdown(decoded).text;
      } else {
        content = decoded;
      }

      const maxChars = request.maxChars ?? 100_000;
      let truncated = hop.truncated;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
      }

      return { url: current.toString(), status: hop.status, contentType, title, content, truncated, cacheable: isCacheable(hop.cacheControl) };
    },
  };
}
