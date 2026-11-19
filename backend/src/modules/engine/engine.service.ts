import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';

export interface EngineRegistration {
  nodeName: string;
  hostname: string;
  version: string;
  adapterVersion?: string;
  capacity: { maxSessions: number; weight?: number; minFreeMemMb?: number };
}

export interface ResourceSnapshot {
  cpu_pct?: number;
  mem_free_mb?: number;
  [k: string]: unknown;
}

const PLACEMENT_LOCK = 'wazap:placement';

export function createEngineService(db: GatewayDb) {
  return {
    /** Upsert berdasarkan node_name (restart engine memakai ID yang sama). */
    async register(r: EngineRegistration): Promise<{ id: string }> {
      const cap = { max_sessions: r.capacity.maxSessions, weight: r.capacity.weight ?? 1, min_free_mem_mb: r.capacity.minFreeMemMb };
      return db.tx({ platform: true }, async (c) =>
        (
          await c.query(
            `INSERT INTO engine_nodes (node_name, hostname, status, version, adapter_version, capacity_config, heartbeat_at)
             VALUES ($1,$2,'HEALTHY',$3,$4,$5::jsonb, now())
             ON CONFLICT (node_name) DO UPDATE SET hostname = EXCLUDED.hostname, status = 'HEALTHY', version = EXCLUDED.version,
               adapter_version = EXCLUDED.adapter_version, capacity_config = EXCLUDED.capacity_config, heartbeat_at = now()
             RETURNING id`,
            [r.nodeName, r.hostname, r.version, r.adapterVersion ?? null, JSON.stringify(cap)]
          )
        ).rows[0]
      );
    },

    /** Heartbeat memulihkan SUSPECT/UNHEALTHY -> HEALTHY, kecuali DRAINING/STOPPED. */
    async heartbeat(engineId: string, snapshot: ResourceSnapshot = {}): Promise<boolean> {
      const r = await db.tx({ platform: true }, (c) =>
        c.query(
          `UPDATE engine_nodes SET heartbeat_at = now(), resource_snapshot = $2::jsonb,
             status = CASE WHEN status IN ('STARTING','SUSPECT','UNHEALTHY') THEN 'HEALTHY' ELSE status END
           WHERE id = $1 AND status <> 'STOPPED'`,
          [engineId, JSON.stringify(snapshot)]
        )
      );
      return r.rowCount === 1;
    },

    /** DRAINING: tidak menerima sesi baru; STOPPED: engine berhenti bersih. */
    async setStatus(engineId: string, status: 'DRAINING' | 'STOPPED'): Promise<void> {
      await db.tx({ platform: true }, (c) => c.query('UPDATE engine_nodes SET status = $2 WHERE id = $1', [engineId, status]));
    },

    /** HEALTHY -> SUSPECT -> UNHEALTHY berdasarkan umur heartbeat. Mengembalikan jumlah perubahan. */
    async sweep(opts: { suspectAfterSec?: number; unhealthyAfterSec?: number } = {}) {
      const s = opts.suspectAfterSec ?? config.ENGINE_SUSPECT_AFTER_SECONDS;
      const u = opts.unhealthyAfterSec ?? config.ENGINE_UNHEALTHY_AFTER_SECONDS;
      return db.tx({ platform: true }, async (c) => {
        const un = await c.query(
          `UPDATE engine_nodes SET status = 'UNHEALTHY'
           WHERE status IN ('HEALTHY','SUSPECT','STARTING') AND heartbeat_at < now() - make_interval(secs => $1)`, [u]);
        const su = await c.query(
          `UPDATE engine_nodes SET status = 'SUSPECT'
           WHERE status = 'HEALTHY' AND heartbeat_at < now() - make_interval(secs => $1)`, [s]);
        return { suspect: su.rowCount ?? 0, unhealthy: un.rowCount ?? 0 };
      });
    },
  };
}
export type EngineService = ReturnType<typeof createEngineService>;

/** Kunci transaksi global untuk penempatan: mencegah dua dispatcher melampaui kapasitas. */
export const lockPlacement = (c: pg.PoolClient) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PLACEMENT_LOCK]);

/**
 * Pilih engine HEALTHY (heartbeat segar) yang masih punya kapasitas, weighted least-loaded.
 * Beban = jumlah lease aktif milik engine (otoritatif). Tanpa kapasitas => null (sesi tetap PENDING_ASSIGNMENT).
 * Panggil setelah lockPlacement() dalam transaksi yang sama dengan acquire lease.
 */
export async function chooseEngine(c: pg.PoolClient, freshSec = config.ENGINE_SUSPECT_AFTER_SECONDS): Promise<string | null> {
  const r = (
    await c.query(
      `SELECT e.id
       FROM engine_nodes e
       LEFT JOIN session_leases l ON l.engine_id = e.id AND l.lease_expires_at > now()
       WHERE e.status = 'HEALTHY' AND e.heartbeat_at > now() - make_interval(secs => $1)
         AND (e.capacity_config->>'min_free_mem_mb' IS NULL OR e.resource_snapshot->>'mem_free_mb' IS NULL
              OR (e.resource_snapshot->>'mem_free_mb')::numeric >= (e.capacity_config->>'min_free_mem_mb')::numeric)
       GROUP BY e.id
       HAVING count(l.session_id) < (e.capacity_config->>'max_sessions')::int
       ORDER BY count(l.session_id)::numeric / GREATEST(COALESCE((e.capacity_config->>'weight')::numeric, 1), 0.0001),
                count(l.session_id), e.id
       LIMIT 1`,
      [freshSec]
    )
  ).rows[0];
  return r?.id ?? null;
}
