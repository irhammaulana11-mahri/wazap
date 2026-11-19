import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { assessRole, inspectDbRole, roleCheckMode } = await import('../src/database/role-check.js');
const { buildApp } = await import('../src/app.js');

const t = skip ? null : await createTestDb(5);
const db = t?.db as any;
after(async () => { await t?.drop(); });

// ---------- role DB ----------

test('assessRole: superuser/BYPASSRLS fatal; pemilik schema = peringatan; role DML-saja bersih', () => {
  const base = { role: 'app', superuser: false, bypassRls: false, ownsSchema: false, canCreateInSchema: false };
  assert.deepEqual(assessRole(base), { fatal: [], warnings: [] });
  assert.equal(assessRole({ ...base, superuser: true }).fatal.length, 1);
  assert.equal(assessRole({ ...base, bypassRls: true }).fatal.length, 1);
  assert.equal(assessRole({ ...base, superuser: true, bypassRls: true }).fatal.length, 2);
  const owner = assessRole({ ...base, ownsSchema: true, canCreateInSchema: true });
  assert.deepEqual([owner.fatal.length, owner.warnings.length], [0, 1]);
  assert.match(owner.warnings[0]!, /DB_ROLES\.md/);
  assert.equal(assessRole({ ...base, canCreateInSchema: true }).warnings.length, 1);
});

test('roleCheckMode: default enforce di production, warn selain itu; eksplisit menang', () => {
  assert.equal(roleCheckMode({ NODE_ENV: 'production' }), 'enforce');
  assert.equal(roleCheckMode({ NODE_ENV: 'development' }), 'warn');
  assert.equal(roleCheckMode({ NODE_ENV: 'test' }), 'warn');
  assert.equal(roleCheckMode({ NODE_ENV: 'production', DB_ROLE_CHECK: 'off' }), 'off');
  assert.equal(roleCheckMode({ NODE_ENV: 'development', DB_ROLE_CHECK: 'enforce' }), 'enforce');
});

test('role runtime pada lingkungan tes bukan superuser/BYPASSRLS (RLS benar-benar berlaku)', { skip }, async () => {
  const r = await inspectDbRole(db.pool, db.schema);
  assert.equal(r.superuser, false, `role ${r.role} superuser: seluruh tes RLS menjadi tidak bermakna`);
  assert.equal(r.bypassRls, false);
});

// ---------- cakupan RLS otomatis ----------

const TABLES_WITHOUT_RLS = new Set(['schema_migrations']); // pencatat migrasi: bukan data tenant, tidak diakses runtime

test('RLS: SEMUA tabel schema (kecuali schema_migrations) ENABLE + FORCE dan punya kebijakan', { skip }, async () => {
  const rows = (await db.pool.query(
    `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`, [db.schema])).rows;
  assert.ok(rows.length >= 20, 'schema tampak kosong');
  const bad = rows.filter((r: any) => !TABLES_WITHOUT_RLS.has(r.name) && !(r.rls && r.forced && r.policies > 0));
  assert.deepEqual(bad.map((r: any) => r.name), [], 'tabel tanpa RLS ENABLE+FORCE+kebijakan (tabel baru wajib RLS)');
});

test('RLS: setiap tabel ber-kolom tenant_id dilindungi; tidak ada kebijakan "USING (true)"', { skip }, async () => {
  const tenantTables = (await db.pool.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c WHERE c.table_schema = $1 AND c.column_name = 'tenant_id'`, [db.schema])).rows.map((r: any) => r.table_name);
  assert.ok(tenantTables.length >= 15);
  const unprotected = (await db.pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`, [db.schema, tenantTables])).rows;
  assert.deepEqual(unprotected, []);
  const open = (await db.pool.query(
    `SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = $1 AND (qual IN ('true','(true)') OR with_check IN ('true','(true)'))`, [db.schema])).rows;
  assert.deepEqual(open, [], 'kebijakan terbuka tanpa syarat tenant/platform');
});

