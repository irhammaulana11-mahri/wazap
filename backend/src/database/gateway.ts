import pg from 'pg';
import { config } from '../config/env.js';

/** Konteks RLS transaksi-lokal. Tidak pernah diisi dari input klien. */
export interface DbContext {
  tenantId?: string;
  userId?: string;
  loginEmail?: string;
  apiKeyHash?: string;
  refreshHash?: string;
  /** Hash token undangan yang sedang diterima (lihat kebijakan tenant_invitations). */
  inviteHash?: string;
  /** Hash kode workspace yang sedang dipakai pemohon (lihat kebijakan tenant_join_codes / tenant_join_requests). */
  joinHash?: string;
  /** Layanan istimewa (control-plane/engine). Hanya boleh dipakai di src/modules/engine dan src/runtime. */
  platform?: boolean;
}

const CTX_KEYS: Record<Exclude<keyof DbContext, 'platform'>, string> = {
  tenantId: 'app.tenant_id',
  userId: 'app.user_id',
  loginEmail: 'app.login_email',
  apiKeyHash: 'app.api_key_hash',
  refreshHash: 'app.refresh_hash',
  inviteHash: 'app.invite_hash',
  joinHash: 'app.join_hash',
};

export interface GatewayDb {
  pool: pg.Pool;
  schema: string;
  /** Jalankan fn dalam satu transaksi dengan konteks RLS (SET LOCAL via set_config(..., true)). */
  tx<T>(ctx: DbContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Koneksi yang diputus server (restart/failover PostgreSQL, jaringan putus, pg_terminate_backend) memancarkan event 'error'
 * pada klien (dan pada pool bila sedang idle). Tanpa listener, Node melempar uncaughtException dan SELURUH proses mati.
 * Listener ini hanya mencatat: klien yang rusak dibuang pool, query berikutnya memakai koneksi baru.
 */
export function guardPool(pool: pg.Pool, onError: (err: Error) => void = defaultDbError): pg.Pool {
  pool.on('error', onError);
  pool.on('connect', (client) => { client.on('error', onError); });
  return pool;
}
const defaultDbError = (err: Error) => {
  if (config.LOG_LEVEL === 'silent') return;
  // Hanya pesan galat (tanpa teks query/parameter) agar tidak membocorkan data.
  console.error(JSON.stringify({ level: 'error', msg: 'pg: koneksi database bermasalah (akan dipulihkan otomatis)', err: err.message }));
};

export function createGatewayDb(schema: string, opts: { pool?: pg.Pool } = {}): GatewayDb {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Nama schema tidak valid');
  const pool = guardPool(
    opts.pool ??
    new pg.Pool({
      ...(config.DATABASE_URL
        ? { connectionString: config.DATABASE_URL }
        : {
            host: config.DB_HOST,
            port: config.DB_PORT,
            database: config.DB_DATABASE,
            user: config.DB_USERNAME,
            password: config.DB_PASSWORD || undefined,
          }),
      max: config.DB_POOL_MAX,
      // Tanpa batas ini, permintaan menggantung selamanya saat DB hang/penuh. Setelah batas => galat => 503 (lihat http/errors.ts).
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
      keepAlive: true, // deteksi koneksi mati diam-diam (firewall/failover) lebih cepat
      options: `-c search_path=${schema}`,
    }));

  return {
    pool,
    schema,
    async tx(ctx, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (ctx.platform) await client.query('SELECT set_config($1, $2, true)', ['app.scope', 'platform']);
        for (const [k, setting] of Object.entries(CTX_KEYS) as [Exclude<keyof DbContext, 'platform'>, string][]) {
          const v = ctx[k];
          if (v !== undefined) await client.query('SELECT set_config($1, $2, true)', [setting, v]);
        }
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

let shared: GatewayDb | undefined;
/** Instance default (schema dari config). Dibuat lazy agar test bisa memakai schema sendiri. */
export function getGatewayDb(): GatewayDb {
  return (shared ??= createGatewayDb(config.DB_SCHEMA));
}

/** Pool khusus migrasi (pemilik schema) bila DB_MIGRATE_USERNAME diisi; undefined bila tidak (migrasi memakai pool runtime). */
export function createMigratePool(): pg.Pool | undefined {
  if (!config.DB_MIGRATE_USERNAME) return undefined;
  return guardPool(new pg.Pool({
    ...(config.DATABASE_URL
      ? { connectionString: config.DATABASE_URL, user: config.DB_MIGRATE_USERNAME, password: config.DB_MIGRATE_PASSWORD || undefined }
      : {
          host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE,
          user: config.DB_MIGRATE_USERNAME, password: config.DB_MIGRATE_PASSWORD || undefined,
        }),
    max: 2,
  }));
}
