// Runs the service on its own at HOST:SERVICE_PORT, default 127.0.0.1:8791.
import { createServer } from 'node:http';
import { createService } from '../index.ts';
import { send } from '../http.ts';
import { standaloneHost } from './host.ts';

const PORT = Number(process.env.SERVICE_PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';

const service = createService(standaloneHost());

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (await service.handle(req, res)) return;
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  send(res, 404, { error: { code: 'not_found', message: `no such endpoint: ${req.method} ${req.url}` } });
});

server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`standalone-service on http://${HOST}:${PORT}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
