import os from 'os';
import type { GatewayDb } from '../database/gateway.js';
import { config } from '../config/env.js';
import type { AdapterFactory } from '../modules/whatsapp/adapter.js';
import { baileysAdapterFactory } from '../modules/whatsapp/baileys-adapter.js';
import { createEngineService } from '../modules/engine/engine.service.js';
import { createControlPlane, startControlPlaneLoop } from '../modules/engine/control-plane.js';
import { createLeaseService } from '../modules/engine/lease.service.js';
import { createAuthStore } from '../modules/engine/auth-store.js';
import { createQrStore } from '../modules/engine/qr-store.js';
import { createMessageQueue } from '../modules/engine/message-queue.js';
import { createEngineRuntime, type EngineRuntime } from '../modules/engine/engine-runtime.js';
import { createRetention } from '../modules/engine/retention.js';
import { createOutboxRelay } from '../modules/engine/outbox-relay.js';
import { createWebhookDeliverer } from '../modules/engine/webhook-delivery.js';
import { getCredentialCrypto, tryGetCredentialCrypto } from '../security/credential-crypto.js';
import { createAlertEvaluator } from '../modules/engine/alert-evaluator.js';
import { createAlertSender } from '../modules/engine/alert-sender.js';
import { startPoller } from './poller.js';
import { acquireEngineSingleton } from './engine-singleton.js';
import { APP_VERSION } from '../version.js';


export interface WorkerRoles { controlPlane: boolean; engine: boolean; webhook: boolean; retention: boolean }
export const ALL_ROLES: WorkerRoles = { controlPlane: true, engine: true, webhook: true, retention: true };

/** `WORKER_ROLES` ("engine,control-plane,webhook,retention") -> peran. Nama tak dikenal ditolak (salah ketik tidak boleh diam-diam menonaktifkan peran). */
export function parseRoles(spec: string): WorkerRoles {
  const names = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const known: Record<string, keyof WorkerRoles> = { engine: 'engine', 'control-plane': 'controlPlane', webhook: 'webhook', retention: 'retention' };
  const out: WorkerRoles = { controlPlane: false, engine: false, webhook: false, retention: false };
  for (const n of names) {
    if (!known[n]) throw new Error(`WORKER_ROLES: peran tidak dikenal "${n}" (valid: ${Object.keys(known).join(', ')})`);
    out[known[n]] = true;
  }
  if (!names.length) throw new Error('WORKER_ROLES kosong: sebutkan minimal satu peran');
  return out;
}

interface Log {
  info: (o: any, m?: string) => void;
  warn: (o: any, m?: string) => void;
  error: (o: any, m?: string) => void;
}
interface ShutdownLike {
  register(name: string, fn: () => Promise<void>): void;
  run(reason: string, fatal?: boolean): Promise<void>;
}

export interface StartWorkersOptions {
  db: GatewayDb;
  log: Log;
  sd: ShutdownLike;
  roles: WorkerRoles;
  /** Default: Baileys. Tes memakai adapter palsu. */
  adapters?: AdapterFactory;
  /** Menimpa interval dari env (tes). */
  intervals?: { controlPlaneMs?: number; engineSyncMs?: number };
  singleton?: { retries?: number; retryMs?: number };
}

/**
 * Komposisi pekerja latar, dipakai SAMA oleh proses API (embedded, dev/single-node) dan entrypoint pekerja terpisah (`worker.ts`).
 * Urutan registrasi shutdown (dijalankan LIFO): retensi, webhook, engine (+ kunci singleton dilepas SETELAH engine berhenti), control-plane.
 */
