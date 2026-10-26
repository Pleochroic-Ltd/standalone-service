import type { IncomingMessage } from 'node:http';
import type { Host, Principal } from '../host.ts';
import { etag, fail, ifRev, readJson, route, send, type Route } from '../http.ts';
import { MAX, NAME } from '../limits.ts';
import type { PutSkill, Scoped, SkillFile, SkillMeta } from '../types.ts';

const scope = (raw: string): Scoped => {
  if (!NAME.scope.test(raw)) throw fail('invalid_request', 'scope is "global", "agent:<id>" or "project:<hash>"');
  return raw as Scoped;
};
const skillName = (raw: string): string => {
  if (!NAME.skill.test(raw)) throw fail('invalid_request', 'a skill name is lowercase words separated by "-"');
  return raw;
};

/** The `key: value` lines of SKILL.md's front matter */
function frontMatter(md: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

const fileBytes = (f: SkillFile): number => (f.encoding === 'base64' ? Buffer.from(f.content, 'base64').length : Buffer.byteLength(f.content, 'utf8'));

/** Relative, with no empty, "." or ".." segments */
function relativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function checkSkill(name: string, files: PutSkill['files']): string {
  if (!Array.isArray(files) || files.length === 0) throw fail('invalid_request', '`files` must be a non-empty array');
  if (files.length > MAX.skillFiles) throw fail('invalid_request', `a skill is at most ${MAX.skillFiles} files`);
  let total = 0;
  const seen = new Set<string>();
  const md = files.find((f) => f.path === 'SKILL.md');
  if (!md) throw fail('invalid_request', 'a skill needs a SKILL.md at its root');
  for (const f of files) {
    if (typeof f.path !== 'string' || !relativePath(f.path)) throw fail('invalid_request', `bad path: ${f.path}`);
    if (f.encoding !== 'utf8' && f.encoding !== 'base64') throw fail('invalid_request', `${f.path}: encoding must be utf8 or base64`);
    if (typeof f.content !== 'string') throw fail('invalid_request', `${f.path}: content must be a string`);
    if (seen.has(f.path)) throw fail('invalid_request', `${f.path} is listed twice`);
    seen.add(f.path);
    total += fileBytes(f);
  }
  if (total > MAX.skillBytes) throw fail('too_large', `a skill folder is at most ${MAX.skillBytes} bytes`, { limit: MAX.skillBytes });
  const mdBytes = fileBytes(md);
  if (mdBytes > MAX.skillMdBytes) throw fail('too_large', `SKILL.md is at most ${MAX.skillMdBytes} bytes`, { limit: MAX.skillMdBytes });
  const text = md.encoding === 'base64' ? Buffer.from(md.content, 'base64').toString('utf8') : md.content;
  const meta = frontMatter(text);
  if (meta.name !== name) throw fail('invalid_request', `SKILL.md's front matter name ("${meta.name ?? ''}") must match the URL ("${name}")`);
  return meta.description ?? '';
}

/** DELETE always needs a definite revision */
function deleteRev(req: IncomingMessage): number {
  const rev = ifRev(req);
  if (typeof rev !== 'number') throw fail('precondition_required', 'send If-Match to delete a skill');
  return rev;
}

/** Admits and records `sync` for the bytes this write grows the account's storage by */
async function meteredPut(host: Host, p: Principal, scopeValue: string, name: string, body: { description: string; files: SkillFile[] }, ifMatchRev: number | null | undefined) {
  const existing = host.store.get(p, 'skill', scopeValue, name);
  const before = existing && !existing.deleted ? existing.size : 0;
  const predicted = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const admission = await host.admit(p, 'sync', Math.max(0, predicted - before));
  try {
    const doc = host.store.put(p, 'skill', scopeValue, name, body, { ifRev: ifMatchRev, client: p.client });
    host.record(p, 'sync', Math.max(0, doc.size - before), { admission, ok: true });
    return doc;
  } catch (err) {
    host.record(p, 'sync', 0, { admission, ok: false, note: (err as Error).message });
    throw err;
  }
}

export const skillRoutes = (host: Host): Route[] => [
  route('GET', '/skills', 'sync', ({ res, principal, query }) => {
    const scopeFilter = query.get('scope');
    if (scopeFilter !== null) scope(scopeFilter);
    const docs = host.store.list(principal, 'skill', scopeFilter !== null ? { kind: scopeFilter } : undefined);
    const metas: SkillMeta[] = docs.map((d) => ({ id: d.id, name: d.id, scope: d.kind as Scoped, description: (d.body as { description: string }).description, rev: d.rev, size: d.size, updatedAt: d.updatedAt, updatedBy: d.updatedBy }));
    send(res, 200, metas);
  }),

  route('GET', '/skills/:scope/:name', 'sync', ({ res, principal, params }) => {
    const s = scope(params.scope);
    const name = skillName(params.name);
    const doc = host.store.get(principal, 'skill', s, name);
    if (!doc || doc.deleted) throw fail('not_found', 'no such skill');
    send(res, 200, { files: (doc.body as { files: SkillFile[] }).files }, etag(doc.rev));
  }),

  route('PUT', '/skills/:scope/:name', 'sync', async ({ req, res, principal, params }) => {
    const s = scope(params.scope);
    const name = skillName(params.name);
    const ifMatchRev = ifRev(req);
    const put = await readJson<PutSkill>(req, MAX.skillBytes);
    const description = checkSkill(name, put.files);
    const doc = await meteredPut(host, principal, s, name, { description, files: put.files }, ifMatchRev);
    const meta: SkillMeta = { id: doc.id, name, scope: s, description, rev: doc.rev, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
    send(res, 200, meta, etag(doc.rev));
  }),

  route('DELETE', '/skills/:scope/:name', 'sync', ({ req, res, principal, params }) => {
    const s = scope(params.scope);
    const name = skillName(params.name);
    host.store.delete(principal, 'skill', s, name, { ifRev: deleteRev(req), client: principal.client });
    send(res, 200, { ok: true });
  }),
];
