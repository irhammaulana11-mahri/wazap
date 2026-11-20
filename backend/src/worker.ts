import pino from 'pino';
import { config } from './config/env.js';
import { getGatewayDb } from './database/gateway.js';
import { assertSchemaMigrated, enforceDbRole } from './runtime/db-guard.js';
import { startHealthServer } from './runtime/health-server.js';
import { createShutdown } from './runtime/shutdown.js';
import { parseRoles, startWorkers } from './runtime/workers.js';
import { APP_VERSION } from './version.js';
import { EngineAlreadyRunningError } from './runtime/engine-singleton.js';
import os from 'os';

/**
 * Entrypoint proses pekerja (engine WhatsApp, control-plane, relay/pengirim webhook, retensi) TANPA server HTTP bisnis.
 * Tidak pernah menjalankan migrasi. Keluar dengan kode 1 pada kegagalan start atau kehilangan peran eksklusif (singleton engine)
 * agar process manager memulai ulang dan alarm menyala; SIGTERM/SIGINT => berhenti rapi (kode 0).
 */
async function main() {
  const log = pino({
    level: config.LOG_LEVEL,
    base: { proc: 'worker' },
    transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' } } : undefined,
  });
  const fatal = (err: unknown, msg: string) => { log.fatal({ err }, msg); process.exit(1); };
  process.on('uncaughtException', (err) => fatal(err, 'uncaughtException'));
  process.on('unhandledRejection', (err) => fatal(err, 'unhandledRejection'));

  const roles = parseRoles(config.WORKER_ROLES);
  const db = getGatewayDb();
  const sd = createShutdown({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS, log });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void sd.run(sig));

  // Pekerja tidak dapat berguna tanpa DB: gagal cepat (process manager mencoba lagi dengan backoff) alih-alih berpura-pura hidup.
  await db.pool.query('SELECT 1');
  await assertSchemaMigrated(db);
  await enforceDbRole(db, log);
  sd.register('gateway-db', () => db.close());

  let health: Awaited<ReturnType<typeof startHealthServer>> | undefined;
  const w = await startWorkers({ db, log, sd, roles });

  if (config.WORKER_HEALTH_PORT > 0) {
    health = await startHealthServer({
      port: config.WORKER_HEALTH_PORT, host: config.WORKER_HEALTH_HOST,
      isReady: async () => !sd.isShuttingDown() && (await db.pool.query('SELECT 1').then(() => true, () => false)),
      info: () => ({
        version: APP_VERSION, node: config.ENGINE_NODE_NAME ?? os.hostname(), roles: Object.entries(roles).filter(([, v]) => v).map(([k]) => k),
        ...(w.engine ? { engine_id: w.engine.engineId, sessions_running: w.engine.runnerCount } : {}),
      }),
    });
    sd.register('health-server', () => health!.close()); // LIFO: readiness menjadi tidak tersedia sesaat sebelum pekerja berhenti
  }
  log.info({ roles, health_port: health?.port ?? null, version: APP_VERSION }, 'worker: berjalan');
}

main().catch((err) => {
  if (err instanceof EngineAlreadyRunningError) { console.error(JSON.stringify({ level: 'fatal', msg: err.message })); process.exit(1); }
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker gagal start', err: (err as Error).message }));
  process.exit(1);
});
