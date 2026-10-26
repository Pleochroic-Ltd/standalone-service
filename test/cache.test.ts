import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateCache, sqliteCache } from '../src/store/cache.ts';

function fresh(maxBytes?: number) {
  const db = new DatabaseSync(':memory:');
  migrateCache(db);
  return sqliteCache(db, { maxBytes });
}

test('a miss is null; a put is readable back with its value and storedAt', () => {
  const cache = fresh();
  assert.equal(cache.get('nope'), null);
  cache.put('k', { results: [1, 2, 3] }, 60);
  const hit = cache.get<{ results: number[] }>('k');
  assert.ok(hit);
  assert.deepEqual(hit.value, { results: [1, 2, 3] });
  assert.ok(hit.storedAt);
  assert.ok(!Number.isNaN(Date.parse(hit.storedAt)));
});

test('an expired entry reads back as a miss, and is gone for good after', () => {
  const cache = fresh();
  cache.put('k', 'v', -1); // already in the past
  assert.equal(cache.get('k'), null);
  assert.equal(cache.get('k'), null);
});

test('a second put to the same key replaces it, TTL and all', () => {
  const cache = fresh();
  cache.put('k', 'first', 60);
  cache.put('k', 'second', -1); // replaced with something already expired
  assert.equal(cache.get('k'), null);
});

test('migrateCache does not touch PRAGMA user_version (safe to share a connection with src/store/sqlite.ts)', () => {
  const db = new DatabaseSync(':memory:');
  migrateCache(db);
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(userVersion, 0);
  const row = db.prepare('SELECT version FROM cache_schema_version WHERE id = 1').get() as { version: number };
  assert.equal(row.version, 1);
});

test('once the cache passes its byte cap, the oldest entries are evicted first', async () => {
  const cache = fresh(300); // small enough that a handful of entries overflow it
  const value = 'x'.repeat(50);
  for (let i = 0; i < 10; i++) {
    cache.put(`k${i}`, value, 3600);
    await new Promise((r) => setTimeout(r, 2)); // distinct storedAt per entry
  }
  assert.equal(cache.get('k0'), null); // the oldest went first
  assert.equal(cache.get('k1'), null);
  assert.ok(cache.get('k9')); // the newest survived
});
