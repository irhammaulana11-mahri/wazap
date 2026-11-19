import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createJoinService } = await import('../src/modules/team/join.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createTenantService } = await import('../src/modules/tenant/tenant.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createRetention } = await import('../src/modules/engine/retention.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);
const app = skip ? (null as any) : buildApp({
  identity, team: createTeamService(db), join: createJoinService(db), sessions: createSessionService(db), tenant: createTenantService(db), audit: createAuditService(db),
  checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1', PW2 = 'kata-sandi-baru-yang-2';
const q = (ctx: any, sql: string, args: any[] = []) => db.tx(ctx, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any, cookie?: string) => {
  const headers: any = { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(cookie ? { cookie } : {}) };
  const r = await app.inject({ method, url: `/api/v1${url}`, headers, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, headers: r.headers, cookie: (String(r.headers['set-cookie'] ?? '').match(/wzp_rt=[^;]*/) ?? [''])[0] };
};
interface U { tok: string; userId: string; email: string; tenantId: string; cookie: string; recovery: string; name: string }
async function reg(): Promise<U> {
  const email = `ac${++n}@x.test`, name = `Akun ${n}`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: name });
  assert.equal(r.status, 201);
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id, cookie: r.cookie, recovery: r.body.data.recovery_code, name };
}
const login = (email: string, password = PW, tenantId?: string) => call('POST', '/auth/login', undefined, { email, password, tenant_id: tenantId });
const actions = async (u: U) => (await call('GET', '/audit-logs?page_size=50', u.tok)).body.data.map((a: any) => a.action) as string[];
async function joinAs(o: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  return { ...u, tenantId: o.tenantId, tok: (await login(u.email, PW, o.tenantId)).body.data.access_token };
}

test('register memberi kode pemulihan sekali tampil (no-store); hanya hash di DB', { skip }, async () => {
  const u = await reg();
  assert.match(u.recovery, /^RC(-[A-Z2-9]{5}){4}$/);
  const row = (await q({ userId: u.userId }, 'SELECT recovery_hash FROM users WHERE id = $1', [u.userId]))[0];
  assert.match(row.recovery_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(row).includes(u.recovery.replace(/-/g, '')));
  const r = await call('POST', '/auth/register', undefined, { email: `ac${++n}@x.test`, password: PW, tenant_name: 'No Store' });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await call('GET', '/auth/me', u.tok)).body.data.recovery_code, undefined, 'tidak muncul lagi');
});

test('ganti kata sandi: validasi, sesi lain dicabut, sesi ini lanjut, login dengan kata sandi baru, audit', { skip }, async () => {
  const u = await reg();
  const other = await login(u.email); // perangkat lain
  const otherTok = other.body.data.access_token, otherCookie = other.cookie;
  assert.equal((await call('POST', '/auth/change-password', u.tok, { current_password: 'salah-salah-12345', new_password: PW2 })).body.error.code, 'INVALID_PASSWORD');
  assert.equal((await call('POST', '/auth/change-password', u.tok, { current_password: 'salah-salah-12345', new_password: PW2 })).status, 403, '403 (bukan 401: tidak memicu refresh klien)');
  assert.equal((await call('POST', '/auth/change-password', u.tok, { current_password: PW, new_password: PW })).body.error.code, 'PASSWORD_UNCHANGED');
  assert.equal((await call('POST', '/auth/change-password', u.tok, { current_password: PW, new_password: 'pendek' })).status, 400);
  assert.equal((await call('POST', '/auth/change-password', u.tok, { current_password: PW, new_password: PW2, x: 1 })).status, 400, 'strict');
  assert.equal((await call('POST', '/auth/change-password', undefined, { current_password: PW, new_password: PW2 })).status, 401);
  const ok = await call('POST', '/auth/change-password', u.tok, { current_password: PW, new_password: PW2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call('GET', '/auth/me', u.tok)).status, 401, 'access token lama mati');
  assert.equal((await call('GET', '/auth/me', otherTok)).status, 401, 'access token perangkat lain mati');
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, otherCookie)).status, 401, 'refresh perangkat lain dicabut');
  assert.equal((await call('GET', '/auth/me', ok.body.data.access_token)).status, 200, 'token baru berlaku');
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, ok.cookie)).status, 200, 'refresh baru berlaku');
  assert.equal((await login(u.email, PW)).status, 401); assert.equal((await login(u.email, PW2)).status, 200);
  assert.ok((await actions({ ...u, tok: ok.body.data.access_token })).includes('account.password_changed'));
  const v = await call('GET', '/auth/me', undefined); assert.equal(v.status, 401);
});

