import type { IncomingMessage } from 'node:http';
import type { Host, Principal } from '../host.ts';
import { etag, fail, ifRev, readJson, route, send, type Route } from '../http.ts';
import { findSecretLike, MAX, NAME } from '../limits.ts';
import { CONFIG_KINDS, type ConfigKind, type ConfigList, type PutConfig, type PutSecret, type SecretMeta } from '../types.ts';

const configKind = (raw: string): ConfigKind => {
  if (!CONFIG_KINDS.includes(raw as ConfigKind)) throw fail('invalid_request', `kind must be one of ${CONFIG_KINDS.join(', ')}`);
  return raw as ConfigKind;
};
const configId = (raw: string): string => {
  if (!NAME.configId.test(raw)) throw fail('invalid_request', 'not a valid config id');
  return raw;
};
const secretName = (raw: string): string => {
  if (!NAME.secret.test(raw)) throw fail('invalid_request', 'a secret name is ^[A-Z][A-Z0-9_]{0,63}$');
  return raw;
};

/** DELETE always needs a definite revision */
function deleteRev(req: IncomingMessage): number {
  const rev = ifRev(req);
  if (typeof rev !== 'number') throw fail('precondition_required', 'send If-Match to delete a document');
  return rev;
}

/** Writes through the store, admitting and recording `sync` for the bytes the account's storage grows by */
async function meteredPut(host: Host, p: Principal, area: 'config' | 'secret', kind: string | null, id: string, body: unknown, ifMatchRev: number | null | undefined, predictedSize: number) {
  const existing = host.store.get(p, area, kind, id);
  const before = existing && !existing.deleted ? existing.size : 0;
  const admission = await host.admit(p, 'sync', Math.max(0, predictedSize - before));
  try {
    const doc = host.store.put(p, area, kind, id, body, { ifRev: ifMatchRev, client: p.client });
    host.record(p, 'sync', Math.max(0, doc.size - before), { admission, ok: true });
    return doc;
  } catch (err) {
    host.record(p, 'sync', 0, { admission, ok: false, note: (err as Error).message });
    throw err;
  }
}

export const syncRoutes = (host: Host): Route[] => [
  route('GET', '/config', 'sync', ({ res, principal, query }) => {
    const kind = query.get('kind');
    if (kind !== null) configKind(kind);
    const docs = host.store.list(principal, 'config', kind !== null ? { kind } : undefined);
    const body: ConfigList = { documents: docs.map((d) => ({ id: d.id, kind: d.kind as ConfigKind, rev: d.rev, size: d.size, updatedAt: d.updatedAt, updatedBy: d.updatedBy })) };
    send(res, 200, body);
  }),

  route('GET', '/config/:kind/:id', 'sync', ({ res, principal, params }) => {
    const kind = configKind(params.kind);
    const id = configId(params.id);
    const doc = host.store.get(principal, 'config', kind, id);
    if (!doc || doc.deleted) throw fail('not_found', 'no such config document');
    send(res, 200, { id: doc.id, kind, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, data: doc.body }, etag(doc.rev));
  }),

  route('PUT', '/config/:kind/:id', 'sync', async ({ req, res, principal, params }) => {
    const kind = configKind(params.kind);
    const id = configId(params.id);
    const ifMatchRev = ifRev(req);
    const put = await readJson<PutConfig>(req, MAX.configBytes);
    if (!put.data || typeof put.data !== 'object' || Array.isArray(put.data)) throw fail('invalid_request', '`data` must be a JSON object');
    const hit = findSecretLike(put.data);
    if (hit) throw fail('invalid_request', `data${hit.slice(1)} looks like a secret; keep it in /secrets and refer to it as \${secret:NAME}`);
    const size = Buffer.byteLength(JSON.stringify(put.data), 'utf8');
    if (size > MAX.configBytes) throw fail('too_large', `data is over ${MAX.configBytes} bytes`, { limit: MAX.configBytes });
    const doc = await meteredPut(host, principal, 'config', kind, id, put.data, ifMatchRev, size);
    send(res, 200, { id: doc.id, kind, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }, etag(doc.rev));
  }),

  route('DELETE', '/config/:kind/:id', 'sync', ({ req, res, principal, params }) => {
    const kind = configKind(params.kind);
    const id = configId(params.id);
    host.store.delete(principal, 'config', kind, id, { ifRev: deleteRev(req), client: principal.client });
    send(res, 200, { ok: true });
  }),

  route('GET', '/secrets', 'sync', ({ res, principal }) => {
    const docs = host.store.list(principal, 'secret');
    const metas: SecretMeta[] = docs.map((d) => ({ id: d.id, rev: d.rev, size: d.size, updatedAt: d.updatedAt, updatedBy: d.updatedBy, sealedBy: (d.body as { sealedBy: 'server' | 'client' }).sealedBy }));
    send(res, 200, metas);
  }),

  route('GET', '/secrets/:name', 'secrets:read', ({ res, principal, params }) => {
    const name = secretName(params.name);
    const doc = host.store.get(principal, 'secret', null, name);
    if (!doc || doc.deleted) throw fail('not_found', 'no such secret');
    const body = doc.body as { sealedBy: 'server'; value: string } | { sealedBy: 'client'; sealed: { alg: string; data: string; keyId?: string } };
    send(res, 200, { id: doc.id, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, ...body }, etag(doc.rev));
  }),

  // Answers meta only, since this route needs no secrets:read
  route('PUT', '/secrets/:name', 'sync', async ({ req, res, principal, params }) => {
    const name = secretName(params.name);
    const ifMatchRev = ifRev(req);
    const put = await readJson<PutSecret>(req, MAX.secretBytes);
    let body: { sealedBy: 'server'; value: string } | { sealedBy: 'client'; sealed: { alg: string; data: string; keyId?: string } };
    if ('value' in put) {
      if (typeof put.value !== 'string' || !put.value) throw fail('invalid_request', '`value` must be a non-empty string');
      if (Buffer.byteLength(put.value, 'utf8') > MAX.secretBytes) throw fail('too_large', `value is over ${MAX.secretBytes} bytes`, { limit: MAX.secretBytes });
      body = { sealedBy: 'server', value: put.value };
    } else if ('sealed' in put && put.sealed && typeof put.sealed.alg === 'string' && typeof put.sealed.data === 'string') {
      body = { sealedBy: 'client', sealed: put.sealed };
    } else {
      throw fail('invalid_request', 'send { value } or { sealed: { alg, data } }');
    }
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const doc = await meteredPut(host, principal, 'secret', null, name, body, ifMatchRev, size);
    const meta: SecretMeta = { id: doc.id, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, sealedBy: body.sealedBy };
    send(res, 200, meta, etag(doc.rev));
  }),

  route('DELETE', '/secrets/:name', 'sync', ({ req, res, principal, params }) => {
    const name = secretName(params.name);
    host.store.delete(principal, 'secret', null, name, { ifRev: deleteRev(req), client: principal.client });
    send(res, 200, { ok: true });
  }),

  route('GET', '/sync/changes', 'sync', ({ res, principal, query }) => {
    const since = Number(query.get('since') ?? '0');
    if (!Number.isInteger(since) || since < 0) throw fail('invalid_request', 'since must be a non-negative integer');
    const rawLimit = query.get('limit');
    const limit = rawLimit === null ? 200 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) throw fail('invalid_request', 'limit must be a positive integer');
    send(res, 200, host.store.changes(principal, since, Math.min(limit, 1000)));
  }),
];
