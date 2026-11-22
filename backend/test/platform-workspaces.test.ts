import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLATFORM_MAX_FAILED_OTP = '20';   // tes ini memakai banyak kode; penguncian diuji di platform-auth.test.ts

const { createTestDb, dbAvailable } = await import('./helpers.js');
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { config } = await import('../src/config/env.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createSettingsService } = await import('../src/modules/tenant/settings.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createPlatformService } = await import('../src/modules/platform/platform.service.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { base32Decode, totpAt } = await import('../src/security/totp.js');

const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
let clock = 1_900_000_000;
const platform = skip ? (null as any) : createPlatformService(db, { crypto: cr, now: () => clock });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), team: createTeamService(db), sessions: createSessionService(db), settings: createSettingsService(db), audit: createAuditService(db), platform,
  checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 }, limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0; const PW = 'kata-sandi-panjang-1';
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const tq = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, headers: r.headers, raw: r.body as string };
};
interface U { tok: string; userId: string; email: string; tenantId: string; name: string }
async function reg(name = `WS ${++n}`): Promise<U> {
  const email = `pw${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: name });
  assert.equal(r.status, 201); return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id, name };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  const tok = (await call('POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId })).body.data.access_token;
  return { ...u, tenantId: owner.tenantId, tok };
}
// ---- platform admin tunggal untuk seluruh berkas ----
const ADMIN = skip ? (null as any) : await (async () => {
  const u = await reg('Akun Admin'); const e = await platform.createAdmin(u.email); const secret = base32Decode(e.secretBase32);
  const code = () => totpAt(secret, clock);
  clock += 30; const l = await call('POST', '/platform/auth/login', undefined, { email: u.email, password: PW });
  const v = await call('POST', '/platform/auth/verify', undefined, { mfa_token: l.body.data.mfa_token, code: code() });
  return { u, secret, code, tok: v.body.data.access_token as string };
})();
const P = (method: string, url: string, payload?: any) => call(method, `/platform${url}`, ADMIN.tok, payload);
/** Perubahan dengan kode TOTP SEGAR (maju satu langkah waktu) dan alasan. */
const quota = (tenantId: string, body: any, extra: any = {}) => { clock += 30; return P('PATCH', `/workspaces/${tenantId}/quotas`, { ...body, reason: 'uji kuota', otp: ADMIN.code(), ...extra }); };
const tenantLimits = async (tenantId: string) => (await call('GET', '/tenant/settings', (await ownerTok(tenantId)))).body.data.limits;
const owners = new Map<string, string>();
const ownerTok = async (tenantId: string) => owners.get(tenantId)!;
async function ws(name?: string) { const o = await reg(name); owners.set(o.tenantId, o.tok); return o; }

test('daftar workspace: bawaan ACTIVE+SUSPENDED, filter status dan pencarian (nama, slug, surel OWNER), paginasi, bentuk tetap tanpa data pelanggan', { skip }, async () => {
  const a = await ws(`Toko Alfa ${++n}`); const b = await ws(`Toko Beta ${n}`); const c = await ws(`Toko Gama ${n}`);
  await plat(`UPDATE tenants SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1`, [b.tenantId]);
  await plat(`UPDATE tenants SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [c.tenantId]);
  const ids = (r: any) => r.body.data.map((x: any) => x.id);
  const all = await P('GET', '/workspaces?page_size=100');
  assert.equal(all.status, 200); assert.ok(ids(all).includes(a.tenantId) && ids(all).includes(b.tenantId) && !ids(all).includes(c.tenantId), 'bawaan: ACTIVE dan SUSPENDED, tanpa DELETED');
  assert.ok(all.body.meta.total >= 3 && all.body.meta.page === 1 && all.body.meta.page_size === 100);
  assert.deepEqual(ids(await P('GET', `/workspaces?status=DELETED&q=${encodeURIComponent(c.name)}`)), [c.tenantId]);
  assert.ok(ids(await P('GET', '/workspaces?status=ALL&page_size=100')).includes(c.tenantId));
  assert.deepEqual(ids(await P('GET', '/workspaces?status=SUSPENDED&page_size=100')).filter((x: string) => [a, b, c].some((u) => u.tenantId === x)), [b.tenantId]);
  assert.deepEqual(ids(await P('GET', `/workspaces?q=${encodeURIComponent(a.name)}`)), [a.tenantId], 'cari nama');
  assert.deepEqual(ids(await P('GET', `/workspaces?q=${encodeURIComponent(b.email.toUpperCase())}`)), [b.tenantId], 'cari surel OWNER (tanpa membedakan huruf)');
  assert.deepEqual(ids(await P('GET', '/workspaces?q=%25')), [], 'karakter wildcard di-escape (tidak mencocokkan semuanya)');
  const p1 = await P('GET', '/workspaces?page=1&page_size=2'); const p2 = await P('GET', '/workspaces?page=2&page_size=2');
  assert.equal(p1.body.data.length, 2); assert.notDeepEqual(ids(p1), ids(p2));
  for (const q of ['page_size=0', 'page_size=101', 'page=0', 'status=APA', 'q=', 'x=1']) assert.equal((await P('GET', `/workspaces?${q}`)).status, 400, q);
  const item = (await P('GET', `/workspaces?q=${encodeURIComponent(a.name)}`)).body.data[0];
  assert.deepEqual(Object.keys(item).sort(), ['created_at', 'decided_at', 'id', 'limits', 'name', 'owners', 'slug', 'status', 'suspended_at', 'used'], 'bentuk tetap (daftar putih kolom)');
  assert.deepEqual(item.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 });
  assert.deepEqual(item.owners, [a.email]);
});

