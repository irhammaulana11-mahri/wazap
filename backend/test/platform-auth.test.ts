import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env sebelum modul dimuat (config dibaca sekali): ambang kecil agar penguncian dapat diuji.
process.env.PLATFORM_MAX_FAILED_OTP = '3';
process.env.PLATFORM_LOCK_MINUTES = '15';

const { createTestDb, dbAvailable } = await import('./helpers.js');
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config/env.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createPlatformService } = await import('../src/modules/platform/platform.service.js');
const { signPlatformToken, signMfaToken } = await import('../src/modules/platform/platform-token.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { createKeyRotator } = await import('../src/runtime/rotate-keys.js');
const { base32Decode, totpAt } = await import('../src/security/totp.js');

const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);
let clock = 1_900_000_000;   // detik epoch yang dikendalikan tes (langkah TOTP), bukan jam sungguhan
const platform = skip ? (null as any) : createPlatformService(db, { crypto: cr, now: () => clock });
const mk = (extra: any = {}) => buildApp({ identity, team: createTeamService(db), sessions: createSessionService(db), platform, checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 }, ...extra });
const app = skip ? (null as any) : mk({ limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
after(async () => { await app?.close(); await t?.drop(); });

let n = 0; const PW = 'kata-sandi-panjang-1';
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (a: any, method: string, url: string, tok?: string, payload?: any, headers: Record<string, string> = {}) =>
  (await a.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload })) as any;
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `pa${++n}@x.test`;
  const r = await call(app, 'POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Platform ${n}` });
  assert.equal(r.statusCode, 201); const b = r.json().data;
  return { tok: b.access_token, userId: b.user.id, email, tenantId: b.tenant.id };
}
/** Pengguna biasa yang didaftarkan sebagai platform admin lewat layanan (setara CLI). */
async function admin() {
  const u = await reg();
  const e = await platform.createAdmin(u.email);
  const secret = base32Decode(e.secretBase32);
  const code = (offsetSteps = 0) => totpAt(secret, clock + offsetSteps * 30);
  return { u, e, secret, code };
}
const login = (a: any, email: string, password = PW) => call(a, 'POST', '/platform/auth/login', undefined, { email, password });
const verify = (a: any, mfa: string, code: string) => call(a, 'POST', '/platform/auth/verify', undefined, { mfa_token: mfa, code });
/** Masuk penuh (kata sandi + TOTP) dan kembalikan token platform. Maju satu langkah TOTP tiap pemanggilan agar kode tidak dianggap pemakaian ulang. */
async function signIn(a: { u: U; code: (o?: number) => string }) {
  clock += 30;
  const l = await login(app, a.u.email); assert.equal(l.statusCode, 200, l.body);
  const v = await verify(app, l.json().data.mfa_token, a.code()); assert.equal(v.statusCode, 200, v.body);
  return v.json().data.access_token as string;
}

test('alur masuk: kata sandi -> token MFA -> TOTP -> token platform; /platform/me; jejak audit; respons tidak di-cache', { skip }, async () => {
  const a = await admin();
  clock += 30;
  const l = await login(app, a.u.email);
  assert.equal(l.statusCode, 200); assert.equal(l.headers['cache-control'], 'no-store');
  const ch = l.json().data; assert.equal(ch.expires_in, config.PLATFORM_MFA_TOKEN_TTL_SECONDS); assert.ok(ch.mfa_token.length > 40);
  assert.equal((await call(app, 'GET', '/platform/me', ch.mfa_token)).statusCode, 401, 'token MFA belum cukup untuk rute platform');
  const v = await verify(app, ch.mfa_token, a.code());
  assert.equal(v.statusCode, 200); assert.equal(v.headers['cache-control'], 'no-store');
  const s = v.json().data; assert.equal(s.expires_in, config.PLATFORM_TOKEN_TTL_SECONDS); assert.equal(s.admin.email, a.u.email); assert.equal(s.recovery_remaining, 10);
  const me = await call(app, 'GET', '/platform/me', s.access_token);
  assert.equal(me.statusCode, 200); assert.deepEqual(me.json().data, { user_id: a.u.userId, email: a.u.email }); assert.equal(me.headers['cache-control'], 'no-store');
  const audit = await plat(`SELECT action, details FROM platform_audit_logs WHERE admin_user_id = $1 ORDER BY id`, [a.u.userId]);
  assert.deepEqual(audit.map((x: any) => x.action), ['platform_admin.created', 'platform_admin.password_ok', 'platform_admin.login']);
  assert.equal(audit[2].details.method, 'totp');
  assert.ok(!JSON.stringify(audit).includes(a.e.secretBase32), 'rahasia TOTP tidak boleh ada di audit');
});

