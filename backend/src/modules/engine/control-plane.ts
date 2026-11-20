import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { transitionSession, OWNED_STATES } from '../sessions/lifecycle.js';
import { chooseEngine, lockPlacement, type EngineService } from './engine.service.js';
import { createLeaseService } from './lease.service.js';
import { eraseAuthIn } from './auth-store.js';
import { createMessageQueue } from './message-queue.js';

export interface ControlPlaneLog {
  info: (o: any, m?: string) => void;
  warn: (o: any, m?: string) => void;
  error: (o: any, m?: string) => void;
}
export interface ReconcileReport {
  engines: { suspect: number; unhealthy: number };
  leasesExpired: number;
  finalized: { disconnected: number; deleted: number };
  assigned: number;
  noCapacity: number;
  messages: { abandoned: number; expired: number };
}

const BATCH = 50;

/**
 * Control-plane: satu iterasi rekonsiliasi (idempoten, aman dijalankan berulang).
 * 1) sweep kesehatan engine, 2) kedaluwarsakan lease & pulihkan sesi, 3) finalisasi DISCONNECTING/DELETING tanpa owner,
 * 4) tempatkan sesi PENDING_ASSIGNMENT (adil antar tenant). Tiap sesi diproses dalam transaksinya sendiri.
 */
export function createControlPlane(db: GatewayDb, engines: EngineService, log: ControlPlaneLog) {
  const leases = createLeaseService(db);
  const queue = createMessageQueue(db, leases);

  async function expireLeases(): Promise<number> {
    const expired = await db.tx({ platform: true }, async (c) =>
      (
        await c.query(
          `UPDATE session_leases SET engine_id = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE engine_id IS NOT NULL AND lease_expires_at < now() RETURNING session_id, tenant_id`
        )
      ).rows as { session_id: string; tenant_id: string }[]
    );
    for (const e of expired) {
      try {
        await db.tx({ platform: true }, async (c) => {
          await c.query('UPDATE wa_sessions SET engine_id = NULL WHERE id = $1', [e.session_id]);
          // Sesi yang masih diinginkan CONNECTED kembali ke antrean penempatan; fencing token naik saat owner baru.
          const s = (await c.query('SELECT desired_state FROM wa_sessions WHERE id = $1', [e.session_id])).rows[0];
          if (s?.desired_state === 'CONNECTED') {
            await transitionSession(c, {
              sessionId: e.session_id, tenantId: null, to: 'PENDING_ASSIGNMENT', actor: 'SYSTEM',
              reason: 'lease_expired', eventType: 'session.lease_expired', onlyFrom: OWNED_STATES,
            });
          }
        });
      } catch (err) {
        log.error({ err, sessionId: e.session_id }, 'gagal memulihkan sesi dengan lease kedaluwarsa');
      }
    }
    return expired.length;
  }

  async function finalize(): Promise<{ disconnected: number; deleted: number }> {
    const rows = await db.tx({ platform: true }, async (c) =>
      (
        await c.query(
          `SELECT s.id, s.status FROM wa_sessions s JOIN session_leases l ON l.session_id = s.id
           WHERE s.status IN ('DISCONNECTING','DELETING') AND l.engine_id IS NULL ORDER BY s.updated_at LIMIT $1`, [BATCH]
        )
      ).rows as { id: string; status: string }[]
    );
    let disconnected = 0, deleted = 0;
    for (const r of rows) {
      try {
        await db.tx({ platform: true }, async (c) => {
          if (r.status === 'DISCONNECTING') {
            const t = await transitionSession(c, { sessionId: r.id, tenantId: null, to: 'DISCONNECTED', actor: 'SYSTEM', reason: 'owner_released', onlyFrom: ['DISCONNECTING'] });
            if (t) disconnected++;
          } else {
            // Tandai DELETED lalu hapus seluruh auth state terenkripsi + QR + referensi kredensial.
            const t = await transitionSession(c, { sessionId: r.id, tenantId: null, to: 'DELETED', actor: 'SYSTEM', reason: 'cleanup_done', onlyFrom: ['DELETING'] });
            if (t) {
              await eraseAuthIn(c, r.id);
              await c.query(`UPDATE message_queue SET status = 'CANCELLED', last_error_code = 'SESSION_DELETED', completed_at = now() WHERE session_id = $1 AND status = 'PENDING'`, [r.id]);
              deleted++;
            }
          }
        });
      } catch (err) {
        log.error({ err, sessionId: r.id }, 'gagal finalisasi sesi');
      }
    }
    return { disconnected, deleted };
  }

  async function assignPending(): Promise<{ assigned: number; noCapacity: number }> {
    // Adil antar tenant: round-robin per tenant (urutan ke-n tiap tenant lebih dulu daripada ke-(n+1)).
    const pending = await db.tx({ platform: true }, async (c) =>
      (
        await c.query(
          `SELECT id FROM (
             SELECT id, updated_at, row_number() OVER (PARTITION BY tenant_id ORDER BY updated_at, id) AS rn
             FROM wa_sessions WHERE status = 'PENDING_ASSIGNMENT' AND desired_state = 'CONNECTED') q
           ORDER BY rn, updated_at LIMIT $1`, [BATCH]
        )
      ).rows as { id: string }[]
    );
    let assigned = 0, noCapacity = 0;
    for (const p of pending) {
      try {
        const res = await db.tx({ platform: true }, async (c) => {
          await lockPlacement(c);
          const cur = (await c.query(`SELECT 1 FROM wa_sessions WHERE id = $1 AND status = 'PENDING_ASSIGNMENT' AND desired_state = 'CONNECTED' FOR UPDATE`, [p.id])).rows[0];
          if (!cur) return 'skipped' as const;
          const engineId = await chooseEngine(c);
          if (!engineId) return 'none' as const;
          const lease = await leases.acquireIn(c, p.id, engineId);
          if (!lease) return 'leased' as const; // lease sesi ini masih dipegang pihak lain: lewati, jangan menghentikan antrean
          const t = await transitionSession(c, {
            sessionId: p.id, tenantId: null, to: 'INITIALIZING', actor: 'SYSTEM', eventType: 'session.assigned',
            reason: 'assigned', payload: { engine_id: engineId, fencing_token: lease.fencingToken }, onlyFrom: ['PENDING_ASSIGNMENT'],
          });
          if (!t) throw new Error('transisi INITIALIZING ditolak'); // rollback: lease ikut dibatalkan
          return 'assigned' as const;
        });
        if (res === 'assigned') assigned++;
        else if (res === 'none') { noCapacity++; break; } // tak ada kapasitas: jangan memutar sia-sia
      } catch (err) {
        log.error({ err, sessionId: p.id }, 'gagal menempatkan sesi');
      }
    }
    return { assigned, noCapacity };
  }

  async function reconcile(): Promise<ReconcileReport> {
    const eng = await engines.sweep();
    const leasesExpired = await expireLeases();
    const finalized = await finalize();
    const messages = await queue.reap();
    const a = await assignPending();
    return { engines: eng, leasesExpired, finalized, assigned: a.assigned, noCapacity: a.noCapacity, messages };
  }

  return { reconcile, expireLeases, finalize, assignPending };
}
export type ControlPlane = ReturnType<typeof createControlPlane>;

