import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PLATFORM_MAX_FAILED_OTP = '20';   // tes ini memakai banyak kode; penguncian diuji di platform-auth.test.ts

const { createTestDb, dbAvailable } = await import('./helpers.js');
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSettingsService } = await import('../src/modules/tenant/settings.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createPlatformService } = await import('../src/modules/platform/platform.service.js');
const { signAccessToken } = await import('../src/modules/identity/tokens.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { base32Decode, totpAt } = await import('../src/security/totp.js');

const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
let clock = 1_900_000_000;
const platform = skip ? (null as any) : createPlatformService(db, { crypto: cr, now: () => clock });
const idOpen = skip ? (null as any) : createIdentityService(db, { registrationApproval: 'open' });
const idReq = skip ? (null as any) : createIdentityService(db, { registrationApproval: 'required' });
const common = { settings: skip ? null : createSettingsService(db), audit: skip ? null : createAuditService(db), platform, checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() } as any;
const appReq = skip ? (null as any) : buildApp({ ...common, identity: idReq });     // persetujuan diwajibkan
const appOpen = skip ? (null as any) : buildApp({ ...common, identity: idOpen });   // perilaku lama
after(async () => { await appReq?.close(); await appOpen?.close(); await t?.drop(); });

const PW = 'kata-sandi-panjang-1'; let n = 0;
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const tq = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (app: any, method: string, url: string, tok?: string, payload?: any) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, headers: r.headers };
};
const statusOf = async (tenantId: string) => (await plat('SELECT status, decided_at FROM tenants WHERE id = $1', [tenantId]))[0];
const signup = async (name = `Daftar ${++n}`) => {
  const email = `reg${++n}@x.test`;
  const r = await call(appReq, 'POST', '/auth/register', undefined, { email, password: PW, tenant_name: name });
  return { r, email, name, tenantId: r.body?.data?.tenant?.id as string, userId: r.body?.data?.user?.id as string };
};
// ---- platform admin (akun biasa pada mode open, lalu didaftarkan lewat layanan) ----
const ADMIN = skip ? (null as any) : await (async () => {
  const email = `admin${++n}@x.test`; await idOpen.register({ email, password: PW, tenantName: 'Akun Admin' });
  const e = await platform.createAdmin(email); const secret = base32Decode(e.secretBase32); const code = () => totpAt(secret, clock);
  clock += 30; const l = await call(appReq, 'POST', '/platform/auth/login', undefined, { email, password: PW });
  const v = await call(appReq, 'POST', '/platform/auth/verify', undefined, { mfa_token: l.body.data.mfa_token, code: code() });
  return { code, tok: v.body.data.access_token as string };
})();
const P = (method: string, url: string, payload?: any) => call(appReq, method, `/platform${url}`, ADMIN.tok, payload);
const approve = (id: string, extra: any = {}) => { clock += 30; return P('POST', `/workspaces/${id}/approve`, { otp: ADMIN.code(), ...extra }); };
const reject = (id: string, extra: any = {}) => { clock += 30; return P('POST', `/workspaces/${id}/reject`, { reason: 'bukan pelanggan kami', otp: ADMIN.code(), ...extra }); };

test('mode required: pendaftaran menjawab 202 tanpa token dan tanpa cookie; workspace PENDING; kode pemulihan tetap diberikan', { skip }, async () => {
  const s = await signup();
  assert.equal(s.r.status, 202);
  assert.equal(s.r.body.data.status, 'PENDING_APPROVAL');
  assert.equal(s.r.body.data.access_token, undefined); assert.equal(s.r.body.data.refresh_token, undefined);
  assert.equal(s.r.headers['set-cookie'], undefined, 'tidak ada cookie refresh');
  assert.match(String(s.r.headers['cache-control']), /no-store/);
  assert.equal(s.r.body.data.recovery_codes.length, 8);
  assert.equal(s.r.body.data.tenant.name, s.name);
  assert.equal((await statusOf(s.tenantId)).status, 'PENDING');
  assert.equal((await tq(s.tenantId, 'SELECT count(*)::int n FROM refresh_tokens'))[0].n, 0, 'tidak ada refresh token diterbitkan');
});

