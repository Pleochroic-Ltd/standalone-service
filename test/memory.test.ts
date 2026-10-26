import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { testHost, startService, type TestService } from './helpers.ts';

let service: TestService;
before(async () => { service = await startService(testHost()); });
after(() => service.stop());

test('PUT creates a note; GET returns the full note; listing returns meta only', async () => {
  const put = await service.call('PUT', '/v1/memory/global/n1', { body: { title: 'Grocery list', content: 'Milk, eggs, bread', tags: ['errand'] } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).content, undefined); // PUT answers meta only

  const get = await service.call('GET', '/v1/memory/global/n1');
  const doc = await get.json();
  assert.equal(doc.title, 'Grocery list');
  assert.equal(doc.content, 'Milk, eggs, bread');

  const list = await (await service.call('GET', '/v1/memory?scope=global')).json();
  const meta = list.find((m: { id: string }) => m.id === 'n1');
  assert.ok(meta);
  assert.equal(meta.content, undefined);
});

test('without q, notes list newest-first', async () => {
  await service.call('PUT', '/v1/memory/global/old', { body: { title: 'Old note', content: 'first' } });
  await new Promise((r) => setTimeout(r, 5));
  await service.call('PUT', '/v1/memory/global/new', { body: { title: 'New note', content: 'second' } });
  const list = await (await service.call('GET', '/v1/memory?scope=global')).json();
  const ids = list.map((m: { id: string }) => m.id);
  assert.ok(ids.indexOf('new') < ids.indexOf('old'));
});

test('q ranks by how well title and content match, title counting for more', async () => {
  await service.call('PUT', '/v1/memory/global/about-rust', { body: { title: 'Rust programming notes', content: 'ownership, borrowing' } });
  await service.call('PUT', '/v1/memory/global/mentions-rust', { body: { title: 'Weekend plans', content: 'mentions rust once in passing' } });
  await service.call('PUT', '/v1/memory/global/unrelated', { body: { title: 'Grocery run', content: 'milk and eggs' } });

  const list = await (await service.call('GET', '/v1/memory?scope=global&q=rust')).json();
  const ids = list.map((m: { id: string }) => m.id);
  assert.ok(ids.includes('about-rust'));
  assert.ok(ids.includes('mentions-rust'));
  assert.equal(ids.includes('unrelated'), false); // no match at all is left out
  assert.ok(ids.indexOf('about-rust') < ids.indexOf('mentions-rust')); // title hit outranks a body-only hit
});

test('tag filters the list', async () => {
  await service.call('PUT', '/v1/memory/global/tagged', { body: { title: 'Tagged', content: 'x', tags: ['work', 'urgent'] } });
  await service.call('PUT', '/v1/memory/global/untagged', { body: { title: 'Untagged', content: 'x' } });
  const list = await (await service.call('GET', '/v1/memory?scope=global&tag=urgent')).json();
  assert.deepEqual(list.map((m: { id: string }) => m.id), ['tagged']);
});

test('limit caps how many come back', async () => {
  const list = await (await service.call('GET', '/v1/memory?scope=global&limit=1')).json();
  assert.equal(list.length, 1);
});

test('a note over 64 KiB is refused', async () => {
  const res = await service.call('PUT', '/v1/memory/global/huge', { body: { title: 't', content: 'x'.repeat(70_000) } });
  assert.equal(res.status, 413);
});

test('DELETE needs If-Match', async () => {
  await service.call('PUT', '/v1/memory/global/del-me', { body: { title: 't', content: 'c' } });
  const doc = await (await service.call('GET', '/v1/memory/global/del-me')).json();
  assert.equal((await service.call('DELETE', '/v1/memory/global/del-me')).status, 428);
  const del = await service.call('DELETE', '/v1/memory/global/del-me', { headers: { 'if-match': `"${doc.rev}"` } });
  assert.equal(del.status, 200);
  assert.equal((await service.call('GET', '/v1/memory/global/del-me')).status, 404);
});
