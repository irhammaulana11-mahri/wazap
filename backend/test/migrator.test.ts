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

test('0021: ADMIN dikonversi ke MEMBER di keanggotaan, undangan, dan permintaan bergabung; RLS FORCE dan trigger penjaga kembali aktif; CHECK menolak ADMIN (ADR-053)', { skip }, async () => {
  const src = path.resolve(new URL('../src/database/migrations', import.meta.url).pathname);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig21-'));
  for (const f of fs.readdirSync(src).filter((x) => /^\d{4}_.+\.sql$/.test(x) && x < '0021')) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  const schema = `gw_test_${crypto.randomBytes(5).toString('hex')}`;
  const t = await createTestDb(); // hanya untuk pool
  const sess = async <T>(fn: (c: any) => Promise<T>) => { const c = await t.db.pool.connect(); try { await c.query(`SET search_path TO ${schema}`); return await fn(c); } finally { c.release(); } };
  const noForce = async (c: any, on: boolean) => { for (const tb of ['tenant_memberships', 'tenant_invitations', 'tenant_join_requests']) await c.query(`ALTER TABLE ${tb} ${on ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`); };
  try {
    await migrate(t.db.pool, schema, dir);                                            // keadaan sebelum 0021: ADMIN masih sah
    const ids = { tenant: crypto.randomUUID(), u1: crypto.randomUUID(), u2: crypto.randomUUID() };
    await sess(async (c) => {
      await noForce(c, false);
      await c.query(`ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY; ALTER TABLE users NO FORCE ROW LEVEL SECURITY`);
      await c.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Uji 0021', $2)`, [ids.tenant, `uji-${crypto.randomBytes(4).toString('hex')}`]);
      await c.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'a1@x.test', 'x'), ($2, 'a2@x.test', 'x')`, [ids.u1, ids.u2]);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1, $2, 'ADMIN', 'a1@x.test'), ($1, $3, 'OWNER', 'a2@x.test')`, [ids.tenant, ids.u1, ids.u2]);
      await c.query(`INSERT INTO tenant_invitations (tenant_id, email, role, token_hash, expires_at) VALUES ($1, 'inv@x.test', 'ADMIN', $2, now() + interval '1 day')`, [ids.tenant, 'a'.repeat(64)]);
      await c.query(`INSERT INTO tenant_join_requests (tenant_id, user_id, email, status, expires_at, decided_by, decided_role, decided_at) VALUES ($1, $2, 'a1@x.test', 'APPROVED', now() + interval '1 day', $3, 'ADMIN', now())`, [ids.tenant, ids.u1, ids.u2]);
      await c.query(`ALTER TABLE tenants FORCE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY`);
      await noForce(c, true);
    });
    fs.copyFileSync(path.join(src, '0021_remove_admin_role.sql'), path.join(dir, '0021_remove_admin_role.sql'));
    const r = await migrate(t.db.pool, schema, dir);
    assert.deepEqual(r.applied, ['0021_remove_admin_role.sql']);
    await sess(async (c) => {
      const flags = (await c.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = $1::regnamespace AND relname = ANY($2)`, [schema, ['tenant_memberships', 'tenant_invitations', 'tenant_join_requests']])).rows;
      assert.equal(flags.length, 3); for (const f of flags) assert.deepEqual([f.relrowsecurity, f.relforcerowsecurity], [true, true], `${f.relname}: ENABLE+FORCE RLS harus kembali aktif`);
      const trg = (await c.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_tenant_memberships_guard' AND tgrelid = 'tenant_memberships'::regclass`)).rows;
      assert.deepEqual(trg.map((x: any) => x.tgenabled), ['O'], 'trigger penjaga keanggotaan harus aktif lagi');
      await noForce(c, false);
      assert.deepEqual((await c.query(`SELECT role FROM tenant_memberships ORDER BY role`)).rows.map((x: any) => x.role), ['MEMBER', 'OWNER'], 'ADMIN -> MEMBER, OWNER tidak tersentuh');
      assert.deepEqual((await c.query(`SELECT role FROM tenant_invitations`)).rows.map((x: any) => x.role), ['MEMBER']);
      assert.deepEqual((await c.query(`SELECT decided_role FROM tenant_join_requests`)).rows.map((x: any) => x.decided_role), ['MEMBER']);
      const inTx = async (fn: () => Promise<void>) => { await c.query('BEGIN'); try { await fn(); } finally { await c.query('ROLLBACK'); } };
      await inTx(async () => {   // trigger penjaga (0016) menolak lebih dulu bila aktif; matikan hanya di transaksi yang di-rollback agar yang diuji adalah CHECK
        await c.query('ALTER TABLE tenant_memberships DISABLE TRIGGER trg_tenant_memberships_guard');
        await assert.rejects(c.query(`UPDATE tenant_memberships SET role = 'ADMIN' WHERE role = 'MEMBER'`), /chk_memberships_role/, 'CHECK keanggotaan menolak ADMIN');
      });
      await inTx(async () => { await assert.rejects(c.query(`INSERT INTO tenant_invitations (tenant_id, email, role, token_hash, expires_at) VALUES ($1, 'z@x.test', 'ADMIN', $2, now() + interval '1 day')`, [ids.tenant, 'b'.repeat(64)]), /chk_invitations_role/); });
      await inTx(async () => { await assert.rejects(c.query(`UPDATE tenant_join_requests SET decided_role = 'ADMIN'`), /chk_join_requests_decided_role/); });
      await noForce(c, true);
    });
  } finally {
    await t.db.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    fs.rmSync(dir, { recursive: true, force: true });
    await t.drop();
  }
});
