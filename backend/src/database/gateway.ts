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
};

export interface GatewayDb {
  pool: pg.Pool;
  schema: string;
  /** Jalankan fn dalam satu transaksi dengan konteks RLS (SET LOCAL via set_config(..., true)). */
  tx<T>(ctx: DbContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createGatewayDb(schema: string, opts: { pool?: pg.Pool } = {}): GatewayDb {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Nama schema tidak valid');
  const pool =
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
      options: `-c search_path=${schema}`,
    });

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
  return new pg.Pool({
    ...(config.DATABASE_URL
      ? { connectionString: config.DATABASE_URL, user: config.DB_MIGRATE_USERNAME, password: config.DB_MIGRATE_PASSWORD || undefined }
      : {
          host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE,
          user: config.DB_MIGRATE_USERNAME, password: config.DB_MIGRATE_PASSWORD || undefined,
        }),
    max: 2,
  });
}
