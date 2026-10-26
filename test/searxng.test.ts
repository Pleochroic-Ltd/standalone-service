import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import type { SearchEngine } from '../src/host.ts';
import { firstOf, searxngSearch } from '../src/engines/search.ts';
import type { SearchRequest } from '../src/types.ts';

let server: Server;
let baseUrl: string;
let lastRequest: { path: string; params: URLSearchParams; authorization: string | null } | null = null;

/** What the next request to /search gets back */
let respondWith: (query: URLSearchParams) => { status: number; body: unknown };

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    lastRequest = { path: url.pathname, params: url.searchParams, authorization: (req.headers.authorization as string) ?? null };
    const { status, body } = respondWith(url.searchParams);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const signal = new AbortController().signal;

test('hits GET {baseUrl}/search with format=json and the mapped params', async () => {
  respondWith = () => ({ status: 200, body: { results: [] } });
  const engine = searxngSearch({ baseUrl, engines: ['google', 'bing'], categories: ['general'] });
  const request: SearchRequest = { query: 'rust ownership', count: 5, freshness: 'week', language: 'zh-CN', sites: ['doc.rust-lang.org'] };
  await engine.search(request, signal);

  assert.ok(lastRequest);
  assert.equal(lastRequest!.path, '/search');
  const p = lastRequest!.params;
  assert.equal(p.get('format'), 'json');
  assert.equal(p.get('pageno'), '1');
  assert.equal(p.get('language'), 'zh-CN');
  assert.equal(p.get('time_range'), 'week');
  assert.equal(p.get('categories'), 'general');
  assert.equal(p.get('engines'), 'google,bing');
  assert.match(p.get('q') ?? '', /rust ownership/);
  assert.match(p.get('q') ?? '', /site:doc\.rust-lang\.org/);
});

test('maps results (title, url, content→snippet, publishedDate→publishedAt) and the backend name', async () => {
  respondWith = () => ({
    status: 200,
    body: {
      results: [
        { title: 'Ownership', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', content: 'Explains ownership', publishedDate: '2023-05-01T00:00:00Z' },
        { title: 'No date', url: 'https://example.com/no-date', content: 'c' },
      ],
    },
  });
  const engine = searxngSearch({ baseUrl });
  const res = await engine.search({ query: 'ownership' }, signal);
  assert.equal(res.backend, 'searxng');
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.results[0], { title: 'Ownership', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', snippet: 'Explains ownership', publishedAt: '2023-05-01T00:00:00.000Z' });
  assert.equal(res.results[1].publishedAt, null);
});

test('a custom backend name overrides the default', async () => {
  respondWith = () => ({ status: 200, body: { results: [{ title: 't', url: 'https://x', content: 'c' }] } });
  const engine = searxngSearch({ baseUrl, backend: 'pleochroic-searxng' });
  assert.equal((await engine.search({ query: 'x' }, signal)).backend, 'pleochroic-searxng');
});

test('dedupes by normalized URL and respects count', async () => {
  respondWith = () => ({
    status: 200,
    body: {
      results: [
        { title: 'A', url: 'https://example.com/a/', content: '1' },
        { title: 'A dup', url: 'https://EXAMPLE.com/a', content: '2' }, // same page
        { title: 'B', url: 'https://example.com/b', content: '3' },
        { title: 'C', url: 'https://example.com/c', content: '4' },
      ],
    },
  });
  const engine = searxngSearch({ baseUrl });
  const res = await engine.search({ query: 'x', count: 2 }, signal);
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.results.map((r) => r.title), ['A', 'B']);
});

test('a token is sent as Authorization: Bearer, for a private instance', async () => {
  respondWith = () => ({ status: 200, body: { results: [] } });
  const engine = searxngSearch({ baseUrl, token: 'secret-token' });
  await engine.search({ query: 'x' }, signal);
  assert.equal(lastRequest?.authorization, 'Bearer secret-token');
});

test('no results but unresponsive_engines is treated as a failure, not "nothing found"', async () => {
  respondWith = () => ({ status: 200, body: { results: [], unresponsive_engines: [['google', 'timeout']] } });
  const engine = searxngSearch({ baseUrl });
  await assert.rejects(() => engine.search({ query: 'x' }, signal), /unresponsive/);
});

test('no results and no unresponsive_engines is a legitimate empty answer, not a failure', async () => {
  respondWith = () => ({ status: 200, body: { results: [], unresponsive_engines: [] } });
  const engine = searxngSearch({ baseUrl });
  const res = await engine.search({ query: 'x' }, signal);
  assert.deepEqual(res.results, []);
});

test('an HTTP-level failure throws too', async () => {
  respondWith = () => ({ status: 500, body: { error: 'boom' } });
  const engine = searxngSearch({ baseUrl });
  await assert.rejects(() => engine.search({ query: 'x' }, signal), /searxng/);
});

test('firstOf falls through from an unresponsive SearXNG to a paid engine', async () => {
  respondWith = () => ({ status: 200, body: { results: [], unresponsive_engines: [['google', 'timeout'], ['bing', 'timeout']] } });
  const paid: SearchEngine = { id: 'brave', search: async () => ({ results: [{ title: 'from brave', url: 'https://x', snippet: '', publishedAt: null }], backend: 'brave' }) };
  const engine = firstOf(searxngSearch({ baseUrl }), paid);
  const res = await engine.search({ query: 'x' }, signal);
  assert.equal(res.backend, 'brave');
});
