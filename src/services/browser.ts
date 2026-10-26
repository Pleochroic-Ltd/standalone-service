import type { Host } from '../host.ts';
import { notImplemented, route, type Route } from '../http.ts';

export const browserRoutes = (_host: Host): Route[] => [
  // admit 'browser' minutes and a concurrent slot → host.browsers.open
  route('POST', '/browser/sessions', 'tools', () => { throw notImplemented('POST /browser/sessions'); }),
  route('GET', '/browser/sessions', 'tools', () => { throw notImplemented('GET /browser/sessions'); }),
  route('POST', '/browser/sessions/:id/actions', 'tools', () => { throw notImplemented('POST /browser/sessions/:id/actions'); }),
  // host.browsers.close → record 'browser' minutes
  route('DELETE', '/browser/sessions/:id', 'tools', () => { throw notImplemented('DELETE /browser/sessions/:id'); }),
];
