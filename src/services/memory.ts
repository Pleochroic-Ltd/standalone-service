import type { IncomingMessage } from 'node:http';
import type { Host, Principal } from '../host.ts';
import { etag, fail, ifRev, readJson, route, send, type Route } from '../http.ts';
import { MAX, NAME } from '../limits.ts';
import type { MemoryMeta, PutMemory, Scoped } from '../types.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const scope = (raw: string): Scoped => {
  if (!NAME.scope.test(raw)) throw fail('invalid_request', 'scope is "global", "agent:<id>" or "project:<hash>"');
  return raw as Scoped;
};

/** Lower-cased words of two or more letters or digits */
const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9À-￿]{2,}/gi) ?? [];

/** Each query word scores 3 per hit in the title and 1 per hit in the body */
function relevance(query: string, title: string, content: string): number {
  const q = words(query);
  if (q.length === 0) return 0;
  const inTitle = words(title);
  const inContent = words(content);
  let score = 0;
  for (const w of q) {
    score += inTitle.filter((t) => t === w).length * 3;
    score += inContent.filter((t) => t === w).length;
  }
  return score;
}

/** DELETE always needs a definite revision */
function deleteRev(req: IncomingMessage): number {
  const rev = ifRev(req);
  if (typeof rev !== 'number') throw fail('precondition_required', 'send If-Match to delete a note');
  return rev;
}

/** Admits and records `sync` for the bytes this write grows the account's storage by */
async function meteredPut(host: Host, p: Principal, scopeValue: string, id: string, body: { title: string; content: string; tags: string[] }, ifMatchRev: number | null | undefined) {
  const existing = host.store.get(p, 'memory', scopeValue, id);
  const before = existing && !existing.deleted ? existing.size : 0;
  const predicted = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const admission = await host.admit(p, 'sync', Math.max(0, predicted - before));
  try {
    const doc = host.store.put(p, 'memory', scopeValue, id, body, { ifRev: ifMatchRev, client: p.client });
    host.record(p, 'sync', Math.max(0, doc.size - before), { admission, ok: true });
    return doc;
  } catch (err) {
    host.record(p, 'sync', 0, { admission, ok: false, note: (err as Error).message });
    throw err;
  }
}

export const memoryRoutes = (host: Host): Route[] => [
  route('GET', '/memory', 'sync', ({ res, principal, query }) => {
    const scopeFilter = query.get('scope');
    if (scopeFilter !== null) scope(scopeFilter);
    const tag = query.get('tag');
    const q = query.get('q');
    const rawLimit = query.get('limit');
    const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) throw fail('invalid_request', 'limit must be a positive integer');

    let docs = host.store.list(principal, 'memory', scopeFilter !== null ? { kind: scopeFilter } : undefined);
    if (tag) docs = docs.filter((d) => (d.body as { tags: string[] }).tags.includes(tag));

    let ranked: { meta: MemoryMeta; score: number }[];
    if (q) {
      ranked = docs
        .map((d) => {
          const body = d.body as { title: string; content: string; tags: string[] };
          return { meta: { id: d.id, scope: d.kind as Scoped, title: body.title, tags: body.tags, rev: d.rev, size: d.size, updatedAt: d.updatedAt, updatedBy: d.updatedBy }, score: relevance(q, body.title, body.content) };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || b.meta.updatedAt.localeCompare(a.meta.updatedAt));
    } else {
      ranked = docs
        .map((d) => {
          const body = d.body as { title: string; content: string; tags: string[] };
          return { meta: { id: d.id, scope: d.kind as Scoped, title: body.title, tags: body.tags, rev: d.rev, size: d.size, updatedAt: d.updatedAt, updatedBy: d.updatedBy }, score: 0 };
        })
        .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt));
    }
    send(res, 200, ranked.slice(0, Math.min(limit, MAX_LIMIT)).map((r) => r.meta));
  }),

  route('GET', '/memory/:scope/:id', 'sync', ({ res, principal, params }) => {
    const s = scope(params.scope);
    const doc = host.store.get(principal, 'memory', s, params.id);
    if (!doc || doc.deleted) throw fail('not_found', 'no such note');
    const body = doc.body as { title: string; content: string; tags: string[] };
    send(res, 200, { id: doc.id, scope: s, title: body.title, content: body.content, tags: body.tags, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }, etag(doc.rev));
  }),

  route('PUT', '/memory/:scope/:id', 'sync', async ({ req, res, principal, params }) => {
    const s = scope(params.scope);
    const ifMatchRev = ifRev(req);
    const put = await readJson<PutMemory>(req, MAX.memoryBytes);
    if (typeof put.title !== 'string' || !put.title.trim()) throw fail('invalid_request', '`title` must be a non-empty string');
    if (typeof put.content !== 'string') throw fail('invalid_request', '`content` must be a string');
    const tags = put.tags === undefined ? [] : put.tags;
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw fail('invalid_request', '`tags` must be an array of strings');
    const body = { title: put.title, content: put.content, tags: [...new Set(tags)] };
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > MAX.memoryBytes) throw fail('too_large', `a note is at most ${MAX.memoryBytes} bytes`, { limit: MAX.memoryBytes });
    const doc = await meteredPut(host, principal, s, params.id, body, ifMatchRev);
    const meta: MemoryMeta = { id: doc.id, scope: s, title: body.title, tags: body.tags, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
    send(res, 200, meta, etag(doc.rev));
  }),

  route('DELETE', '/memory/:scope/:id', 'sync', ({ req, res, principal, params }) => {
    const s = scope(params.scope);
    host.store.delete(principal, 'memory', s, params.id, { ifRev: deleteRev(req), client: principal.client });
    send(res, 200, { ok: true });
  }),
];
