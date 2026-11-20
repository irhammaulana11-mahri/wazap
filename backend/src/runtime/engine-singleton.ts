import type pg from 'pg';
import type { GatewayDb } from '../database/gateway.js';

/**
 * Satu proses per nama node engine. `engines.register` meng-upsert berdasarkan node_name, sehingga dua proses dengan nama sama
 * (PM2 cluster, salah start dua kali) akan berbagi engine_id DAN fencing token yang sama: fencing tidak dapat membedakannya dan satu
 * sesi WhatsApp bisa dipegang dua socket sekaligus. Kunci advisory sesi di koneksi khusus mencegahnya; lock lepas otomatis bila proses mati.
 *
 * Bila koneksi kunci putus (blip DB), kunci dicoba direbut kembali beberapa kali. Berhasil => lanjut; gagal (ada pihak lain yang
 * sudah memegangnya) => `onFatal`: proses WAJIB berhenti agar tidak ada dua pemilik.
 */
export interface EngineSingleton { release(): Promise<void> }
export class EngineAlreadyRunningError extends Error {
  constructor(nodeName: string) {
    super(`Engine "${nodeName}" sudah berjalan di proses lain (gunakan ENGINE_NODE_NAME yang berbeda per proses)`);
  }
}

export async function acquireEngineSingleton(
  db: Pick<GatewayDb, 'pool' | 'schema'>,
  nodeName: string,
  log: { warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void },
  onFatal: (why: string) => void,
  opts: { retries?: number; retryMs?: number } = {}
): Promise<EngineSingleton> {
  const key = `wazap:engine:${db.schema}:${nodeName}`;
  const retries = opts.retries ?? 5;
  const retryMs = opts.retryMs ?? 1000;
  let held: pg.PoolClient | undefined;
  let closed = false;
  let recovering = false;

  const take = async (): Promise<pg.PoolClient | null> => {
    const c = await db.pool.connect();
    const dead = () => void lost(c);
    try {
      c.on('error', dead); c.on('end', dead);
      const ok = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key])).rows[0].ok as boolean;
      if (ok) return c;
    } catch { /* koneksi bermasalah: perlakukan sebagai gagal */ }
    c.removeListener('error', dead); c.removeListener('end', dead);
    try { c.release(true); } catch { /* sudah dilepas */ }
    return null;
  };

  async function lost(c: pg.PoolClient) {
    if (closed || held !== c || recovering) return;
    held = undefined; recovering = true;
    try { c.release(true); } catch { /* sudah dilepas */ }
    log.warn({ node: nodeName }, 'engine: koneksi kunci singleton putus, mencoba merebut kembali');
    for (let i = 0; i < retries && !closed; i++) {
      await new Promise((r) => setTimeout(r, retryMs).unref());
      const n = await take().catch(() => null);
      if (n) { held = n; recovering = false; log.warn({ node: nodeName }, 'engine: kunci singleton direbut kembali'); return; }
    }
    recovering = false;
    if (!closed) { log.error({ node: nodeName }, 'engine: kunci singleton hilang dan tidak dapat direbut kembali'); onFatal('engine_singleton_lost'); }
  }

  const first = await take();
  if (!first) throw new EngineAlreadyRunningError(nodeName);
  held = first;

  return {
    async release() {
      closed = true;
      const c = held; held = undefined;
      if (!c) return;
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
      try { c.release(); } catch { /* sudah dilepas */ }
    },
  };
}