test('mode open (bawaan) tidak berubah: 201 dengan token dan workspace ACTIVE', { skip }, async () => {
  const r = await call(appOpen, 'POST', '/auth/register', undefined, { email: `open${++n}@x.test`, password: PW, tenant_name: 'Terbuka' });
  assert.equal(r.status, 201); assert.ok(r.body.data.access_token); assert.equal((await statusOf(r.body.data.tenant.id)).status, 'ACTIVE');
});

test('login: kata sandi salah tetap seragam (401); kata sandi benar menjawab 403 REGISTRATION_PENDING; token palsu untuk workspace PENDING ditolak', { skip }, async () => {
  const s = await signup();
  const bad = await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: 'salah-salah-salah' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  const l = await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: PW });
  assert.equal(l.status, 403); assert.equal(l.body.error.code, 'REGISTRATION_PENDING');
  const forged = signAccessToken(s.userId, s.tenantId, undefined, 0);
  assert.equal((await call(appReq, 'GET', '/auth/me', forged)).status, 401, 'access token untuk workspace PENDING tidak sah');
  assert.equal((await call(appReq, 'GET', '/sessions', forged)).status, 401);
});

test('konsol platform: daftar bawaan tidak memuat PENDING; filter PENDING/ALL memuatnya dengan surel pemilik; detail dapat dibuka', { skip }, async () => {
  const s = await signup('Menunggu Daftar');
  const def = await P('GET', `/workspaces?q=${encodeURIComponent('Menunggu Daftar')}`);
  assert.equal(def.body.data.length, 0, 'daftar bawaan (ACTIVE,SUSPENDED) tidak memuat pendaftaran menunggu');
  const pend = await P('GET', `/workspaces?status=PENDING&q=${encodeURIComponent('Menunggu Daftar')}`);
  assert.equal(pend.body.data.length, 1); assert.equal(pend.body.data[0].status, 'PENDING'); assert.deepEqual(pend.body.data[0].owners, [s.email]); assert.equal(pend.body.data[0].decided_at, null);
  assert.equal((await P('GET', `/workspaces?status=ALL&q=${encodeURIComponent('Menunggu Daftar')}`)).body.data.length, 1);
  assert.equal((await P('GET', `/workspaces/${s.tenantId}`)).body.data.status, 'PENDING');
  const cnt = await P('GET', '/workspaces?status=PENDING&page_size=1'); assert.ok(cnt.body.meta.total >= 1, 'total PENDING tersedia untuk lencana');
});

test('persetujuan: kode TOTP salah atau hilang tidak mengubah apa pun; menyetujui yang sudah ACTIVE 409; sukses memulihkan akses dan tercatat di audit', { skip }, async () => {
  const s = await signup();
  const noOtp = await P('POST', `/workspaces/${s.tenantId}/approve`, {}); assert.equal(noOtp.status, 400);
  const badOtp = await P('POST', `/workspaces/${s.tenantId}/approve`, { otp: '000000' }); assert.equal(badOtp.status, 401);
  assert.equal((await statusOf(s.tenantId)).status, 'PENDING', 'kode salah tidak mengubah status');
  assert.equal((await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: PW })).status, 403);
  const ok = await approve(s.tenantId, { reason: 'pelanggan sah' });
  assert.equal(ok.status, 200); assert.equal(ok.body.data.status, 'ACTIVE'); assert.ok(ok.body.data.decided_at);
  const row = await statusOf(s.tenantId); assert.equal(row.status, 'ACTIVE'); assert.ok(row.decided_at);
  const l = await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: PW });
  assert.equal(l.status, 200); assert.equal(l.body.data.tenant.id, s.tenantId); assert.equal(l.body.data.role, 'OWNER');
  assert.equal((await call(appReq, 'GET', '/sessions', l.body.data.access_token)).status, 200, 'akses penuh setelah disetujui');
  assert.equal((await approve(s.tenantId)).status, 409, 'sudah ACTIVE');
  // kuota awal = kuota bawaan platform
  const lim = (await call(appReq, 'GET', '/tenant/settings', l.body.data.access_token)).body.data.limits;
  const def = (await P('GET', '/defaults')).body.data.limits;
  assert.deepEqual([lim.max_sessions, lim.max_api_keys, lim.max_members, lim.messages_per_minute], [def.max_sessions, def.max_api_keys, def.max_members, def.messages_per_minute]);
  // jejak: audit platform (dengan alasan) dan audit workspace (tanpa alasan dan identitas operator)
  const pa = (await P('GET', `/audit?tenant_id=${s.tenantId}&action=tenant.approved`)).body.data; assert.equal(pa.length, 1); assert.equal(pa[0].reason, 'pelanggan sah'); assert.equal(pa[0].details.previous_status, 'PENDING');
  const ta = await tq(s.tenantId, `SELECT actor_email, details FROM audit_logs WHERE action = 'tenant.approved'`);
  assert.equal(ta.length, 1); assert.equal(ta[0].actor_email, 'platform'); assert.ok(!JSON.stringify(ta[0].details).includes('pelanggan sah'), 'alasan internal tidak bocor ke workspace');
});

