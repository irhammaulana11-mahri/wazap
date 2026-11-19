import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { signAccessToken } = await import('../src/modules/identity/tokens.js');

const t = skip ? null : await createTestDb();
const identity = skip ? (null as any) : createIdentityService(t!.db);
const app = skip ? (null as any) : buildApp({ identity, sessions: createSessionService(t!.db), checkDb: async () => true, limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
after(async () => { await app?.close(); await t?.drop(); });

const PW = 'correct-horse-battery';
let n = 0;
const post = (url: string, payload?: any, headers: any = {}, cookies: any = {}) =>
  app.inject({ method: 'POST', url, payload, headers, cookies });
async function register(label = `u${++n}`) {
  const r = await post('/api/v1/auth/register', { email: `${label}@Example.test`, password: PW, tenant_name: `Workspace ${label}` });
  assert.equal(r.statusCode, 201, r.body);
  return { res: r, body: r.json().data, rt: r.cookies.find((c: any) => c.name === 'wzp_rt')?.value as string, label };
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const createKey = (tok: string, scopes = ['sessions:read'], extra: any = {}) =>
  post('/api/v1/api-keys', { name: 'integrasi', scopes, ...extra }, bearer(tok));

test('register: 201, cookie refresh HttpOnly, refresh token tidak ada di body, email dinormalisasi', { skip }, async () => {
  const { res, body, label } = await register();
  assert.equal(body.user.email, `${label}@example.test`);
  assert.equal(body.role, 'OWNER');
  assert.ok(body.access_token);
  assert.equal(body.refresh_token, undefined);
  const c = res.cookies.find((x: any) => x.name === 'wzp_rt');
  assert.equal(c.httpOnly, true); assert.equal(c.sameSite, 'Strict'); assert.equal(c.path, '/api/v1/auth');
  assert.equal(res.headers['x-request-id'] !== undefined, true);
});

test('register: email duplikat 409, password lemah & tenant_id dari klien ditolak 400', { skip }, async () => {
  const a = await register();
  const dup = await post('/api/v1/auth/register', { email: `${a.label}@example.test`, password: PW, tenant_name: 'Another' });
  assert.equal(dup.statusCode, 409); assert.equal(dup.json().error.code, 'EMAIL_TAKEN');
  const weak = await post('/api/v1/auth/register', { email: 'w@example.test', password: 'short', tenant_name: 'Weak' });
  assert.equal(weak.statusCode, 400); assert.equal(weak.json().error.code, 'VALIDATION_ERROR');
  const inj = await post('/api/v1/auth/register', { email: 'i@example.test', password: PW, tenant_name: 'Inj', tenant_id: a.body.tenant.id });
  assert.equal(inj.statusCode, 400, 'tenant_id dari klien tidak boleh menjadi otoritas');
  assert.ok(inj.json().request_id);
});

test('password disimpan sebagai argon2id, bukan plaintext', { skip }, async () => {
  const a = await register();
  const h = await t!.db.tx({ userId: a.body.user.id }, async (c) => (await c.query('SELECT password_hash FROM users WHERE id=$1', [a.body.user.id])).rows[0].password_hash);
  assert.match(h, /^\$argon2id\$/); assert.ok(!h.includes(PW));
});

test('login: sukses; salah password & user tidak ada => pesan identik 401', { skip }, async () => {
  const a = await register();
  const ok = await post('/api/v1/auth/login', { email: `${a.label}@EXAMPLE.test`, password: PW });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().data.tenant.id, a.body.tenant.id);
  const bad = await post('/api/v1/auth/login', { email: `${a.label}@example.test`, password: 'wrong-password-1' });
  const none = await post('/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password-1' });
  assert.equal(bad.statusCode, 401); assert.equal(none.statusCode, 401);
  assert.deepEqual(bad.json().error, none.json().error);
});

test('login: tenant_id hanya memilih membership milik sendiri, tenant lain ditolak', { skip }, async () => {
  const a = await register(); const b = await register();
  const r = await post('/api/v1/auth/login', { email: `${a.label}@example.test`, password: PW, tenant_id: b.body.tenant.id });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'NO_ACTIVE_TENANT');
});

