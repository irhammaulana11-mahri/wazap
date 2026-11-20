import { buildApp } from './app.js';
import { config } from './config/env.js';
import { migrate } from './database/migrator.js';
import { createMigratePool, getGatewayDb } from './database/gateway.js';
import { enforceDbRole } from './runtime/db-guard.js';
import { createShutdown } from './runtime/shutdown.js';
import { startWorkers } from './runtime/workers.js';
import { attachRealtime } from './modules/realtime/realtime.js';
import { createIdentityService } from './modules/identity/identity.service.js';

async function main() {
  let sd: ReturnType<typeof createShutdown> | undefined;
  const app = buildApp({ isShuttingDown: () => sd?.isShuttingDown() ?? false });
  sd = createShutdown({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS, log: app.log });

  const isDbConnected = await getGatewayDb().pool.query('SELECT 1').then(() => true, () => false);
  if (isDbConnected) {
    if (config.AUTO_MIGRATE === 'true') {
      app.log.info('PostgreSQL connected. Running migrations...');
      const own = createMigratePool(); // kredensial pemilik schema bila dikonfigurasi; selain itu pool runtime
      try {
        const r = await migrate(own ?? getGatewayDb().pool, config.DB_SCHEMA);
        app.log.info({ applied: r.applied, skipped: r.skipped.length, as: own ? 'migrator' : 'runtime' }, 'Migrations executed successfully.');
      } catch (err) {
        app.log.error({ err }, 'Failed to run database migrations');
      } finally {
        await own?.end();
      }
    } else {
      app.log.info('AUTO_MIGRATE=false: migrasi dilewati (jalankan `npm run migrate:prod` sebelum deploy).');
    }
    await enforceDbRole(getGatewayDb(), app.log);
  } else {
    app.log.warn('PostgreSQL is not reachable; /health/ready akan melapor NOT_READY.');
  }

  sd!.register('gateway-db', () => getGatewayDb().close());
  sd!.register('http-server', () => app.close());

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void sd!.run(sig));
  }

  if (isDbConnected) {
    const rt = attachRealtime({
      httpServer: app.server, identity: createIdentityService(getGatewayDb()), db: getGatewayDb(), log: app.log,
      opts: { corsOrigins: config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean), maxSocketsPerTenant: config.REALTIME_MAX_SOCKETS_PER_TENANT, revalidateMs: config.REALTIME_REVALIDATE_SECONDS * 1000 },
    });
    sd!.register('realtime', () => rt.close()); // LIFO: socket ditutup sebelum http server
  }

  if (isDbConnected) {
    // Pekerja latar embedded (dev/single-node). Produksi: set semua ENABLE_EMBEDDED_*=false dan jalankan `worker.ts` terpisah.
    await startWorkers({
      db: getGatewayDb(), log: app.log, sd: sd!,
      roles: {
        controlPlane: config.ENABLE_EMBEDDED_CONTROL_PLANE === 'true', engine: config.ENABLE_EMBEDDED_ENGINE === 'true',
        webhook: config.ENABLE_EMBEDDED_WEBHOOK_WORKER === 'true', retention: config.ENABLE_EMBEDDED_RETENTION === 'true',
      },
    });
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
