// standalone-service: account services for Alexandrite clients, as one request handler any Node HTTP server can mount.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Host } from './host.ts';
import { fail, match, sendError, ServiceError, type Route } from './http.ts';
import { accountRoutes } from './services/account.ts';
import { browserRoutes } from './services/browser.ts';
import { graphRoutes } from './services/graph.ts';
import { memoryRoutes } from './services/memory.ts';
import { latticeRoutes } from './services/lattice.ts';
import { skillRoutes } from './services/skills.ts';
import { syncRoutes } from './services/sync.ts';
import { webRoutes } from './services/web.ts';

export type * from './types.ts';
export type * from './host.ts';
export { ServiceError } from './http.ts';
export { SCOPES, SERVICE_IDS } from './types.ts';
export { migrateStore, sqliteStore } from './store/sqlite.ts';
export { migrateCache, sqliteCache } from './store/cache.ts';
export { braveSearch, firstOf, searxngSearch, tavilySearch } from './engines/search.ts';
export { httpFetcher } from './engines/fetch.ts';

export const VERSION = '0.1.0';

export interface Service {
  routes: Route[];
  /** True when the request was one of the service's and is answered, false when left untouched */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createService(host: Host, { prefix = '/v1' }: { prefix?: string } = {}): Service {
  const routes = [
    ...accountRoutes(host), ...syncRoutes(host), ...skillRoutes(host), ...memoryRoutes(host),
    ...webRoutes(host), ...browserRoutes(host), ...graphRoutes(host), ...latticeRoutes(host),
  ];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const full = url.pathname.replace(/\/+$/, '') || '/';
    if (!full.startsWith(`${prefix}/`)) return false;
    const found = match(routes, req.method ?? 'GET', full.slice(prefix.length));
    if (!found) return false;

    try {
      if (found === 'method') throw fail('invalid_request', `${req.method} is not allowed here`);
      const principal = await host.authenticate(req);
      if (!principal) throw fail('unauthorized', 'send a key in Authorization: Bearer …');
      const { route, params } = found;
      if (route.scope && !principal.scopes.includes(route.scope)) throw fail('missing_scope', `this key lacks the ${route.scope} scope`, { scope: route.scope });

      const aborter = new AbortController();
      res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
      await route.handler({ req, res, principal, params, query: url.searchParams, signal: aborter.signal });
    } catch (err) {
      if (res.headersSent) { res.end(); return true; }
      if (err instanceof ServiceError) sendError(res, err);
      else {
        console.error('[standalone-service]', err);
        sendError(res, fail('internal', 'internal error'));
      }
    }
    return true;
  }

  return { routes, handle };
}
