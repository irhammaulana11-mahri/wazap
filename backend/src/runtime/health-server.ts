import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Server HTTP minimal untuk proses pekerja (tanpa Fastify, tanpa rute bisnis): liveness/readiness untuk PM2/monitoring.
 * Default hanya mendengarkan loopback. Tidak memuat rahasia; `info` hanya metadata operasional.
 */
export function startHealthServer(o: {
  port: number;
  host: string;
  /** Siap bila DB terjangkau dan proses tidak sedang shutdown. */
  isReady: () => Promise<boolean>;
  info: () => Record<string, unknown>;
}): Promise<{ port: number; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return json(405, { status: 'METHOD_NOT_ALLOWED' });
    if (req.url === '/health/live') return json(200, { status: 'OK' });
    if (req.url === '/health/ready') {
      o.isReady().then((ok) => json(ok ? 200 : 503, { status: ok ? 'READY' : 'NOT_READY', ...o.info() }), () => json(503, { status: 'NOT_READY' }));
      return;
    }
    json(404, { status: 'NOT_FOUND' });
  });
  srv.requestTimeout = 5000;
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(o.port, o.host, () => resolve({
      port: (srv.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
    }));
  });
}