test('/auth/me dengan access token; tanpa/rusak token 401 dengan envelope kontrak', { skip }, async () => {
  const a = await register();
  const me = await app.inject({ url: '/api/v1/auth/me', headers: bearer(a.body.access_token) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().data.user.id, a.body.user.id); assert.equal(me.json().data.role, 'OWNER');
  assert.ok(!JSON.stringify(me.json()).includes('password_hash'));
  const none = await app.inject({ url: '/api/v1/auth/me' });
  assert.equal(none.statusCode, 401); assert.equal(none.json().error.code, 'UNAUTHENTICATED'); assert.equal(none.json().success, false);
  const tampered = await app.inject({ url: '/api/v1/auth/me', headers: bearer(a.body.access_token.slice(0, -2) + 'xx') });
  assert.equal(tampered.statusCode, 401);
});

test('access token kedaluwarsa ditolak; user dinonaktifkan/membership suspend langsung efektif', { skip }, async () => {
  const a = await register();
  const expired = signAccessToken(a.body.user.id, a.body.tenant.id, -10);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: bearer(expired) })).statusCode, 401);
  await t!.db.tx({ tenantId: a.body.tenant.id }, (c) => c.query(`UPDATE tenant_memberships SET status='SUSPENDED' WHERE tenant_id=$1`, [a.body.tenant.id]));
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: bearer(a.body.access_token) })).statusCode, 401);
});

test('token acak dengan tenant_id sembarang tidak memberi akses lintas tenant', { skip }, async () => {
  const a = await register(); const b = await register();
  const forged = signAccessToken(a.body.user.id, b.body.tenant.id); // user A mengklaim tenant B
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: bearer(forged) })).statusCode, 401);
});

test('refresh: rotasi, token lama tidak dapat dipakai ulang dan reuse mencabut seluruh family', { skip }, async () => {
  const a = await register();
  const r1 = await post('/api/v1/auth/refresh', undefined, {}, { wzp_rt: a.rt });
  assert.equal(r1.statusCode, 200);
  const rt2 = r1.cookies.find((c: any) => c.name === 'wzp_rt').value;
  assert.notEqual(rt2, a.rt);
  const reuse = await post('/api/v1/auth/refresh', undefined, {}, { wzp_rt: a.rt });
  assert.equal(reuse.statusCode, 401); assert.equal(reuse.json().error.code, 'INVALID_REFRESH_TOKEN');
  const afterReuse = await post('/api/v1/auth/refresh', undefined, {}, { wzp_rt: rt2 });
  assert.equal(afterReuse.statusCode, 401, 'family harus dicabut setelah reuse terdeteksi');
  assert.equal((await post('/api/v1/auth/refresh')).statusCode, 401);
  assert.equal((await post('/api/v1/auth/refresh', undefined, {}, { wzp_rt: 'garbage' })).statusCode, 401);
});

test('refresh token hanya tersimpan sebagai hash', { skip }, async () => {
  const a = await register();
  const rows = (await t!.db.pool.query(`SELECT count(*)::int n FROM refresh_tokens WHERE token_hash = $1`, [a.rt])).rows[0].n;
  assert.equal(rows, 0);
});

test('logout mencabut refresh token & menghapus cookie (idempoten)', { skip }, async () => {
  const a = await register();
  const out = await post('/api/v1/auth/logout', undefined, {}, { wzp_rt: a.rt });
  assert.equal(out.statusCode, 204);
  assert.equal((await post('/api/v1/auth/refresh', undefined, {}, { wzp_rt: a.rt })).statusCode, 401);
  assert.equal((await post('/api/v1/auth/logout')).statusCode, 204);
});

test('API key: raw tampil sekali, DB hanya menyimpan hash, bisa dipakai, scope dipaksakan', { skip }, async () => {
  const a = await register();
  const c = await createKey(a.body.access_token, ['sessions:read']);
  assert.equal(c.statusCode, 201);
  const { key, id } = c.json().data;
  assert.match(key, /^gwk_[A-Za-z0-9_-]{43}$/);
  const raw = (await t!.db.pool.query('SELECT * FROM api_keys WHERE id=$1', [id]));
  // pool tanpa konteks tidak melihat baris (RLS) -> baca lewat konteks tenant
  assert.equal(raw.rowCount, 0);
  const row = await t!.db.tx({ tenantId: a.body.tenant.id }, async (cl) => (await cl.query('SELECT * FROM api_keys WHERE id=$1', [id])).rows[0]);
  assert.ok(!JSON.stringify(row).includes(key)); assert.equal(row.key_hash.length, 64);
  const list = await app.inject({ url: '/api/v1/api-keys', headers: bearer(a.body.access_token) });
  assert.equal(list.json().meta.total, 1); assert.ok(!JSON.stringify(list.json()).includes(key)); assert.equal(list.json().data[0].key_hash, undefined);
  // API key tidak boleh mengelola API key / membaca profil dashboard
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: bearer(key) })).statusCode, 403);
  assert.equal((await createKey(key)).statusCode, 403);
  // API key tidak boleh mengelola/menampilkan API key; tetapi terautentikasi (route legacy => 501, bukan 401)
  assert.equal((await app.inject({ url: '/api/v1/api-keys', headers: { 'x-api-key': key } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/sessions', headers: { 'x-api-key': key } })).statusCode, 200);
});

test('API key: scope tak dikenal/kosong/wildcard ditolak, expires_at masa lalu ditolak, tenant_id klien ditolak', { skip }, async () => {
  const a = await register();
  for (const body of [{ scopes: ['*'] }, { scopes: [] }, { scopes: ['admin:all'] }, { expires_at: new Date(Date.now() - 1000).toISOString() }, { tenant_id: a.body.tenant.id }]) {
    const r = await post('/api/v1/api-keys', { name: 'x1', scopes: ['sessions:read'], ...body }, bearer(a.body.access_token));
    assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
});

test('API key dicabut/kedaluwarsa tidak dapat mengakses; revoke idempoten', { skip }, async () => {
  const a = await register();
  const k = (await createKey(a.body.access_token)).json().data;
  const probe = (key: string) => app.inject({ url: '/api/v1/sessions', headers: bearer(key) }).then((r: any) => r.statusCode);
  assert.equal(await probe(k.key), 200, 'key valid terautentikasi');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${k.id}`, headers: bearer(a.body.access_token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${k.id}`, headers: bearer(a.body.access_token) })).statusCode, 200);
  assert.equal(await probe(k.key), 401);
  const e = (await createKey(a.body.access_token, ['sessions:read'], { expires_at: new Date(Date.now() + 60_000).toISOString() })).json().data;
  await t!.db.tx({ tenantId: a.body.tenant.id }, (c) => c.query(`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id=$1`, [e.id]));
  assert.equal(await probe(e.key), 401);
  assert.equal(await probe('gwk_' + 'A'.repeat(43)), 401);
});

