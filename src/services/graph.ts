import type { Host } from '../host.ts';
import { notImplemented, route, type Route } from '../http.ts';

export const graphRoutes = (_host: Host): Route[] => [
  route('GET', '/graphs', 'graph', () => { throw notImplemented('GET /graphs'); }),
  // admit 'graph' 1 graph
  route('POST', '/graphs', 'graph', () => { throw notImplemented('POST /graphs'); }),
  route('GET', '/graphs/:name', 'graph', () => { throw notImplemented('GET /graphs/:name'); }),
  route('DELETE', '/graphs/:name', 'graph', () => { throw notImplemented('DELETE /graphs/:name'); }),
  route('GET', '/graphs/:name/snapshot', 'graph', () => { throw notImplemented('GET /graphs/:name/snapshot'); }),
  // ≤ MAX.graphBatchOps ops and MAX.graphBatchBytes, baseSeq behind → 409 { seq }, admit 'sync' for GraphInfo.size growth
  route('POST', '/graphs/:name/ops', 'graph', () => { throw notImplemented('POST /graphs/:name/ops'); }),
  // host.graphs.since → OpsPage, or 410 snapshot_required { oldestSeq }
  route('GET', '/graphs/:name/ops', 'graph', () => { throw notImplemented('GET /graphs/:name/ops'); }),
];
