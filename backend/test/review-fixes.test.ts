/** Regresi untuk temuan code-review (2026-11-20): #1 audit, #2 reissue/kuota, #3 undangan, #4 API key, #5 zona waktu, #7 helper bersama, #8 ceiling. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createUsageService, validTimeZone } = await import('../src/modules/usage/usage.service.js');
const { createSettingsService } = await import('../src/modules/tenant/settings.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { isSecretKey } = await import('../src/modules/audit/audit.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { config } = await import('../src/config/env.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), team: createTeamService(db), usage: createUsageService(db), settings: createSettingsService(db), audit: createAuditService(db),
  checkDb: async () => true, limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(), apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const tq = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any, headers: any = {}) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body };
};
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `rf${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `RF ${n}` });
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  assert.equal((await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token })).status, 200);
  const tok = (await call('POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId })).body.data.access_token;
  return { ...u, tenantId: owner.tenantId, tok };
}
const invs = async (o: U, status?: string) => (await call('GET', `/team/invitations?page_size=100${status ? `&status=${status}` : ''}`, o.tok)).body.data as any[];
const auditOf = async (o: U, qs = '') => (await call('GET', `/audit-logs?page_size=100${qs}`, o.tok)).body.data as any[];
const mkKey = async (u: U, name: string) => (await call('POST', '/api-keys', u.tok, { name, scopes: ['usage:read'] })).body.data;
const useKey = (key: string) => call('GET', '/usage/summary', undefined, undefined, { 'x-api-key': key });

// ---------- #1 audit tidak boleh membuang kunci kuota ----------

test('#1 filter rahasia audit memakai batas kata: max_api_keys tercatat, kunci rahasia tetap dibuang', () => {
  for (const k of ['max_api_keys', 'max_sessions', 'max_members', 'messages_per_minute', 'role', 'expires_at', 'revoked_api_keys', 'from', 'to', 'reason']) assert.equal(isSecretKey(k), false, k);
  for (const k of ['api_key', 'x-api-key', 'apikey', 'api-key', 'token', 'invitation_token', 'token_hash', 'secret', 'webhook_secret', 'password', 'password_hash', 'authorization', 'cookie', 'key', 'access_token']) assert.equal(isSecretKey(k), true, k);
});

test('#1 perubahan max_api_keys muncul di jejak settings.updated (sebelumnya terbuang diam-diam)', { skip }, async () => {
  const o = await reg();
  assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_api_keys: 7, max_sessions: 4 })).status, 200);
  const a = (await auditOf(o, '&action=settings.updated'))[0];
  assert.deepEqual(a.details.changes, { max_api_keys: { from: 20, to: 7 }, max_sessions: { from: 3, to: 4 } });
});

// ---------- #2 reissue tidak boleh melewati kuota anggota ----------

test('#2 menghidupkan undangan kedaluwarsa dengan reissue tunduk pada kuota anggota', { skip }, async () => {
  const o = await reg();
  assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 2 })).status, 200);
  const x = await call('POST', '/team/invitations', o.tok, { email: 'kedaluwarsa@x.test', role: 'VIEWER' }); // 1 anggota + 1 tertunda = penuh
  assert.equal(x.status, 201);
  await tq(o.tenantId, `UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [x.body.data.id]);
  await join(o, 'MEMBER');                                                                                  // slot yang dibebaskan kedaluwarsa kini terisi anggota nyata: penuh lagi
  const r = await call('POST', `/team/invitations/${x.body.data.id}/reissue`, o.tok);
  assert.deepEqual([r.status, r.body.error.code], [409, 'QUOTA_EXCEEDED'], 'tanpa perbaikan: anggota akan menjadi 3 dari maksimum 2');
  const members = (await call('GET', '/team/members', o.tok)).body.meta.total;
  assert.equal(members, 2);
  // ada ruang -> boleh
  assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 3 })).status, 200);
  assert.equal((await call('POST', `/team/invitations/${x.body.data.id}/reissue`, o.tok)).status, 200);
  // undangan yang MASIH hidup tidak butuh slot tambahan (sudah dihitung)
  assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 3 })).status, 200);
  assert.equal((await call('POST', `/team/invitations/${x.body.data.id}/reissue`, o.tok)).status, 200, 'masih hidup: reissue tidak memicu cek kuota');
});

// ---------- #3 undangan tidak boleh hidup lebih lama daripada wewenang pembuatnya ----------

test('#3 undangan tertunda dicabut saat pembuatnya ditangguhkan, diturunkan, dihapus, atau keluar; yang lain tidak tersentuh', { skip }, async () => {
  const o = await reg();
  const mk = async (tok: string, email: string) => (await call('POST', '/team/invitations', tok, { email, role: 'MEMBER' })).body.data;
  // (a) ditangguhkan
  const a1 = await join(o, 'OWNER'); const ia = await mk(a1.tok, 'a-susp@x.test'); const keep = await mk(o.tok, 'milik-owner@x.test');
  assert.equal((await call('PATCH', `/team/members/${a1.userId}`, o.tok, { status: 'SUSPENDED' })).status, 200);
  assert.equal((await invs(o, 'REVOKED')).some((x) => x.id === ia.id), true);
  assert.equal((await call('POST', '/team/invitations/accept', (await reg()).tok, { token: ia.token })).status, 404, 'token undangan yang dicabut tidak berlaku');
  assert.equal((await invs(o, 'PENDING')).some((x) => x.id === keep.id), true, 'undangan milik OWNER tidak tersentuh');
  const rev = (await auditOf(o, '&action=invitation.revoked')).find((x) => x.target.id === ia.id);
  assert.deepEqual([rev.details.reason, rev.actor.user_id], ['inviter_suspended', o.userId], 'tercatat di audit dengan alasan dan pelaku');
  // diaktifkan kembali tidak menghidupkan undangan lama
  await call('PATCH', `/team/members/${a1.userId}`, o.tok, { status: 'ACTIVE' });
  assert.equal((await invs(o, 'REVOKED')).some((x) => x.id === ia.id), true);
  // (b) diturunkan
  const a2 = await join(o, 'OWNER'); const ib = await mk(a2.tok, 'a-turun@x.test');
  await call('PATCH', `/team/members/${a2.userId}`, o.tok, { role: 'MEMBER' });
  assert.equal((await invs(o, 'REVOKED')).some((x) => x.id === ib.id), true);
  assert.equal((await auditOf(o, '&action=invitation.revoked')).find((x) => x.target.id === ib.id).details.reason, 'inviter_demoted');
  // (c) perubahan yang TIDAK menurunkan wewenang (peran sama) TIDAK mencabut (ADR-053: tidak ada peran di atas OWNER)
  const a3 = await join(o, 'OWNER'); const ic = await mk(a3.tok, 'a-naik@x.test');
  await call('PATCH', `/team/members/${a3.userId}`, o.tok, { role: 'OWNER' });
  assert.equal((await invs(o, 'PENDING')).some((x) => x.id === ic.id), true, 'wewenang tidak berkurang, undangan tetap sah');
  // (d) dihapus
  const a4 = await join(o, 'OWNER'); const id = await mk(a4.tok, 'a-hapus@x.test');
  await call('DELETE', `/team/members/${a4.userId}`, o.tok);
  assert.equal((await invs(o, 'REVOKED')).some((x) => x.id === id.id), true);
  assert.equal((await auditOf(o, '&action=invitation.revoked')).find((x) => x.target.id === id.id).details.reason, 'inviter_removed');
  // (e) keluar sendiri
  const a5 = await join(o, 'OWNER'); const ie = await mk(a5.tok, 'a-keluar@x.test');
  await call('DELETE', `/team/members/${a5.userId}`, a5.tok);
  assert.equal((await auditOf(o, '&action=invitation.revoked')).find((x) => x.target.id === ie.id).details.reason, 'inviter_left');
  // undangan yang sudah DITERIMA tidak berubah
  const a6 = await join(o, 'OWNER'); const accepted = await join(a6, 'VIEWER');
  await call('DELETE', `/team/members/${a6.userId}`, o.tok);
  assert.equal(((await call('GET', '/team/members?page_size=100', o.tok)).body.data as any[]).some((m) => m.user_id === accepted.userId), true, 'anggota yang sudah bergabung tidak ikut terhapus');
});

// ---------- #4 offboarding: API key pembuat ikut dicabut saat dihapus ----------

test('#4 API key yang dibuat anggota dicabut saat ia dihapus; key anggota lain tetap; ditangguhkan tidak mencabut; daftar menampilkan pembuat', { skip }, async () => {
  const o = await reg(); const adm = await join(o, 'OWNER'); const adm2 = await join(o, 'OWNER');
  const kOwner = await mkKey(o, 'kunci-owner'); const kA = await mkKey(adm, 'kunci-admin'); const kA2 = await mkKey(adm2, 'kunci-admin2');
  for (const k of [kOwner, kA, kA2]) assert.equal((await useKey(k.key)).status, 200);
  // daftar menampilkan pembuat
  const list0 = (await call('GET', '/api-keys', o.tok)).body.data as any[];
  assert.deepEqual(list0.find((x) => x.id === kA.id).created_by, { user_id: adm.userId, email: adm.email });
  assert.ok(!JSON.stringify(list0).includes(kA.key), 'daftar tidak memuat key');
  // ditangguhkan: key tetap hidup
  await call('PATCH', `/team/members/${adm2.userId}`, o.tok, { status: 'SUSPENDED' });
  assert.equal((await useKey(kA2.key)).status, 200, 'ditangguhkan: key tetap berfungsi (daftar menunjukkan pembuatnya untuk dicabut manual)');
  // dihapus: key pembuat dicabut seketika, lainnya tidak
  assert.equal((await call('DELETE', `/team/members/${adm.userId}`, o.tok)).status, 200);
  assert.equal((await useKey(kA.key)).status, 401, 'key milik anggota yang dihapus tidak lagi berfungsi');
  assert.equal((await useKey(kOwner.key)).status, 200); assert.equal((await useKey(kA2.key)).status, 200);
  const list1 = (await call('GET', '/api-keys', o.tok)).body.data as any[];
  const revoked = list1.find((x) => x.id === kA.id);
  assert.ok(revoked.revoked_at); assert.equal(revoked.created_by, null, 'FK ON DELETE SET NULL mengosongkan pembuat saat keanggotaan dihapus; jejak id key yang dicabut ada di audit');
  const au = (await auditOf(o, '&action=member.removed'))[0];
  assert.deepEqual(au.details.revoked_api_keys, [kA.id], 'audit mencatat key yang dicabut (id saja, bukan nilai key)');
  assert.ok(!JSON.stringify(au).includes(kA.key));
  // keluar sendiri juga mencabut
  const adm3 = await join(o, 'OWNER'); const kA3 = await mkKey(adm3, 'kunci-admin3');
  await call('DELETE', `/team/members/${adm3.userId}`, adm3.tok);
  assert.equal((await useKey(kA3.key)).status, 401);
  assert.equal((await auditOf(o, '&action=member.left'))[0].details.revoked_api_keys.length, 1);
});

// ---------- #5 zona waktu offset ----------

test('#5 zona waktu bentuk offset ditolak; nama IANA yang dikenal diterima dan konsisten dengan PostgreSQL', { skip }, async () => {
  for (const z of ['+07:00', '-05:00', 'UTC+7', 'GMT+7', '07:00', 'Mars/Phobos', 'Asia/Jakarta;drop', '']) assert.equal(validTimeZone(z), false, z);
  for (const z of ['Asia/Jakarta', 'Etc/GMT-7', 'UTC', 'America/Argentina/Buenos_Aires']) assert.equal(validTimeZone(z), true, z);
  const o = await reg();
  const range = 'from=2026-11-10T00:00:00Z&to=2026-11-12T00:00:00Z&group_by=day';
  for (const tz of ['%2B07:00', '-05:00', 'UTC%2B7', 'Mars/Phobos']) assert.equal((await call('GET', `/usage/messages?${range}&tz=${tz}`, o.tok)).status, 400, tz);
  const jak = await call('GET', `/usage/messages?${range}&tz=Asia/Jakarta`, o.tok); const gmt = await call('GET', `/usage/messages?${range}&tz=Etc/GMT-7`, o.tok);
  assert.equal(jak.status, 200); assert.equal(gmt.status, 200);
  assert.deepEqual(gmt.body.data.map((x: any) => x.bucket), jak.body.data.map((x: any) => x.bucket), 'Etc/GMT-7 = UTC+7 = Asia/Jakarta (tanda tidak terbalik)');
  assert.equal(jak.body.data[0].bucket, '2026-11-09T17:00:00.000Z');
  const svc = createUsageService(db);
  assert.equal(await svc.timezoneKnown('Asia/Jakarta'), true); assert.equal(await svc.timezoneKnown('Mars/Phobos'), false);
});

// ---------- #7 helper bersama ----------

test('#7 kunci serialisasi tim didefinisikan di SATU berkas (tidak ada salinan yang bisa menyimpang)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes("'wazap:team:'")) hits.push(path.relative(root, p)); } };
  walk(root);
  assert.deepEqual(hits, ['modules/team/team-lock.ts']);
});

// ---------- #8 ceiling diturunkan operator ----------

test('#8 menurunkan LIMIT_CEIL_* tidak membuat pengiriman ulang nilai yang tidak berubah ditolak; menaikkan di atas ceiling tetap ditolak', { skip }, async () => {
  const o = await reg();
  assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 15 })).status, 200);
  const prev = config.LIMIT_CEIL_MEMBERS; (config as any).LIMIT_CEIL_MEMBERS = 12; // operator menurunkan ceiling di bawah nilai tersimpan (15)
  try {
    const same = await call('PATCH', '/tenant/settings', o.tok, { max_members: 15, messages_per_minute: 90 }); // formulir yang mengirim semua field
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual([same.body.data.limits.max_members, same.body.data.limits.messages_per_minute], [15, 90]);
    assert.equal((await auditOf(o, '&action=settings.updated'))[0].details.changes.max_members, undefined, 'nilai yang sama tidak tercatat sebagai perubahan');
    assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 16 })).status, 400, 'naik di atas ceiling baru tetap ditolak');
    assert.equal((await call('PATCH', '/tenant/settings', o.tok, { max_members: 12 })).status, 200, 'turun ke ceiling boleh');
  } finally { (config as any).LIMIT_CEIL_MEMBERS = prev; }
});
