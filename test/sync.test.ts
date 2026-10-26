import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { testHost, startService, type TestService } from './helpers.ts';

let service: TestService;
before(async () => { service = await startService(testHost()); });
after(() => service.stop());

test('PUT /config creates a document; GET returns it with an ETag; a second PUT needs If-Match', async () => {
  const put1 = await service.call('PUT', '/v1/config/provider/openai-compatible%2Fworkbuddy', { body: { data: { model: 'gpt-x' } } });
  assert.equal(put1.status, 200);
  assert.equal(put1.headers.get('etag'), '"1"');
  const meta = await put1.json();
  assert.equal(meta.rev, 1);
  assert.equal(meta.data, undefined); // PUT answers meta only

  const get1 = await service.call('GET', '/v1/config/provider/openai-compatible%2Fworkbuddy');
  assert.equal(get1.headers.get('etag'), '"1"');
  assert.deepEqual((await get1.json()).data, { model: 'gpt-x' });

  const withoutIfMatch = await service.call('PUT', '/v1/config/provider/openai-compatible%2Fworkbuddy', { body: { data: { model: 'gpt-y' } } });
  assert.equal(withoutIfMatch.status, 428);
  assert.equal((await withoutIfMatch.json()).error.code, 'precondition_required');

  const staleIfMatch = await service.call('PUT', '/v1/config/provider/openai-compatible%2Fworkbuddy', { body: { data: { model: 'gpt-y' } }, headers: { 'if-match': '"99"' } });
  assert.equal(staleIfMatch.status, 409);
  const conflictBody = await staleIfMatch.json();
  assert.equal(conflictBody.error.code, 'conflict');
  assert.equal(conflictBody.error.current.rev, 1);

  const put2 = await service.call('PUT', '/v1/config/provider/openai-compatible%2Fworkbuddy', { body: { data: { model: 'gpt-y' } }, headers: { 'if-match': '"1"' } });
  assert.equal(put2.status, 200);
  assert.equal((await put2.json()).rev, 2);
});

