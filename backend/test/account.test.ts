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
const { recoveryHash } = await import('../src/modules/identity/codes.js');
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
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id, cookie: r.cookie, recovery: r.body.data.recovery_codes, name };
}
const login = (email: string, password = PW, tenantId?: string) => call('POST', '/auth/login', undefined, { email, password, tenant_id: tenantId });
const actions = async (u: U) => (await call('GET', '/audit-logs?page_size=50', u.tok)).body.data.map((a: any) => a.action) as string[];
async function joinAs(o: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  return { ...u, tenantId: o.tenantId, tok: (await login(u.email, PW, o.tenantId)).body.data.access_token };
}

test('register memberi 8 kode pemulihan sekali tampil (no-store); hanya hash di DB; me menampilkan status tanpa nilai kode', { skip }, async () => {
  const u = await reg();
  assert.equal(u.recovery.length, 8); assert.equal(new Set(u.recovery).size, 8);
  for (const c of u.recovery) assert.match(c, /^RC(-[A-Z2-9]{5}){4}$/);
  const rows = await q({ userId: u.userId }, 'SELECT code_hash, used_at FROM user_recovery_codes WHERE user_id = $1', [u.userId]);
  assert.equal(rows.length, 8);
  for (const r of rows) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes(u.recovery[0].replace(/-/g, '')));
  const r = await call('POST', '/auth/register', undefined, { email: `ac${++n}@x.test`, password: PW, tenant_name: 'No Store' });
  assert.equal(r.headers['cache-control'], 'no-store');
  const me = (await call('GET', '/auth/me', u.tok)).body.data;
  assert.equal(me.recovery_codes, undefined); assert.deepEqual(me.recovery, { codes_remaining: 8, confirmed: false });
  assert.equal((await call('POST', '/auth/recovery-codes/confirm', u.tok, {})).status, 200);
  assert.deepEqual((await call('GET', '/auth/me', u.tok)).body.data.recovery, { codes_remaining: 8, confirmed: true });
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
  for (const [m, url, body] of [['POST', '/auth/change-password', { current_password: PW, new_password: PW2 }], ['POST', '/auth/logout-all', {}], ['POST', '/auth/change-email', { password: PW, new_email: 'z@x.test' }], ['POST', '/auth/recovery-codes', { password: PW }]] as const) {
    const r = await app.inject({ method: m, url: `/api/v1${url}`, headers: { 'x-api-key': key }, payload: body });
    assert.equal(r.statusCode, 403, url);
  }
});

test('kode pemulihan: terbitkan ulang (butuh kata sandi), reset tanpa email, tiap kode sekali pakai, sisa kode tetap berlaku, sesi dicabut, jawaban seragam', { skip }, async () => {
  const u = await reg();
  const sess = await login(u.email);
  assert.equal((await call('POST', '/auth/recovery-codes', u.tok, { password: 'salah-salah-12345' })).status, 403);
  await call('POST', '/auth/recovery-codes/confirm', u.tok, {});
  const fresh = (await call('POST', '/auth/recovery-codes', u.tok, { password: PW })).body.data.recovery_codes as string[];
  assert.equal(fresh.length, 8); assert.ok(fresh.every((c) => !u.recovery.includes(c)));
  assert.equal((await call('GET', '/auth/me', u.tok)).body.data.recovery.confirmed, false, 'himpunan baru perlu dikonfirmasi lagi');
  const bad = async (email: string, code: string) => { const r = await call('POST', '/auth/reset-password', undefined, { email, recovery_code: code, new_password: PW2 }); return [r.status, r.body.error?.code, r.body.error?.message].join('|'); };
  const uniform = await bad(u.email, u.recovery[0]); // himpunan lama sudah hangus
  assert.equal(uniform.split('|')[0], '400'); assert.equal(uniform.split('|')[1], 'INVALID_RECOVERY');
  assert.equal(await bad('tidakada@x.test', fresh[0]), uniform, 'email tak dikenal: jawaban identik');
  assert.equal(await bad(u.email, 'WJ-AAAAA-AAAAA-AAAAA-AAAAA'), uniform, 'kode salah: jawaban identik');
  assert.equal(await bad(u.email, 'bukan-kode'), uniform);
  const r = await call('POST', '/auth/reset-password', undefined, { email: u.email.toUpperCase(), recovery_code: fresh[0].toLowerCase().replace(/-/g, ''), new_password: PW2 });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.remaining_recovery_codes, 7);
  assert.equal((await call('GET', '/auth/me', sess.body.data.access_token)).status, 401, 'sesi lama mati');
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, sess.cookie)).status, 401);
  assert.equal((await login(u.email, PW)).status, 401); assert.equal((await login(u.email, PW2)).status, 200);
  assert.equal(await bad(u.email, fresh[0]), uniform, 'kode yang sama tidak dapat dipakai ulang');
  const r2 = await call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: fresh[1], new_password: 'kata-sandi-ketiga-yang-9' });
  assert.equal(r2.status, 200); assert.equal(r2.body.data.remaining_recovery_codes, 6, 'kode lain tetap berlaku');
  assert.deepEqual((await call('GET', '/auth/me', (await login(u.email, 'kata-sandi-ketiga-yang-9')).body.data.access_token)).body.data.recovery, { codes_remaining: 6, confirmed: false });
});