test('API key tidak dapat memakai endpoint akun', { skip }, async () => {
  const u = await reg();
  const key = (await call('POST', '/api-keys', u.tok, { name: 'kunci', scopes: ['sessions:read'] })).body.data.key;
  for (const [m, url, body] of [['POST', '/auth/change-password', { current_password: PW, new_password: PW2 }], ['POST', '/auth/logout-all', {}], ['POST', '/auth/change-email', { password: PW, new_email: 'z@x.test' }], ['POST', '/auth/recovery-code', { password: PW }]] as const) {
    const r = await app.inject({ method: m, url: `/api/v1${url}`, headers: { 'x-api-key': key }, payload: body });
    assert.equal(r.statusCode, 403, url);
  }
});

test('kode pemulihan: terbitkan ulang (butuh kata sandi), reset tanpa email, sekali pakai, sesi dicabut, jawaban seragam', { skip }, async () => {
  const u = await reg();
  const sess = await login(u.email);
  assert.equal((await call('POST', '/auth/recovery-code', u.tok, { password: 'salah-salah-12345' })).status, 403);
  const fresh = (await call('POST', '/auth/recovery-code', u.tok, { password: PW })).body.data.recovery_code as string;
  assert.notEqual(fresh, u.recovery);
  const bad = async (email: string, code: string) => { const r = await call('POST', '/auth/reset-password', undefined, { email, recovery_code: code, new_password: PW2 }); return [r.status, r.body.error?.code, r.body.error?.message].join('|'); };
  const uniform = await bad(u.email, u.recovery); // kode lama sudah hangus
  assert.equal(uniform.split('|')[0], '400'); assert.equal(uniform.split('|')[1], 'INVALID_RECOVERY');
  assert.equal(await bad('tidakada@x.test', fresh), uniform, 'email tak dikenal: jawaban identik');
  assert.equal(await bad(u.email, 'WJ-AAAAA-AAAAA-AAAAA-AAAAA'), uniform, 'kode salah: jawaban identik');
  assert.equal(await bad(u.email, 'bukan-kode'), uniform);
  const r = await call('POST', '/auth/reset-password', undefined, { email: u.email.toUpperCase(), recovery_code: fresh.toLowerCase().replace(/-/g, ''), new_password: PW2 });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.data.recovery_code, /^RC(-[A-Z2-9]{5}){4}$/); assert.notEqual(r.body.data.recovery_code, fresh);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await call('GET', '/auth/me', sess.body.data.access_token)).status, 401, 'sesi lama mati');
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, sess.cookie)).status, 401);
  assert.equal((await login(u.email, PW)).status, 401); assert.equal((await login(u.email, PW2)).status, 200);
  assert.equal(await bad(u.email, fresh), uniform, 'kode dipakai ulang ditolak');
  // akun tanpa kode pemulihan (mis. dibuat sebelum fitur ini) tidak dapat direset
  await q({ userId: u.userId }, 'UPDATE users SET recovery_hash = NULL WHERE id = $1', [u.userId]);
  assert.equal(await bad(u.email, r.body.data.recovery_code), uniform);
});

test('reset serentak dengan kode yang sama: hanya satu yang menang', { skip }, async () => {
  const u = await reg();
  const res = await Promise.all([PW2, 'kata-sandi-lain-yang-3', 'kata-sandi-lain-yang-4'].map((p) => call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: u.recovery, new_password: p })));
  assert.equal(res.filter((r) => r.status === 200).length, 1, res.map((r) => r.status).join());
});

test('pemohon bergabung (akun baru lewat kode workspace) mendapat kode pemulihan yang berfungsi; akun lama tidak', { skip }, async () => {
  const o = await reg();
  const code = (await call('PUT', '/team/join-code', o.tok)).body.data.join_code;
  const e = `jr${++n}@x.test`;
  const r = await call('POST', '/auth/join-requests', undefined, { join_code: code, email: e, password: PW });
  assert.equal(r.status, 201); assert.match(r.body.data.recovery_code, /^RC-/); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: e, recovery_code: r.body.data.recovery_code, new_password: PW2 })).status, 200);
  const existing = await reg(); // akun lama di workspace lain
  const again = await call('POST', '/auth/join-requests', undefined, { join_code: code, email: existing.email, password: PW });
  assert.equal(again.status, 201); assert.equal(again.body.data.recovery_code, undefined, 'akun lama tidak menerima kode baru');
});

test('alat operator: terbitkan kode pemulihan untuk email lalu pengguna mereset', { skip }, async () => {
  const u = await reg();
  const code = await identity.adminIssueRecoveryCode(u.email.toUpperCase());
  assert.match(code, /^RC-/); assert.equal(await identity.adminIssueRecoveryCode('hantu@x.test'), null);
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: u.recovery, new_password: PW2 })).status, 400, 'kode lama hangus');
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: code, new_password: PW2 })).status, 200);
});

