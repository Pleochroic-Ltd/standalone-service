import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createService } from '../src/index.ts';
import type { Host, Principal } from '../src/host.ts';
import { migrateStore, sqliteStore } from '../src/store/sqlite.ts';
import { SCOPES, SERVICE_IDS } from '../src/types.ts';

const owner: Principal = { accountId: 'a1', keyId: 'k1', scopes: [...SCOPES], client: null };
const modelsOnly: Principal = { ...owner, scopes: ['models'] };

const db = new DatabaseSync(':memory:');
migrateStore(db);

const host: Host = {
  authenticate: (req) => (req.headers.authorization === 'Bearer good' ? owner : req.headers.authorization === 'Bearer narrow' ? modelsOnly : null),
  status: (p) => ({
    service: { name: 'test', version: '0', apiVersion: 1 },
    account: { id: p.accountId, name: null, plan: { id: 'intermodal', name: 'Intermodal' } },
    scopes: p.scopes, credits: { balanceMicros: 0 },
    services: Object.fromEntries(SERVICE_IDS.map((id) => [id, { enabled: true, quota: null, overage: 'stop', priceMicros: null }])) as never,
  }),
  admit: () => ({ billed: false }),
  record: () => {},
  store: sqliteStore(db, { seal: (s) => s, unseal: (s) => s }),
  graphs: {} as never,
};

/** Lattice and the headless browser, whose routes still answer 501 */
const STILL_501 = ['/browser', '/graphs', '/embeddings', '/lattice'];

let server: Server;
let base: string;
before(async () => {
  const service = createService(host);
  server = createServer(async (req, res) => {
    if (await service.handle(req, res)) return;
    res.writeHead(418).end('not the service');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const call = (method: string, path: string, key = 'good') =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });

test('paths that are not the service are left to the server', async () => {
  for (const path of ['/v1/chat/completions', '/v1/models', '/service', '/v2/service', '/v1/config/agent/x/y/z/w']) {
    assert.equal((await call('POST', path)).status, 418, path);
  }
});

test('GET /v1/service answers the host status', async () => {
  const r = await call('GET', '/v1/service');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.account.plan.id, 'intermodal');
  assert.deepEqual(Object.keys(body.services).sort(), [...SERVICE_IDS].sort());
});

test('no key or a bad one is 401 in the error shape', async () => {
  const r = await call('GET', '/v1/service', 'bad');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
});

test('a key without the route’s scope is 403 missing_scope', async () => {
  const r = await call('POST', '/v1/search', 'narrow');
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error.code, 'missing_scope');
  assert.equal(body.error.scope, 'tools');
});

test('a known path with the wrong method is 400', async () => {
  assert.equal((await call('PUT', '/v1/search')).status, 400);
});

test('Lattice and the browser are routed, and not written yet', async () => {
  const service = createService(host);
  for (const r of service.routes.filter((r) => STILL_501.some((prefix) => r.path.startsWith(prefix)))) {
    const path = '/v1' + r.path.replace(/:(\w+)/g, (_, name) => (name === 'scope' ? 'global' : name === 'kind' ? 'agent' : 'x'));
    const res = await call(r.method, path);
    assert.equal(res.status, 501, `${r.method} ${path}`);
    assert.equal((await res.json()).error.code, 'not_implemented');
  }
});

test('every other endpoint is routed (reaches its handler, past auth and scope checks)', async () => {
  const service = createService(host);
  for (const r of service.routes.filter((r) => r.path !== '/service' && !STILL_501.some((prefix) => r.path.startsWith(prefix)))) {
    const path = '/v1' + r.path.replace(/:(\w+)/g, (_, name) => (name === 'scope' ? 'global' : name === 'kind' ? 'agent' : 'x'));
    const res = await call(r.method, path);
    assert.notEqual(res.status, 418, `${r.method} ${path} never reached the service`);
    assert.notEqual(res.status, 501, `${r.method} ${path} should be implemented`);
  }
});

test('ids with slashes travel percent-encoded as one segment', async () => {
  const res = await call('GET', `/v1/config/provider/${encodeURIComponent('openai-compatible/workbuddy')}`);
  assert.equal(res.status, 404); // routed and decoded, with nothing stored yet
});
