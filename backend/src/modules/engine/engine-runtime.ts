import os from 'os';
import type { GatewayDb } from '../../database/gateway.js';
import type { AdapterFactory } from '../whatsapp/adapter.js';
import { transitionSession, OWNED_STATES, type SessionState } from '../sessions/lifecycle.js';
import type { AuthStore } from './auth-store.js';
import type { EngineService } from './engine.service.js';
import { releaseLeaseIn, type Lease, type LeaseService } from './lease.service.js';
import type { QrStore } from './qr-store.js';
import type { MessageQueue } from './message-queue.js';
import { createInbox } from './inbox.js';
import { fetchMedia as realFetchMedia, type FetchedMedia, type MediaKind } from '../media/fetch.js';
import { config } from '../../config/env.js';
import { SessionRunner, type RunnerLog } from './session-runner.js';

export interface EngineRuntimeOptions {
  nodeName: string;
  version: string;
  capacity: { maxSessions: number; weight?: number; minFreeMemMb?: number };
  heartbeatSeconds: number;
  syncIntervalMs: number;
  reconnect: { baseMs: number; maxMs: number; maxAttempts: number; random?: () => number };
  send: { intervalMs: number; pollMs: number; timeoutMs: number; verifyRecipient: boolean; random?: () => number };
}

interface OwnedRow {
  session_id: string;
  tenant_id: string;
  fencing_token: string | number;
  status: SessionState;
}

/**
 * Engine runtime: mendaftar, heartbeat, menjalankan SessionRunner untuk setiap sesi yang lease-nya dimiliki node ini,
 * dan menghentikan runner yang kehilangan kepemilikan. Dapat berjalan embedded (proses API) atau sebagai proses sendiri.
 */
