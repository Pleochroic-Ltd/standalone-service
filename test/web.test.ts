import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SearchEngine, Fetcher } from '../src/host.ts';
import { migrateCache, sqliteCache } from '../src/store/cache.ts';
import { registrableDomain } from '../src/services/web.ts';
import { testHost, startService } from './helpers.ts';

const freshCache = () => {
  const db = new DatabaseSync(':memory:');
  migrateCache(db);
  return sqliteCache(db);
};

test('POST /search validates the request before touching the engine', async () => {
  const service = await startService(testHost());
  try {
    const res = await service.call('POST', '/v1/search', { body: { count: 999 } });
    assert.equal(res.status, 400);
  } finally {
    await service.stop();
  }
});

test('POST /search is 501 when no search engine is configured', async () => {
  const service = await startService(testHost());
  try {
    const res = await service.call('POST', '/v1/search', { body: { query: 'hello' } });
    assert.equal(res.status, 501);
  } finally {
    await service.stop();
  }
});

test('POST /search calls admit/record and returns the engine\'s answer', async () => {
  const calls: { admit: unknown[]; record: unknown[] } = { admit: [], record: [] };
  const fake: SearchEngine = { id: 'fake', search: async () => ({ results: [{ title: 'T', url: 'https://x', snippet: 's', publishedAt: null }], backend: 'fake' }) };
  const host = testHost({
    search: fake,
    admit: (...args) => { calls.admit.push(args); return { billed: false }; },
    record: (...args) => { calls.record.push(args); },
  });
  const service = await startService(host);
  try {
    const res = await service.call('POST', '/v1/search', { body: { query: 'hello' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).backend, 'fake');
    assert.equal(calls.admit.length, 1);
    assert.equal(calls.record.length, 1);
  } finally {
    await service.stop();
  }
});

test('POST /search turns an engine failure into upstream_error', async () => {
  const failing: SearchEngine = { id: 'failing', search: async () => { throw new Error('boom'); } };
  const service = await startService(testHost({ search: failing }));
  try {
    const res = await service.call('POST', '/v1/search', { body: { query: 'hello' } });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'upstream_error');
  } finally {
    await service.stop();
  }
});

test('POST /fetch validates, 501s with no fetcher, and otherwise returns the fetcher\'s answer', async () => {
  const service1 = await startService(testHost());
  try {
    assert.equal((await service1.call('POST', '/v1/fetch', { body: {} })).status, 400);
    assert.equal((await service1.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } })).status, 501);
  } finally {
    await service1.stop();
  }

  const fakeFetcher: Fetcher = { fetch: async () => ({ url: 'https://example.com', status: 200, contentType: 'text/plain', title: null, content: 'hi', truncated: false }) };
  const service2 = await startService(testHost({ fetcher: fakeFetcher }));
  try {
    const res = await service2.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).content, 'hi');
  } finally {
    await service2.stop();
  }
});

test('POST /search: a second identical request is a cache hit — the engine is called once, cached: true the second time', async () => {
  let calls = 0;
  const records: { cached?: boolean }[] = [];
  const fake: SearchEngine = { id: 'fake', search: async () => { calls++; return { results: [{ title: 'T', url: 'https://x', snippet: 's', publishedAt: null }], backend: 'fake' }; } };
  const service = await startService(testHost({ search: fake, cache: freshCache(), record: (...args) => records.push(args[3]) }));
  try {
    const first = await service.call('POST', '/v1/search', { body: { query: 'rust ownership' } });
    assert.equal((await first.json()).cached, undefined);
    const second = await service.call('POST', '/v1/search', { body: { query: 'Rust Ownership' } }); // same query, different case
    const secondBody = await second.json();
    assert.equal(secondBody.cached, true);
    assert.equal(secondBody.backend, 'fake');
    assert.equal(calls, 1);
    assert.equal(records.length, 2);
    assert.equal(records[0].cached, undefined);
    assert.equal(records[1].cached, true);
  } finally {
    await service.stop();
  }
});

test('POST /search: different count/freshness/sites/language are different cache keys', async () => {
  let calls = 0;
  const fake: SearchEngine = { id: 'fake', search: async () => { calls++; return { results: [], backend: 'fake' }; } };
  const service = await startService(testHost({ search: fake, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/search', { body: { query: 'x', count: 5 } });
    await service.call('POST', '/v1/search', { body: { query: 'x', count: 6 } });
    await service.call('POST', '/v1/search', { body: { query: 'x', count: 5, freshness: 'week' } });
    await service.call('POST', '/v1/search', { body: { query: 'x', count: 5, sites: ['a.com', 'b.com'] } });
    await service.call('POST', '/v1/search', { body: { query: 'x', count: 5, sites: ['b.com', 'a.com'] } }); // same sites, other order
    assert.equal(calls, 4);
  } finally {
    await service.stop();
  }
});

test('POST /fetch: a second identical request is a cache hit', async () => {
  let calls = 0;
  const fetcher: Fetcher = { fetch: async () => { calls++; return { url: 'https://example.com/', status: 200, contentType: 'text/html', title: 'T', content: 'hello', truncated: false }; } };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    const res = await service.call('POST', '/v1/fetch', { body: { url: 'https://EXAMPLE.com' } }); // normalized to the same key
    assert.equal((await res.json()).cached, true);
    assert.equal(calls, 1);
  } finally {
    await service.stop();
  }
});

test('POST /fetch: a different format is a different cache entry', async () => {
  let calls = 0;
  const fetcher: Fetcher = { fetch: async () => { calls++; return { url: 'https://example.com/', status: 200, contentType: 'text/html', title: null, content: 'c', truncated: false }; } };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com', format: 'markdown' } });
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com', format: 'text' } });
    assert.equal(calls, 2);
  } finally {
    await service.stop();
  }
});

