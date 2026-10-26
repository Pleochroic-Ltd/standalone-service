import type { SearchEngine } from '../host.ts';
import type { SearchRequest, SearchResponse, SearchResult } from '../types.ts';

const FRESHNESS_BRAVE: Record<NonNullable<SearchRequest['freshness']>, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

/** https://api.search.brave.com/app/documentation/web-search/get-started */
export function braveSearch({ apiKey }: { apiKey: string }): SearchEngine {
  return {
    id: 'brave',
    async search(request, signal) {
      if (!apiKey) throw new Error('brave: BRAVE_API_KEY is not set');
      const query = request.sites?.length ? `${request.query} (${request.sites.map((s) => `site:${s}`).join(' OR ')})` : request.query;
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(request.count ?? 10));
      if (request.freshness) url.searchParams.set('freshness', FRESHNESS_BRAVE[request.freshness]);
      if (request.language) url.searchParams.set('search_lang', request.language.split('-')[0]);
      const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey }, signal });
      if (!res.ok) throw new Error(`brave: ${res.status} ${await res.text().catch(() => '')}`.trim());
      const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; age?: string; page_age?: string }[] } };
      const results: SearchResult[] = (body.web?.results ?? []).map((r) => ({
        title: r.title, url: r.url, snippet: r.description ?? '', publishedAt: toIso(r.page_age ?? r.age ?? null),
      }));
      return { results, backend: 'brave' };
    },
  };
}

/** https://docs.tavily.com/documentation/api-reference/endpoint/search */
export function tavilySearch({ apiKey }: { apiKey: string }): SearchEngine {
  return {
    id: 'tavily',
    async search(request, signal) {
      if (!apiKey) throw new Error('tavily: TAVILY_API_KEY is not set');
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: request.query,
          max_results: request.count ?? 10,
          ...(request.freshness ? { time_range: request.freshness } : {}),
          ...(request.sites?.length ? { include_domains: request.sites } : {}),
        }),
        signal,
      });
      if (!res.ok) throw new Error(`tavily: ${res.status} ${await res.text().catch(() => '')}`.trim());
      const body = (await res.json()) as { results?: { title: string; url: string; content?: string; published_date?: string }[] };
      const results: SearchResult[] = (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '', publishedAt: toIso(r.published_date ?? null) }));
      return { results, backend: 'tavily' };
    },
  };
}

/**
 * A SearXNG instance over its JSON API.
 * No results alongside unresponsive engines counts as a failure.
 */
export function searxngSearch({ baseUrl, timeoutMs = 8_000, engines, categories, token, backend = 'searxng' }: {
  baseUrl: string;
  timeoutMs?: number;
  engines?: string[];
  categories?: string[];
  token?: string;
  /** SearchResponse.backend, default 'searxng' */
  backend?: string;
}): SearchEngine {
  return {
    id: 'searxng',
    async search(request, signal) {
      const query = request.sites?.length ? `${request.query} (${request.sites.map((s) => `site:${s}`).join(' OR ')})` : request.query;
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('pageno', '1');
      if (request.language) url.searchParams.set('language', request.language);
      if (request.freshness) url.searchParams.set('time_range', request.freshness);
      if (categories?.length) url.searchParams.set('categories', categories.join(','));
      if (engines?.length) url.searchParams.set('engines', engines.join(','));

      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const res = await fetch(url, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: combined });
      if (!res.ok) throw new Error(`searxng: ${res.status} ${await res.text().catch(() => '')}`.trim());
      const body = (await res.json()) as {
        results?: { title: string; url: string; content?: string; publishedDate?: string | null }[];
        unresponsive_engines?: unknown[];
      };
      const raw = body.results ?? [];
      if (raw.length === 0 && (body.unresponsive_engines?.length ?? 0) > 0) {
        throw new Error(`searxng: no results, and engines were unresponsive (${JSON.stringify(body.unresponsive_engines)})`);
      }

      const seen = new Set<string>();
      const results: SearchResult[] = [];
      const count = request.count ?? 10;
      for (const r of raw) {
        if (results.length >= count) break;
        const key = normalizeUrlForDedupe(r.url);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: r.title, url: r.url, snippet: r.content ?? '', publishedAt: toIso(r.publishedDate ?? null) });
      }
      return { results, backend };
    },
  };
}

function normalizeUrlForDedupe(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw;
  }
}

function toIso(date: string | null): string | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Tries each engine in order until one answers */
export function firstOf(...engines: SearchEngine[]): SearchEngine {
  return {
    id: `firstOf(${engines.map((e) => e.id).join(',')})`,
    async search(request, signal) {
      let lastError: unknown;
      for (const engine of engines) {
        if (signal.aborted) throw new Error('aborted');
        try {
          return await engine.search(request, signal);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('no search engine is configured');
    },
  };
}