export async function startWorkers(o: StartWorkersOptions): Promise<{ engine?: EngineRuntime }> {
  const { db, log, sd, roles } = o;
  const out: { engine?: EngineRuntime } = {};

  if (roles.controlPlane) {
    const loop = startControlPlaneLoop(db, createControlPlane(db, createEngineService(db), log), log, o.intervals?.controlPlaneMs);
    sd.register('control-plane', () => loop.stop());
  }

  if (roles.engine) {
    // Fail fast: tanpa kunci enkripsi engine tidak boleh menyimpan kredensial WhatsApp.
    const crypto = getCredentialCrypto(config);
    const nodeName = config.ENGINE_NODE_NAME ?? os.hostname();
    const single = await acquireEngineSingleton(db, nodeName, log, (why) => void sd.run(why, true), o.singleton);
    sd.register('engine-singleton', () => single.release());
    const leases = createLeaseService(db);
    const runtime = createEngineRuntime({
      db, engines: createEngineService(db), leases, authStore: createAuthStore({ db, leases, crypto }),
      qrStore: createQrStore({ db, leases, crypto }), queue: createMessageQueue(db, leases), adapters: o.adapters ?? baileysAdapterFactory, log,
      opts: {
        nodeName, version: APP_VERSION,
        capacity: { maxSessions: config.ENGINE_MAX_SESSIONS, weight: config.ENGINE_WEIGHT, minFreeMemMb: config.ENGINE_MIN_FREE_MEM_MB },
        heartbeatSeconds: config.ENGINE_HEARTBEAT_SECONDS, syncIntervalMs: o.intervals?.engineSyncMs ?? config.ENGINE_SYNC_INTERVAL_MS,
        reconnect: { baseMs: config.RECONNECT_BASE_MS, maxMs: config.RECONNECT_MAX_MS, maxAttempts: config.RECONNECT_MAX_ATTEMPTS },
        send: { intervalMs: config.SESSION_SEND_INTERVAL_MS, pollMs: config.QUEUE_POLL_MS, timeoutMs: config.SEND_TIMEOUT_MS, verifyRecipient: config.VERIFY_RECIPIENT === 'true' },
      },
    });
    await runtime.start();
    sd.register('engine', () => runtime.stop()); // LIFO: engine berhenti lebih dulu daripada kunci singleton/control-plane/db
    out.engine = runtime;
  }

  if (roles.webhook) {
    const relay = createOutboxRelay(db);
    const p1 = startPoller('outbox-relay', () => relay.runOnce(), config.OUTBOX_POLL_MS, log);
    sd.register('outbox-relay', () => p1.stop());
    const crypto = tryGetCredentialCrypto(config);
    if (crypto) {
      const deliverer = createWebhookDeliverer({ db, crypto, log });
      const p2 = startPoller('webhook-deliverer', () => deliverer.runOnce(), config.WEBHOOK_POLL_MS, log);
      sd.register('webhook-deliverer', () => p2.stop());
      // Notifikasi alarm per workspace (ADR-049): evaluator menulis antrean, pengirim mengirimnya. Aman multi-instans (idempotensi di DB).
      const evaluator = createAlertEvaluator({ db, log });
      const pe = startPoller('alert-evaluator', () => evaluator.runOnce(), config.ALERTS_EVAL_INTERVAL_MS, log);
      sd.register('alert-evaluator', () => pe.stop());
      const sender = createAlertSender({ db, crypto, log });
      const ps = startPoller('alert-sender', () => (config.ALERTS_ENABLED === 'true' ? sender.runOnce() : Promise.resolve(0)), config.ALERTS_SEND_POLL_MS, log);
      sd.register('alert-sender', () => ps.stop());
    } else {
      log.warn({}, 'CREDENTIAL_ENCRYPTION_KEYS belum diset: pengiriman webhook dinonaktifkan.');
    }
  }

  if (roles.retention) {
    const retention = createRetention(db);
    const p3 = startPoller('retention', async () => {
      const r = await retention.runOnce();
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      if (total) log.info(r, 'retensi: data dibersihkan');
      return 0; // satu penyapuan per interval; sisa (bila ada) diselesaikan pada putaran berikutnya
    }, config.RETENTION_INTERVAL_MINUTES * 60_000, log);
    sd.register('retention', () => p3.stop());
  }
  return out;
}
