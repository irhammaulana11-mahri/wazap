import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createGatewayDb } = await import('../src/database/gateway.js');
const t = skip ? null : await createTestDb();
after(async () => { await t?.drop(); });

const id = () => crypto.randomUUID();
const A = { tenant: id(), user: id() }, B = { tenant: id(), user: id() };
const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function seed(x: { tenant: string; user: string }, label: string) {
  await t!.db.tx({ tenantId: x.tenant, userId: x.user }, async (c) => {
    await c.query(`INSERT INTO users (id,email,password_hash) VALUES ($1,$2,'h')`, [x.user, `${label}@x.test`]);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)`, [x.tenant, label, `${label}-ws`]);
    await c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')`, [x.tenant, x.user]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [x.tenant]);
    await c.query(`INSERT INTO api_keys (tenant_id,name,key_prefix,key_hash,scopes,created_by_user_id) VALUES ($1,'k','gwk_',$2,'["sessions:read"]',$3)`,
      [x.tenant, hashOf(label), x.user]);
  });
}
if (!skip) { await seed(A, 'a'); await seed(B, 'b'); }

const count = (ctx: any, table: string) =>
  t!.db.tx(ctx, async (c) => (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number);

test('role aplikasi tidak superuser/BYPASSRLS dan RLS FORCE aktif', { skip }, async () => {
  const r = (await t!.db.pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  assert.equal(r.rolsuper, false); assert.equal(r.rolbypassrls, false);
  const f = (await t!.db.pool.query(
    `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND relkind='r' AND relname <> 'schema_migrations' AND NOT (relrowsecurity AND relforcerowsecurity)`, [t!.schema])).rows;
  assert.deepEqual(f, [], 'semua tabel domain harus ENABLE+FORCE RLS');
});

test('tanpa konteks tidak ada baris yang terlihat', { skip }, async () => {
  for (const tb of ['tenants', 'users', 'tenant_memberships', 'tenant_settings', 'api_keys', 'refresh_tokens'])
    assert.equal(await count({}, tb), 0, tb);
});

test('tenant A hanya melihat datanya sendiri', { skip }, async () => {
  const ctx = { tenantId: A.tenant };
  assert.equal(await count(ctx, 'api_keys'), 1);
  assert.equal(await count(ctx, 'tenant_settings'), 1);
  assert.equal(await count(ctx, 'tenant_memberships'), 1);
  assert.equal(await count(ctx, 'tenants'), 1);
  const rows = await t!.db.tx(ctx, async (c) => (await c.query('SELECT tenant_id FROM api_keys')).rows);
  assert.ok(rows.every((r) => r.tenant_id === A.tenant));
});

test('tenant A tidak bisa menulis/mengubah/menghapus data tenant B', { skip }, async () => {
  const ctx = { tenantId: A.tenant, userId: A.user };
  await assert.rejects(() => t!.db.tx(ctx, (c) => c.query(
    `INSERT INTO api_keys (tenant_id,name,key_prefix,key_hash,scopes) VALUES ($1,'x','gwk_',$2,'[]')`, [B.tenant, hashOf('evil')])), /row-level security/);
  await assert.rejects(() => t!.db.tx(ctx, (c) => c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'x','evil-ws')`, [B.tenant])), /row-level security|duplicate/);
  const upd = await t!.db.tx(ctx, (c) => c.query(`UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1`, [B.tenant]));
  assert.equal(upd.rowCount, 0);
  const del = await t!.db.tx(ctx, (c) => c.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [B.tenant]));
  assert.equal(del.rowCount, 0);
  assert.equal(await count({ tenantId: B.tenant }, 'api_keys'), 1, 'data B utuh');
});

test('composite FK: api key tidak bisa dibuat atas nama anggota tenant lain', { skip }, async () => {
  await assert.rejects(() => t!.db.tx({ tenantId: A.tenant }, (c) => c.query(
    `INSERT INTO api_keys (tenant_id,name,key_prefix,key_hash,scopes,created_by_user_id) VALUES ($1,'x','gwk_',$2,'[]',$3)`,
    [A.tenant, hashOf('cross'), B.user])), /foreign key/);
});

test('lookup by hash hanya membuka satu baris; hash lain tidak', { skip }, async () => {
  assert.equal(await count({ apiKeyHash: hashOf('a') }, 'api_keys'), 1);
  assert.equal(await count({ apiKeyHash: hashOf('nonexistent') }, 'api_keys'), 0);
  assert.equal(await count({ loginEmail: 'a@x.test' }, 'users'), 1);
  assert.equal(await count({ loginEmail: 'zzz@x.test' }, 'users'), 0);
});

test('konteks tidak bocor antar transaksi pada koneksi pool yang sama', { skip }, async () => {
  const one = createGatewayDb(t!.schema, { pool: undefined });
  try {
    await one.tx({ tenantId: A.tenant }, async (c) => (await c.query('SELECT 1')).rows);
    for (let i = 0; i < 3; i++) {
      const v = (await one.pool.query(`SELECT current_setting('app.tenant_id', true) AS v`)).rows[0].v;
      assert.ok(v === null || v === '', 'setting harus kembali kosong setelah transaksi');
      assert.equal((await one.pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n, 0);
    }
  } finally { await one.close(); }
});

test('uuid konteks rusak diperlakukan sebagai tidak ada konteks', { skip }, async () => {
  assert.equal(await count({ tenantId: 'not-a-uuid' }, 'api_keys'), 0);
});