test('RLS: tidak ada fungsi SECURITY DEFINER di schema (akan melewati RLS dengan hak pemilik)', { skip }, async () => {
  const defs = (await db.pool.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prosecdef`, [db.schema])).rows;
  assert.deepEqual(defs, []);
});

// ---------- kebocoran informasi ----------

test('galat tak terduga: 500 generik tanpa stack/detail internal; 404 rute tidak membocorkan apa pun', async () => {
  const app = buildApp({ checkDb: async () => true });
  app.get('/boom', async () => { throw new Error('password=SUPERSECRET at /srv/app/secret.ts:42'); });
  const r = await app.inject({ url: '/boom' });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(Object.keys(r.json()).sort(), ['error', 'request_id', 'success']);
  assert.equal(r.json().error.code, 'INTERNAL_ERROR');
  assert.ok(!r.body.includes('SUPERSECRET') && !r.body.includes('secret.ts') && !r.body.includes('stack'));
  const nf = await app.inject({ url: '/api/v1/tidak-ada' });
  assert.equal(nf.statusCode, 404); assert.equal(nf.json().error.code, 'NOT_FOUND');
  const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bukan json' });
  assert.equal(bad.statusCode, 400);
  assert.ok(!/SyntaxError|JSON\.parse|at /.test(bad.body), 'pesan parser tidak boleh bocor');
  await app.close();
});

// ---------- header keamanan & pembatasan laju ----------

const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

test('header keamanan ada pada respons API (sukses, galat, dan 404)', async () => {
  const app = buildApp({ checkDb: async () => true });
  for (const url of ['/health/live', '/api/v1/tidak-ada', '/api/v1/auth/me']) {
    const r = await app.inject({ url });
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', url);
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/, url);
    assert.equal(r.headers['cache-control'], 'no-store', url);
    assert.ok(r.headers['x-request-id']);
  }
  await app.close();
});

test('batas laju per IP: 429 RATE_LIMITED + Retry-After setelah batas; IP lain tidak terpengaruh; health tidak dibatasi', async () => {
  const app = buildApp({ checkDb: async () => true, apiLimits: { ipPerMinute: 5, tenantPerMinute: 0 } });
  const hit = (ip: string, url = '/api/v1/auth/me') => app.inject({ url, remoteAddress: ip });
  for (let i = 0; i < 5; i++) assert.equal((await hit('10.1.1.1')).statusCode, 401);
  const blocked = await hit('10.1.1.1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  assert.equal(blocked.headers['x-content-type-options'], 'nosniff', 'respons 429 juga membawa header keamanan');
  assert.equal((await hit('10.2.2.2')).statusCode, 401, 'IP lain punya anggaran sendiri');
  for (let i = 0; i < 20; i++) assert.equal((await hit('10.1.1.1', '/health/live')).statusCode, 200);
  await app.close();
});

test('batas laju per IP dapat dimatikan (0)', async () => {
  const app = buildApp({ checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 } });
  for (let i = 0; i < 30; i++) assert.equal((await app.inject({ url: '/api/v1/auth/me' })).statusCode, 401);
  await app.close();
});

test('batas laju per tenant: dibagi semua kredensial tenant, tenant lain tidak terpengaruh, IP berbeda tidak menghindarinya', { skip }, async () => {
  const identity = createIdentityService(db);
  const a = await identity.register({ email: 'rl-a@x.test', password: 'correct-horse-battery', tenantName: 'A' });
  const b = await identity.register({ email: 'rl-b@x.test', password: 'correct-horse-battery', tenantName: 'B' });
  const app = buildApp({ identity, checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 4 }, apiLimiter: new RateLimiter() });
  const me = (tok: string, ip: string) => app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tok}` }, remoteAddress: ip });
  for (let i = 0; i < 4; i++) assert.equal((await me(a.accessToken, `10.3.3.${i + 1}`)).statusCode, 200);
  const over = await me(a.accessToken, '10.3.3.99'); // IP baru, tenant sama
  assert.equal(over.statusCode, 429); assert.equal(over.json().error.code, 'RATE_LIMITED'); assert.ok(over.headers['retry-after']);
  assert.equal((await me(b.accessToken, '10.3.3.1')).statusCode, 200, 'tenant B tidak ikut terblokir');
  const bad = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: 'Bearer palsu' } });
  assert.equal(bad.statusCode, 401, 'kredensial tidak valid tidak menghabiskan anggaran tenant manapun');
  await app.close();
});

// ---------- hitungan daftar berbatas ----------

test('daftar pesan/chat: total berbatas (LIST_COUNT_CAP) + total_capped; di bawah batas total eksak tanpa penanda', { skip }, async () => {
  const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
  const { createChatService } = await import('../src/modules/chats/chats.service.js');
  const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
  const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
  const crypto = await import('node:crypto');
  const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
  const reg = await createIdentityService(db).register({ email: 'cap@x.test', password: 'correct-horse-battery', tenantName: 'Cap' });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await createSessionService(db, { crypto: cr }).create(principal, { name: 'cap1', autoConnect: true });
  const capped = createMessageService(db, { countCap: 3 });
  for (let i = 0; i < 5; i++) await capped.send(principal, { sessionId: s.id, to: `62811000000${i}`, text: 'x', priority: 5 });
  const page = await capped.list(reg.tenant.id, { page: 1, pageSize: 2 });
  assert.deepEqual([page.rows.length, page.total, page.capped], [2, 3, true]);
  assert.equal((await capped.list(reg.tenant.id, { page: 3, pageSize: 2 })).rows.length, 1, 'halaman tetap benar di luar batas hitungan');
  const exact = createMessageService(db, { countCap: 100 });
  const all = await exact.list(reg.tenant.id, { page: 1, pageSize: 20 });
  assert.deepEqual([all.total, all.capped], [5, false]);
  // chat
  await db.tx({ platform: true }, (c: any) => c.query(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone) SELECT $1, $2, '6270000000' || g || '@s.whatsapp.net', '6270000000' || g FROM generate_series(1,5) g`, [reg.tenant.id, s.id]));
  const cc = await createChatService(db, { countCap: 3 }).listChats(reg.tenant.id, { page: 1, pageSize: 20 });
  assert.deepEqual([cc.rows.length, cc.total, cc.capped], [5, 3, true]);
  const cx = await createChatService(db, { countCap: 100 }).listChats(reg.tenant.id, { page: 1, pageSize: 20 });
  assert.deepEqual([cx.total, cx.capped], [5, false]);
});