test('reset serentak dengan kode yang sama: hanya satu yang menang', { skip }, async () => {
  const u = await reg();
  const res = await Promise.all([PW2, 'kata-sandi-lain-yang-3', 'kata-sandi-lain-yang-4'].map((p) => call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: u.recovery[0], new_password: p })));
  assert.equal(res.filter((r) => r.status === 200).length, 1, res.map((r) => r.status).join());
});

test('pemohon bergabung (akun baru lewat kode workspace) mendapat 8 kode pemulihan; akun lama tidak; pembuatan permintaan diaudit', { skip }, async () => {
  const o = await reg();
  const code = (await call('PUT', '/team/join-code', o.tok)).body.data.join_code;
  const e = `jr${++n}@x.test`;
  const r = await call('POST', '/auth/join-requests', undefined, { join_code: code, email: e, password: PW });
  assert.equal(r.status, 201); assert.equal(r.body.data.recovery_codes.length, 8); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: e, recovery_code: r.body.data.recovery_codes[3], new_password: PW2 })).status, 200);
  const existing = await reg(); // akun lama di workspace lain
  const again = await call('POST', '/auth/join-requests', undefined, { join_code: code, email: existing.email, password: PW });
  assert.equal(again.status, 201); assert.equal(again.body.data.recovery_codes, undefined, 'akun lama tidak menerima kode baru');
  const log = (await call('GET', '/audit-logs?action=join_request.created&page_size=10', o.tok)).body.data;
  assert.equal(log.length, 2); assert.deepEqual(log.map((l: any) => l.target.email).sort(), [e, existing.email].sort());
  assert.ok(log.every((l: any) => l.actor.user_id && l.request_id), 'aktor dan request_id tercatat');
});

test('alat operator: terbitkan himpunan kode pemulihan untuk email lalu pengguna mereset', { skip }, async () => {
  const u = await reg();
  const codes = await identity.adminIssueRecoveryCodes(u.email.toUpperCase());
  assert.equal(codes.length, 8); assert.equal(await identity.adminIssueRecoveryCodes('hantu@x.test'), null);
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: u.recovery[0], new_password: PW2 })).status, 400, 'kode lama hangus');
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: u.email, recovery_code: codes[0], new_password: PW2 })).status, 200);
});

test('reset kata sandi tercatat di audit SETIAP workspace tempat pengguna menjadi anggota; pemalsuan lewat SQL ditolak', { skip }, async () => {
  const o1 = await reg(); const o2 = await reg(); const multi = await reg(); const stranger = await reg();
  for (const o of [o1, o2]) { const inv = await call('POST', '/team/invitations', o.tok, { email: multi.email, role: 'MEMBER' }); await call('POST', '/team/invitations/accept', multi.tok, { token: inv.body.data.token }); }
  assert.equal((await call('POST', '/auth/reset-password', undefined, { email: multi.email, recovery_code: multi.recovery[0], new_password: PW2 })).status, 200);
  const multiTok = (await login(multi.email, PW2)).body.data.access_token; // token lama mati oleh reset
  for (const o of [o1, o2, { ...multi, tok: multiTok }]) {
    const a = (await call('GET', '/audit-logs?action=account.password_reset', o.tok)).body.data;
    assert.equal(a.length, 1, `audit di ${o.name}`); assert.equal(a[0].actor.email, multi.email); assert.equal(a[0].details.method, 'recovery_code'); assert.ok(a[0].request_id);
  }
  assert.equal((await call('GET', '/audit-logs?action=account.password_reset', stranger.tok)).body.data.length, 0, 'workspace lain tidak melihat');
  const forge = (ctx: any, tenantId: string, action: string) => q(ctx, `INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type) VALUES ($1,$2,$3,'account')`, [tenantId, ctx.userId, action]);
  await assert.rejects(forge({ userId: stranger.userId }, o1.tenantId, 'account.password_reset'), /row-level security/, 'bukan anggota workspace itu');
  await assert.rejects(forge({ userId: multi.userId }, stranger.tenantId, 'account.password_reset'), /row-level security/);
  await assert.rejects(forge({ userId: multi.userId }, o1.tenantId, 'tenant.deleted'), /row-level security/, 'hanya aksi reset yang diizinkan tanpa konteks tenant');
  await assert.rejects(forge({ userId: stranger.userId }, o1.tenantId, 'join_request.created'), /row-level security/, 'tanpa kode workspace yang valid');
});

