import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createRetention } = await import('../src/modules/engine/retention.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { sha256hex } = await import('../src/modules/identity/tokens.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), team: createTeamService(db), audit: createAuditService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const tq = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any, headers: any = {}, remoteAddress?: string) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload, remoteAddress });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, headers: r.headers };
};
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `au${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Audit ${n}` });
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id };
}
const login = async (email: string, tenantId?: string) => (await call('POST', '/auth/login', undefined, { email, password: PW, tenant_id: tenantId })).body.data.access_token as string;
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  return { ...u, tenantId: owner.tenantId, tok: await login(u.email, owner.tenantId) };
}
const logs = async (u: U, qs = '') => (await call('GET', `/audit-logs?page_size=100${qs}`, u.tok)).body.data as any[];
const actions = async (u: U) => (await logs(u)).map((x) => x.action).reverse();

// ---------- jejak perubahan ----------

test('semua perubahan tim tercatat: aksi, pelaku, sasaran, detail, ip, request_id; terbaru dulu', { skip }, async () => {
  const o = await reg(); const u = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email, role: 'MEMBER' }, {}, '10.9.8.7');
  assert.equal(inv.status, 201);
  const created = (await logs(o))[0];
  assert.deepEqual([created.action, created.actor.user_id, created.actor.email, created.actor.role], ['invitation.created', o.userId, o.email, 'OWNER']);
  assert.deepEqual([created.target.type, created.target.id, created.target.email], ['invitation', inv.body.data.id, u.email]);
  assert.equal(created.details.role, 'MEMBER');
  assert.equal(created.ip, '10.9.8.7', 'ip dari koneksi (bukan dari klien)');
  assert.equal(created.request_id, inv.headers['x-request-id'], 'request_id sama dengan header respons -> dapat ditelusuri');

  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  const acc = (await logs(o))[0];
  assert.deepEqual([acc.action, acc.actor.user_id, acc.actor.email, acc.actor.role, acc.target.id], ['invitation.accepted', u.userId, u.email, 'MEMBER', inv.body.data.id], 'pelaku = penerima, tercatat di tenant pengundang');

  assert.equal((await call('PATCH', `/team/members/${u.userId}`, o.tok, { role: 'OWNER' })).status, 200);
  assert.equal((await call('PATCH', `/team/members/${u.userId}`, o.tok, { status: 'SUSPENDED' })).status, 200);
  assert.equal((await call('PATCH', `/team/members/${u.userId}`, o.tok, { role: 'VIEWER', status: 'ACTIVE' })).status, 200, 'dua perubahan sekaligus');
  const all = await logs(o);
  assert.deepEqual(all.slice(0, 4).map((x) => [x.action, x.details.from, x.details.to]).reverse(), [
    ['member.role_changed', 'MEMBER', 'OWNER'], ['member.status_changed', 'ACTIVE', 'SUSPENDED'], ['member.role_changed', 'OWNER', 'VIEWER'], ['member.status_changed', 'SUSPENDED', 'ACTIVE']]);
  assert.ok(all.every((x, i) => i === 0 || new Date(x.created_at) <= new Date(all[i - 1].created_at)), 'urut terbaru dulu');
  assert.equal(all[0].target.email, u.email); assert.equal(all[0].target.id, u.userId);

  await call('DELETE', `/team/members/${u.userId}`, o.tok);
  assert.deepEqual([(await logs(o))[0].action, (await logs(o))[0].details.role], ['member.removed', 'VIEWER']);
  const v = await join(o, 'VIEWER');
  await call('DELETE', `/team/members/${v.userId}`, v.tok);
  const left = (await logs(o))[0];
  assert.deepEqual([left.action, left.actor.user_id, left.target.id], ['member.left', v.userId, v.userId], 'keluar sendiri tercatat sebagai member.left');

  const inv2 = await call('POST', '/team/invitations', o.tok, { email: 'x1@x.test', role: 'VIEWER' });
  const re = await call('POST', `/team/invitations/${inv2.body.data.id}/reissue`, o.tok);
  assert.equal(re.status, 200);
  await call('DELETE', `/team/invitations/${inv2.body.data.id}`, o.tok);
  assert.deepEqual((await actions(o)).slice(-3), ['invitation.created', 'invitation.reissued', 'invitation.revoked']);
});

