import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../src/index.ts';
import type { Host, Principal } from '../src/host.ts';
import { migrateStore, sqliteStore } from '../src/store/sqlite.ts';
import { SCOPES, SERVICE_IDS } from '../src/types.ts';

export const owner: Principal = { accountId: 'a1', keyId: 'k1', scopes: [...SCOPES], client: 'test/1' };

// A seal that visibly transforms its input
const seal = (plaintext: string) => `v1.${Buffer.from(plaintext, 'utf8').toString('base64url')}`;
const unseal = (sealed: string) => Buffer.from(sealed.slice('v1.'.length), 'base64url').toString('utf8');

export function freshStore() {
  const db = new DatabaseSync(':memory:');
  migrateStore(db);
  return sqliteStore(db, { seal, unseal });
}

/** A Host for the HTTP-level tests: real storage, nothing counted */
export function testHost(overrides: Partial<Host> = {}): Host {
  return {
    authenticate: (req) => (req.headers.authorization === 'Bearer good' ? owner : null),
    status: (p: Principal) => ({
      service: { name: 'test', version: '0', apiVersion: 1 },
      account: { id: p.accountId, name: null, plan: null },
      scopes: p.scopes,
      credits: null,
      services: Object.fromEntries(SERVICE_IDS.map((id) => [id, { enabled: true, quota: null, overage: 'stop', priceMicros: null }])) as never,
    }),
    admit: () => ({ billed: false }),
    record: () => {},
    store: freshStore(),
    graphs: {} as never,
    ...overrides,
  };
}

export interface TestService {
  base: string;
  call(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string>; key?: string }): Promise<Response>;
  stop(): Promise<void>;
}

export async function startService(host: Host): Promise<TestService> {
  const service = createService(host);
  const server: Server = createServer(async (req, res) => {
    if (await service.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    call(method, path, { body, headers = {}, key = 'good' } = {}) {
      return fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
