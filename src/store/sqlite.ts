import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Area, Store } from '../host.ts';
import { fail } from '../http.ts';
import type { Change, ChangePage, DocMeta } from '../types.ts';

/* ---------- Schema ---------- */

const MIGRATIONS = [
  // 1: documents and the change feed
  `
  CREATE TABLE IF NOT EXISTS documents (
    account_id TEXT NOT NULL,
    area       TEXT NOT NULL CHECK (area IN ('config', 'secret', 'skill', 'memory')),
    kind       TEXT NOT NULL DEFAULT '',
    id         TEXT NOT NULL,
    rev        INTEGER NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    body       TEXT,
    PRIMARY KEY (account_id, area, kind, id)
  );

  -- Every list() and bytes() scopes by account and area; deleted is in the index too since both filter it out
  CREATE INDEX IF NOT EXISTS documents_scope ON documents (account_id, area, deleted);

  CREATE TABLE IF NOT EXISTS changes (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    area       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT '',
    id         TEXT NOT NULL,
    rev        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS changes_account_seq ON changes (account_id, seq);
  `,
];

/** Runs the pending migrations, counted in PRAGMA user_version */
export function migrateStore(db: DatabaseSync): void {
  const from = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (from > MIGRATIONS.length) throw new Error(`store schema is at ${from}, newer than this code (${MIGRATIONS.length})`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`store migration ${v + 1} failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

/* ---------- Helpers ---------- */

function prep<Row = never>(db: DatabaseSync, sql: string) {
  const s = db.prepare(sql);
  return {
    get: (...params: SQLInputValue[]) => s.get(...params) as Row | undefined,
    all: (...params: SQLInputValue[]) => s.all(...params) as Row[],
    run: (...params: SQLInputValue[]) => s.run(...params),
  };
}

/** Runs `fn` in one write transaction, joining an outer one if open */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** A null kind is stored as '' */
const normalizeKind = (kind: string | null): string => kind ?? '';
const denormalizeKind = (kind: string): string | null => (kind === '' ? null : kind);

interface DocRow {
  account_id: string;
  area: Area;
  kind: string;
  id: string;
  rev: number;
  size: number;
  updated_at: string;
  updated_by: string | null;
  deleted: number;
  body: string | null;
}

const toMeta = (row: DocRow): DocMeta => ({ id: row.id, rev: row.rev, size: row.size, updatedAt: row.updated_at, updatedBy: row.updated_by });

/* ---------- Secrets ---------- */

type SecretBody = { sealedBy: 'server'; value: string } | { sealedBy: 'client'; sealed: { alg: string; data: string; keyId?: string } };
/** On disk, a server-sealed secret holds `ciphertext` in place of `value` */
type SealedBody = { sealedBy: 'server'; ciphertext: string } | { sealedBy: 'client'; sealed: { alg: string; data: string; keyId?: string } };

function sealSecret(body: unknown, seal: (plain: string) => string): SealedBody {
  const b = body as SecretBody;
  if (!b || (b.sealedBy !== 'server' && b.sealedBy !== 'client')) throw fail('invalid_request', 'a secret needs sealedBy "server" or "client"');
  if (b.sealedBy === 'server') {
    if (typeof b.value !== 'string') throw fail('invalid_request', 'a server-sealed secret needs a string value');
    return { sealedBy: 'server', ciphertext: seal(b.value) };
  }
  if (!b.sealed || typeof b.sealed.alg !== 'string' || typeof b.sealed.data !== 'string') throw fail('invalid_request', 'a client-sealed secret needs { alg, data }');
  return { sealedBy: 'client', sealed: b.sealed };
}

function unsealSecret(persisted: SealedBody, unseal: (sealed: string) => string): SecretBody {
  return persisted.sealedBy === 'server' ? { sealedBy: 'server', value: unseal(persisted.ciphertext) } : persisted;
}

export interface SqliteStoreOptions {
  /** Seals a secret's plaintext value for storage */
  seal(plaintext: string): string;
  /** Opens a value this same `seal` produced */
  unseal(sealed: string): string;
}

/** A delete leaves a tombstone, so a revision never goes back or repeats */
export function sqliteStore(db: DatabaseSync, opts: SqliteStoreOptions): Store {
  const getRow = prep<DocRow>(db, 'SELECT * FROM documents WHERE account_id = ? AND area = ? AND kind = ? AND id = ?');
  const listRows = prep<DocRow>(db, 'SELECT * FROM documents WHERE account_id = ? AND area = ? AND deleted = 0 ORDER BY kind, id');
  const listRowsByKind = prep<DocRow>(db, 'SELECT * FROM documents WHERE account_id = ? AND area = ? AND kind = ? AND deleted = 0 ORDER BY id');
  const putRow = prep(db, `
    INSERT INTO documents (account_id, area, kind, id, rev, size, updated_at, updated_by, deleted, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT (account_id, area, kind, id) DO UPDATE SET
      rev = excluded.rev, size = excluded.size, updated_at = excluded.updated_at,
      updated_by = excluded.updated_by, deleted = 0, body = excluded.body
  `);
  const tombstoneRow = prep(db, `
    UPDATE documents SET rev = ?, size = 0, updated_at = ?, updated_by = ?, deleted = 1, body = NULL
    WHERE account_id = ? AND area = ? AND kind = ? AND id = ?
  `);
  const insertChange = prep(db, 'INSERT INTO changes (account_id, area, kind, id, rev, deleted, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const listChanges = prep<{ seq: number; area: Area; kind: string; id: string; rev: number; deleted: number; at: string }>(
    db, 'SELECT seq, area, kind, id, rev, deleted, at FROM changes WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?');
  const sumBytes = prep<{ total: number }>(db, 'SELECT coalesce(sum(size), 0) AS total FROM documents WHERE account_id = ? AND deleted = 0');

  /** `forList` returns only a secret's sealedBy */
  function toStoredDoc(row: DocRow, forList: boolean) {
    let body: unknown = null;
    if (!row.deleted && row.body != null) {
      const parsed = JSON.parse(row.body);
      if (row.area === 'secret') body = forList ? { sealedBy: (parsed as SealedBody).sealedBy } : unsealSecret(parsed, opts.unseal);
      else body = parsed;
    }
    return { ...toMeta(row), area: row.area, kind: denormalizeKind(row.kind), body, deleted: Boolean(row.deleted) };
  }

  return {
    get(p, area, kind, id) {
      const row = getRow.get(p.accountId, area, normalizeKind(kind), id);
      return row ? toStoredDoc(row, false) : null;
    },

    list(p, area, filter) {
      const rows = filter && filter.kind !== undefined
        ? listRowsByKind.all(p.accountId, area, normalizeKind(filter.kind))
        : listRows.all(p.accountId, area);
      return rows.map((r) => toStoredDoc(r, true));
    },

    put(p, area, kind, id, body, opts2) {
      const k = normalizeKind(kind);
      return transaction(db, () => {
        const current = getRow.get(p.accountId, area, k, id);
        if (opts2.ifRev === null) {
          // If-None-Match: *
          if (current && !current.deleted) throw fail('conflict', 'a document already exists at this id', { current: toMeta(current) });
        } else if (opts2.ifRev === undefined) {
          // No precondition
          if (current && !current.deleted) throw fail('precondition_required', 'send If-Match to replace an existing document');
        } else {
          // If-Match
          if (!current) throw fail('not_found', 'no such document');
          if (current.deleted || current.rev !== opts2.ifRev) throw fail('conflict', 'If-Match does not match the current revision', { current: toMeta(current) });
        }

        const persisted = area === 'secret' ? sealSecret(body, opts.seal) : body;
        const json = JSON.stringify(persisted);
        const size = Buffer.byteLength(json, 'utf8');
        const rev = (current?.rev ?? 0) + 1;
        const now = new Date().toISOString();
        putRow.run(p.accountId, area, k, id, rev, size, now, opts2.client, json);
        insertChange.run(p.accountId, area, k, id, rev, 0, now);
        return { id, rev, size, updatedAt: now, updatedBy: opts2.client, area, kind, body, deleted: false };
      });
    },

    delete(p, area, kind, id, opts2) {
      const k = normalizeKind(kind);
      transaction(db, () => {
        const current = getRow.get(p.accountId, area, k, id);
        if (!current || current.deleted) throw fail('not_found', 'no such document');
        if (opts2.ifRev === undefined || opts2.ifRev === null) throw fail('precondition_required', 'send If-Match to delete a document');
        if (current.rev !== opts2.ifRev) throw fail('conflict', 'If-Match does not match the current revision', { current: toMeta(current) });
        const rev = current.rev + 1;
        const now = new Date().toISOString();
        tombstoneRow.run(rev, now, opts2.client, p.accountId, area, k, id);
        insertChange.run(p.accountId, area, k, id, rev, 1, now);
      });
    },

    changes(p, since, limit): ChangePage {
      const rows = listChanges.all(p.accountId, since, limit + 1);
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return {
        changes: page.map((r): Change => ({ seq: r.seq, area: r.area, kind: denormalizeKind(r.kind), id: r.id, rev: r.rev, deleted: Boolean(r.deleted), at: r.at })),
        cursor: page.length ? page[page.length - 1].seq : since,
        more,
      };
    },

    bytes(p) {
      return sumBytes.get(p.accountId)?.total ?? 0;
    },
  };
}
