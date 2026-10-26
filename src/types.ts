/* ---------- Services and what an account may use of them ---------- */

/** One service, as entitlements and metering name it */
export type ServiceId =
  | 'sync'          // config documents, secrets, skills and memory
  | 'search'
  | 'fetch'
  | 'browser'       // headless browser sessions
  | 'graph'         // Lattice graph storage
  | 'embeddings'
  | 'memoryModel';  // POST /lattice/complete

export const SERVICE_IDS: ServiceId[] = ['sync', 'search', 'fetch', 'browser', 'graph', 'embeddings', 'memoryModel'];

/** What a quota is counted in */
export type Unit = 'bytes' | 'requests' | 'minutes' | 'tokens' | 'graphs';

export interface Quota {
  unit: Unit;
  /** The window the count restarts after, null for a standing allowance */
  period: 'day' | 'month' | null;
  /** Null: no limit */
  limit: number | null;
  used: number;
  /** When `used` next starts again from 0, null for a standing allowance */
  resetsAt: string | null;
}

export interface ServiceEntitlement {
  /** False: requests to it answer 403 not_entitled */
  enabled: boolean;
  /** Its main allowance */
  quota: Quota | null;
  extra?: Record<string, Quota | number | null>;
  /** Past the quota: 'credits' bills `priceMicros` per unit (per million tokens), 'stop' answers 429 quota_exceeded */
  overage: 'credits' | 'stop';
  priceMicros: number | null;
}

/** GET /service: who the caller is and what they may use */
export interface ServiceStatus {
  service: { name: string; version: string; apiVersion: 1 };
  account: { id: string; name: string | null; plan: { id: string; name: string } | null };
  /** The key's scopes, all of them for a session */
  scopes: Scope[];
  credits: { balanceMicros: number } | null;
  services: Record<ServiceId, ServiceEntitlement>;
}

/** What a key may do */
export type Scope = 'models' | 'sync' | 'secrets:read' | 'tools' | 'graph';
export const SCOPES: Scope[] = ['models', 'sync', 'secrets:read', 'tools', 'graph'];

/* ---------- Errors ---------- */

export type ErrorCode =
  | 'invalid_request'       // 400
  | 'unauthorized'          // 401
  | 'not_entitled'          // 403: the plan lacks the service
  | 'missing_scope'         // 403: the key lacks the scope
  | 'not_found'             // 404
  | 'conflict'              // 409 (body: `current`)
  | 'precondition_required' // 428: a write to an existing document without If-Match
  | 'snapshot_required'     // 410 (body: `oldestSeq`)
  | 'too_large'             // 413
  | 'quota_exceeded'        // 429 (body: `service`, `resetsAt`)
  | 'insufficient_credits'  // 402
  | 'rate_limited'          // 429 (header Retry-After)
  | 'upstream_error'        // 502
  | 'not_implemented'       // 501
  | 'internal';             // 500

export interface ErrorBody {
  error: { code: ErrorCode; message: string; [extra: string]: unknown };
}

/* ---------- Sync: documents with revisions ---------- */

/** The kinds of config document, one per place Alexandrite keeps them */
export type ConfigKind = 'provider' | 'agent' | 'profile' | 'mcp' | 'settings' | 'instructions';
export const CONFIG_KINDS: ConfigKind[] = ['provider', 'agent', 'profile', 'mcp', 'settings', 'instructions'];

export interface DocMeta {
  id: string;
  /** Goes up by one with each write */
  rev: number;
  size: number;
  updatedAt: string;
  /** The X-Client of the last writer */
  updatedBy: string | null;
}

export interface ConfigDoc extends DocMeta {
  kind: ConfigKind;
  data: Record<string, unknown>;
}

export interface ConfigList { documents: (DocMeta & { kind: ConfigKind })[] }
export interface PutConfig { data: Record<string, unknown> }

/** A secret's value, sealed by the server (`value`) or by the client (`sealed`) */
export type PutSecret = { value: string } | { sealed: { alg: string; data: string; keyId?: string } };
export interface SecretMeta extends DocMeta { sealedBy: 'server' | 'client' }
export type SecretDoc = SecretMeta & ({ value: string } | { sealed: { alg: string; data: string; keyId?: string } });

/* ---------- Skills ---------- */

/** Where a skill or memory belongs: everywhere, one agent, or one project by a stable hash of its root */
export type Scoped = 'global' | `agent:${string}` | `project:${string}`;

export interface SkillFile {
  path: string;                    // relative
  encoding: 'utf8' | 'base64';
  content: string;
}
export interface SkillMeta extends DocMeta { name: string; scope: Scoped; description: string }
export interface SkillDoc extends SkillMeta { files: SkillFile[] }
export interface PutSkill { files: SkillFile[] }

/* ---------- Memory ---------- */

export interface MemoryMeta extends DocMeta { scope: Scoped; title: string; tags: string[] }
export interface MemoryDoc extends MemoryMeta { content: string }
export interface PutMemory { title: string; content: string; tags?: string[] }

