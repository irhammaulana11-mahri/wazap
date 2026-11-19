import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';

export class FencedError extends Error {
  constructor() {
    super('Lease hilang atau fencing token tidak valid');
  }
}

export interface Lease {
  sessionId: string;
  engineId: string;
  fencingToken: number;
}

/**
 * Lease + fencing. Hanya dipakai layanan platform (control-plane / engine).
 * Otoritas kepemilikan = baris session_leases; compare-and-set dilakukan atomik di SQL.
 */
export function createLeaseService(db: GatewayDb, opts: { ttlSeconds?: number } = {}) {
  const ttl = () => opts.ttlSeconds ?? config.ENGINE_LEASE_TTL_SECONDS;

  /** Ambil kepemilikan hanya bila belum dimiliki atau lease sudah kedaluwarsa; fencing_token naik. */
  async function acquireIn(c: pg.PoolClient, sessionId: string, engineId: string): Promise<Lease | null> {
    const r = (
      await c.query(
        `UPDATE session_leases l SET engine_id = $2, fencing_token = l.fencing_token + 1,
           lease_expires_at = now() + make_interval(secs => $3), acquired_at = now(), updated_at = now()
         WHERE l.session_id = $1 AND (l.engine_id IS NULL OR l.lease_expires_at < now())
           AND EXISTS (SELECT 1 FROM engine_nodes e WHERE e.id = $2 AND e.status = 'HEALTHY')
         RETURNING fencing_token`,
        [sessionId, engineId, ttl()]
      )
    ).rows[0];
    if (!r) return null;
    await c.query('UPDATE wa_sessions SET engine_id = $2 WHERE id = $1', [sessionId, engineId]);
    return { sessionId, engineId, fencingToken: Number(r.fencing_token) };
  }

  return {
    acquireIn,

    acquire: (sessionId: string, engineId: string) =>
      db.tx({ platform: true }, (c) => acquireIn(c, sessionId, engineId)),

    /** Perpanjang lease; gagal (false) bila owner/token tidak lagi cocok => engine WAJIB berhenti. */
    async renew(l: Lease): Promise<boolean> {
      const r = await db.tx({ platform: true }, (c) =>
        c.query(
          `UPDATE session_leases SET lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
           WHERE session_id = $1 AND engine_id = $2 AND fencing_token = $3`,
          [l.sessionId, l.engineId, l.fencingToken, ttl()]
        )
      );
      return r.rowCount === 1;
    },

    /** Lepas lease secara sukarela (token tetap, agar monoton). */
    release: (l: Lease): Promise<boolean> => db.tx({ platform: true }, (c) => releaseLeaseIn(c, l)),

    /**
     * Jalankan operasi penulisan persisten (mis. simpan kredensial) hanya jika engine masih pemilik sah.
     * Baris lease dikunci FOR SHARE selama transaksi, sehingga takeover (UPDATE) menunggu sampai commit:
     * engine lama tidak dapat menulis setelah kehilangan kepemilikan.
     */
    async withFence<T>(l: Lease, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      return db.tx({ platform: true }, async (c) => {
        const ok = (
          await c.query(
            `SELECT 1 FROM session_leases WHERE session_id = $1 AND engine_id = $2 AND fencing_token = $3
               AND lease_expires_at > now() FOR SHARE`,
            [l.sessionId, l.engineId, l.fencingToken]
          )
        ).rows[0];
        if (!ok) throw new FencedError();
        return fn(c);
      });
    },
  };
}
export type LeaseService = ReturnType<typeof createLeaseService>;

/** Lepas lease dalam transaksi yang sudah ada (token tetap, agar monoton). Hanya berhasil bila owner+token cocok. */
export async function releaseLeaseIn(c: pg.PoolClient, l: Lease): Promise<boolean> {
  const r = await c.query(
    `UPDATE session_leases SET engine_id = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE session_id = $1 AND engine_id = $2 AND fencing_token = $3`,
    [l.sessionId, l.engineId, l.fencingToken]
  );
  if (r.rowCount === 1) await c.query('UPDATE wa_sessions SET engine_id = NULL WHERE id = $1', [l.sessionId]);
  return r.rowCount === 1;
}

/** Lepas paksa tanpa pemilik (jalur tenant: reconnect/delete). Token tidak diubah; owner lama kehilangan lease. */
export async function revokeLeaseIn(c: pg.PoolClient, sessionId: string, tenantId: string | null) {
  await c.query(
    `UPDATE session_leases SET engine_id = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE session_id = $1 AND ($2::uuid IS NULL OR tenant_id = $2) AND engine_id IS NOT NULL`,
    [sessionId, tenantId]
  );
  await c.query('UPDATE wa_sessions SET engine_id = NULL WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2)', [sessionId, tenantId]);
}
