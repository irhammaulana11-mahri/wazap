import { buildApp } from './app.js';
import { config } from './config/env.js';
import { migrate } from './database/migrator.js';
import { createMigratePool, getGatewayDb } from './database/gateway.js';
import { assessRole, inspectDbRole, roleCheckMode } from './database/role-check.js';
import { createEngineService } from './modules/engine/engine.service.js';
import { createControlPlane, startControlPlaneLoop } from './modules/engine/control-plane.js';
import os from 'os';
import { createLeaseService } from './modules/engine/lease.service.js';
import { createAuthStore } from './modules/engine/auth-store.js';
import { createQrStore } from './modules/engine/qr-store.js';
import { createMessageQueue } from './modules/engine/message-queue.js';
import { createEngineRuntime } from './modules/engine/engine-runtime.js';
import { baileysAdapterFactory } from './modules/whatsapp/baileys-adapter.js';
import { getCredentialCrypto } from './security/credential-crypto.js';
import { APP_VERSION } from './app.js';
import { createShutdown } from './runtime/shutdown.js';
import { startPoller } from './runtime/poller.js';
import { attachRealtime } from './modules/realtime/realtime.js';
import { createIdentityService } from './modules/identity/identity.service.js';
import { createRetention } from './modules/engine/retention.js';
import { createOutboxRelay } from './modules/engine/outbox-relay.js';
import { createWebhookDeliverer } from './modules/engine/webhook-delivery.js';
import { tryGetCredentialCrypto } from './security/credential-crypto.js';

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
    // Isolasi tenant bergantung pada RLS: tolak start bila role runtime melewatinya.
    const mode = roleCheckMode(config);
    if (mode !== 'off') {
      try {
        const a = assessRole(await inspectDbRole(getGatewayDb().pool, config.DB_SCHEMA));
        for (const w of a.warnings) app.log.warn(w);
        for (const f of a.fatal) app.log.error(f);
        if (a.fatal.length && mode === 'enforce') { app.log.error('Menolak start: role DB tidak aman (DB_ROLE_CHECK=enforce).'); process.exit(1); }
      } catch (err) {
        app.log.warn({ err }, 'Pemeriksaan role DB gagal');
      }
    }
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

  if (isDbConnected && config.ENABLE_EMBEDDED_CONTROL_PLANE === 'true') {
    const gdb = getGatewayDb();
    const loop = startControlPlaneLoop(gdb, createControlPlane(gdb, createEngineService(gdb), app.log), app.log);
    sd!.register('control-plane', () => loop.stop());
  }

  if (isDbConnected && config.ENABLE_EMBEDDED_ENGINE === 'true') {
    // Fail fast: tanpa kunci enkripsi engine tidak boleh menyimpan kredensial WhatsApp.
    const crypto = getCredentialCrypto(config);
    const gdb = getGatewayDb();
    const leases = createLeaseService(gdb);
    const runtime = createEngineRuntime({
      db: gdb, engines: createEngineService(gdb), leases, authStore: createAuthStore({ db: gdb, leases, crypto }),
      qrStore: createQrStore({ db: gdb, leases, crypto }), queue: createMessageQueue(gdb, leases), adapters: baileysAdapterFactory, log: app.log,
      opts: {
        nodeName: config.ENGINE_NODE_NAME ?? os.hostname(), version: APP_VERSION,
        capacity: { maxSessions: config.ENGINE_MAX_SESSIONS, weight: config.ENGINE_WEIGHT, minFreeMemMb: config.ENGINE_MIN_FREE_MEM_MB },
        heartbeatSeconds: config.ENGINE_HEARTBEAT_SECONDS, syncIntervalMs: config.ENGINE_SYNC_INTERVAL_MS,
        reconnect: { baseMs: config.RECONNECT_BASE_MS, maxMs: config.RECONNECT_MAX_MS, maxAttempts: config.RECONNECT_MAX_ATTEMPTS },
        send: { intervalMs: config.SESSION_SEND_INTERVAL_MS, pollMs: config.QUEUE_POLL_MS, timeoutMs: config.SEND_TIMEOUT_MS, verifyRecipient: config.VERIFY_RECIPIENT === 'true' },
      },
    });
    await runtime.start();
    sd!.register('engine', () => runtime.stop()); // LIFO: engine berhenti lebih dulu daripada control-plane/http/db
  }

  if (isDbConnected && config.ENABLE_EMBEDDED_WEBHOOK_WORKER === 'true') {
    const gdb = getGatewayDb();
    const relay = createOutboxRelay(gdb);
    const p1 = startPoller('outbox-relay', () => relay.runOnce(), config.OUTBOX_POLL_MS, app.log);
    sd!.register('outbox-relay', () => p1.stop());
    const crypto = tryGetCredentialCrypto(config);
    if (crypto) {
      const deliverer = createWebhookDeliverer({ db: gdb, crypto, log: app.log });
      const p2 = startPoller('webhook-deliverer', () => deliverer.runOnce(), config.WEBHOOK_POLL_MS, app.log);
      sd!.register('webhook-deliverer', () => p2.stop());
    } else {
      app.log.warn('CREDENTIAL_ENCRYPTION_KEYS belum diset: pengiriman webhook dinonaktifkan.');
    }
  }

  if (isDbConnected && config.ENABLE_EMBEDDED_RETENTION === 'true') {
    const retention = createRetention(getGatewayDb());
    const p3 = startPoller('retention', async () => {
      const r = await retention.runOnce();
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      if (total) app.log.info(r, 'retensi: data dibersihkan');
      return 0; // satu penyapuan per interval; sisa (bila ada) diselesaikan pada putaran berikutnya
    }, config.RETENTION_INTERVAL_MINUTES * 60_000, app.log);
    sd!.register('retention', () => p3.stop());
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