export function createEngineRuntime(deps: {
  db: GatewayDb;
  engines: EngineService;
  leases: LeaseService;
  authStore: AuthStore;
  qrStore: QrStore;
  queue: MessageQueue;
  /** Opsional (tes). Default: unduh sungguhan dengan kebijakan dari env MEDIA_*. */
  fetchMedia?: (url: string, kind: MediaKind, hintMime?: string) => Promise<FetchedMedia>;
  adapters: AdapterFactory;
  log: RunnerLog;
  opts: EngineRuntimeOptions;
}) {
  const { db, engines, leases, authStore, qrStore, queue, adapters, log, opts } = deps;
  const inbox = createInbox(leases);
  const fetchMedia = deps.fetchMedia ?? ((url: string, kind: MediaKind, hintMime?: string) =>
    realFetchMedia(url, kind, {
      maxBytes: config.MEDIA_MAX_BYTES, timeoutMs: config.MEDIA_FETCH_TIMEOUT_MS, hintMime,
      policy: { allowHttp: config.MEDIA_ALLOW_HTTP === 'true', allowPrivate: config.MEDIA_ALLOW_PRIVATE_TARGETS === 'true' },
    }));
  const runners = new Map<string, SessionRunner>();
  let engineId = '';
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> = Promise.resolve();
  let stopping = false;
  let lastBeat = 0;
  let lastRenew = 0;

  const onStopped = (r: SessionRunner) => {
    if (runners.get(r.sessionId) === r) runners.delete(r.sessionId);
  };
  const mkRunner = (row: OwnedRow) => {
    const lease: Lease = { sessionId: row.session_id, engineId, fencingToken: Number(row.fencing_token) };
    return new SessionRunner({ db, leases, authStore, qrStore, adapters, log, reconnect: opts.reconnect, queue, inbox, fetchMedia, send: opts.send, onStopped }, lease, row.tenant_id, row.status);
  };

  const scan = () =>
    db.tx({ platform: true }, async (c) =>
      (
        await c.query(
          `SELECT l.session_id, l.tenant_id, l.fencing_token, s.status
           FROM session_leases l JOIN wa_sessions s ON s.id = l.session_id
           WHERE l.engine_id = $1`,
          [engineId]
        )
      ).rows as OwnedRow[]
    );

  /** Lease milik node ini tanpa runner di memori (mis. proses restart): kembalikan ke antrean / selesaikan pemutusan. */
  async function recoverOrphan(row: OwnedRow): Promise<void> {
    const lease: Lease = { sessionId: row.session_id, engineId, fencingToken: Number(row.fencing_token) };
    await leases.withFence(lease, async (c) => {
      if (row.status === 'DISCONNECTING') {
        await transitionSession(c, { sessionId: row.session_id, tenantId: row.tenant_id, to: 'DISCONNECTED', actor: 'ENGINE', reason: 'owner_released', onlyFrom: ['DISCONNECTING'] });
      } else if (OWNED_STATES.includes(row.status)) {
        await transitionSession(c, { sessionId: row.session_id, tenantId: row.tenant_id, to: 'PENDING_ASSIGNMENT', actor: 'ENGINE', reason: 'engine_restarted', eventType: 'session.lease_expired', onlyFrom: OWNED_STATES });
      }
      await releaseLeaseIn(c, lease);
    });
  }

  const snapshot = () => ({
    mem_free_mb: Math.floor(os.freemem() / 1048576),
    cpu_load1: Number(os.loadavg()[0].toFixed(2)),
    sessions_running: runners.size,
  });

  async function tick(): Promise<void> {
    const now = Date.now();
    if (now - lastBeat >= opts.heartbeatSeconds * 1000) {
      lastBeat = now;
      await engines.heartbeat(engineId, snapshot());
    }
    const rows = await scan();
    const byId = new Map(rows.map((r) => [r.session_id, r]));

    // Runner tanpa lease valid (dicabut/diambil alih) => berhenti lokal tanpa menulis.
    for (const r of [...runners.values()]) {
      const row = byId.get(r.sessionId);
      if (!row || Number(row.fencing_token) !== r.lease.fencingToken) await r.lost();
    }

    const renewDue = now - lastRenew >= opts.heartbeatSeconds * 1000;
    if (renewDue) lastRenew = now;
    for (const row of rows) {
      let r = runners.get(row.session_id);
      if (!r) {
        if (stopping) continue;
        if (row.status === 'INITIALIZING') {
          r = mkRunner(row);
          runners.set(row.session_id, r);
          void r.start();
        } else {
          await recoverOrphan(row).catch((err) => log.error({ sessionId: row.session_id, err: (err as Error).message }, 'engine: gagal memulihkan sesi yatim'));
        }
        continue;
      }
      if (row.status === 'DISCONNECTING') void r.disconnectRequested();
      else if (renewDue && !(await leases.renew(r.lease))) await r.lost();
    }
  }

  const schedule = () => {
    if (stopping) return;
    timer = setTimeout(() => {
      ticking = tick()
        .catch((err) => log.error({ err: (err as Error).message }, 'engine: tick gagal'))
        .finally(schedule);
    }, opts.syncIntervalMs);
    timer.unref();
  };

  return {
    get engineId() {
      return engineId;
    },
    get runnerCount() {
      return runners.size;
    },
    getRunner: (sessionId: string) => runners.get(sessionId),
    /** Satu iterasi sinkronisasi (dipakai loop & tes). */
    tick,

    async start(): Promise<{ engineId: string }> {
      const reg = await engines.register({
        nodeName: opts.nodeName,
        hostname: os.hostname(),
        version: opts.version,
        adapterVersion: `${adapters.name}@${adapters.version}`,
        capacity: opts.capacity,
      });
      engineId = reg.id;
      lastBeat = Date.now();
      // Proses baru: lease milik node ini dari inkarnasi sebelumnya dipulihkan dulu (tidak ada runner di memori).
      for (const row of await scan()) {
        await recoverOrphan(row).catch((err) => log.error({ sessionId: row.session_id, err: (err as Error).message }, 'engine: gagal memulihkan sesi yatim'));
      }
      schedule();
      log.info({ engineId, node: opts.nodeName }, 'engine: berjalan');
      return { engineId };
    },

    /** Berhenti rapi: DRAINING, tutup semua socket, lepas lease, sesi kembali ke antrean, STOPPED. */
    async stop(): Promise<void> {
      stopping = true;
      if (timer) clearTimeout(timer);
      await ticking;
      if (!engineId) return;
      await engines.setStatus(engineId, 'DRAINING').catch(() => {});
      await Promise.allSettled([...runners.values()].map((r) => r.shutdownGracefully()));
      await engines.setStatus(engineId, 'STOPPED').catch(() => {});
      log.info({ engineId }, 'engine: berhenti');
    },

    /** Simulasi crash untuk tes: hentikan semua tanpa menulis apa pun (lease dibiarkan kedaluwarsa). */
    async crash(): Promise<void> {
      stopping = true;
      if (timer) clearTimeout(timer);
      await ticking;
      await Promise.allSettled([...runners.values()].map((r) => r.lost()));
    },
  };
}
export type EngineRuntime = ReturnType<typeof createEngineRuntime>;