test('ISOLASI TENANT: A tidak dapat melihat/mencabut API key B; key A tidak membuka data B', { skip }, async () => {
  const a = await register(); const b = await register();
  const kb = (await createKey(b.body.access_token)).json().data;
  const ka = (await createKey(a.body.access_token)).json().data;
  const listA = (await app.inject({ url: '/api/v1/api-keys', headers: bearer(a.body.access_token) })).json();
  assert.deepEqual(listA.data.map((x: any) => x.id), [ka.id]);
  const rev = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${kb.id}`, headers: bearer(a.body.access_token) });
  assert.equal(rev.statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/sessions', headers: bearer(kb.key) })).statusCode, 200, 'key B tetap aktif');
  const pa = await identity.authenticateApiKey(ka.key), pb = await identity.authenticateApiKey(kb.key);
  assert.equal(pa?.tenantId, a.body.tenant.id); assert.equal(pb?.tenantId, b.body.tenant.id);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/api-keys/not-a-uuid', headers: bearer(a.body.access_token) })).statusCode, 404);
});

test('role VIEWER/MEMBER tidak boleh membuat/mencabut API key', { skip }, async () => {
  const a = await register(); const v = await register();
  await t!.db.tx({ tenantId: a.body.tenant.id }, (c) => c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'VIEWER')`, [a.body.tenant.id, v.body.user.id]));
  const login = await post('/api/v1/auth/login', { email: `${v.label}@example.test`, password: PW, tenant_id: a.body.tenant.id });
  assert.equal(login.json().data.role, 'VIEWER');
  const tok = login.json().data.access_token;
  assert.equal((await createKey(tok)).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/api-keys', headers: bearer(tok) })).statusCode, 200);
});

test('kuota max_api_keys dipaksakan', { skip }, async () => {
  const a = await register();
  await t!.db.tx({ tenantId: a.body.tenant.id }, (c) => c.query(`UPDATE tenant_settings SET max_api_keys = 1 WHERE tenant_id=$1`, [a.body.tenant.id]));
  assert.equal((await createKey(a.body.access_token)).statusCode, 201);
  const r = await createKey(a.body.access_token);
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'QUOTA_EXCEEDED');
});

test('rate limit login per email => 429 + Retry-After', { skip }, async () => {
  const lim = new RateLimiter();
  const app2 = buildApp({ identity, checkDb: async () => true, limiter: lim });
  let last: any;
  for (let i = 0; i < 9; i++) last = await app2.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'brute@example.test', password: 'whatever-pass' } });
  assert.equal(last.statusCode, 429); assert.ok(Number(last.headers['retry-after']) > 0);
  assert.equal(last.json().error.code, 'RATE_LIMITED');
  await app2.close();
});

test('login dengan body legacy {username} ditolak (400)', { skip }, async () => {
  const bad = await post('/api/v1/auth/login', { username: 'admin', password: 'salah-salah' });
  assert.equal(bad.statusCode, 400);
});

test('RateLimiter: jendela berakhir mereset hitungan', () => {
  let now = 0; const l = new RateLimiter(() => now);
  assert.ok(l.check('k', 1, 1000).allowed); assert.ok(!l.check('k', 1, 1000).allowed);
  now = 1001; assert.ok(l.check('k', 1, 1000).allowed);
});