test('pemakaian agregat dan detail: sesi, kunci API, anggota (+undangan tertunda), OWNER, riwayat; sama dengan definisi kuota; id tidak valid/tidak ada 404', { skip }, async () => {
  const o = await ws(); const m = await join(o, 'MEMBER'); await join(o, 'VIEWER');
  await call('POST', '/sessions', o.tok, { session_name: 'Sesi Satu', auto_connect: false }); const s2 = (await call('POST', '/sessions', o.tok, { session_name: 'Sesi Dua', auto_connect: false })).body.data;
  await plat(`UPDATE wa_sessions SET status = 'CONNECTED' WHERE id = $1`, [s2.id]);
  const k = (await call('POST', '/api-keys', o.tok, { name: 'kunci-1', scopes: ['usage:read'] })).body.data; await call('POST', '/api-keys', o.tok, { name: 'kunci-2', scopes: ['usage:read'] });
  await call('DELETE', `/api-keys/${k.id}`, o.tok);
  await call('POST', '/team/invitations', o.tok, { email: 'tertunda@x.test', role: 'VIEWER' });
  const d = (await P('GET', `/workspaces/${o.tenantId}`)).body.data;
  assert.deepEqual(d.used, { sessions: 2, sessions_connected: 1, api_keys: 1, members: 3 });
  assert.deepEqual(d.quota_used, { sessions: 2, api_keys: 1, members: 4 }, 'anggota kuota = anggota + undangan tertunda (definisi yang sama dengan penolakan pembuatan)');
  assert.deepEqual(d.members_by_role, { OWNER: 1, MEMBER: 1, VIEWER: 1 }); assert.equal(d.pending_invitations, 1);
  assert.deepEqual(d.owner_accounts.map((x: any) => [x.user_id, x.email, x.status]), [[o.userId, o.email, 'ACTIVE']]);
  assert.deepEqual(d.minimums, { max_sessions: 1, max_api_keys: 0, max_members: 1, messages_per_minute: 1 }); assert.equal(d.ceilings.max_sessions, config.LIMIT_CEIL_SESSIONS);
  assert.ok(Array.isArray(d.history));
  assert.equal((await call('GET', '/tenant/settings', o.tok)).body.data.used.members, 4, 'angka yang dilihat OWNER sama dengan yang dilihat platform');
  void m;
  assert.equal((await P('GET', `/workspaces/${crypto.randomUUID()}`)).status, 404); assert.equal((await P('GET', '/workspaces/bukan-uuid')).status, 404);
});

