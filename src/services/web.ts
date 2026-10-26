import { createHash } from 'node:crypto';
import type { Host } from '../host.ts';
import { fail, readJson, route, send, ServiceError, type Route } from '../http.ts';
import { MAX } from '../limits.ts';
import type { FetchRequest, FetchResponse, SearchRequest, SearchResponse } from '../types.ts';

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function searchRequest(body: Record<string, unknown>): SearchRequest {
  if (!nonEmptyString(body.query)) throw fail('invalid_request', '`query` must be a non-empty string');
  const count = body.count === undefined ? 10 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX.searchCount) throw fail('invalid_request', `count must be between 1 and ${MAX.searchCount}`);
  if (body.freshness !== undefined && !['day', 'week', 'month', 'year'].includes(body.freshness as string)) throw fail('invalid_request', 'freshness must be day, week, month or year');
  if (body.sites !== undefined && (!Array.isArray(body.sites) || !body.sites.every((s) => typeof s === 'string'))) throw fail('invalid_request', '`sites` must be an array of strings');
  if (body.language !== undefined && typeof body.language !== 'string') throw fail('invalid_request', '`language` must be a string');
  return {
    query: body.query,
    count,
    freshness: body.freshness as SearchRequest['freshness'],
    sites: body.sites as string[] | undefined,
    language: body.language as string | undefined,
  };
}

function fetchRequest(body: Record<string, unknown>): FetchRequest {
  if (!nonEmptyString(body.url)) throw fail('invalid_request', '`url` must be a non-empty string');
  const format = body.format === undefined ? 'markdown' : body.format;
  if (!['markdown', 'text', 'html'].includes(format as string)) throw fail('invalid_request', 'format must be markdown, text or html');
  const maxChars = body.maxChars === undefined ? 100_000 : Number(body.maxChars);
  if (!Number.isInteger(maxChars) || maxChars < 1) throw fail('invalid_request', 'maxChars must be a positive integer');
  return { url: body.url, format: format as FetchRequest['format'], maxChars: Math.min(maxChars, MAX.fetchChars) };
}

/** Rethrows a ServiceError as it is and any other engine failure as upstream_error */
function upstream(err: unknown): never {
  if (err instanceof ServiceError) throw err;
  throw fail('upstream_error', err instanceof Error ? err.message : 'the request to the upstream service failed');
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw;
  }
}

const cacheKey = (namespace: string, canonical: unknown): string => `${namespace}:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;

function searchCacheKey(request: SearchRequest): string {
  return cacheKey('search', {
    q: request.query.trim().toLowerCase(),
    count: request.count ?? 10,
    freshness: request.freshness ?? null,
    sites: [...(request.sites ?? [])].map((s) => s.toLowerCase()).sort(),
    language: request.language ?? null,
  });
}

function searchTtlSeconds(freshness: SearchRequest['freshness']): number {
  if (freshness === 'day') return 15 * 60;
  if (freshness === 'week') return 2 * 60 * 60;
  return 12 * 60 * 60; // month, year, or none
}

const fetchCacheKey = (request: FetchRequest): string => cacheKey('fetch', { url: normalizeUrl(request.url), format: request.format ?? 'markdown' });
const FETCH_TTL_SECONDS = 6 * 60 * 60;

/** Second-level public suffixes, so "www.bbc.co.uk" yields "bbc.co.uk" */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.il', 'co.th', 'co.id',
  'com.cn', 'net.cn', 'org.cn', 'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.tr', 'com.hk', 'com.sg', 'com.tw',
]);

/** The registrable domain of `rawUrl`'s host, or null when it isn't a URL */
export function registrableDomain(rawUrl: string): string | null {
  let host: string;
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const take = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const isTextResponse = (contentType: string | null): boolean => !contentType || /^text\//i.test(contentType) || /^application\/(json|xml|xhtml\+xml|javascript)\b/i.test(contentType);

/** A hit in the shared cache is still admitted and recorded, with `cached: true` */
export const webRoutes = (host: Host): Route[] => [
  route('POST', '/search', 'tools', async ({ req, res, principal, signal }) => {
    const request = searchRequest(await readJson(req, MAX.smallBody));
    if (!host.search) throw fail('not_implemented', 'no search engine is configured');
    const cache = host.cache;
    const key = cache ? searchCacheKey(request) : null;
    const admission = await host.admit(principal, 'search', 1);

    if (cache && key) {
      const hit = cache.get<SearchResponse>(key);
      if (hit) {
        host.record(principal, 'search', 1, { admission, ok: true, cached: true });
        send(res, 200, { ...hit.value, cached: true });
        return;
      }
    }
    try {
      const result = await host.search.search(request, signal);
      host.record(principal, 'search', 1, { admission, ok: true });
      if (cache && key) cache.put(key, result, searchTtlSeconds(request.freshness));
      send(res, 200, result);
    } catch (err) {
      host.record(principal, 'search', 1, { admission, ok: false, note: err instanceof Error ? err.message : String(err) });
      upstream(err);
    }
  }),

  route('POST', '/fetch', 'tools', async ({ req, res, principal, signal }) => {
    const request = fetchRequest(await readJson(req, MAX.smallBody));
    if (!host.fetcher) throw fail('not_implemented', 'no fetcher is configured');
    const cache = host.cache;
    const key = cache ? fetchCacheKey(request) : null;
    const admission = await host.admit(principal, 'fetch', 1);

    const domain = registrableDomain(request.url) ?? undefined;

    if (cache && key) {
      const hit = cache.get<FetchResponse>(key);
      if (hit) {
        host.record(principal, 'fetch', 1, { admission, ok: true, cached: true, note: domain });
        send(res, 200, { ...hit.value, cached: true });
        return;
      }
    }
    try {
      const { cacheable, ...wire } = await host.fetcher.fetch(request, signal);
      host.record(principal, 'fetch', 1, { admission, ok: true, note: domain });
      if (cache && key && cacheable !== false && wire.status >= 200 && wire.status < 300 && isTextResponse(wire.contentType)) {
        cache.put(key, wire, FETCH_TTL_SECONDS);
      }
      send(res, 200, wire);
    } catch (err) {
      host.record(principal, 'fetch', 1, { admission, ok: false, note: domain });
      upstream(err);
    }
  }),
];