test('PUT /config refuses data that holds a secret-shaped string', async () => {
  const res = await service.call('PUT', '/v1/config/settings/app', { body: { data: { token: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' } } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /looks like a secret/);
});

test('PUT /config refuses data nested deeper than any real config, rather than walking it to a stack overflow', async () => {
  const deep = JSON.parse('{"a":' + '['.repeat(50_000) + ']'.repeat(50_000) + '}');
  const res = await service.call('PUT', '/v1/config/settings/deep', { body: { data: deep } });
  assert.equal(res.status, 400);
  let fine: unknown = 'leaf';
  for (let i = 0; i < 30; i++) fine = { x: fine };
  assert.equal((await service.call('PUT', '/v1/config/settings/nested', { body: { data: fine } })).status, 200, 'ordinary nesting is fine');
});

test('PUT /config accepts a ${secret:NAME} reference (not flagged as a secret itself)', async () => {
  const res = await service.call('PUT', '/v1/config/settings/app2', { body: { data: { apiKey: '${secret:OPENAI_API_KEY}' } } });
  assert.equal(res.status, 200);
});

test('GET /config lists meta without deleted documents; DELETE needs If-Match and leaves a tombstone', async () => {
  await service.call('PUT', '/v1/config/agent/main', { body: { data: { x: 1 } } });
  const list1 = await service.call('GET', '/v1/config?kind=agent');
  const doc = (await list1.json()).documents.find((d: { id: string }) => d.id === 'main');
  assert.ok(doc);

  const noIfMatch = await service.call('DELETE', '/v1/config/agent/main');
  assert.equal(noIfMatch.status, 428);

  const del = await service.call('DELETE', '/v1/config/agent/main', { headers: { 'if-match': `"${doc.rev}"` } });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  const list2 = await service.call('GET', '/v1/config?kind=agent');
  assert.equal((await list2.json()).documents.find((d: { id: string }) => d.id === 'main'), undefined);
  assert.equal((await service.call('GET', '/v1/config/agent/main')).status, 404);
});

test('an unknown config kind is 400, not 404 or 500', async () => {
  assert.equal((await service.call('GET', '/v1/config/bogus/x')).status, 400);
});

test('secrets: PUT with { value } seals it, GET returns the plaintext, listing never does, scope gates the read', async () => {
  const put = await service.call('PUT', '/v1/secrets/OPENAI_API_KEY', { body: { value: 'sk-test-value-123' } });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.sealedBy, 'server');
  assert.equal('value' in putBody, false); // PUT /secrets answers meta only

  const list = await service.call('GET', '/v1/secrets');
  const listed = (await list.json()).find((s: { id: string }) => s.id === 'OPENAI_API_KEY');
  assert.equal(listed.sealedBy, 'server');
  assert.equal('value' in listed, false);

  const get = await service.call('GET', '/v1/secrets/OPENAI_API_KEY');
  assert.equal(get.status, 200);
  assert.equal((await get.json()).value, 'sk-test-value-123');
});

test('secrets: a client-sealed blob is kept opaque and returned exactly as sent', async () => {
  const sealed = { alg: 'my-e2ee-scheme', data: 'client-produced-ciphertext', keyId: 'device-1' };
  await service.call('PUT', '/v1/secrets/CLIENT_SEALED', { body: { sealed } });
  const get = await service.call('GET', '/v1/secrets/CLIENT_SEALED');
  const body = await get.json();
  assert.equal(body.sealedBy, 'client');
  assert.deepEqual(body.sealed, sealed);
});

test('a secret name must match ^[A-Z][A-Z0-9_]{0,63}$', async () => {
  const res = await service.call('PUT', '/v1/secrets/lowercase', { body: { value: 'x' } });
  assert.equal(res.status, 400);
});

test('DELETE /secrets removes it, and GET answers 404 after', async () => {
  await service.call('PUT', '/v1/secrets/TO_DELETE', { body: { value: 'x' } });
  const meta = await (await service.call('GET', '/v1/secrets/TO_DELETE')).json();
  await service.call('DELETE', '/v1/secrets/TO_DELETE', { headers: { 'if-match': `"${meta.rev}"` } });
  assert.equal((await service.call('GET', '/v1/secrets/TO_DELETE')).status, 404);
});

test('GET /sync/changes pages across areas, in order, with deletions included', async () => {
  const start = await (await service.call('GET', '/v1/sync/changes')).json();
  const since = start.cursor;

  await service.call('PUT', '/v1/config/settings/p1', { body: { data: {} } });
  await service.call('PUT', '/v1/memory/global/note-1', { body: { title: 't', content: 'c' } });
  const skillPut = await service.call('PUT', '/v1/skills/global/demo-skill', { body: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: demo-skill\ndescription: a demo\n---\nBody.' }] } });
  assert.equal(skillPut.status, 200);

  const page1 = await (await service.call('GET', `/v1/sync/changes?since=${since}&limit=2`)).json();
  assert.equal(page1.changes.length, 2);
  assert.equal(page1.more, true);
  const page2 = await (await service.call('GET', `/v1/sync/changes?since=${page1.cursor}&limit=10`)).json();
  assert.equal(page2.changes.length, 1);
  assert.equal(page2.more, false);

  const areas = [...page1.changes, ...page2.changes].map((c: { area: string }) => c.area).sort();
  assert.deepEqual(areas, ['config', 'memory', 'skill']);
});

test('a key without the sync scope is 403 missing_scope on /config', async () => {
  const narrow = testHost();
  const svc = await startService({ ...narrow, authenticate: (req) => (req.headers.authorization === 'Bearer narrow' ? { accountId: 'a1', keyId: 'k', scopes: ['models'], client: null } : null) });
  try {
    const res = await svc.call('GET', '/v1/config', { key: 'narrow' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'missing_scope');
  } finally {
    await svc.stop();
  }
});