test('semua kegagalan langkah 1 sama: pengguna tidak ada, kata sandi salah, bukan admin, admin dinonaktifkan (tidak membocorkan siapa admin)', { skip }, async () => {
  const a = await admin(); const plain = await reg();
  const bodies = [
    await login(app, 'tidak-ada@x.test'),
    await login(app, a.u.email, 'salah-salah-12345'),
    await login(app, plain.email),                                   // kata sandi BENAR tetapi bukan platform admin
  ];
  await plat(`UPDATE platform_admins SET status = 'DISABLED' WHERE user_id = $1`, [a.u.userId]);
  bodies.push(await login(app, a.u.email));                          // admin nonaktif
  for (const r of bodies) assert.equal(r.statusCode, 401);
  const shapes = new Set(bodies.map((r) => JSON.stringify({ c: r.json().error.code, m: r.json().error.message })));
  assert.equal(shapes.size, 1, `galat harus identik: ${[...shapes].join(' | ')}`);
  assert.equal(bodies[0].json().error.code, 'INVALID_CREDENTIALS');
  assert.equal((await call(app, 'POST', '/platform/auth/login', undefined, { email: a.u.email, password: PW, extra: 1 })).statusCode, 400, 'body strict');
});

test('TOTP salah dihitung dan mengunci akun admin itu; kode benar saat terkunci ditolak 429; setelah kunci berakhir kembali normal', { skip }, async () => {
  const a = await admin();
  clock += 30;
  const mfa = (await login(app, a.u.email)).json().data.mfa_token;
  for (let i = 1; i <= 2; i++) { const r = await verify(app, mfa, '000000'); assert.equal(r.statusCode, 401); assert.equal(r.json().error.code, 'INVALID_OTP'); }
  const third = await verify(app, mfa, '000000');
  assert.equal(third.statusCode, 401, 'kegagalan ketiga masih 401 (lalu mengunci)');
  const locked = await verify(app, mfa, a.code());
  assert.equal(locked.statusCode, 429, 'kode BENAR pun ditolak saat terkunci'); assert.equal(locked.json().error.code, 'ACCOUNT_LOCKED'); assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal((await login(app, a.u.email)).statusCode, 429, 'langkah 1 juga ditolak saat terkunci (kata sandi benar)');
  assert.deepEqual((await plat(`SELECT action FROM platform_audit_logs WHERE admin_user_id = $1 AND action LIKE '%otp_failed' OR action = 'platform_admin.locked' AND admin_user_id = $1 ORDER BY id`, [a.u.userId])).map((x: any) => x.action), ['platform_admin.otp_failed', 'platform_admin.otp_failed', 'platform_admin.locked']);
  await plat(`UPDATE platform_admins SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [a.u.userId]);
  const mfa2 = (await login(app, a.u.email)).json().data.mfa_token;
  assert.equal((await verify(app, mfa2, a.code())).statusCode, 200, 'setelah kunci berakhir kode benar diterima');
  assert.deepEqual((await plat(`SELECT failed_attempts, locked_until FROM platform_admins WHERE user_id = $1`, [a.u.userId]))[0], { failed_attempts: 0, locked_until: null }, 'hitungan dan kunci direset');
});

test('anti-pengulangan: kode TOTP yang sama tidak dapat dipakai dua kali; langkah berikutnya sah', { skip }, async () => {
  const a = await admin();
  clock += 30;
  const code = a.code();
  const m1 = (await login(app, a.u.email)).json().data.mfa_token;
  assert.equal((await verify(app, m1, code)).statusCode, 200);
  const m2 = (await login(app, a.u.email)).json().data.mfa_token;
  const replay = await verify(app, m2, code);
  assert.equal(replay.statusCode, 401); assert.equal(replay.json().error.code, 'INVALID_OTP', 'kode yang sama ditolak');
  clock += 30;
  assert.equal((await verify(app, m2, a.code())).statusCode, 200, 'langkah waktu berikutnya diterima');
});

test('kode pemulihan: sekali pakai, mengurangi sisa, salah dihitung; kode TOTP bukan kode pemulihan', { skip }, async () => {
  const a = await admin();
  clock += 30;
  const rc = a.e.recoveryCodes as string[]; assert.equal(rc.length, 10);
  const m1 = (await login(app, a.u.email)).json().data.mfa_token;
  const ok = await verify(app, m1, rc[0]!.toUpperCase());
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().data.recovery_remaining, 9);
  const m2 = (await login(app, a.u.email)).json().data.mfa_token;
  assert.equal((await verify(app, m2, rc[0]!)).statusCode, 401, 'kode pemulihan yang sama tidak sah lagi');
  assert.equal((await verify(app, m2, 'abcd-efgh-jkmn')).statusCode, 401, 'kode pemulihan acak ditolak');
  assert.equal((await verify(app, m2, rc[1]!)).statusCode, 200); assert.equal((await plat(`SELECT cardinality(recovery_hashes)::int n FROM platform_admins WHERE user_id = $1`, [a.u.userId]))[0].n, 8);
  assert.equal((await plat(`SELECT details FROM platform_audit_logs WHERE admin_user_id = $1 AND action = 'platform_admin.login' ORDER BY id DESC LIMIT 1`, [a.u.userId]))[0].details.method, 'recovery');
});

test('pemisahan token: token workspace, API key, token MFA, token kedaluwarsa, dan token rusak TIDAK sah di rute platform; token platform TIDAK sah di rute workspace', { skip }, async () => {
  const a = await admin(); const tok = await signIn(a);
  const key = (await call(app, 'POST', '/api-keys', a.u.tok, { name: 'kunci-uji', scopes: ['sessions:read'] })).json().data.key;
  const mfa = signMfaToken(a.u.userId, 0);
  const expired = signPlatformToken(a.u.userId, 0, -10);
  const forged = tok.slice(0, -3) + (tok.endsWith('AAA') ? 'BBB' : 'AAA');
  for (const [name, h] of [
    ['token workspace', { authorization: `Bearer ${a.u.tok}` }], ['API key sebagai Bearer', { authorization: `Bearer ${key}` }], ['API key X-API-Key', { 'x-api-key': key }],
    ['token MFA', { authorization: `Bearer ${mfa}` }], ['kedaluwarsa', { authorization: `Bearer ${expired}` }], ['rusak', { authorization: `Bearer ${forged}` }],
    ['tanpa kredensial', {}], ['tanpa skema Bearer', { authorization: tok }],
  ] as const) assert.equal((await call(app, 'GET', '/platform/me', undefined, undefined, h as any)).statusCode, 401, name);
  assert.equal((await call(app, 'GET', '/platform/me', tok)).statusCode, 200);
  // arah sebaliknya: token platform tidak diterima di rute workspace mana pun
  for (const url of ['/auth/me', '/sessions', '/team/members', '/tenant/settings', '/usage/summary']) assert.equal((await call(app, 'GET', url, tok)).statusCode, 401, `${url} dengan token platform`);
  // token MFA tidak dapat dipakai untuk memverifikasi sebagai orang lain: sub terikat
  const other = await admin();
  assert.equal((await verify(app, signMfaToken(other.u.userId, 0), a.code())).statusCode, 401, 'kode admin A tidak sah untuk token MFA admin B');
});

test('ganti kata sandi mematikan token platform dan token MFA yang diterbitkan sebelumnya', { skip }, async () => {
  const a = await admin(); const tok = await signIn(a);
  assert.equal((await call(app, 'GET', '/platform/me', tok)).statusCode, 200);
  clock += 30; const mfaOld = (await login(app, a.u.email)).json().data.mfa_token;
  const pw = await call(app, 'POST', '/auth/change-password', a.u.tok, { current_password: PW, new_password: 'kata-sandi-baru-2x' });
  assert.equal(pw.statusCode, 200, pw.body);
  assert.equal((await call(app, 'GET', '/platform/me', tok)).statusCode, 401, 'token platform lama mati');
  assert.equal((await verify(app, mfaOld, a.code())).statusCode, 401, 'token MFA lama mati');
});

test('saklar PLATFORM_ENABLED=false: seluruh /platform/* menjawab 404 (termasuk login)', { skip }, async () => {
  const a = await admin();
  (config as any).PLATFORM_ENABLED = 'false';
  try {
    assert.equal((await login(app, a.u.email)).statusCode, 404);
    assert.equal((await call(app, 'POST', '/platform/auth/verify', undefined, { mfa_token: 'x'.repeat(20), code: '123456' })).statusCode, 404);
    assert.equal((await call(app, 'GET', '/platform/me')).statusCode, 404);
  } finally { (config as any).PLATFORM_ENABLED = 'true'; }
  assert.equal((await login(app, a.u.email)).statusCode, 200, 'kembali normal');
});

test('pembatas laju login: per-email 5 per 15 menit dan per-IP; 429 membawa Retry-After', { skip }, async () => {
  const strict = mk();   // pembatas laju nyata
  try {
    const email = `limit${++n}@x.test`;
    for (let i = 0; i < 5; i++) assert.equal((await login(strict, email, 'salah-salah-12345')).statusCode, 401);
    const r = await login(strict, email, 'salah-salah-12345');
    assert.equal(r.statusCode, 429); assert.equal(r.json().error.code, 'RATE_LIMITED'); assert.ok(Number(r.headers['retry-after']) > 0);
  } finally { await strict.close(); }
});

test('pengelolaan akun (setara CLI): duplikat 409, pengguna tidak ada 404, reset-mfa mematikan perangkat lama, cabut menutup akses, daftar tanpa rahasia, rahasia terenkripsi saat disimpan', { skip }, async () => {
  const a = await admin();
  await assert.rejects(platform.createAdmin(a.u.email), (e: any) => e.code === 'ALREADY_EXISTS');
  await assert.rejects(platform.createAdmin('tidak-ada@x.test'), (e: any) => e.code === 'NOT_FOUND');
  // rahasia tidak tersimpan terbaca
  const row = (await plat(`SELECT totp_cipher, recovery_hashes, totp_key_version FROM platform_admins WHERE user_id = $1`, [a.u.userId]))[0];
  assert.ok(!Buffer.from(row.totp_cipher).includes(Buffer.from(a.e.secretBase32)) && !Buffer.from(row.totp_cipher).includes(a.secret), 'rahasia TOTP terenkripsi di DB');
  assert.ok(row.recovery_hashes.every((h: string) => /^[0-9a-f]{64}$/.test(h)) && !row.recovery_hashes.some((h: string) => (a.e.recoveryCodes as string[]).includes(h)), 'hanya hash kode pemulihan');
  assert.equal(row.totp_key_version, 1);
  // daftar tidak memuat rahasia
  const list = await platform.listAdmins(); const mine = list.find((x: any) => x.user_id === a.u.userId);
  assert.deepEqual([mine.email, mine.status, mine.recovery_remaining], [a.u.email, 'ACTIVE', 10]);
  assert.ok(!/totp|cipher|hash|secret/i.test(JSON.stringify(list)), 'daftar admin tidak memuat rahasia');
  // reset-mfa: perangkat lama mati, baru berfungsi
  const oldCode = a.code(); const e2 = await platform.resetMfa(a.u.email);
  const fresh = totpAt(base32Decode(e2.secretBase32), clock + 30);
  clock += 30;
  const m = (await login(app, a.u.email)).json().data.mfa_token;
  assert.equal((await verify(app, m, totpAt(a.secret, clock))).statusCode, 401, 'kode dari perangkat lama tidak sah');
  void oldCode; clock += 30;
  assert.equal((await verify(app, m, totpAt(base32Decode(e2.secretBase32), clock))).statusCode, 200, 'perangkat baru sah'); void fresh;
  // cabut: tidak dapat masuk lagi dan token yang ada mati
  const tok = await signIn({ u: a.u, code: () => totpAt(base32Decode(e2.secretBase32), clock) });
  await platform.revokeAdmin(a.u.email);
  assert.equal((await call(app, 'GET', '/platform/me', tok)).statusCode, 401);
  assert.equal((await login(app, a.u.email)).statusCode, 401);
  assert.equal((await plat(`SELECT count(*)::int n FROM platform_audit_logs WHERE admin_user_id = $1 AND action IN ('platform_admin.created','platform_admin.mfa_reset','platform_admin.revoked')`, [a.u.userId]))[0].n, 3, 'jejak pembuatan/reset/pencabutan tetap ada');
});

test('platform_audit_logs append-only mutlak (UPDATE/DELETE tidak berdampak, TRUNCATE ditolak, walau konteks platform); tabel platform tidak terlihat dari konteks tenant/pengguna', { skip }, async () => {
  const a = await admin();
  const before = (await plat(`SELECT id, action FROM platform_audit_logs WHERE admin_user_id = $1 ORDER BY id`, [a.u.userId]));
  const id = before[0].id;
  // Tanpa kebijakan UPDATE/DELETE, RLS menyembunyikan baris dari perintah itu: tidak ada galat tetapi 0 baris berubah (trigger penjaga menjadi lapis cadangan).
  assert.equal((await db.tx({ platform: true }, (c: any) => c.query(`UPDATE platform_audit_logs SET action = 'x.y' WHERE id = $1`, [id]))).rowCount, 0, 'UPDATE tidak mengubah baris');
  assert.equal((await db.tx({ platform: true }, (c: any) => c.query(`DELETE FROM platform_audit_logs WHERE id = $1`, [id]))).rowCount, 0, 'DELETE tidak menghapus baris');
  await assert.rejects(plat(`TRUNCATE platform_audit_logs`), /append-only/, 'TRUNCATE ditolak trigger');
  assert.deepEqual(await plat(`SELECT id, action FROM platform_audit_logs WHERE admin_user_id = $1 ORDER BY id`, [a.u.userId]), before, 'isi jejak utuh');
  for (const ctx of [{ tenantId: a.u.tenantId }, { userId: a.u.userId }, { tenantId: a.u.tenantId, userId: a.u.userId }]) {
    for (const tb of ['platform_admins', 'platform_audit_logs']) assert.equal((await db.tx(ctx, async (c: any) => (await c.query(`SELECT 1 FROM ${tb}`)).rows)).length, 0, `${tb} tidak terlihat dari ${Object.keys(ctx)}`);
    await assert.rejects(db.tx(ctx, (c: any) => c.query(`INSERT INTO platform_audit_logs (admin_email, action) VALUES ('x@x.test', 'a.b')`)), /row-level security|violates/);
    assert.equal((await db.tx(ctx, (c: any) => c.query(`UPDATE platform_defaults SET max_sessions = 99`))).rowCount, 0, 'default hanya ditulis platform (USING RLS menyaring: 0 baris berubah, tanpa galat)');
  }
  assert.equal((await db.tx({ tenantId: a.u.tenantId }, async (c: any) => (await c.query('SELECT max_sessions FROM platform_defaults')).rows))[0].max_sessions, 3, 'default dapat dibaca konteks tenant (untuk registrasi) dan nilainya tidak berubah');
  assert.equal((await db.tx({ loginEmail: a.u.email }, async (c: any) => (await c.query('SELECT 1 FROM platform_defaults')).rows)).length, 0, 'konteks tanpa tenant/pengguna/platform tidak melihat default');
});

test('rotasi kunci master: rahasia TOTP dienkripsi ulang ke versi aktif (dry-run tidak mengubah); setelah kunci lama dipensiunkan admin tetap dapat masuk; tanpa rotasi mereka terkunci', { skip }, async () => {
  const k1 = crypto.randomBytes(32).toString('base64'), k2 = crypto.randomBytes(32).toString('base64');
  await plat('DELETE FROM platform_admins');   // admin dari tes lain memakai kunci acak lain: isolasi agar laporan rotasi hanya memuat baris tes ini
  const svc1 = createPlatformService(db, { crypto: createCredentialCrypto(parseKeyring(`1:${k1}`)), now: () => clock });
  const u = await reg(); const e = await svc1.createAdmin(u.email); const secret = base32Decode(e.secretBase32);
  const version = async () => (await plat(`SELECT totp_key_version v FROM platform_admins WHERE user_id = $1`, [u.userId]))[0].v;
  assert.equal(await version(), 1);
  const rot = createKeyRotator(db, createCredentialCrypto(parseKeyring(`1:${k1},2:${k2}`, 2)));
  const dry = await rot.run({ dryRun: true });
  assert.ok(dry.platformTotp.rotated >= 1 && dry.platformTotp.failed === 0); assert.equal(await version(), 1, 'dry-run tidak mengubah apa pun');
  const rep = await rot.run();
  assert.ok(rep.platformTotp.rotated >= 1 && rep.platformTotp.failed === 0); assert.equal(await version(), 2);
  assert.equal(rep.versions.platform_totp?.['1'], undefined, 'tidak ada rahasia TOTP tersisa pada versi lama'); assert.equal(rep.retireReady, true, 'kunci lama aman dipensiunkan');
  // kunci 1 dipensiunkan: ring hanya berisi kunci 2
  const svc2 = createPlatformService(db, { crypto: createCredentialCrypto(parseKeyring(`2:${k2}`, 2)), now: () => clock });
  clock += 30;
  const l = await svc2.login({ email: u.email, password: PW });
  const v = await svc2.verifyMfa({ mfaToken: l.mfa_token, code: totpAt(secret, clock) });
  assert.ok(v.access_token, 'masuk berhasil dengan kunci baru saja');
  // kontrol: admin yang BELUM dirotasi tidak dapat masuk bila kunci lamanya dipensiunkan (inilah yang dicegah rotasi)
  const u2 = await reg(); const e2 = await svc1.createAdmin(u2.email);
  clock += 30;
  const l2 = await svc2.login({ email: u2.email, password: PW });
  await assert.rejects(svc2.verifyMfa({ mfaToken: l2.mfa_token, code: totpAt(base32Decode(e2.secretBase32), clock) }), (err: any) => err.code === 'INVALID_MFA_TOKEN', 'tanpa rotasi, kunci lama dipensiunkan = admin terkunci');
});
