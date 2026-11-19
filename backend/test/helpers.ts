import crypto from 'crypto';
import pg from 'pg';

process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const { config } = await import('../src/config/env.js');
const { createGatewayDb } = await import('../src/database/gateway.js');
const { migrate } = await import('../src/database/migrator.js');

export async function dbAvailable(): Promise<boolean> {
  const c = new pg.Client({
    host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE, user: config.DB_USERNAME,
    password: config.DB_PASSWORD || undefined, connectionTimeoutMillis: 2000,
  });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

/** Schema sementara terisolasi (gw_test_*) di database dev; tidak menyentuh schema lain. */
export async function createTestDb(poolMax = 5) {
  const schema = `gw_test_${crypto.randomBytes(5).toString('hex')}`;
  const db = createGatewayDb(schema);
  await migrate(db.pool, schema);
  return {
    db,
    schema,
    async drop() {
      await db.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    },
  };
}
export { config };
