import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { ServiceError } from '../src/http.ts';
import { httpFetcher } from '../src/engines/fetch.ts';

let server: Server;
let port: number;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Fetch Test</title></head><body>
        <nav>skip me</nav>
        <h1>Hello <em>World</em></h1>
        <p>A <a href="https://example.com">link</a> and <strong>bold</strong> text.</p>
        <ul><li>one</li><li>two</li></ul>
      </body></html>`);
    } else if (url.pathname === '/large') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(50_000));
    } else if (url.pathname === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
    } else if (url.pathname === '/redirect-to-self') {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/html` }).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
after(() => server.close());

const signal = new AbortController().signal;
/** Lets the local test server's loopback address through */
const allowOnlyLocalServer = (address: string) => address === '127.0.0.1';

test('loopback is refused by default, with no override', async () => {
  const fetcher = httpFetcher();
  await assert.rejects(
    () => fetcher.fetch({ url: `http://127.0.0.1:${port}/html` }, signal),
    (err: unknown) => err instanceof ServiceError && err.code === 'invalid_request',
  );
});

test('a private literal address is refused by default, with no network access needed to prove it', async () => {
  const fetcher = httpFetcher();
  await assert.rejects(() => fetcher.fetch({ url: 'http://10.1.2.3/' }, signal), (err: unknown) => err instanceof ServiceError && err.code === 'invalid_request');
});

test('a cloud metadata address is refused by default (it falls under link-local)', async () => {
  const fetcher = httpFetcher();
  await assert.rejects(() => fetcher.fetch({ url: 'http://169.254.169.254/latest/meta-data/' }, signal), (err: unknown) => err instanceof ServiceError);
});

test('an IPv4-mapped IPv6 loopback address is refused too', async () => {
  const fetcher = httpFetcher();
  await assert.rejects(() => fetcher.fetch({ url: 'http://[::ffff:127.0.0.1]/' }, signal), (err: unknown) => err instanceof ServiceError);
});

test('a hostname (not a literal address) connects through the pinned lookup, as real sites do', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer, resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] });
  const res = await fetcher.fetch({ url: `http://fetch-test.invalid:${port}/html` }, signal);
  assert.equal(res.status, 200);
  assert.equal(res.title, 'Fetch Test');
});

test('with the test server allowed, a normal fetch succeeds and converts HTML to Markdown', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer });
  const res = await fetcher.fetch({ url: `http://127.0.0.1:${port}/html` }, signal);
  assert.equal(res.status, 200);
  assert.equal(res.title, 'Fetch Test');
  assert.doesNotMatch(res.content, /skip me/); // <nav> is stripped
  assert.match(res.content, /# Hello \*World\*/);
  assert.match(res.content, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(res.content, /- one/);
  assert.equal(res.truncated, false);
});

test('format: text strips tags without Markdown syntax; format: html returns the raw markup', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer });
  const text = await fetcher.fetch({ url: `http://127.0.0.1:${port}/html`, format: 'text' }, signal);
  assert.doesNotMatch(text.content, /[*#[\]]/);
  assert.match(text.content, /Hello World/);

  const html = await fetcher.fetch({ url: `http://127.0.0.1:${port}/html`, format: 'html' }, signal);
  assert.match(html.content, /<h1>/);
});

test('maxChars truncates the converted content and sets truncated', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer });
  const res = await fetcher.fetch({ url: `http://127.0.0.1:${port}/html`, maxChars: 10 }, signal);
  assert.equal(res.content.length, 10);
  assert.equal(res.truncated, true);
});

test('maxBytes caps the raw download before it is even decoded', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer, maxBytes: 1000 });
  const res = await fetcher.fetch({ url: `http://127.0.0.1:${port}/large`, format: 'text' }, signal);
  assert.equal(res.truncated, true);
  assert.ok(res.content.length <= 1000);
});

test('a redirect to a private address is refused even though the first hop was allowed', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer });
  await assert.rejects(() => fetcher.fetch({ url: `http://127.0.0.1:${port}/redirect-to-metadata` }, signal), (err: unknown) => err instanceof ServiceError);
});

test('a redirect to another allowed address is followed, and the final url reflects it', async () => {
  const fetcher = httpFetcher({ isAddressAllowed: allowOnlyLocalServer });
  const res = await fetcher.fetch({ url: `http://127.0.0.1:${port}/redirect-to-self` }, signal);
  assert.equal(res.status, 200);
  assert.equal(res.url, `http://127.0.0.1:${port}/html`);
});

test('a DNS answer that resolves to a private address is refused, even for an innocuous-looking hostname', async () => {
  // Default validation of the resolved address, with a fake resolver
  const fetcher = httpFetcher({ resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] });
  await assert.rejects(() => fetcher.fetch({ url: 'http://evil.example.test/' }, signal), (err: unknown) => err instanceof ServiceError && err.code === 'invalid_request');
});

test('only http and https are fetched', async () => {
  const fetcher = httpFetcher();
  await assert.rejects(() => fetcher.fetch({ url: 'file:///etc/passwd' }, signal), (err: unknown) => err instanceof ServiceError);
});