/**
 * Loop control-plane dengan leader election (advisory lock sesi): hanya satu instans aktif.
 * Lock dipegang di koneksi khusus; bila koneksi mati, lock lepas otomatis dan instans lain mengambil alih.
 */
export function startControlPlaneLoop(db: GatewayDb, cp: ControlPlane, log: ControlPlaneLog, intervalMs = config.CONTROL_PLANE_INTERVAL_MS) {
  // Kunci advisory berlaku se-database: dibatasi per schema agar instans schema lain (mis. tes, staging) tidak saling memblokir.
  const lockKey = `wazap:control-plane:${db.schema}`;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let leader: import('pg').PoolClient | undefined;
  let running: Promise<void> = Promise.resolve();

  /** Lepas peran leader dan kembalikan (buang) koneksinya ke pool tepat sekali; aman dipanggil dari event maupun tick. */
  const dropLeader = (c: import('pg').PoolClient | undefined, why: string) => {
    if (!c || leader !== c) return;
    leader = undefined;
    try { c.release(true); } catch { /* sudah dilepas */ }
    log.warn({}, `control-plane: ${why}, memilih ulang`);
  };
  const tick = async () => {
    try {
      if (leader) {
        // Lock bertahan selama koneksi ini hidup. Bila koneksi mati diam-diam (restart DB), lock sudah lepas dan instans lain
        // dapat menjadi leader: berhenti memimpin sebelum rekonsiliasi supaya tidak pernah ada dua leader aktif.
        const cur = leader;
        try { await cur.query('SELECT 1'); } catch { dropLeader(cur, 'koneksi leader putus'); return; }
      }
      if (!leader) {
        const c = await db.pool.connect();
        const onDead = () => dropLeader(c, 'koneksi leader putus');
        c.on('error', onDead); c.on('end', onDead);
        let got = false;
        try { got = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey])).rows[0].ok; }
        catch (err) { c.removeListener('error', onDead); c.removeListener('end', onDead); c.release(true); throw err; }
        if (!got) { c.removeListener('error', onDead); c.removeListener('end', onDead); c.release(); return; }
        leader = c;
        log.info({}, 'control-plane: menjadi leader');
      }
      const rep = await cp.reconcile();
      if (rep.assigned || rep.leasesExpired || rep.finalized.deleted || rep.finalized.disconnected || rep.engines.unhealthy || rep.messages.abandoned || rep.messages.expired) log.info(rep, 'control-plane reconcile');
    } catch (err) {
      log.error({ err }, 'control-plane tick gagal');
      dropLeader(leader, 'tick gagal'); // buang koneksi => lock lepas
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { running = tick().finally(schedule); }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      if (leader) { await leader.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {}); leader.release(); leader = undefined; }
    },
  };
}