test('ganti email: validasi, login dengan email baru, member_email di SEMUA keanggotaan ikut berubah, peran tidak tersentuh', { skip }, async () => {
  const o1 = await reg(); const o2 = await reg();
  const m1 = await joinAs(o1, 'MEMBER'); const m2 = await joinAs(o2, 'ADMIN'); // pengguna yang sama? tidak: dua akun; buat satu akun di dua tenant:
  const multi = await reg(); // OWNER tenant sendiri
  const inv = await call('POST', '/team/invitations', o1.tok, { email: multi.email, role: 'VIEWER' });
  await call('POST', '/team/invitations/accept', multi.tok, { token: inv.body.data.token });
  const dup = (await call('POST', '/auth/change-email', multi.tok, { password: PW, new_email: m1.email }));
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'EMAIL_TAKEN');
  assert.equal((await call('POST', '/auth/change-email', multi.tok, { password: 'salah-salah-12345', new_email: 'baru1@x.test' })).status, 403);
  assert.equal((await call('POST', '/auth/change-email', multi.tok, { password: PW, new_email: multi.email.toUpperCase() })).body.error.code, 'EMAIL_UNCHANGED');
  assert.equal((await call('POST', '/auth/change-email', multi.tok, { password: PW, new_email: 'bukan-email' })).status, 400);
  const ok = await call('POST', '/auth/change-email', multi.tok, { password: PW, new_email: `Baru${++n}@X.test` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); const ne = ok.body.data.user.email; assert.equal(ne, ne.toLowerCase());
  assert.equal((await login(multi.email)).status, 401); assert.equal((await login(ne)).status, 200);
  assert.equal((await q({ tenantId: multi.tenantId }, 'SELECT member_email FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [multi.tenantId, multi.userId]))[0].member_email, ne);
  const inO1 = (await q({ tenantId: o1.tenantId }, 'SELECT member_email, role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [o1.tenantId, multi.userId]))[0];
  assert.deepEqual([inO1.member_email, inO1.role], [ne, 'VIEWER'], 'salinan di tenant lain ikut berubah, peran utuh');
  assert.ok((await actions(multi)).includes('account.email_changed'));
  void m2;
});

test('RLS/guard keanggotaan: di luar tenant aktif hanya member_email yang dapat berubah (peran/status tidak)', { skip }, async () => {
  const o1 = await reg(); const m = await joinAs(o1, 'MEMBER'); const other = await reg();
  // pengguna memegang konteks tenant LAIN: tidak dapat menaikkan perannya di o1
  await assert.rejects(q({ userId: m.userId, tenantId: other.tenantId }, `UPDATE tenant_memberships SET role = 'OWNER' WHERE tenant_id = $1 AND user_id = $2`, [o1.tenantId, m.userId]), /hanya boleh menyinkronkan member_email/);
  await assert.rejects(q({ userId: m.userId }, `UPDATE tenant_memberships SET status = 'ACTIVE', role = 'ADMIN' WHERE user_id = $1`, [m.userId]), /hanya boleh menyinkronkan member_email/);
  await assert.rejects(q({ userId: m.userId }, `UPDATE tenant_memberships SET member_email = 'palsu@x.test' WHERE user_id = $1`, [m.userId]), /hanya boleh menyinkronkan member_email/, 'harus sama dengan email akun');
  assert.equal((await q({ userId: other.userId }, `UPDATE tenant_memberships SET member_email = 'x@x.test' WHERE tenant_id = $1 RETURNING 1`, [o1.tenantId])).length, 0, 'baris orang lain tidak terlihat');
});

test('keluar dari semua perangkat: semua refresh dan access token mati, 204', { skip }, async () => {
  const u = await reg(); const a = await login(u.email); const b = await login(u.email);
  const r = await call('POST', '/auth/logout-all', a.body.data.access_token);
  assert.equal(r.status, 204);
  for (const tok of [u.tok, a.body.data.access_token, b.body.data.access_token]) assert.equal((await call('GET', '/auth/me', tok)).status, 401);
  for (const c of [u.cookie, a.cookie, b.cookie]) assert.equal((await call('POST', '/auth/refresh', undefined, undefined, c)).status, 401);
  const again = await login(u.email); assert.equal(again.status, 200); assert.equal((await call('GET', '/auth/me', again.body.data.access_token)).status, 200, 'login baru berlaku');
  assert.ok((await actions({ ...u, tok: again.body.data.access_token })).includes('account.sessions_revoked'));
});

test('edit API key: nama dan scope; yang dicabut 409; MEMBER 403; scope baru berlaku segera; audit', { skip }, async () => {
  const o = await reg(); const m = await joinAs(o, 'MEMBER');
  const k = (await call('POST', '/api-keys', o.tok, { name: 'kunci lama', scopes: ['sessions:read', 'messages:read'] })).body.data;
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, m.tok, { name: 'x-x' })).status, 403);
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, o.tok, {})).status, 400);
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, o.tok, { scopes: ['*'] })).status, 400, 'scope * ditolak');
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, o.tok, { name: 'a' })).status, 400);
  const r = await call('PATCH', `/api-keys/${k.id}`, o.tok, { name: '  kunci baru  ', scopes: ['sessions:read'] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.name, 'kunci baru'); assert.deepEqual(r.body.data.scopes, ['sessions:read']); assert.equal(r.body.data.key, undefined);
  const withKey = (path: string) => app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { 'x-api-key': k.key } });
  assert.equal((await withKey('/sessions')).statusCode, 200); assert.equal((await withKey('/messages')).statusCode, 403, 'scope messages:read sudah dicabut');
  assert.ok((await actions(o)).includes('api_key.updated'));
  assert.equal((await call('PATCH', '/api-keys/bukan-uuid', o.tok, { name: 'abc' })).status, 404);
  assert.equal((await call('PATCH', `/api-keys/00000000-0000-4000-8000-000000000000`, o.tok, { name: 'abc' })).status, 404);
  await call('DELETE', `/api-keys/${k.id}`, o.tok);
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, o.tok, { name: 'abc' })).body.error.code, 'INVALID_STATE');
  const other = await reg();
  assert.equal((await call('PATCH', `/api-keys/${k.id}`, other.tok, { name: 'abc' })).status, 404, 'tenant lain tidak dapat menyentuh');
});

