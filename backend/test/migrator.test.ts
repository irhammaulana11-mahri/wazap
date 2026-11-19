import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const { migrate } = await import('../src/database/migrator.js');
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';

test('migrasi diterapkan sekali dan idempoten', { skip }, async () => {
  const t = await createTestDb();
  try {
    const again = await migrate(t.db.pool, t.schema);
    assert.deepEqual(again.applied, []);
    assert.ok(again.skipped.includes('0001_identity_tenant.sql'));
    const tables = (await t.db.pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [t.schema])).rows.map((r) => r.tablename);
    for (const n of ['tenants', 'users', 'tenant_memberships', 'tenant_settings', 'api_keys', 'refresh_tokens', 'schema_migrations'])
      assert.ok(tables.includes(n), n);
  } finally { await t.drop(); }
});

test('checksum berubah ditolak; migrasi gagal di-rollback', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const schema = `gw_test_${crypto.randomBytes(5).toString('hex')}`;
  const t = await createTestDb(); // hanya untuk pool
  try {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await migrate(t.db.pool, schema, dir);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, x int);');
    await assert.rejects(() => migrate(t.db.pool, schema, dir), /Checksum/);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT nonexistent_fn();');
    await assert.rejects(() => migrate(t.db.pool, schema, dir), /0002_bad.sql gagal/);
    const b = await t.db.pool.query(`SELECT to_regclass($1) AS r`, [`${schema}.b`]);
    assert.equal(b.rows[0].r, null, 'tabel b harus ter-rollback');
  } finally {
    await t.db.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await t.drop();
    fs.rmSync(dir, { recursive: true });
  }
});

test('schema tidak valid ditolak (anti-injection)', async () => {
  const { createGatewayDb } = await import('../src/database/gateway.js');
  assert.throws(() => createGatewayDb('x; DROP SCHEMA public'));
  await assert.rejects(() => migrate({} as any, 'bad-name; --'), /tidak valid/);
});
