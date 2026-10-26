import type { Host } from '../host.ts';
import { route, send, type Route } from '../http.ts';

export const accountRoutes = (host: Host): Route[] => [
  route('GET', '/service', null, async ({ res, principal }) => send(res, 200, await host.status(principal))),
];
