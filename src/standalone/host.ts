import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { httpFetcher } from '../engines/fetch.ts';
import { braveSearch, firstOf, searxngSearch, tavilySearch } from '../engines/search.ts';
import type { Cache, GraphStore, Host, Principal, SearchEngine, Store } from '../host.ts';
import { notImplemented } from '../http.ts';
import { migrateCache, sqliteCache } from '../store/cache.ts';
import { migrateStore, sqliteStore } from '../store/sqlite.ts';
import { SCOPES, SERVICE_IDS, type ServiceEntitlement, type ServiceId, type ServiceStatus } from '../types.ts';

const VERSION = '0.1.0';

const DATA_DIR = process.env.SERVICE_DATA || './data';
mkdirSync(DATA_DIR, { recursive: true });

function loadToken(): string {
  const file = process.env.SERVICE_TOKEN_FILE;
  const token = (file ? readFileSync(file, 'utf8') : process.env.SERVICE_TOKEN || '').trim();
  if (token.length < 16) throw new Error('set SERVICE_TOKEN (or SERVICE_TOKEN_FILE) to at least 16 characters');
  return token;
}

/** The AES-256-GCM key that seals secret values, written on first use */
function loadSealingKey(): Buffer {
  const file = process.env.SERVICE_SECRET_KEY_FILE || join(DATA_DIR, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  const hex = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} must hold 64 hex characters`);
  return Buffer.from(hex, 'hex');
}

/** Seals as "v1.<iv|tag|ciphertext>" */
function sealer(key: Buffer) {
  return {
    seal(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
    },
    unseal(sealed: string): string {
      const [version, data] = sealed.split('.');
      if (version !== 'v1' || !data) throw new Error('not a sealed value');
      const buf = Buffer.from(data, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

/** The configured search engines chained SearXNG → Brave → Tavily, or undefined when none */
function configureSearch(): SearchEngine | undefined {
  const engines: SearchEngine[] = [];
  if (process.env.SEARXNG_URL) engines.push(searxngSearch({ baseUrl: process.env.SEARXNG_URL, token: process.env.SEARXNG_TOKEN }));
  if (process.env.BRAVE_API_KEY) engines.push(braveSearch({ apiKey: process.env.BRAVE_API_KEY }));
  if (process.env.TAVILY_API_KEY) engines.push(tavilySearch({ apiKey: process.env.TAVILY_API_KEY }));
  if (engines.length === 0) return undefined;
  return engines.length === 1 ? engines[0] : firstOf(...engines);
}

const unlimited: ServiceEntitlement = { enabled: true, quota: null, overage: 'stop', priceMicros: null };

/** Placeholder whose every method answers 501 */
const pending = <T extends object>(what: string): T =>
  new Proxy({} as T, { get: (_t, name) => () => { throw notImplemented(`${what}.${String(name)}`); } });

export function standaloneHost(): Host {
  const token = Buffer.from(loadToken());
  const principal: Principal = { accountId: 'owner', keyId: null, scopes: [...SCOPES], client: null };

  const db = new DatabaseSync(join(DATA_DIR, 'service.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrateStore(db);
  const store: Store = sqliteStore(db, sealer(loadSealingKey()));

  migrateCache(db);
  const cache: Cache = sqliteCache(db, { maxBytes: Number(process.env.CACHE_MAX_BYTES) || undefined });

  const search = configureSearch();
  console.log(`[standalone-service] search: ${search ? search.id : 'none (set SEARXNG_URL, BRAVE_API_KEY or TAVILY_API_KEY)'}`);

  return {
    authenticate(req: IncomingMessage) {
      const sent = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (sent.length !== token.length || !timingSafeEqual(sent, token)) return null;
      return { ...principal, client: String(req.headers['x-client'] || '').slice(0, 100) || null };
    },

    status(p: Principal): ServiceStatus {
      const services = Object.fromEntries(SERVICE_IDS.map((id) => [id, unlimited])) as Record<ServiceId, ServiceEntitlement>;
      services.sync = { ...unlimited, quota: { unit: 'bytes', period: null, limit: null, used: store.bytes(p), resetsAt: null } };
      return {
        service: { name: 'standalone-service', version: VERSION, apiVersion: 1 },
        account: { id: p.accountId, name: null, plan: null },
        scopes: p.scopes,
        credits: null,
        services,
      };
    },

    admit: () => ({ billed: false }),
    record: () => {},

    store,
    graphs: pending<GraphStore>('graphs'),
    search,
    fetcher: httpFetcher(),
    cache,
    // TODO: models from EMBEDDINGS_* and MEMORY_MODEL_*
  };
}