test('ganti nama sesi: unik per tenant, VIEWER 403, tercatat di event, sesi DELETING 409', { skip }, async () => {
  const o = await reg(); const v = await joinAs(o, 'VIEWER'); const mem = await joinAs(o, 'MEMBER');
  const s1 = (await call('POST', '/sessions', o.tok, { session_name: 'Satu', auto_connect: false })).body.data;
  const s2 = (await call('POST', '/sessions', o.tok, { session_name: 'Dua', auto_connect: false })).body.data;
  assert.equal((await call('PATCH', `/sessions/${s1.id}`, v.tok, { session_name: 'Tiga' })).status, 403);
  assert.equal((await call('PATCH', `/sessions/${s1.id}`, mem.tok, { session_name: 'Tiga' })).status, 200);
  const dup = await call('PATCH', `/sessions/${s2.id}`, o.tok, { session_name: 'tiga' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'SESSION_NAME_TAKEN');
  assert.equal((await call('PATCH', `/sessions/${s1.id}`, o.tok, { session_name: 'x' })).status, 400);
  assert.equal((await call('PATCH', `/sessions/${s1.id}`, o.tok, { session_name: 'Tiga', status: 'CONNECTED' })).status, 400, 'strict');
  const ev = await call('GET', `/sessions/${s1.id}/events`, o.tok);
  assert.ok(ev.body.data.some((e: any) => e.event_type === 'session.renamed'));
  await call('DELETE', `/sessions/${s2.id}`, o.tok);
  assert.equal((await call('PATCH', `/sessions/${s2.id}`, o.tok, { session_name: 'Empat' })).body.error.code, 'INVALID_STATE');
  const other = await reg();
  assert.equal((await call('PATCH', `/sessions/${s1.id}`, other.tok, { session_name: 'Lima' })).status, 404);
});

test('ganti nama workspace: hanya OWNER, nama pada kode workspace ikut berubah, audit', { skip }, async () => {
  const o = await reg(); const adm = await joinAs(o, 'ADMIN');
  const code = (await call('PUT', '/team/join-code', o.tok)).body.data.join_code;
  assert.equal((await call('PATCH', '/tenant', adm.tok, { name: 'Nama Baru' })).status, 403);
  assert.equal((await call('PATCH', '/tenant', o.tok, { name: 'x' })).status, 400);
  const r = await call('PATCH', '/tenant', o.tok, { name: '  Nama Baru  ' });
  assert.equal(r.status, 200); assert.equal(r.body.data.name, 'Nama Baru');
  assert.equal((await call('GET', '/auth/me', o.tok)).body.data.memberships.find((x: any) => x.tenant_id === o.tenantId).name, 'Nama Baru');
  const req = await call('POST', '/auth/join-requests', undefined, { join_code: code, email: `nm${++n}@x.test`, password: PW });
  assert.equal(req.body.data.tenant_name, 'Nama Baru');
  assert.ok((await actions(o)).includes('tenant.renamed'));
});

test('hapus workspace: password+konfirmasi nama, hanya OWNER; akses berhenti; sesi/webhook/key dimatikan; tenant lain utuh; retensi menghapus data', { skip }, async () => {
  const o = await reg(); const adm = await joinAs(o, 'ADMIN'); const bystander = await reg();
  const key = (await call('POST', '/api-keys', o.tok, { name: 'kunci', scopes: ['sessions:read'] })).body.data.key;
  const s = (await call('POST', '/sessions', o.tok, { session_name: 'Hapus Saya', auto_connect: false })).body.data;
  await q({ tenantId: o.tenantId }, `INSERT INTO webhook_endpoints (tenant_id, url, secret_ciphertext, secret_key_version, secret_hint) VALUES ($1,'https://example.com/h','\\x00',1,'abcd')`, [o.tenantId]);
  const del = (body: any, tok = o.tok) => call('DELETE', '/tenant', tok, body);
  assert.equal((await del({ password: PW, confirm_name: o.name }, adm.tok)).status, 403, 'ADMIN tidak boleh');
  assert.equal((await del({ password: 'salah-salah-12345', confirm_name: o.name })).body.error.code, 'INVALID_PASSWORD');
  assert.equal((await del({ password: PW, confirm_name: 'Nama Salah' })).body.error.code, 'CONFIRMATION_MISMATCH');
  assert.equal((await del({ password: PW })).status, 400);
  assert.equal((await call('GET', '/auth/me', o.tok)).status, 200, 'percobaan gagal tidak berdampak');
  const r = await del({ password: PW, confirm_name: ` ${o.name} ` });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.deleted, true); assert.equal(r.body.data.sessions_scheduled, 1);
  for (const tok of [o.tok, adm.tok]) assert.equal((await call('GET', '/sessions', tok)).status, 401, 'akses anggota berhenti');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: { 'x-api-key': key } })).statusCode, 401, 'API key mati');
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, o.cookie)).status, 401);
  assert.equal((await login(o.email, PW, o.tenantId)).status, 403, 'login ke workspace terhapus ditolak');
  assert.equal((await login(adm.email)).body.data.tenant.id !== o.tenantId, true, 'anggota tetap dapat masuk ke workspace lain');
  const st = (await q({ tenantId: o.tenantId }, 'SELECT status FROM wa_sessions WHERE id = $1', [s.id]))[0].status;
  assert.equal(st, 'DELETING');
  assert.equal((await q({ tenantId: o.tenantId }, 'SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1', [o.tenantId])).length, 0);
  assert.equal((await call('GET', '/auth/me', bystander.tok)).status, 200, 'tenant lain tidak terpengaruh');
  assert.equal((await call('GET', '/auth/me', (await login(adm.email)).body.data.access_token)).body.data.memberships.some((x: any) => x.tenant_id === o.tenantId), false, 'workspace terhapus tidak muncul di me');
  // retensi: belum waktunya -> tetap; sudah lewat -> dihapus permanen beserta isinya; tenant lain utuh
  const policy = (tenantDays: number) => () => ({ contentDays: 30, rowDays: 180, outboxDays: 7, deliveryDays: 30, auditDays: 365, tenantDays, batch: 10 });
  assert.equal((await createRetention(db, policy(30)).runOnce()).tenantsPurged, 0);
  assert.equal((await createRetention(db, policy(0)).runOnce()).tenantsPurged, 1);
  assert.equal((await q({ platform: true }, 'SELECT 1 FROM tenants WHERE id = $1', [o.tenantId])).length, 0);
  assert.equal((await q({ platform: true }, 'SELECT 1 FROM wa_sessions WHERE tenant_id = $1', [o.tenantId])).length, 0);
  assert.equal((await q({ platform: true }, 'SELECT 1 FROM tenants WHERE id = $1', [bystander.tenantId])).length, 1);
  assert.equal((await createRetention(db, policy(0)).runOnce()).tenantsPurged, 0, 'idempoten');
});

test('platform tidak dapat menghapus tenant yang masih ACTIVE (kebijakan RLS)', { skip }, async () => {
  const o = await reg();
  assert.equal((await q({ platform: true }, 'DELETE FROM tenants WHERE id = $1 RETURNING id', [o.tenantId])).length, 0);
  assert.equal((await q({ tenantId: o.tenantId }, 'SELECT 1 FROM tenants WHERE id = $1', [o.tenantId])).length, 1);
});
