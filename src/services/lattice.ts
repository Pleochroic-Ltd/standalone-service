import type { Host } from '../host.ts';
import { notImplemented, route, type Route } from '../http.ts';

export const latticeRoutes = (_host: Host): Route[] => [
  // ≤ MAX.embeddingInputs inputs; admit 'embeddings' (estimated tokens) → host.models.embed → record actual
  route('POST', '/embeddings', 'graph', () => { throw notImplemented('POST /embeddings'); }),
  // task in MEMORY_TASKS, ≤ MAX.completeBytes; admit 'memoryModel' → host.models.complete → record actual
  route('POST', '/lattice/complete', 'graph', () => { throw notImplemented('POST /lattice/complete'); }),
];
