import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Cache, CacheEntry } from '../host.ts';

const MIGRATIONS = [
  // 1: one row per key, with its expiry and size
  `
  CREATE TABLE IF NOT EXISTS cache_entries (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    stored_at  TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cache_entries_stored ON cache_entries (stored_at);
  `,
];

/** Keeps its version in cache_schema_version, so it can share a database with migrateStore */
export function migrateCache(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS cache_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
  db.exec('INSERT OR IGNORE INTO cache_schema_version (id, version) VALUES (1, 0)');
  const from = (db.prepare('SELECT version FROM cache_schema_version WHERE id = 1').get() as { version: number }).version;
  if (from > MIGRATIONS.length) throw new Error(`cache schema is at ${from}, newer than this code (${MIGRATIONS.length})`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE cache_schema_version SET version = ? WHERE id = 1').run(v + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`cache migration ${v + 1} failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

function prep<Row = never>(db: DatabaseSync, sql: string) {
  const s = db.prepare(sql);
  return {
    get: (...params: SQLInputValue[]) => s.get(...params) as Row | undefined,
    all: (...params: SQLInputValue[]) => s.all(...params) as Row[],
    run: (...params: SQLInputValue[]) => s.run(...params),
  };
}

export interface SqliteCacheOptions {
  /** Past this many bytes the oldest entries go, default 64 MB */
  maxBytes?: number;
}

export function sqliteCache(db: DatabaseSync, { maxBytes = 64 * 1024 * 1024 }: SqliteCacheOptions = {}): Cache {
  const getRow = prep<{ value: string; stored_at: string; expires_at: string }>(db, 'SELECT value, stored_at, expires_at FROM cache_entries WHERE key = ?');
  const deleteRow = prep(db, 'DELETE FROM cache_entries WHERE key = ?');
  const putRow = prep(db, `
    INSERT INTO cache_entries (key, value, bytes, stored_at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, stored_at = excluded.stored_at, expires_at = excluded.expires_at
  `);
  const totalBytes = prep<{ total: number }>(db, 'SELECT coalesce(sum(bytes), 0) AS total FROM cache_entries');
  const oldest = prep<{ key: string; bytes: number }>(db, 'SELECT key, bytes FROM cache_entries ORDER BY stored_at ASC LIMIT ?');

  function evictIfOverCap(): void {
    let total = totalBytes.get()?.total ?? 0;
    if (total <= maxBytes) return;
    while (total > maxBytes) {
      const batch = oldest.all(50);
      if (batch.length === 0) break;
      for (const row of batch) {
        deleteRow.run(row.key);
        total -= row.bytes;
        if (total <= maxBytes) break;
      }
    }
  }

  return {
    get<T>(key: string): CacheEntry<T> | null {
      const row = getRow.get(key);
      if (!row) return null;
      if (row.expires_at <= new Date().toISOString()) {
        deleteRow.run(key);
        return null;
      }
      return { value: JSON.parse(row.value) as T, storedAt: row.stored_at };
    },

    put(key: string, value: unknown, ttlSeconds: number): void {
      const now = new Date();
      const json = JSON.stringify(value);
      putRow.run(key, json, Buffer.byteLength(json, 'utf8'), now.toISOString(), new Date(now.getTime() + ttlSeconds * 1000).toISOString());
      evictIfOverCap();
    },
  };
}