test('tidak ada jejak untuk operasi yang ditolak atau tidak mengubah apa pun; tidak ada rahasia di jejak', { skip }, async () => {
  const o = await reg(); const admin = await join(o, 'MEMBER'); const m = await join(o, 'MEMBER');
  const before = (await logs(o)).length;
  assert.equal((await call('PATCH', `/team/members/${o.userId}`, admin.tok, { role: 'VIEWER' })).status, 403);            // di luar wewenang
  assert.equal((await call('PATCH', `/team/members/${admin.userId}`, admin.tok, { role: 'VIEWER' })).status, 403);        // diri sendiri
  assert.equal((await call('DELETE', `/team/members/${o.userId}`, o.tok)).status, 409);                                    // OWNER terakhir
  assert.equal((await call('POST', '/team/invitations', admin.tok, { email: 'z@x.test', role: 'OWNER' })).status, 403);    // eskalasi
  assert.equal((await call('POST', '/team/invitations', o.tok, { email: m.email, role: 'VIEWER' })).status, 409);          // sudah anggota
  assert.equal((await call('PATCH', `/team/members/${m.userId}`, o.tok, { role: 'MEMBER' })).status, 200);                 // no-op: peran sama
  assert.equal((await call('POST', '/team/invitations/accept', m.tok, { token: 'inv_' + 'A'.repeat(43) })).status, 404);   // token salah
  assert.equal((await logs(o)).length, before, 'tidak ada baris baru');
  // rahasia: token mentah tidak boleh muncul di mana pun di jejak
  const inv = await call('POST', '/team/invitations', o.tok, { email: 'rahasia@x.test', role: 'VIEWER' });
  const re = await call('POST', `/team/invitations/${inv.body.data.id}/reissue`, o.tok);
  const dump = JSON.stringify((await call('GET', '/audit-logs?page_size=100', o.tok)).body) + JSON.stringify(await tq(o.tenantId, 'SELECT * FROM audit_logs'));
  for (const tok of [inv.body.data.token, re.body.data.token, sha256hex(inv.body.data.token), sha256hex(re.body.data.token)]) assert.ok(!dump.includes(tok), 'token/hash tidak boleh ada di audit');
  assert.ok(!/inv_[A-Za-z0-9_-]{43}/.test(dump) && !/password/i.test(dump));
});

test('terbitkan ulang undangan: token lama hangus, token baru sah, masa berlaku dihitung ulang; aturan akses', { skip }, async () => {
  const o = await reg(); const u = await reg(); const admin = await join(o, 'MEMBER');
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email, role: 'MEMBER' });
  const oldTok = inv.body.data.token as string;
  const re = await call('POST', `/team/invitations/${inv.body.data.id}/reissue`, o.tok);
  assert.equal(re.status, 200); assert.equal(re.headers['cache-control'], 'no-store');
  assert.match(re.body.data.token, /^inv_[A-Za-z0-9_-]{43}$/); assert.notEqual(re.body.data.token, oldTok);
  assert.equal(re.body.data.id, inv.body.data.id); assert.equal(re.body.data.status, 'PENDING');
  assert.equal((await call('POST', '/team/invitations/accept', u.tok, { token: oldTok })).status, 404, 'token lama hangus');
  // kedaluwarsa lalu diterbitkan ulang -> hidup lagi
  await tq(o.tenantId, `UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.body.data.id]);
  assert.equal((await call('GET', '/team/invitations', o.tok)).body.data[0].status, 'EXPIRED');
  const re2 = await call('POST', `/team/invitations/${inv.body.data.id}/reissue`, o.tok);
  assert.equal(re2.status, 200); assert.ok(new Date(re2.body.data.expires_at) > new Date());
  // non-OWNER (MEMBER) tidak dapat menerbitkan ulang undangan apa pun
  const ownerInv = await call('POST', '/team/invitations', o.tok, { email: 'o2@x.test', role: 'OWNER' });
  assert.equal((await call('POST', `/team/invitations/${ownerInv.body.data.id}/reissue`, admin.tok)).status, 403);
  assert.equal((await call('POST', `/team/invitations/${crypto.randomUUID()}/reissue`, o.tok)).status, 404);
  assert.equal((await call('POST', `/team/invitations/bukan-uuid/reissue`, o.tok)).status, 404);
  // diterima dengan token baru; setelah itu tidak dapat diterbitkan ulang
  assert.equal((await call('POST', '/team/invitations/accept', u.tok, { token: re2.body.data.token })).status, 200);
  assert.equal((await call('POST', `/team/invitations/${inv.body.data.id}/reissue`, o.tok)).body.error.code, 'INVALID_STATE');
  // dicabut -> tidak dapat diterbitkan ulang
  const inv3 = await call('POST', '/team/invitations', o.tok, { email: 'z9@x.test', role: 'VIEWER' });
  await call('DELETE', `/team/invitations/${inv3.body.data.id}`, o.tok);
  assert.equal((await call('POST', `/team/invitations/${inv3.body.data.id}/reissue`, o.tok)).status, 409);
});

test('invite_url: null tanpa DASHBOARD_BASE_URL; tersusun benar bila diatur (tidak dibaca dari klien)', { skip }, async () => {
  const { config } = await import('../src/config/env.js');
  const prev = config.DASHBOARD_BASE_URL; // hermetik: jangan bergantung pada .env mesin yang menjalankan tes
  const o = await reg();
  const spoof = { origin: 'https://penyerang.example', host: 'penyerang.example' };
  try {
    (config as any).DASHBOARD_BASE_URL = undefined;
    const inv = await call('POST', '/team/invitations', o.tok, { email: 'iu@x.test', role: 'VIEWER' }, spoof);
    assert.equal(inv.body.data.invite_url, null, 'tanpa konfigurasi: frontend membangun tautan dari origin-nya sendiri');
    (config as any).DASHBOARD_BASE_URL = 'https://dash.contoh.id/';
    const inv2 = await call('POST', '/team/invitations', o.tok, { email: 'iu2@x.test', role: 'VIEWER' }, spoof);
    assert.equal(inv2.body.data.invite_url, `https://dash.contoh.id/invite#token=${inv2.body.data.token}`);
    const u = new URL(inv2.body.data.invite_url);
    assert.equal(u.search, '', 'tanpa query string: token tidak boleh sampai ke server/log dashboard');
    assert.equal(u.hash, `#token=${inv2.body.data.token}`);
    assert.ok(!inv2.body.data.invite_url.includes('penyerang'), 'tidak memakai header Origin/Host dari klien');
    const re = await call('POST', `/team/invitations/${inv2.body.data.id}/reissue`, o.tok, undefined, spoof);
    assert.equal(re.body.data.invite_url, `https://dash.contoh.id/invite#token=${re.body.data.token}`);
    const list = await call('GET', '/team/invitations', o.tok);
    assert.ok(!JSON.stringify(list.body).includes('invite_url'), 'daftar tidak memuat tautan');
  } finally { (config as any).DASHBOARD_BASE_URL = prev; }
});