test('POST /fetch: a non-2xx response is never cached', async () => {
  let calls = 0;
  const fetcher: Fetcher = { fetch: async () => { calls++; return { url: 'https://example.com/', status: 404, contentType: 'text/html', title: null, content: 'not found', truncated: false }; } };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    const second = await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    assert.equal((await second.json()).cached, undefined);
    assert.equal(calls, 2);
  } finally {
    await service.stop();
  }
});

test('POST /fetch: Cache-Control: no-store from the origin is honoured — never cached', async () => {
  let calls = 0;
  const fetcher: Fetcher = { fetch: async () => { calls++; return { url: 'https://example.com/', status: 200, contentType: 'text/html', title: null, content: 'c', truncated: false, cacheable: false }; } };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    assert.equal(calls, 2);
  } finally {
    await service.stop();
  }
});

test('POST /fetch: a non-text content type is never cached', async () => {
  let calls = 0;
  const fetcher: Fetcher = { fetch: async () => { calls++; return { url: 'https://example.com/pic.png', status: 200, contentType: 'image/png', title: null, content: '', truncated: false }; } };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com/pic.png' } });
    await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com/pic.png' } });
    assert.equal(calls, 2);
  } finally {
    await service.stop();
  }
});

test('the internal `cacheable` flag never reaches the client', async () => {
  const fetcher: Fetcher = { fetch: async () => ({ url: 'https://example.com/', status: 200, contentType: 'text/html', title: null, content: 'c', truncated: false, cacheable: true }) };
  const service = await startService(testHost({ fetcher, cache: freshCache() }));
  try {
    const res = await service.call('POST', '/v1/fetch', { body: { url: 'https://example.com' } });
    assert.equal('cacheable' in (await res.json()), false);
  } finally {
    await service.stop();
  }
});

test('without a cache on the host, nothing is cached and every request reaches the engine', async () => {
  let calls = 0;
  const fake: SearchEngine = { id: 'fake', search: async () => { calls++; return { results: [], backend: 'fake' }; } };
  const service = await startService(testHost({ search: fake })); // no `cache`
  try {
    await service.call('POST', '/v1/search', { body: { query: 'x' } });
    const res = await service.call('POST', '/v1/search', { body: { query: 'x' } });
    assert.equal((await res.json()).cached, undefined);
    assert.equal(calls, 2);
  } finally {
    await service.stop();
  }
});

/* ---------- The fetch-domain note ---------- */

test('registrableDomain: host only, with a short list of two-label public suffixes', () => {
  assert.equal(registrableDomain('https://example.com/a/b?x=1'), 'example.com', 'path and query are dropped');
  assert.equal(registrableDomain('https://www.example.com'), 'example.com');
  assert.equal(registrableDomain('https://deep.sub.example.com'), 'example.com');
  assert.equal(registrableDomain('https://WWW.Example.COM'), 'example.com', 'case-folded');
  assert.equal(registrableDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk', 'a known two-label suffix keeps three labels');
  assert.equal(registrableDomain('https://example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('https://news.ycombinator.com'), 'ycombinator.com', 'an ordinary two-label TLD stays at two labels');
  assert.equal(registrableDomain('https://localhost:8080/x'), 'localhost', 'a bare host with no dots at all');
  assert.equal(registrableDomain('not a url'), null);
});

test('POST /fetch: the record note is the target’s registrable domain, host only, on success, a cache hit, and a failure', async () => {
  const notes: (string | undefined)[] = [];
  const fetcher: Fetcher = { fetch: async () => ({ url: 'https://example.com/a/b', status: 200, contentType: 'text/html', title: null, content: 'hi', truncated: false }) };
  const service = await startService(testHost({ fetcher, cache: freshCache(), record: (...args) => notes.push((args[3] as { note?: string }).note) }));
  try {
    await service.call('POST', '/v1/fetch', { body: { url: 'https://www.example.com/a/b?secret=1' } });
    await service.call('POST', '/v1/fetch', { body: { url: 'https://www.example.com/a/b?secret=1' } }); // cache hit
    assert.deepEqual(notes, ['example.com', 'example.com'], 'host only — never the path or the query string');
  } finally {
    await service.stop();
  }
});

test('POST /fetch: the record note is still the domain when the fetch itself fails', async () => {
  const notes: (string | undefined)[] = [];
  const failing: Fetcher = { fetch: async () => { throw new Error('boom: connection refused to 10.0.0.1 with secret token xyz'); } };
  const service = await startService(testHost({ fetcher: failing, record: (...args) => notes.push((args[3] as { note?: string }).note) }));
  try {
    const res = await service.call('POST', '/v1/fetch', { body: { url: 'https://evil.example.net/path' } });
    assert.equal(res.status, 502);
    assert.deepEqual(notes, ['example.net'], 'the domain, not the error text (which could otherwise leak into a stored note)');
  } finally {
    await service.stop();
  }
});
