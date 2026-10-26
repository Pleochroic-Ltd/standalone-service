import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Principal } from '../src/host.ts';
import { migrateStore, sqliteStore } from '../src/store/sqlite.ts';

// A seal that visibly transforms its input
const seal = (plaintext: string) => `SEALED:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
const unseal = (sealed: string) => Buffer.from(sealed.slice('SEALED:'.length), 'base64').toString('utf8');

function freshStore() {
  const db = new DatabaseSync(':memory:');
  migrateStore(db);
  return { db, store: sqliteStore(db, { seal, unseal }) };
}

const alice: Principal = { accountId: 'alice', keyId: 'k1', scopes: [], client: 'test/1' };
const bob: Principal = { accountId: 'bob', keyId: 'k2', scopes: [], client: null };

test('put creates a document at rev 1, and get reads it back', () => {
  const { store } = freshStore();
  const doc = store.put(alice, 'config', 'provider', 'openai/x', { a: 1 }, { ifRev: undefined, client: 'alexandrite/1' });
  assert.equal(doc.rev, 1);
  assert.equal(doc.updatedBy, 'alexandrite/1');
  const got = store.get(alice, 'config', 'provider', 'openai/x');
  assert.ok(got);
  assert.deepEqual(got.body, { a: 1 });
  assert.equal(got.deleted, false);
});

test('a write to an existing document without If-Match is 428', () => {
  const { store } = freshStore();
  store.put(alice, 'config', 'provider', 'x', { a: 1 }, { ifRev: undefined, client: null });
  assert.throws(() => store.put(alice, 'config', 'provider', 'x', { a: 2 }, { ifRev: undefined, client: null }), (err: any) => err.code === 'precondition_required');
});

test('If-None-Match: * (ifRev null) on an existing document is 409, with the current meta', () => {
  const { store } = freshStore();
  const first = store.put(alice, 'config', 'provider', 'x', { a: 1 }, { ifRev: undefined, client: null });
  try {
    store.put(alice, 'config', 'provider', 'x', { a: 2 }, { ifRev: null, client: null });
    assert.fail('expected a conflict');
  } catch (err: any) {
    assert.equal(err.code, 'conflict');
    assert.equal(err.extra.current.rev, first.rev);
  }
});

test('a stale If-Match is 409 with the current meta; the right one succeeds and bumps rev', () => {
  const { store } = freshStore();
  const v1 = store.put(alice, 'config', 'provider', 'x', { a: 1 }, { ifRev: undefined, client: null });
  assert.throws(() => store.put(alice, 'config', 'provider', 'x', { a: 2 }, { ifRev: v1.rev + 1, client: null }), (err: any) => err.code === 'conflict' && err.extra.current.rev === v1.rev);
  const v2 = store.put(alice, 'config', 'provider', 'x', { a: 2 }, { ifRev: v1.rev, client: null });
  assert.equal(v2.rev, v1.rev + 1);
});

test('If-Match on a document that was never created is 404, not 409', () => {
  const { store } = freshStore();
  assert.throws(() => store.put(alice, 'config', 'provider', 'never', { a: 1 }, { ifRev: 1, client: null }), (err: any) => err.code === 'not_found');
});

test('delete needs a definite revision: no If-Match is 428, the wrong one is 409, deleting twice is 404', () => {
  const { store } = freshStore();
  const v1 = store.put(alice, 'memory', 'global', 'note', { title: 't', content: 'c', tags: [] }, { ifRev: undefined, client: null });
  assert.throws(() => store.delete(alice, 'memory', 'global', 'note', { ifRev: undefined, client: null }), (err: any) => err.code === 'precondition_required');
  assert.throws(() => store.delete(alice, 'memory', 'global', 'note', { ifRev: v1.rev + 1, client: null }), (err: any) => err.code === 'conflict');
  store.delete(alice, 'memory', 'global', 'note', { ifRev: v1.rev, client: null });
  assert.throws(() => store.delete(alice, 'memory', 'global', 'note', { ifRev: v1.rev, client: null }), (err: any) => err.code === 'not_found');
});

test('a deleted document disappears from get/list, but can be recreated — and revisions never go backwards', () => {
  const { store } = freshStore();
  const v1 = store.put(alice, 'skill', 'global', 's', { description: '', files: [] }, { ifRev: undefined, client: null });
  store.delete(alice, 'skill', 'global', 's', { ifRev: v1.rev, client: null });
  assert.equal(store.get(alice, 'skill', 'global', 's')?.deleted, true);
  assert.equal(store.list(alice, 'skill').length, 0);

  // Recreating with If-None-Match: * works
  const v2 = store.put(alice, 'skill', 'global', 's', { description: '', files: [] }, { ifRev: null, client: null });
  // and the revision keeps climbing
  assert.ok(v2.rev > v1.rev);
});

test('list leaves tombstones out; the change feed carries them with deleted: true', () => {
  const { store } = freshStore();
  const a = store.put(alice, 'memory', 'global', 'a', { title: 'A', content: '', tags: [] }, { ifRev: undefined, client: null });
  store.put(alice, 'memory', 'global', 'b', { title: 'B', content: '', tags: [] }, { ifRev: undefined, client: null });
  store.delete(alice, 'memory', 'global', 'a', { ifRev: a.rev, client: null });

  const listed = store.list(alice, 'memory');
  assert.deepEqual(listed.map((d) => d.id).sort(), ['b']);

  const page = store.changes(alice, 0, 10);
  assert.equal(page.changes.length, 3); // put a, put b, delete a
  assert.equal(page.changes[0].deleted, false);
  assert.equal(page.changes[2].id, 'a');
  assert.equal(page.changes[2].deleted, true);
  assert.equal(page.more, false);
});

test('changes() pages with cursor and more', () => {
  const { store } = freshStore();
  for (let i = 0; i < 5; i++) store.put(alice, 'memory', 'global', `n${i}`, { title: String(i), content: '', tags: [] }, { ifRev: undefined, client: null });

  const page1 = store.changes(alice, 0, 2);
  assert.equal(page1.changes.length, 2);
  assert.equal(page1.more, true);
  assert.equal(page1.changes[1].seq, page1.cursor);

  const page2 = store.changes(alice, page1.cursor, 2);
  assert.equal(page2.changes.length, 2);
  assert.equal(page2.changes[0].id, 'n2');

  const rest = store.changes(alice, page2.cursor, 10);
  assert.equal(rest.changes.length, 1);
  assert.equal(rest.more, false);
});

test('accounts are isolated: one account never sees or affects another\'s documents, bytes, or feed', () => {
  const { store } = freshStore();
  // Same (area, kind, id) in both accounts
  const aliceDoc = store.put(alice, 'config', 'provider', 'x', { a: 1 }, { ifRev: undefined, client: null });
  store.put(bob, 'config', 'provider', 'x', { a: 'different' }, { ifRev: undefined, client: null });

  assert.deepEqual(store.get(alice, 'config', 'provider', 'x')?.body, { a: 1 });
  assert.deepEqual(store.get(bob, 'config', 'provider', 'x')?.body, { a: 'different' });
  assert.equal(store.list(alice, 'config').length, 1);
  assert.equal(store.list(bob, 'config').length, 1);
  assert.equal(store.changes(bob, 0, 10).changes.length, 1);
  assert.notEqual(store.bytes(alice), 0);

  // Deleting alice's document leaves bob's
  store.delete(alice, 'config', 'provider', 'x', { ifRev: aliceDoc.rev, client: null });
  assert.equal(store.get(alice, 'config', 'provider', 'x')?.deleted, true);
  assert.deepEqual(store.get(bob, 'config', 'provider', 'x')?.body, { a: 'different' });
  assert.equal(store.list(bob, 'config').length, 1);
});

test('bytes() counts only live documents, never tombstones, and only this account\'s', () => {
  const { store } = freshStore();
  store.put(alice, 'memory', 'global', 'a', { title: 'hello', content: 'x'.repeat(100), tags: [] }, { ifRev: undefined, client: null });
  const b = store.put(alice, 'memory', 'global', 'b', { title: 'hello', content: 'x'.repeat(200), tags: [] }, { ifRev: undefined, client: null });
  store.put(bob, 'memory', 'global', 'z', { title: 'bob', content: '', tags: [] }, { ifRev: undefined, client: null });

  const beforeDelete = store.bytes(alice);
  assert.ok(beforeDelete > 0);
  store.delete(alice, 'memory', 'global', 'b', { ifRev: b.rev, client: null });
  assert.ok(store.bytes(alice) < beforeDelete);
  assert.notEqual(store.bytes(alice), store.bytes(bob));
});

test('a server-sealed secret is actually sealed at rest, and round-trips through get()', () => {
  const { db, store } = freshStore();
  store.put(alice, 'secret', null, 'OPENAI_API_KEY', { sealedBy: 'server', value: 'sk-super-secret-value' }, { ifRev: undefined, client: null });

  const raw = db.prepare("SELECT body FROM documents WHERE account_id = 'alice' AND area = 'secret' AND id = 'OPENAI_API_KEY'").get() as { body: string };
  assert.ok(!raw.body.includes('sk-super-secret-value'), 'the plaintext must never sit in the row as-is');

  const got = store.get(alice, 'secret', null, 'OPENAI_API_KEY');
  assert.deepEqual(got?.body, { sealedBy: 'server', value: 'sk-super-secret-value' });
});

test('listing secrets never exposes a value or ciphertext, only sealedBy', () => {
  const { store } = freshStore();
  store.put(alice, 'secret', null, 'A', { sealedBy: 'server', value: 'plain' }, { ifRev: undefined, client: null });
  store.put(alice, 'secret', null, 'B', { sealedBy: 'client', sealed: { alg: 'aes-256-gcm', data: 'opaque' } }, { ifRev: undefined, client: null });

  for (const doc of store.list(alice, 'secret')) {
    assert.deepEqual(Object.keys(doc.body as object), ['sealedBy']);
  }
});

test('a client-sealed secret is kept exactly as given, never opened', () => {
  const { store } = freshStore();
  const sealed = { alg: 'my-own-scheme', data: 'whatever-the-client-put-here', keyId: 'k1' };
  store.put(alice, 'secret', null, 'X', { sealedBy: 'client', sealed }, { ifRev: undefined, client: null });
  const got = store.get(alice, 'secret', null, 'X');
  assert.deepEqual(got?.body, { sealedBy: 'client', sealed });
});