test('kuota: perubahan berlaku seketika; di bawah pemakaian ditolak; tidak ada perubahan 409; nilai sama tidak dihitung; workspace lain tidak terpengaruh', { skip }, async () => {
  const o = await ws(); const other = await ws();
  const mk = (name: string) => call('POST', '/sessions', o.tok, { session_name: name, auto_connect: false });
  for (const nm of ['s1', 's2', 's3']) assert.equal((await mk(nm)).status, 201);
  assert.deepEqual([(await mk('s4')).status, (await mk('s4')).body.error.code], [409, 'QUOTA_EXCEEDED']);
  const up = await quota(o.tenantId, { max_sessions: 5 });
  assert.equal(up.status, 200); assert.equal(up.body.data.limits.max_sessions, 5); assert.equal(up.body.data.used.sessions, 3); assert.equal(up.body.data.editable, false);
  assert.equal((await mk('s4')).status, 201, 'berlaku seketika tanpa restart');
  const low = await quota(o.tenantId, { max_sessions: 3 });
  assert.deepEqual([low.status, low.body.error.code], [409, 'LIMIT_BELOW_USAGE']);
  assert.equal((await tenantLimits(o.tenantId)).max_sessions, 5, 'gagal = tidak berubah');
  assert.equal((await quota(o.tenantId, { max_sessions: 4 })).status, 200, 'sama dengan pemakaian: boleh');
  assert.equal((await mk('s5')).body.error.code, 'QUOTA_EXCEEDED');
  await call('POST', '/api-keys', o.tok, { name: 'kunci-satu', scopes: ['usage:read'] });
  assert.equal((await quota(o.tenantId, { max_api_keys: 1 })).status, 200);
  assert.equal((await call('POST', '/api-keys', o.tok, { name: 'kunci-dua', scopes: ['usage:read'] })).body.error.code, 'QUOTA_EXCEEDED');
  assert.equal((await quota(o.tenantId, { max_api_keys: 0 })).body.error.code, 'LIMIT_BELOW_USAGE');
  await call('POST', '/team/invitations', o.tok, { email: 'p1@x.test', role: 'VIEWER' });
  assert.equal((await quota(o.tenantId, { max_members: 1 })).body.error.code, 'LIMIT_BELOW_USAGE', 'anggota + undangan tertunda dihitung');
  assert.equal((await quota(o.tenantId, { max_members: 2 })).status, 200);
  assert.equal((await call('POST', '/team/invitations', o.tok, { email: 'p2@x.test', role: 'VIEWER' })).body.error.code, 'QUOTA_EXCEEDED');
  const mpm = await quota(o.tenantId, { messages_per_minute: 5 });
  assert.equal(mpm.body.data.limits.messages_per_minute, 5);
  assert.equal((await tq(o.tenantId, 'SELECT messages_per_minute n FROM tenant_settings WHERE tenant_id = $1', [o.tenantId]))[0].n, 5, 'nilai yang dibaca penegak klaim pesan ikut berubah');
  const same = await quota(o.tenantId, { messages_per_minute: 5 });
  assert.deepEqual([same.status, same.body.error.code], [409, 'NO_CHANGE']);
  assert.deepEqual(await tenantLimits(other.tenantId), { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 }, 'workspace lain tidak terpengaruh');
});