test('RLS kode pemulihan: hanya pemilik; pengguna lain dan platform tidak melihat; hash tidak memuat kode mentah', { skip }, async () => {
  const a = await reg(); const b = await reg();
  assert.equal((await q({ userId: b.userId }, 'SELECT 1 FROM user_recovery_codes WHERE user_id = $1', [a.userId])).length, 0);
  assert.equal((await q({ platform: true }, 'SELECT 1 FROM user_recovery_codes')).length, 0);
  await assert.rejects(q({ userId: b.userId }, `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [a.userId, recoveryHash('ABCDEFGHJKMNPQRSTUVW')]), /row-level security/);
  assert.equal((await q({ userId: b.userId }, `UPDATE user_recovery_codes SET used_at = NULL WHERE user_id = $1 RETURNING 1`, [a.userId])).length, 0);
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

test('pemulihan workspace terhapus: OWNER dengan email+kata sandi, dalam masa tunggu; data kembali, koneksi/webhook/key tidak; di luar masa tunggu ditolak', { skip }, async () => {
  const o = await reg(); const adm = await joinAs(o, 'ADMIN'); const other = await reg();
  const k = (await call('POST', '/api-keys', o.tok, { name: 'kunci', scopes: ['sessions:read'] })).body.data.key;
  const s = (await call('POST', '/sessions', o.tok, { session_name: 'Pulih', auto_connect: false })).body.data;
  await q({ tenantId: o.tenantId }, `INSERT INTO webhook_endpoints (tenant_id, url, secret_ciphertext, secret_key_version, secret_hint) VALUES ($1,'https://example.com/h','\\x00',1,'abcd')`, [o.tenantId]);
  assert.equal((await call('DELETE', '/tenant', o.tok, { password: PW, confirm_name: o.name })).status, 200);
  const list = (b: any) => call('POST', '/auth/deleted-workspaces', undefined, b);
  const restore = (b: any) => call('POST', '/auth/restore-workspace', undefined, b);
  assert.equal((await list({ email: o.email, password: 'salah-salah-12345' })).status, 401);
  const l = await list({ email: o.email, password: PW });
  assert.equal(l.status, 200); assert.deepEqual(l.body.data.map((x: any) => x.tenant_id), [o.tenantId]); assert.ok(l.body.data[0].restorable_until);
  assert.deepEqual((await list({ email: adm.email, password: PW })).body.data.filter((x: any) => x.tenant_id === o.tenantId), [], 'ADMIN tidak melihatnya');
  assert.deepEqual((await list({ email: other.email, password: PW })).body.data, [], 'pengguna lain tidak melihatnya');
  assert.equal((await restore({ email: adm.email, password: PW, tenant_id: o.tenantId })).status, 404, 'bukan OWNER = tidak ada');
  assert.equal((await restore({ email: other.email, password: PW, tenant_id: o.tenantId })).status, 404);
  assert.equal((await restore({ email: o.email, password: 'salah-salah-12345', tenant_id: o.tenantId })).status, 401);
  assert.equal((await restore({ email: o.email, password: PW, tenant_id: 'bukan-uuid' })).status, 400);
  // di luar masa tunggu
  await q({ tenantId: o.tenantId }, `UPDATE tenants SET deleted_at = now() - interval '31 days' WHERE id = $1`, [o.tenantId]);
  assert.equal((await restore({ email: o.email, password: PW, tenant_id: o.tenantId })).status, 404);
  assert.deepEqual((await list({ email: o.email, password: PW })).body.data, []);
  await q({ tenantId: o.tenantId }, `UPDATE tenants SET deleted_at = now() - interval '5 days' WHERE id = $1`, [o.tenantId]);
  const r = await restore({ email: o.email, password: PW, tenant_id: o.tenantId });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.restored, true); assert.deepEqual(r.body.data.must_recreate, ['whatsapp_sessions', 'webhooks', 'api_keys', 'invitations']);
  const again = await login(o.email, PW, o.tenantId); assert.equal(again.status, 200);
  assert.equal(again.body.data.role, 'OWNER');
  const tok = again.body.data.access_token;
  assert.equal((await login(adm.email, PW, o.tenantId)).status, 200, 'anggota kembali dapat masuk');
  assert.equal((await call('GET', '/team/members', tok)).body.meta.total, 2, 'anggota utuh');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: { 'x-api-key': k } })).statusCode, 401, 'API key tetap dicabut');
  const sess = (await call('GET', '/sessions', tok)).body.data; assert.equal(sess.some((x: any) => x.id === s.id && x.status !== 'DELETING' && x.status !== 'DELETED'), false, 'koneksi tidak kembali');
  assert.equal((await q({ tenantId: o.tenantId }, 'SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1', [o.tenantId])).length, 0);
  assert.ok((await actions({ ...o, tok })).includes('tenant.restored'));
  assert.equal((await restore({ email: o.email, password: PW, tenant_id: o.tenantId })).status, 404, 'sudah aktif: tidak dapat dipulihkan lagi');
  assert.equal((await q({ platform: true }, 'SELECT deleted_at FROM tenants WHERE id = $1', [o.tenantId]))[0].deleted_at, null);
});
