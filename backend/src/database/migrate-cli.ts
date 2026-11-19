import pg from 'pg';
import { config } from '../config/env.js';
import { createMigratePool, getGatewayDb } from './gateway.js';
import { migrate } from './migrator.js';

/** `npm run migrate` / `npm run migrate:prod`: jalankan migrasi dengan kredensial migrator (bila ada) lalu keluar. */
async function main() {
  const own = createMigratePool();
  const db = own ? undefined : getGatewayDb();
  const pool: pg.Pool = own ?? db!.pool;
  try {
    const r = await migrate(pool, config.DB_SCHEMA);
    console.log(JSON.stringify({ schema: config.DB_SCHEMA, as: own ? 'migrator' : 'runtime', applied: r.applied, skipped: r.skipped.length }));
  } finally {
    await (own ? own.end() : db!.close());
  }
}
main().catch((err) => { console.error('migrasi gagal:', (err as Error).message); process.exit(1); });