test('kuota: rentang (di atas batas mutlak, di bawah minimum, bukan bilangan bulat, tipe salah, field asing, kosong) => 400; batas tepat diterima; satu nilai salah membatalkan semua', { skip }, async () => {
  const o = await ws();
  const bad = async (body: any, p?: string) => {
    const r = await quota(o.tenantId, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    if (p) assert.ok(r.body.error.details.some((d: any) => d.path === p), `${p}: ${JSON.stringify(r.body.error.details)}`);
  };
  await bad({ max_sessions: config.LIMIT_CEIL_SESSIONS + 1 }, 'max_sessions'); await bad({ max_sessions: 0 }, 'max_sessions'); await bad({ max_members: 0 }, 'max_members');
  await bad({ max_api_keys: -1 }, 'max_api_keys'); await bad({ messages_per_minute: 0 }, 'messages_per_minute');
  await bad({ messages_per_minute: config.LIMIT_CEIL_MESSAGES_PER_MINUTE + 1 }, 'messages_per_minute'); await bad({ max_api_keys: config.LIMIT_CEIL_API_KEYS + 1 }, 'max_api_keys'); await bad({ max_members: config.LIMIT_CEIL_MEMBERS + 1 }, 'max_members');
  await bad({ max_sessions: 2.5 }); await bad({ max_sessions: '4' }); await bad({ max_sessions: null }); await bad({}); await bad({ max_sessions: 4, extra: 1 }); await bad({ tenant_id: crypto.randomUUID(), max_sessions: 4 });
  assert.equal((await quota(o.tenantId, { max_sessions: config.LIMIT_CEIL_SESSIONS, messages_per_minute: 1, max_api_keys: 0, max_members: config.LIMIT_CEIL_MEMBERS })).status, 200);
  assert.deepEqual(await tenantLimits(o.tenantId), { max_sessions: config.LIMIT_CEIL_SESSIONS, max_api_keys: 0, max_members: config.LIMIT_CEIL_MEMBERS, messages_per_minute: 1 });
  const mixed = await quota(o.tenantId, { max_sessions: 2, messages_per_minute: config.LIMIT_CEIL_MESSAGES_PER_MINUTE + 5 });
  assert.equal(mixed.status, 400); assert.equal((await tenantLimits(o.tenantId)).max_sessions, config.LIMIT_CEIL_SESSIONS, 'tidak ada perubahan sebagian');
});

test('LIMIT_CEIL_* adalah batas mutlak bahkan bagi platform admin; menurunkannya tidak menolak nilai yang tidak berubah (formulir mengirim semua kolom)', { skip }, async () => {
  const o = await ws();
  assert.equal((await quota(o.tenantId, { max_members: 15 })).status, 200);
  const prev = config.LIMIT_CEIL_MEMBERS; (config as any).LIMIT_CEIL_MEMBERS = 12;
  try {
    const same = await quota(o.tenantId, { max_members: 15, messages_per_minute: 90 });
    assert.equal(same.status, 200, JSON.stringify(same.body)); assert.deepEqual([same.body.data.limits.max_members, same.body.data.limits.messages_per_minute], [15, 90]);
    assert.equal((await quota(o.tenantId, { max_members: 16 })).status, 400, 'naik di atas batas mutlak baru ditolak');
    assert.equal((await quota(o.tenantId, { max_members: 12 })).status, 200, 'turun ke batas boleh');
  } finally { (config as any).LIMIT_CEIL_MEMBERS = prev; }
});

test('keamanan perubahan: kode TOTP wajib dan SEGAR (tanpa/salah/dipakai ulang ditolak), alasan wajib, id/tenant tidak sah 404; input salah TIDAK menghabiskan kode', { skip }, async () => {
  const o = await ws();
  const before = JSON.stringify(await tenantLimits(o.tenantId));
  assert.equal((await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 4, reason: 'uji kuota' })).status, 400, 'tanpa otp');
  assert.equal((await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 4, otp: '123456' })).status, 400, 'tanpa alasan');
  assert.equal((await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 4, otp: '123456', reason: 'x' })).status, 400, 'alasan terlalu pendek');
  clock += 30;
  const wrong = await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 4, reason: 'uji kuota', otp: '000000' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'INVALID_OTP']);
  assert.equal(JSON.stringify(await tenantLimits(o.tenantId)), before, 'kode salah: tidak ada perubahan');
  // input salah (di atas batas mutlak) dijawab SEBELUM kode dikonsumsi: kode yang sama masih sah untuk permintaan benar pada langkah yang sama
  const code = ADMIN.code();
  assert.equal((await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: config.LIMIT_CEIL_SESSIONS + 1, reason: 'uji kuota', otp: code })).status, 400);
  const good = await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 4, reason: 'uji kuota', otp: code });
  assert.equal(good.status, 200, 'kode tidak terpakai oleh input salah');
  const replay = await P('PATCH', `/workspaces/${o.tenantId}/quotas`, { max_sessions: 5, reason: 'uji kuota', otp: code });
  assert.deepEqual([replay.status, replay.body.error.code], [401, 'INVALID_OTP'], 'kode yang sama tidak dapat dipakai dua kali');
  assert.equal((await tenantLimits(o.tenantId)).max_sessions, 4);
  assert.equal((await quota(crypto.randomUUID(), { max_sessions: 4 })).status, 404); assert.equal((await quota('bukan-uuid', { max_sessions: 4 })).status, 404);
  await plat(`UPDATE tenants SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [o.tenantId]);
  assert.equal((await quota(o.tenantId, { max_sessions: 5 })).status, 404, 'workspace terhapus tidak dapat diubah kuotanya');
});

test('audit: platform mencatat perubahan (sebelum/sesudah, alasan, admin, ip, request_id; max_api_keys tidak terbuang filter); workspace melihat jejak transparansi TANPA alasan dan tanpa identitas operator', { skip }, async () => {
  const o = await ws();
  const r = await quota(o.tenantId, { max_api_keys: 7, max_sessions: 4 }, { reason: 'permintaan pelanggan tiket #123' });
  assert.equal(r.status, 200);
  const pa = (await plat(`SELECT admin_email, admin_user_id, action, tenant_id, details, reason, ip, request_id FROM platform_audit_logs WHERE tenant_id = $1 AND action = 'tenant.quota_changed'`, [o.tenantId]))[0];
  assert.deepEqual([pa.admin_email, pa.admin_user_id, pa.reason], [ADMIN.u.email, ADMIN.u.userId, 'permintaan pelanggan tiket #123']);
  assert.deepEqual(pa.details.changes, { max_api_keys: { from: 20, to: 7 }, max_sessions: { from: 3, to: 4 } });
  assert.ok(pa.ip && pa.request_id);
  const wa = (await call('GET', '/audit-logs?action=tenant.quota_changed', o.tok)).body.data;
  assert.equal(wa.length, 1);
  assert.deepEqual([wa[0].actor.email, wa[0].actor.user_id, wa[0].target.type, wa[0].details.source], ['platform', null, 'tenant', 'platform']);
  assert.deepEqual(wa[0].details.changes, pa.details.changes);
  assert.ok(!JSON.stringify(wa).includes('tiket #123') && !JSON.stringify(wa).includes(ADMIN.u.email), 'alasan internal dan identitas operator tidak bocor ke workspace');
  const d = (await P('GET', `/workspaces/${o.tenantId}`)).body.data;
  assert.equal(d.history[0].action, 'tenant.quota_changed'); assert.equal(d.history[0].reason, 'permintaan pelanggan tiket #123');
  const bad = await quota(o.tenantId, { max_sessions: 999 }); assert.equal(bad.status, 400);
  assert.equal((await plat(`SELECT count(*)::int n FROM platform_audit_logs WHERE tenant_id = $1 AND action = 'tenant.quota_changed'`, [o.tenantId]))[0].n, 1, 'penolakan tidak mencatat');
});

test('kuota bawaan: dibaca, diubah dengan TOTP dan alasan, hanya workspace BARU yang memakainya, validasi, tanpa perubahan 409, tercatat di audit', { skip }, async () => {
  const d0 = (await P('GET', '/defaults')).body.data;
  assert.deepEqual(d0.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 }); assert.equal(d0.ceilings.max_sessions, config.LIMIT_CEIL_SESSIONS);
  const old = await ws();
  clock += 30;
  assert.equal((await P('PATCH', '/defaults', { max_sessions: 6, reason: 'kebijakan paket baru', otp: ADMIN.code() })).body.data.limits.max_sessions, 6);
  try {
    const fresh = await ws();
    assert.equal((await tenantLimits(fresh.tenantId)).max_sessions, 6, 'workspace baru memakai bawaan');
    assert.equal((await tenantLimits(old.tenantId)).max_sessions, 3, 'workspace lama tidak berubah');
    assert.equal((await P('PATCH', '/defaults', { max_sessions: 6, reason: 'sama', otp: (clock += 30, ADMIN.code()) })).body.error.code, 'NO_CHANGE');
    assert.equal((await P('PATCH', '/defaults', { max_sessions: 0, reason: 'salah', otp: (clock += 30, ADMIN.code()) })).status, 400);
    assert.equal((await P('PATCH', '/defaults', { max_sessions: 7 })).status, 400, 'tanpa otp/alasan');
    assert.equal((await plat(`SELECT count(*)::int n FROM platform_audit_logs WHERE action = 'platform.defaults_changed' AND details->'changes'->'max_sessions'->>'to' = '6'`))[0].n, 1);
  } finally {
    clock += 30; await P('PATCH', '/defaults', { max_sessions: 3, reason: 'pulihkan', otp: ADMIN.code() });
  }
  assert.equal((await P('GET', '/defaults')).body.data.limits.max_sessions, 3);
});

test('daftar audit platform: terbaru dulu, filter tenant dan aksi, paginasi, validasi; tanpa rahasia', { skip }, async () => {
  const o = await ws(); await quota(o.tenantId, { max_sessions: 4 }); await quota(o.tenantId, { max_sessions: 5 });
  const all = await P('GET', '/audit?page_size=100');
  assert.equal(all.status, 200); assert.ok(all.body.meta.total >= 3);
  assert.ok(all.body.data.every((x: any, i: number, a: any[]) => i === 0 || new Date(x.created_at) <= new Date(a[i - 1].created_at)), 'terbaru dulu');
  const byT = await P('GET', `/audit?tenant_id=${o.tenantId}`); assert.equal(byT.body.data.length, 2); assert.ok(byT.body.data.every((x: any) => x.tenant_id === o.tenantId && x.action === 'tenant.quota_changed'));
  const byA = await P('GET', '/audit?action=platform_admin.login&page_size=100'); assert.ok(byA.body.data.length >= 1 && byA.body.data.every((x: any) => x.action === 'platform_admin.login'));
  assert.equal((await P('GET', `/audit?tenant_id=${o.tenantId}&page=2&page_size=1`)).body.data.length, 1);
  for (const q of ['page_size=500', 'action=BUKAN FORMAT', 'x=1', 'page=0']) assert.equal((await P('GET', `/audit?${q.replace(' ', '%20')}`)).status, 400, q);
  assert.ok(!all.body.data.some((x: any) => /secret|cipher|hash|password/i.test(JSON.stringify(x.details))), 'detail audit tanpa rahasia');
});

test('status cadangan (hanya-baca): tidak dikonfigurasi, berkas belum ada, valid, basi, rusak, terlalu besar, bentuk salah; kolom asing dibuang', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbk-')); const file = path.join(dir, 'backup.json'); const prev = config.PLATFORM_BACKUP_STATUS_FILE;
  const get = async () => (await P('GET', '/backup-status')).body.data;
  try {
    (config as any).PLATFORM_BACKUP_STATUS_FILE = undefined;
    assert.deepEqual([(await get()).configured, (await get()).available], [false, false]);
    (config as any).PLATFORM_BACKUP_STATUS_FILE = file;
    const missing = await get(); assert.deepEqual([missing.configured, missing.available], [true, false]); assert.match(missing.reason, /belum ada/);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ updated_at: hoursAgo(1), last_success_at: hoursAgo(2), last_failure_at: null, last_file: 'wazap-x.dump', last_size_bytes: 1234, location: 'separate_disk', offsite_ok_at: null, rahasia: 'PASSWORD-DI-BERKAS' }));
    const ok = await get();
    assert.deepEqual([ok.available, ok.stale, ok.status.location, ok.status.last_file, ok.status.last_size_bytes], [true, false, 'separate_disk', 'wazap-x.dump', 1234]);
    assert.ok(ok.age_hours >= 1.9 && ok.age_hours <= 2.2); assert.equal(ok.max_age_hours, config.PLATFORM_BACKUP_MAX_AGE_HOURS);
    assert.ok(!JSON.stringify(ok).includes('PASSWORD-DI-BERKAS'), 'kolom di luar daftar putih dibuang');
    fs.writeFileSync(file, JSON.stringify({ updated_at: hoursAgo(1), last_success_at: hoursAgo(config.PLATFORM_BACKUP_MAX_AGE_HOURS + 2), location: 'same_disk' }));
    assert.equal((await get()).stale, true, 'sukses terakhir lebih tua dari batas = basi');
    fs.writeFileSync(file, JSON.stringify({ updated_at: hoursAgo(1), last_success_at: null, last_failure_at: hoursAgo(1), last_failure_reason: 'pg_dump gagal', location: 'same_disk' }));
    const never = await get(); assert.deepEqual([never.available, never.stale, never.age_hours, never.status.last_failure_reason], [true, true, null, 'pg_dump gagal']);
    fs.writeFileSync(file, '{rusak'); const broken = await get(); assert.deepEqual([broken.available, broken.status], [false, null]);
    fs.writeFileSync(file, JSON.stringify({ updated_at: 'x', location: 'langit' })); assert.equal((await get()).available, false, 'bentuk salah');
    fs.writeFileSync(file, 'x'.repeat(70_000)); assert.equal((await get()).available, false, 'terlalu besar');
  } finally { (config as any).PLATFORM_BACKUP_STATUS_FILE = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PRIVASI: konsol platform tidak pernah mengembalikan isi pesan, nama sesi, kunci API, token undangan, URL webhook, target alarm, atau kolom sensitif', { skip }, async () => {
  const o = await ws(`Privasi ${++n}`);
  const SECRETS = { pesan: 'ISI-PESAN-RAHASIA-9917', sesi: 'NAMA-SESI-RAHASIA-4421', webhook: 'https://hook.contoh.test/RAHASIA-WEBHOOK-3310', kontak: '6281299917731' };
  const ses = (await call('POST', '/sessions', o.tok, { session_name: SECRETS.sesi, auto_connect: false })).body.data;
  const qid = (await tq(o.tenantId, `INSERT INTO message_queue (tenant_id, session_id, recipient, payload, actor) VALUES ($1,$2,$3,$4::jsonb,'USER') RETURNING id`, [o.tenantId, ses.id, SECRETS.kontak, JSON.stringify({ text: SECRETS.pesan })]))[0].id;
  await plat(`UPDATE message_queue SET status = 'SENT', provider_message_id = 'PM-1', completed_at = now() WHERE id = $1`, [qid]);   // (engine menulis dengan konteks platform) memicu pencerminan ke wa_messages/wa_chats (trigger 0018)
  const apiKey = (await call('POST', '/api-keys', o.tok, { name: 'kunci-privasi', scopes: ['usage:read'] })).body.data.key as string;
  const inv = (await call('POST', '/team/invitations', o.tok, { email: 'undangan@x.test', role: 'VIEWER' })).body.data.token as string;
  await tq(o.tenantId, `INSERT INTO webhook_endpoints (tenant_id, url, secret_ciphertext, secret_key_version, secret_hint) VALUES ($1,$2,'\\x00',1,'abcd')`, [o.tenantId, SECRETS.webhook]);
  assert.equal((await tq(o.tenantId, `SELECT count(*)::int n FROM wa_messages WHERE tenant_id = $1`, [o.tenantId]))[0].n >= 1, true, 'pesan nyata ada di DB (uji bermakna)');
  await quota(o.tenantId, { max_sessions: 4 });
  const urls = ['/workspaces?page_size=100', `/workspaces/${o.tenantId}`, '/audit?page_size=100', '/defaults', '/backup-status', '/me'];
  const forbiddenKeys = /^(body|payload|text|content|key_hash|key|token|token_hash|secret|secret_ciphertext|target|target_ciphertext|session_name|recipient|phone|contact_phone|url|password|password_hash|totp_cipher|recovery_hashes)$/i;
  const walk = (v: any, where: string) => { if (Array.isArray(v)) v.forEach((x) => walk(x, where)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!forbiddenKeys.test(k), `${where}: kolom terlarang "${k}"`); walk(x, where); } };
  for (const u of urls) {
    const r = await P('GET', u); assert.equal(r.status, 200, u);
    for (const [name, val] of Object.entries({ ...SECRETS, apiKey, inv })) assert.ok(!r.raw.includes(val), `${u} membocorkan ${name}`);
    walk(r.body, u);
  }
});

test('ujung ke ujung: backup-run.sh (bash sungguhan) menulis berkas status, konsol platform membacanya: sukses, lalu kegagalan mempertahankan sukses terakhir; tanpa rahasia', { skip }, async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbk-e2e-')); const prev = config.PLATFORM_BACKUP_STATUS_FILE;
  const ops = path.join(dir, 'ops'); fs.mkdirSync(ops); const bk = path.join(dir, 'bk'); fs.mkdirSync(bk);
  const status = path.join(dir, 'status', 'backup.json'); const conf = path.join(dir, 'backup.env');
  // ops palsu: backup.sh membuat berkas dump (atau gagal bila FAIL ada), notify.sh tidak mengirim apa pun
  fs.writeFileSync(path.join(ops, 'backup.sh'), `#!/bin/bash\n[ -e "${dir}/FAIL" ] && { echo "pg_dump gagal: password=RAHASIA123"; exit 1; }\nf="$BACKUP_DIR/wazap-wazap_prod-gateway-$(date -u +%Y%m%dT%H%M%S).dump"; head -c 2048 /dev/zero > "$f"; echo ok\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(ops, 'notify.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(conf, `PGDATABASE=wazap_prod\nBACKUP_PGUSER=x\nBACKUP_DIR=${bk}\nSCHEMA=gateway\nSTATUS_FILE=${status}\nOFFSITE_RSYNC_DEST=\nOFFSITE_RCLONE_REMOTE=\n`, { mode: 0o600 });
  const run = () => spawnSync('bash', [path.resolve(import.meta.dirname, '../../deploy/production/bin/backup-run.sh')], { env: { ...process.env, WAZAP_BACKUP_ENV: conf, WAZAP_BACKUP_LOGDIR: path.join(dir, 'log'), WAZAP_OPS_DIR: ops }, encoding: 'utf8' });
  const get = async () => (await P('GET', '/backup-status')).body.data;
  try {
    (config as any).PLATFORM_BACKUP_STATUS_FILE = status;
    assert.equal(run().status, 0);
    const ok = await get();
    assert.deepEqual([ok.available, ok.stale, ok.status.last_size_bytes, ok.status.last_failure_at], [true, false, 2048, null], JSON.stringify(ok));
    assert.ok(['same_disk', 'separate_disk'].includes(ok.status.location), `lokasi dihitung dari perangkat (bergantung lingkungan uji): ${ok.status.location}`);
    assert.match(ok.status.last_file, /^wazap-wazap_prod-gateway-.*\.dump$/);
    const firstOk = ok.status.last_success_at;
    fs.writeFileSync(path.join(dir, 'FAIL'), '');
    assert.equal(run().status, 1);
    const bad = await get();
    assert.equal(bad.status.last_success_at, firstOk, 'kegagalan mempertahankan waktu sukses terakhir');
    assert.ok(bad.status.last_failure_at && /backup.sh gagal/.test(bad.status.last_failure_reason) && /pg_dump gagal/.test(bad.status.last_failure_reason), JSON.stringify(bad.status));
    assert.ok(!JSON.stringify(bad).includes('RAHASIA123') && !fs.readFileSync(status, 'utf8').includes('RAHASIA123') && !fs.readFileSync(path.join(dir, 'log', 'backup.log'), 'utf8').includes('RAHASIA123'), 'rahasia dalam keluaran skrip disamarkan di status, API, dan log');
    assert.match(bad.status.last_failure_reason, /password=\*\*\*/);
    assert.equal(bad.status.last_file, ok.status.last_file, 'berkas terakhir yang sukses dipertahankan');
    assert.ok(JSON.parse(fs.readFileSync(status, 'utf8')) && !fs.existsSync(`${status}.tmp`), 'JSON valid dan penulisan atomik (tanpa sisa .tmp)');
    fs.rmSync(path.join(dir, 'FAIL'));
    await new Promise((r) => setTimeout(r, 1100));   // stempel waktu berresolusi detik: beri jarak agar sukses baru dapat dibedakan dari yang pertama
    assert.equal(run().status, 0);
    const rec = await get(); assert.ok(rec.status.last_success_at !== firstOk && /pg_dump gagal/.test(rec.status.last_failure_reason), 'setelah pulih: sukses baru tercatat dan riwayat kegagalan terakhir dipertahankan');
  } finally { (config as any).PLATFORM_BACKUP_STATUS_FILE = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});