// ---------- API baca ----------

test('GET /audit-logs: filter, paginasi, validasi; hanya OWNER dashboard', { skip }, async () => {
  const o = await reg(); const m = await join(o, 'MEMBER'); const v = await join(o, 'VIEWER'); const a = await join(o, 'OWNER');
  await call('PATCH', `/team/members/${m.userId}`, o.tok, { role: 'VIEWER' });
  await call('PATCH', `/team/members/${v.userId}`, a.tok, { role: 'MEMBER' });
  const byAction = await logs(o, '&action=member.role_changed');
  assert.equal(byAction.length, 2); assert.ok(byAction.every((x) => x.action === 'member.role_changed'));
  const byActor = await logs(o, `&actor_user_id=${a.userId}`);
  assert.deepEqual(byActor.map((x) => x.action), ['member.role_changed', 'invitation.accepted'], 'OWNER kedua: satu perubahan peran + penerimaan undangannya sendiri');
  const byTarget = await logs(o, `&target_id=${m.userId}`);
  assert.ok(byTarget.length >= 1 && byTarget.every((x) => x.target.id === m.userId));
  const p1 = await call('GET', '/audit-logs?page=1&page_size=2', o.tok); const p2 = await call('GET', '/audit-logs?page=2&page_size=2', o.tok);
  assert.equal(p1.body.data.length, 2); assert.ok(p1.body.meta.total > 4);
  assert.notDeepEqual(p1.body.data.map((x: any) => x.id), p2.body.data.map((x: any) => x.id));
  const future = await call('GET', `/audit-logs?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`, o.tok);
  assert.equal(future.body.meta.total, 0);
  assert.equal((await logs(o, `&from=${encodeURIComponent('2020-01-01T00:00:00Z')}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).length > 4, true);
  for (const qs of ['action=BUKAN FORMAT', 'actor_user_id=bukan-uuid', 'page_size=500', 'from=2026-11-10T00:00:00Z&to=2026-11-10T00:00:00Z', 'from=kemarin']) {
    assert.equal((await call('GET', `/audit-logs?${qs.replace(' ', '%20')}`, o.tok)).status, 400, qs);
  }
  assert.equal((await call('GET', '/audit-logs', a.tok)).status, 200, 'OWNER kedua boleh membaca');
  for (const x of [m, v]) assert.equal((await call('GET', '/audit-logs', x.tok)).status, 403);
  const key = (await call('POST', '/api-keys', o.tok, { name: 'kunci-uji', scopes: ['usage:read'] })).body.data.key;
  assert.equal((await call('GET', '/audit-logs', undefined, undefined, { 'x-api-key': key })).status, 403, 'API key tidak boleh membaca audit');
  assert.equal((await call('GET', '/audit-logs')).status, 401);
});

// ---------- keamanan data ----------

test('append-only dan terisolasi: tenant tidak dapat mengubah/menghapus/memalsukan jejak, juga tidak melihat jejak tenant lain', { skip }, async () => {
  const a = await reg(); const b = await reg();
  await call('POST', '/team/invitations', a.tok, { email: 'iso@x.test', role: 'VIEWER' });
  const rowA = (await tq(a.tenantId, 'SELECT id, action FROM audit_logs'))[0];
  await db.tx({ tenantId: a.tenantId }, async (c: any) => {
    assert.equal((await c.query(`UPDATE audit_logs SET action = 'member.removed'`)).rowCount, 0, 'tidak ada kebijakan UPDATE');
    assert.equal((await c.query('DELETE FROM audit_logs')).rowCount, 0, 'DELETE hanya platform');
  });
  await db.tx({ platform: true }, async (c: any) => assert.equal((await c.query(`UPDATE audit_logs SET action = 'member.removed'`)).rowCount, 0, 'platform pun tidak dapat mengubah'));
  assert.equal((await tq(a.tenantId, 'SELECT action FROM audit_logs WHERE id = $1', [rowA.id]))[0].action, rowA.action);
  // tenant lain
  assert.equal((await tq(b.tenantId, 'SELECT 1 FROM audit_logs')).length, 0);
  assert.equal((await call('GET', `/audit-logs?target_id=${rowA.id}`, b.tok)).body.meta.total, 0);
  // memalsukan jejak di tenant lain / sebagai pelaku lain
  const ins = (ctx: any, tenantId: string, action: string, actor: string) => db.tx(ctx, (c: any) =>
    c.query(`INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type) VALUES ($1,$2,$3,'member')`, [tenantId, actor, action]));
  await assert.rejects(ins({ tenantId: b.tenantId }, a.tenantId, 'member.removed', b.userId), /row-level security/, 'tenant B tidak dapat menulis jejak tenant A');
  await assert.rejects(ins({ userId: b.userId, tenantId: b.tenantId }, a.tenantId, 'invitation.accepted', b.userId), /row-level security/, 'tanpa token undangan');
});

test('pencatatan "undangan diterima" hanya oleh penerima sah: pemegang token berakun lain ditolak di tingkat SQL', { skip }, async () => {
  const o = await reg(); const invitee = await reg(); const holder = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: invitee.email, role: 'MEMBER' });
  const hash = sha256hex(inv.body.data.token);
  const ins = (ctx: any, actor: string) => db.tx(ctx, (c: any) =>
    c.query(`INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type) VALUES ($1,$2,'invitation.accepted','invitation')`, [o.tenantId, actor]));
  await assert.rejects(ins({ userId: holder.userId, tenantId: holder.tenantId, inviteHash: hash }, holder.userId), /row-level security/, 'pemegang token yang emailnya berbeda');
  await assert.rejects(ins({ userId: invitee.userId, tenantId: invitee.tenantId, inviteHash: hash }, holder.userId), /row-level security/, 'mengatasnamakan pengguna lain');
  await assert.doesNotReject(ins({ userId: invitee.userId, tenantId: invitee.tenantId, inviteHash: hash }, invitee.userId)); // kontrol: penerima sah
});

test('retensi audit: hanya jejak lebih tua dari batas yang dihapus (konteks platform); yang baru tetap', { skip }, async () => {
  const o = await reg();
  await call('POST', '/team/invitations', o.tok, { email: 'old@x.test', role: 'VIEWER' });
  await call('POST', '/team/invitations', o.tok, { email: 'new@x.test', role: 'VIEWER' });
  const ids = (await tq(o.tenantId, 'SELECT id FROM audit_logs ORDER BY id')).map((r: any) => r.id);
  // mundurkan waktu satu baris langsung (hanya mungkin lewat pemilik tabel; trigger melarang UPDATE biasa -> gunakan INSERT lama)
  await db.tx({ tenantId: o.tenantId }, (c: any) => c.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, created_at) VALUES ($1,$2,'member.removed','member', now() - interval '400 days')`, [o.tenantId, o.userId]));
  const ret = createRetention(db, () => ({ contentDays: 30, rowDays: 180, outboxDays: 7, deliveryDays: 30, auditDays: 365, batch: 10 }));
  const rep = await ret.runOnce();
  assert.ok(rep.auditDeleted >= 1);
  const left = await tq(o.tenantId, 'SELECT id, action FROM audit_logs ORDER BY id');
  assert.deepEqual(left.map((r: any) => r.id), ids, 'yang berusia 400 hari terhapus, yang baru utuh');
  assert.equal((await ret.runOnce()).auditDeleted, 0, 'idempoten');
});
