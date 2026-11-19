import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  checkDb: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  version: string;
}

/**
 * /health/live  : proses hidup (tanpa dependensi eksternal).
 * /health/ready : siap menerima trafik (DB OK dan tidak sedang shutdown).
 * /health       : alias ringkas untuk kompatibilitas prototipe.
 * Tidak mengembalikan detail internal/secret.
 */
export async function healthRoutes(app: FastifyInstance, deps: HealthDeps) {
  app.get('/health/live', async () => ({ status: 'UP', version: deps.version }));

  const ready = async (_req: unknown, reply: any) => {
    const shuttingDown = deps.isShuttingDown();
    const db = shuttingDown ? false : await deps.checkDb().catch(() => false);
    const ok = db && !shuttingDown;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'READY' : 'NOT_READY',
      checks: { database: db ? 'UP' : 'DOWN', shutting_down: shuttingDown },
      timestamp: new Date().toISOString(),
    });
  };
  app.get('/health/ready', ready);
  app.get('/health', ready);
}