test('penolakan: alasan wajib; REJECTED menjawab 403 REGISTRATION_REJECTED; surel tidak dapat didaftarkan ulang; tidak bisa ditolak dua kali; dapat disetujui kemudian', { skip }, async () => {
  const s = await signup();
  assert.equal((await P('POST', `/workspaces/${s.tenantId}/reject`, { otp: ADMIN.code() })).status, 400, 'alasan wajib');
  assert.equal((await P('POST', `/workspaces/${s.tenantId}/reject`, { reason: 'x', otp: ADMIN.code() })).status, 400, 'alasan minimal 3 karakter');
  assert.equal((await statusOf(s.tenantId)).status, 'PENDING');
  const rj = await reject(s.tenantId); assert.equal(rj.status, 200); assert.equal(rj.body.data.status, 'REJECTED'); assert.ok(rj.body.data.decided_at);
  const l = await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: PW });
  assert.equal(l.status, 403); assert.equal(l.body.error.code, 'REGISTRATION_REJECTED');
  assert.equal((await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: 'salah-salah-salah' })).status, 401, 'kata sandi salah tetap seragam');
  const again = await call(appReq, 'POST', '/auth/register', undefined, { email: s.email, password: PW, tenant_name: 'Coba Lagi' });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'EMAIL_TAKEN');
  assert.equal((await reject(s.tenantId)).status, 409, 'sudah REJECTED');
  const pa = (await P('GET', `/audit?tenant_id=${s.tenantId}&action=tenant.rejected`)).body.data; assert.equal(pa.length, 1); assert.equal(pa[0].reason, 'bukan pelanggan kami');
  assert.equal((await tq(s.tenantId, `SELECT 1 FROM audit_logs WHERE action = 'tenant.rejected'`)).length, 0, 'penolakan tidak ditulis ke audit workspace (alasan internal)');
  const ok = await approve(s.tenantId); assert.equal(ok.status, 200, 'kesempatan kedua: REJECTED dapat disetujui');
  assert.equal((await call(appReq, 'POST', '/auth/login', undefined, { email: s.email, password: PW })).status, 200);
});

test('tanpa admin platform tidak ada jalan: tanpa token dan token workspace ditolak; PENDING tidak menghasilkan sesi atau data', { skip }, async () => {
  const s = await signup();
  assert.equal((await call(appReq, 'POST', `/platform/workspaces/${s.tenantId}/approve`, undefined, { otp: '123456' })).status, 401);
  const wsTok = (await idOpen.register({ email: `tok${++n}@x.test`, password: PW, tenantName: 'Biasa' })).accessToken;
  assert.equal((await call(appReq, 'POST', `/platform/workspaces/${s.tenantId}/approve`, wsTok, { otp: '123456' })).status, 401, 'token workspace tidak sah di konsol platform');
  assert.equal((await statusOf(s.tenantId)).status, 'PENDING');
  assert.equal((await tq(s.tenantId, 'SELECT count(*)::int n FROM wa_sessions'))[0].n, 0);
});