/* ---------- One change feed for all of sync ---------- */

export interface Change {
  /** Increasing per account */
  seq: number;
  area: 'config' | 'secret' | 'skill' | 'memory';
  /** Config kind, or the skill or memory scope */
  kind: string | null;
  id: string;
  rev: number;
  deleted: boolean;
  at: string;
}
export interface ChangePage { changes: Change[]; cursor: number; more: boolean }

/* ---------- Search and fetch ---------- */

export interface SearchRequest {
  query: string;
  /** 1–20, default 10 */
  count?: number;
  freshness?: 'day' | 'week' | 'month' | 'year';
  /** Only results from these hosts */
  sites?: string[];
  /** BCP 47 */
  language?: string;
}
export interface SearchResult { title: string; url: string; snippet: string; publishedAt: string | null }
/** `cached`: from the shared result cache */
export interface SearchResponse { results: SearchResult[]; backend: string; cached?: boolean }

export interface FetchRequest {
  url: string;
  /** Default 'markdown' */
  format?: 'markdown' | 'text' | 'html';
  /** Cap on `content`, default 100 000 characters */
  maxChars?: number;
}
export interface FetchResponse {
  /** After redirects */
  url: string;
  status: number;
  contentType: string | null;
  title: string | null;
  content: string;
  truncated: boolean;
  /** From the shared result cache */
  cached?: boolean;
}

/* ---------- Headless browser ---------- */

export interface OpenBrowser {
  viewport?: { width: number; height: number };
  locale?: string;
  /** Closes after this long without an action, default 300 */
  idleSeconds?: number;
}
export interface BrowserSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string | null;
  /** A DevTools-protocol WebSocket, null where not offered */
  cdpUrl: string | null;
}

/** One step, naming elements by a snapshot's `ref` or a CSS selector */
export type BrowserAction =
  | { action: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { action: 'back' } | { action: 'forward' } | { action: 'reload' }
  | { action: 'click'; ref?: string; selector?: string }
  | { action: 'type'; ref?: string; selector?: string; text: string; submit?: boolean }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { action: 'select'; ref?: string; selector?: string; values: string[] }
  | { action: 'wait'; seconds?: number; text?: string }
  | { action: 'snapshot' }                                  // accessibility tree with refs, as text
  | { action: 'screenshot'; fullPage?: boolean }            // PNG, base64
  | { action: 'evaluate'; expression: string };

export interface BrowserResult {
  url: string;
  title: string;
  snapshot?: string;
  screenshot?: { mediaType: 'image/png'; data: string };
  value?: unknown;
}

/* ---------- Lattice: graph storage ---------- */

/** A Lattice graph kept remotely as an ordered op log and a snapshot to start from */
export interface GraphInfo {
  name: string;
  seq: number;
  engrams: number;
  edges: number;
  /** The embedding model and dimension of the graph's vectors */
  embedding: { model: string; dimension: number } | null;
  /** Bytes of the records as they stand */
  size: number;
  /** The oldest seq the op log still holds */
  oldestSeq: number;
  updatedAt: string;
}

export interface Engram {
  id: number;
  content: string;
  /** L2-normalised float32, little-endian, base64 */
  embedding: string;
  [field: string]: unknown;   // salience, layer, times, provenance
}

export type GraphOp =
  | { op: 'putEngram'; engram: Engram }
  | { op: 'deleteEngram'; id: number }   // removes its edges and memberships too
  | { op: 'putEdge'; a: number; b: number; type: string; weight: number; [field: string]: unknown }
  | { op: 'deleteEdge'; a: number; b: number }
  | { op: 'putRecord'; type: string; key: string; data: Record<string, unknown> }   // any other record
  | { op: 'deleteRecord'; type: string; key: string };

export interface PostOps {
  /** The seq this batch was made against, 409 conflict when the graph has moved on */
  baseSeq?: number;
  ops: GraphOp[];
}
export interface OpsPage { ops: (GraphOp & { seq: number })[]; seq: number; more: boolean }

/* ---------- Lattice: model calls ---------- */

/** OpenAI's embeddings format */
export interface EmbeddingsRequest { model?: string; input: string | string[]; encoding_format?: 'float' | 'base64' }
export interface EmbeddingsResponse {
  object: 'list';
  model: string;
  data: { object: 'embedding'; index: number; embedding: number[] | string }[];
  usage: { prompt_tokens: number; total_tokens: number };
}

/** The jobs Lattice gives a model */
export type MemoryTask = 'extract' | 'judge' | 'abstract' | 'entities' | 'narrate' | 'scenes' | 'periods';
export const MEMORY_TASKS: MemoryTask[] = ['extract', 'judge', 'abstract', 'entities', 'narrate', 'scenes', 'periods'];

export interface CompleteRequest { task: MemoryTask; system: string; user: string }
export interface CompleteResponse { text: string; model: string; usage: { input: number; output: number } }
