import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from './host.ts';
import type { ErrorBody, ErrorCode, Scope } from './types.ts';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400, unauthorized: 401, insufficient_credits: 402, not_entitled: 403, missing_scope: 403, not_found: 404,
  conflict: 409, snapshot_required: 410, too_large: 413, precondition_required: 428, quota_exceeded: 429, rate_limited: 429, internal: 500,
  not_implemented: 501, upstream_error: 502,
};

/** Thrown anywhere to answer `{ error: { code, message, ...extra } }` with the code's status */
export class ServiceError extends Error {
  code: ErrorCode;
  status: number;
  extra: Record<string, unknown>;
  headers: Record<string, string>;
  constructor(code: ErrorCode, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
    this.headers = headers;
  }
}

export const fail = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}) => new ServiceError(code, message, extra);
export const notImplemented = (what: string) => fail('not_implemented', `${what} is not implemented yet`);

/** What a handler gets */
export interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  principal: Principal;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Aborts when the client goes away */
  signal: AbortSignal;
}

export type Handler = (call: Call) => unknown;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Below the mount prefix */
  path: string;
  /** Scope the key needs, if any */
  scope: Scope | null;
  handler: Handler;
}

export function route(method: Route['method'], path: string, scope: Scope | null, handler: Handler): Route {
  return { method, path, scope, handler };
}

/** The route for a method and path, 'method' when only the path matches, or null */
export function match(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
  let pathMatched = false;
  for (const r of routes) {
    const params = matchPath(r.path, path);
    if (!params) continue;
    if (r.method === method) return { route: r, params };
    pathMatched = true;
  }
  return pathMatched ? 'method' : null;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      try { params[want[i].slice(1)] = decodeURIComponent(got[i]); } catch { return null; }
    } else if (want[i] !== got[i]) return null;
  }
  return params;
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

export function sendError(res: ServerResponse, err: ServiceError): void {
  const body: ErrorBody = { error: { ...err.extra, code: err.code, message: err.message } };
  send(res, err.status, body, err.headers);
}

/** The body as a JSON object, at most `max` bytes */
export function readJson<T = Record<string, unknown>>(req: IncomingMessage, max: number): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(fail('invalid_request', 'expected JSON'));
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; reject(fail('too_large', `the body is over ${max} bytes`, { limit: max })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reject(fail('invalid_request', 'invalid JSON')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(fail('invalid_request', 'expected a JSON object'));
      resolve(body as T);
    });
    req.on('error', reject);
  });
}

/** The revision in If-Match, null for `If-None-Match: *`, undefined when neither was sent */
export function ifRev(req: IncomingMessage): number | null | undefined {
  if (req.headers['if-none-match'] === '*') return null;
  const tag = req.headers['if-match'];
  if (tag === undefined) return undefined;
  const n = Number(String(tag).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw fail('invalid_request', 'If-Match must be a revision, e.g. "3"');
  return n;
}

export const etag = (rev: number) => ({ ETag: `"${rev}"` });
