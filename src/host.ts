import type { IncomingMessage } from 'node:http';
import type {
  BrowserAction, BrowserResult, BrowserSession, Change, ConfigKind, DocMeta, EmbeddingsRequest, EmbeddingsResponse,
  FetchRequest, FetchResponse, GraphInfo, GraphOp, MemoryTask, OpenBrowser, Scope, SearchRequest, SearchResponse,
  ServiceId, ServiceStatus,
} from './types.ts';

/** Who is calling */
export interface Principal {
  accountId: string;
  /** Null for a portal session */
  keyId: string | null;
  scopes: Scope[];
  /** The calling app, from X-Client */
  client: string | null;
}

/** What the host decided about a request before the work starts */
export interface Admission {
  /** Paid from credits */
  billed: boolean;
}

/** Who is calling, what they may use, where things are kept and which engines do the work, per account */
export interface Host {
  /** Who sent this request, or null to answer 401 */
  authenticate(req: IncomingMessage): Promise<Principal | null> | Principal | null;

  /** What GET /service answers for this principal now */
  status(p: Principal): Promise<ServiceStatus> | ServiceStatus;

  /** May `p` spend `units` of `service` now? Throws a ServiceError if not. */
  admit(p: Principal, service: ServiceId, units: number): Promise<Admission> | Admission;

  /**
   * What a request used, after it ended.
   * `cached`: the answer came from `cache`. `note`: free text the host may keep with the record.
   */
  record(p: Principal, service: ServiceId, units: number, detail: { admission: Admission; ok: boolean; note?: string; cached?: boolean }): void;

  store: Store;
  graphs: GraphStore;
  /** Absent: the endpoints answer 501 */
  search?: SearchEngine;
  fetcher?: Fetcher;
  browsers?: BrowserPool;
  models?: MemoryModels;
  /** Absent: every /search and /fetch goes upstream */
  cache?: Cache;
}

export interface CacheEntry<T = unknown> {
  value: T;
  /** When it was put */
  storedAt: string;
}
/** One result cache shared by every account */
export interface Cache {
  /** Null when absent or past its TTL */
  get<T = unknown>(key: string): CacheEntry<T> | null;
  put(key: string, value: unknown, ttlSeconds: number): void;
}

/* ---------- Storage for sync ---------- */

export type Area = 'config' | 'secret' | 'skill' | 'memory';

export interface StoredDoc extends DocMeta { area: Area; kind: string | null; body: unknown; deleted: boolean }

export interface WriteOptions {
  /** The revision the writer last saw: null to create, undefined to skip the check */
  ifRev?: number | null;
  client: string | null;
}

/**
 * Documents per account, each with a revision, plus one change feed across them.
 * A revision that doesn't match throws ServiceError conflict with the current DocMeta.
 */
export interface Store {
  get(p: Principal, area: Area, kind: string | null, id: string): StoredDoc | null;
  list(p: Principal, area: Area, filter?: { kind?: string | null }): StoredDoc[];
  put(p: Principal, area: Area, kind: string | null, id: string, body: unknown, opts: WriteOptions): StoredDoc;
  delete(p: Principal, area: Area, kind: string | null, id: string, opts: WriteOptions): void;
  changes(p: Principal, since: number, limit: number): { changes: Change[]; cursor: number; more: boolean };
  bytes(p: Principal): number;
}

/** Text search over an account's memory notes */
export interface MemoryIndex {
  search(p: Principal, query: string, filter: { scope?: string; tags?: string[] }, limit: number): { id: string; scope: string; score: number }[];
}

/* ---------- Lattice graphs ---------- */

/** How long a graph's op log keeps the ops no later op superseded */
export const OP_LOG_DAYS = 30;

export interface GraphStore {
  list(p: Principal): GraphInfo[];
  create(p: Principal, name: string, embedding: GraphInfo['embedding']): GraphInfo;
  drop(p: Principal, name: string): void;
  info(p: Principal, name: string): GraphInfo | null;
  /** Every record as it stands, as one stream of ops at `seq` */
  snapshot(p: Principal, name: string): { seq: number; ops: AsyncIterable<GraphOp> };
  /** Applies a batch in one transaction and returns the new seq */
  append(p: Principal, name: string, ops: GraphOp[], baseSeq: number | null): number;
  /** Ops after `seq`, or ServiceError snapshot_required when the log no longer reaches back that far */
  since(p: Principal, name: string, seq: number, limit: number): { ops: (GraphOp & { seq: number })[]; seq: number; more: boolean };
  /** Drops superseded ops and ops older than `before`, returning the oldest seq still in the log */
  compact(p: Principal, name: string, before: Date): { oldestSeq: number };
}

/* ---------- Engines ---------- */

export interface SearchEngine {
  id: string;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}

/** Fetches a page as Markdown or text and refuses private addresses */
export interface Fetcher {
  /** `cacheable`: false when the answer must not be cached, absent counts as true */
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResponse & { cacheable?: boolean }>;
}

/** Headless browsers, one Chromium context per session */
export interface BrowserPool {
  open(p: Principal, options: OpenBrowser): Promise<BrowserSession>;
  list(p: Principal): BrowserSession[];
  act(p: Principal, id: string, action: BrowserAction, signal: AbortSignal): Promise<BrowserResult>;
  close(p: Principal, id: string): Promise<{ minutes: number }>;
}

/** The models behind Lattice */
export interface MemoryModels {
  embed(p: Principal, request: EmbeddingsRequest, signal: AbortSignal): Promise<EmbeddingsResponse>;
  complete(p: Principal, task: MemoryTask, system: string, user: string, signal: AbortSignal):
    Promise<{ text: string; model: string; usage: { input: number; output: number } }>;
}

/** Whether the host refuses to keep a config document */
export type ConfigPolicy = (kind: ConfigKind, id: string) => boolean;
