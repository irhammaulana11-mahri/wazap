import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { sha256hex } = await import('../src/modules/identity/tokens.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);
const app = skip ? (null as any) : buildApp({
  identity, team: createTeamService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
// Tabel tim (memberships/invitations/settings) sengaja TIDAK memberi akses platform: baca/ubah lewat konteks tenant.
const q = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any, headers: any = {}) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, headers: r.headers, cookie: (String(r.headers['set-cookie'] ?? '').match(/wzp_rt=[^;]+/) ?? [''])[0] };
};
interface U { tok: string; userId: string; email: string; tenantId: string; cookie: string }
async function reg(): Promise<U> {
  const email = `tm${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Tim ${n}` });
  assert.equal(r.status, 201);
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id, cookie: r.cookie };
}
const login = async (email: string, tenantId?: string) => (await call('POST', '/auth/login', undefined, { email, password: PW, tenant_id: tenantId })).body.data.access_token as string;
/** Pengguna baru yang bergabung ke tenant `owner` dengan `role` lewat alur undangan penuh; mengembalikan token untuk tenant itu. */
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const acc = await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return { ...u, tenantId: owner.tenantId, tok: await login(u.email, owner.tenantId) };
}
const roleOf = async (tenantId: string, userId: string) => (await q(tenantId, 'SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]))[0];

// ---------- daftar anggota ----------

test('daftar anggota: OWNER saja; memuat email, peran, is_me; MEMBER/VIEWER/API key ditolak', { skip }, async () => {
  const o = await reg();
  const m = await join(o, 'MEMBER'); const v = await join(o, 'VIEWER'); const o2 = await join(o, 'OWNER');
  const r = await call('GET', '/team/members', o.tok);
  assert.equal(r.status, 200); assert.equal(r.body.meta.total, 4);
  assert.deepEqual(r.body.data.map((x: any) => x.role), ['OWNER', 'OWNER', 'MEMBER', 'VIEWER'], 'urut menurut peran (ADR-053: tanpa ADMIN)');
  const me = r.body.data.find((x: any) => x.is_me);
  assert.deepEqual([me.email, me.role, me.status, me.user_id], [o.email, 'OWNER', 'ACTIVE', o.userId]);
  assert.equal((await call('GET', '/team/members', o2.tok)).status, 200, 'OWNER kedua boleh');
  for (const x of [m, v]) assert.equal((await call('GET', '/team/members', x.tok)).status, 403);
  const key = (await call('POST', '/api-keys', o.tok, { name: 'kunci-uji', scopes: ['sessions:read'] })).body.data.key;
  assert.equal((await call('GET', '/team/members', undefined, undefined, { 'x-api-key': key })).status, 403, 'API key tidak dapat mengelola tim');
  assert.equal((await call('GET', '/team/members')).status, 401);
  assert.ok(!JSON.stringify(r.body).includes('password'), 'tidak ada data kredensial');
});

// ---------- undangan ----------

test('undangan end-to-end: token sekali tampil (hanya hash disimpan), terima, pindah workspace, tidak bisa dipakai ulang', { skip }, async () => {
  const o = await reg(); const u = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email.toUpperCase(), role: 'MEMBER' });
  assert.equal(inv.status, 201); assert.equal(inv.headers['cache-control'], 'no-store');
  const token = inv.body.data.token as string;
  assert.match(token, /^inv_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([inv.body.data.email, inv.body.data.role, inv.body.data.status], [u.email, 'MEMBER', 'PENDING'], 'email dinormalkan');
  const row = (await q(o.tenantId, 'SELECT token_hash FROM tenant_invitations WHERE id = $1', [inv.body.data.id]))[0];
  assert.equal(row.token_hash, sha256hex(token)); assert.ok(!JSON.stringify(row).includes(token), 'token mentah tidak disimpan');
  const list = await call('GET', '/team/invitations', o.tok);
  assert.ok(!JSON.stringify(list.body).includes(token), 'daftar tidak membocorkan token');
  assert.equal(list.body.data[0].status, 'PENDING');

  const acc = await call('POST', '/team/invitations/accept', u.tok, { token });
  assert.equal(acc.status, 200);
  assert.deepEqual([acc.body.data.tenant.id, acc.body.data.role], [o.tenantId, 'MEMBER']);
  assert.deepEqual((await roleOf(o.tenantId, u.userId)), { role: 'MEMBER', status: 'ACTIVE' });
  assert.equal((await q(o.tenantId, 'SELECT member_email FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [o.tenantId, u.userId]))[0].member_email, u.email);
  assert.equal((await call('GET', '/team/invitations?status=ACCEPTED', o.tok)).body.data[0].status, 'ACCEPTED');

  const again = await call('POST', '/team/invitations/accept', u.tok, { token });
  assert.equal(again.status, 404); assert.equal(again.body.error.code, 'INVALID_INVITATION', 'token sekali pakai');

  // pindah workspace tanpa kata sandi: token baru untuk tenant tujuan, cookie refresh dirotasi
  const sw = await call('POST', '/auth/switch-tenant', u.tok, { tenant_id: o.tenantId }, { cookie: u.cookie });
  assert.equal(sw.status, 200);
  assert.deepEqual([sw.body.data.tenant.id, sw.body.data.role], [o.tenantId, 'MEMBER']);
  assert.match(sw.headers['set-cookie'] as string, /wzp_rt=.*HttpOnly/);
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, { cookie: u.cookie })).status, 401, 'family refresh lama dicabut');
  assert.equal((await call('GET', '/auth/me', sw.body.data.access_token)).body.data.active_tenant_id, o.tenantId);
  assert.equal((await call('POST', '/auth/refresh', undefined, undefined, { cookie: sw.cookie })).body.data.tenant.id, o.tenantId, 'refresh baru mempertahankan tenant tujuan');
});

test('terima undangan: token salah/kedaluwarsa/dicabut/email beda/API key semuanya ditolak seragam; token tetap sah untuk pemilik email', { skip }, async () => {
  const o = await reg(); const right = await reg(); const wrong = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: right.email, role: 'VIEWER' });
  const token = inv.body.data.token as string;
  const bad = async (tok: string, body: any) => { const r = await call('POST', '/team/invitations/accept', tok, body); assert.equal(r.status, 404, JSON.stringify(body)); assert.equal(r.body.error.code, 'INVALID_INVITATION'); };
  await bad(wrong.tok, { token });                                   // token valid milik orang lain
  await bad(right.tok, { token: 'inv_' + 'A'.repeat(43) });          // format benar, tidak ada
  await bad(right.tok, { token: 'sampah-sampah-sampah' });          // format salah (lolos validasi panjang, gagal format)
  assert.equal((await call('POST', '/team/invitations/accept', right.tok, { token: token, extra: 1 })).status, 400, 'body strict');
  const key = (await call('POST', '/api-keys', right.tok, { name: 'kunci-uji', scopes: ['sessions:read'] })).body.data.key;
  assert.equal((await call('POST', '/team/invitations/accept', undefined, { token }, { 'x-api-key': key })).status, 403);
  assert.equal((await roleOf(o.tenantId, wrong.userId)), undefined, 'pengguna lain tidak ikut menjadi anggota');
  // kedaluwarsa
  await q(o.tenantId, `UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.body.data.id]);
  await bad(right.tok, { token });
  assert.equal((await call('GET', '/team/invitations', o.tok)).body.data[0].status, 'EXPIRED');
  // undangan baru untuk email yang sama (yang kedaluwarsa tidak menghalangi) lalu dicabut
  const inv2 = await call('POST', '/team/invitations', o.tok, { email: right.email, role: 'VIEWER' });
  assert.equal(inv2.status, 201);
  assert.equal((await call('DELETE', `/team/invitations/${inv2.body.data.id}`, o.tok)).body.data.status, 'REVOKED');
  await bad(right.tok, { token: inv2.body.data.token });
  // undangan ketiga: sah dan diterima oleh pemilik email
  const inv3 = await call('POST', '/team/invitations', o.tok, { email: right.email, role: 'VIEWER' });
  assert.equal((await call('POST', '/team/invitations/accept', right.tok, { token: inv3.body.data.token })).status, 200);
});

test('RLS menegakkan undangan di tingkat SQL: tidak ada jalan masuk ke tenant lain tanpa token yang cocok', { skip }, async () => {
  const o = await reg(); const intruder = await reg(); const invitee = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: invitee.email, role: 'MEMBER' });
  const hash = sha256hex(inv.body.data.token);
  const ins = (ctx: any, role: string, email: string, userId: string) =>
    db.tx(ctx, (c: any) => c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,$3,$4)`, [o.tenantId, userId, role, email]));
  const denied = /row-level security/;
  // 1) tanpa token: penyusup tidak dapat menyisipkan keanggotaan di tenant lain
  await assert.rejects(ins({ userId: intruder.userId, tenantId: intruder.tenantId }, 'OWNER', intruder.email, intruder.userId), denied);
  // 2) dengan token valid tetapi bukan pemilik email
  await assert.rejects(ins({ userId: intruder.userId, tenantId: intruder.tenantId, inviteHash: hash }, 'MEMBER', intruder.email, intruder.userId), denied);
  // 3) pemilik email, tetapi mencoba eskalasi peran
  await assert.rejects(ins({ userId: invitee.userId, tenantId: invitee.tenantId, inviteHash: hash }, 'OWNER', invitee.email, invitee.userId), denied);
  // 4) pemilik email mendaftarkan pengguna lain
  await assert.rejects(ins({ userId: invitee.userId, tenantId: invitee.tenantId, inviteHash: hash }, 'MEMBER', invitee.email, intruder.userId), denied);
  // 5) penyusup tidak dapat menandai undangan diterima, juga tidak dapat membaca undangan tenant lain
  await db.tx({ userId: intruder.userId, tenantId: intruder.tenantId }, async (c: any) => {
    assert.equal((await c.query('SELECT 1 FROM tenant_invitations')).rowCount, 0);
    assert.equal((await c.query(`UPDATE tenant_invitations SET status = 'REVOKED'`)).rowCount, 0);
  });
  assert.equal((await q(o.tenantId, 'SELECT status FROM tenant_invitations WHERE id = $1', [inv.body.data.id]))[0].status, 'PENDING');
  // 6) jalur sah berhasil (kontrol): pemilik email + token + peran yang sama
  await ins({ userId: invitee.userId, tenantId: invitee.tenantId, inviteHash: hash }, 'MEMBER', invitee.email, invitee.userId);
  assert.deepEqual(await roleOf(o.tenantId, invitee.userId), { role: 'MEMBER', status: 'ACTIVE' });
});

test('aturan undangan: matriks peran, duplikat, sudah anggota, validasi, kuota (anggota + tertunda)', { skip }, async () => {
  const o = await reg(); const owner2 = await join(o, 'OWNER'); const member = await join(o, 'MEMBER');
  const invite = (tok: string, body: any) => call('POST', '/team/invitations', tok, body);
  assert.equal((await invite(o.tok, { email: 'a1@x.test', role: 'ADMIN' })).status, 400, 'peran ADMIN dihapus (ADR-053)');
  assert.equal((await invite(member.tok, { email: 'a2@x.test', role: 'OWNER' })).status, 403, 'MEMBER tidak dapat mengundang siapa pun (tanpa eskalasi)');
  assert.equal((await invite(owner2.tok, { email: 'a3@x.test', role: 'VIEWER' })).status, 201, 'OWNER kedua boleh mengundang');
  assert.equal((await invite(member.tok, { email: 'a4@x.test', role: 'VIEWER' })).status, 403);
  assert.equal((await invite(o.tok, { email: 'a5@x.test', role: 'OWNER' })).status, 201, 'OWNER boleh mengundang OWNER');
  const dup = await invite(o.tok, { email: 'a3@x.test', role: 'MEMBER' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'INVITATION_EXISTS');
  const already = await invite(o.tok, { email: member.email, role: 'VIEWER' });
  assert.equal(already.status, 409); assert.equal(already.body.error.code, 'ALREADY_MEMBER');
  assert.equal((await invite(o.tok, { email: 'bukan-email', role: 'MEMBER' })).status, 400);
  assert.equal((await invite(o.tok, { email: 'a6@x.test', role: 'SUPER' })).status, 400);
  assert.equal((await invite(o.tok, { email: 'a6@x.test', role: 'MEMBER', tenant_id: crypto.randomUUID() })).status, 400, 'field asing ditolak');
  assert.equal((await invite(o.tok, { email: 'a6@x.test' })).body.data.role, 'MEMBER', 'default MEMBER');
  // kuota: 3 anggota + 3 undangan tertunda = 6; batasi ke 6
  assert.equal((await db.tx({ tenantId: o.tenantId }, (c: any) => c.query(`UPDATE tenant_settings SET max_members = 6 WHERE tenant_id = $1`, [o.tenantId]))).rowCount, 1);
  const full = await invite(o.tok, { email: 'a7@x.test', role: 'MEMBER' });
  assert.equal(full.status, 409); assert.equal(full.body.error.code, 'QUOTA_EXCEEDED');
  // mencabut membuka kuota
  const pending = (await call('GET', '/team/invitations?status=PENDING', o.tok)).body.data;
  await call('DELETE', `/team/invitations/${pending[0].id}`, o.tok);
  assert.equal((await invite(o.tok, { email: 'a7@x.test', role: 'MEMBER' })).status, 201);
  // MEMBER tidak dapat mencabut undangan apa pun
  const ownerInv = (await call('GET', '/team/invitations?status=PENDING', o.tok)).body.data.find((x: any) => x.role === 'OWNER');
  assert.equal((await call('DELETE', `/team/invitations/${ownerInv.id}`, member.tok)).status, 403);
  assert.equal((await call('DELETE', `/team/invitations/${crypto.randomUUID()}`, o.tok)).status, 404);
  assert.equal((await call('DELETE', `/team/invitations/bukan-uuid`, o.tok)).status, 404);
});

// ---------- kelola anggota ----------

test('matriks peran anggota: OWNER mengelola semua anggota; MEMBER/VIEWER tidak; peran ADMIN tidak sah; tidak bisa ubah diri sendiri', { skip }, async () => {
  const o = await reg(); const o2 = await join(o, 'OWNER'); const m = await join(o, 'MEMBER'); const v = await join(o, 'VIEWER');
  const patch = (tok: string, id: string, body: any) => call('PATCH', `/team/members/${id}`, tok, body);
  assert.equal((await patch(o.tok, m.userId, { role: 'VIEWER' })).body.data.role, 'VIEWER', 'OWNER mengubah MEMBER<->VIEWER');
  assert.equal((await patch(o.tok, m.userId, { role: 'ADMIN' })).status, 400, 'peran ADMIN dihapus (ADR-053)');
  assert.equal((await patch(o2.tok, o.userId, { status: 'SUSPENDED' })).status, 200, 'OWNER mengelola OWNER lain selama masih ada OWNER aktif');
  assert.equal((await patch(o2.tok, o.userId, { status: 'ACTIVE' })).status, 200);
  const self = await patch(o2.tok, o2.userId, { role: 'VIEWER' });
  assert.equal(self.status, 403); assert.equal(self.body.error.code, 'CANNOT_MODIFY_SELF');
  assert.equal((await patch(m.tok, v.userId, { role: 'MEMBER' })).status, 403, 'non-OWNER tidak dapat mengelola');
  assert.equal((await patch(v.tok, m.userId, { role: 'MEMBER' })).status, 403, 'VIEWER tidak dapat mengelola');
  assert.equal((await patch(o.tok, v.userId, {})).status, 400); assert.equal((await patch(o.tok, v.userId, { role: 'ROOT' })).status, 400);
  assert.equal((await patch(o.tok, v.userId, { role: 'MEMBER', extra: 1 })).status, 400);
  assert.equal((await patch(o.tok, crypto.randomUUID(), { role: 'MEMBER' })).status, 404);
  assert.equal((await patch(o.tok, 'bukan-uuid', { role: 'MEMBER' })).status, 404);
  assert.deepEqual(await roleOf(o.tenantId, m.userId), { role: 'VIEWER', status: 'ACTIVE' });
});

test('pemilik terakhir terlindungi: tidak dapat diturunkan, ditangguhkan, dihapus, atau keluar; dengan 2 OWNER salah satunya boleh keluar', { skip }, async () => {
  const o = await reg();
  const last = (r: any) => { assert.equal(r.status, 409); assert.equal(r.body.error.code, 'LAST_OWNER'); };
  const o2 = await join(o, 'OWNER');                                    // OWNER kedua (hanya OWNER yang bisa mengundang OWNER)
  assert.equal((await call('PATCH', `/team/members/${o2.userId}`, o.tok, { role: 'MEMBER' })).body.data.role, 'MEMBER', 'masih ada OWNER lain');
  assert.equal((await call('PATCH', `/team/members/${o2.userId}`, o.tok, { role: 'OWNER' })).body.data.role, 'OWNER');
  // o2 menurunkan o (ada o2 yang tetap OWNER) -> boleh
  assert.equal((await call('PATCH', `/team/members/${o.userId}`, o2.tok, { role: 'MEMBER' })).body.data.role, 'MEMBER');
  // sekarang o2 adalah OWNER terakhir
  last(await call('DELETE', `/team/members/${o2.userId}`, o2.tok));        // keluar sendiri ditolak
  const mem = await join(o2, 'MEMBER');
  assert.equal((await call('PATCH', `/team/members/${o2.userId}`, mem.tok, { status: 'SUSPENDED' })).status, 403);
  // pemulihan kondisi: promosikan o kembali, lalu o2 boleh keluar
  await call('PATCH', `/team/members/${o.userId}`, o2.tok, { role: 'OWNER' });
  assert.equal((await call('DELETE', `/team/members/${o2.userId}`, o2.tok)).status, 200, 'keluar sendiri sah bila ada OWNER lain');
  assert.equal(await roleOf(o.tenantId, o2.userId), undefined);
});

test('balapan: dua OWNER saling menurunkan secara bersamaan => tepat satu berhasil, selalu tersisa satu OWNER', { skip }, async () => {
  const o = await reg(); const o2 = await join(o, 'OWNER');
  const [r1, r2] = await Promise.all([
    call('PATCH', `/team/members/${o2.userId}`, o.tok, { role: 'VIEWER' }),
    call('PATCH', `/team/members/${o.userId}`, o2.tok, { role: 'VIEWER' }),
  ]);
  const owners = (await q(o.tenantId, `SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`, [o.tenantId]))[0].n;
  assert.equal(owners, 1, `harus tersisa tepat satu OWNER (r1=${r1.status}, r2=${r2.status})`);
  const statuses = [r1.status, r2.status];
  assert.equal(statuses.filter((x) => x === 200).length, 1, `tepat satu permintaan sukses (${statuses})`);
  assert.ok(statuses.every((x) => x === 200 || x === 403 || x === 409), 'yang kalah ditolak (403: perannya sudah turun; 409: pemilik terakhir)');
});

test('ditangguhkan/dihapus kehilangan akses seketika; diaktifkan kembali pulih; isolasi antar tenant', { skip }, async () => {
  const o = await reg(); const m = await join(o, 'MEMBER'); const other = await reg();
  assert.equal((await call('GET', '/sessions', m.tok)).status, 200);
  assert.equal((await call('PATCH', `/team/members/${m.userId}`, o.tok, { status: 'SUSPENDED' })).body.data.status, 'SUSPENDED');
  assert.equal((await call('GET', '/sessions', m.tok)).status, 401, 'token yang sama langsung tidak berlaku');
  assert.equal((await call('PATCH', `/team/members/${m.userId}`, o.tok, { status: 'ACTIVE' })).body.data.status, 'ACTIVE');
  assert.equal((await call('GET', '/sessions', m.tok)).status, 200, 'pulih setelah diaktifkan');
  // tenant lain tidak dapat melihat/mengubah/menghapus anggota tenant ini
  assert.equal((await call('PATCH', `/team/members/${m.userId}`, other.tok, { role: 'VIEWER' })).status, 404);
  assert.equal((await call('DELETE', `/team/members/${m.userId}`, other.tok)).status, 404);
  assert.equal((await call('GET', '/team/members', other.tok)).body.meta.total, 1);
  assert.deepEqual(await roleOf(o.tenantId, m.userId), { role: 'MEMBER', status: 'ACTIVE' });
  // dihapus
  assert.equal((await call('DELETE', `/team/members/${m.userId}`, o.tok)).body.data.removed, true);
  assert.equal((await call('GET', '/sessions', m.tok)).status, 401);
  assert.equal(await roleOf(o.tenantId, m.userId), undefined);
  assert.equal((await call('DELETE', `/team/members/${m.userId}`, o.tok)).status, 404, 'idempoten: sudah tidak ada');
  // MEMBER/VIEWER tidak dapat menghapus orang lain, tetapi boleh keluar sendiri
  const v1 = await join(o, 'VIEWER'); const v2 = await join(o, 'VIEWER');
  assert.equal((await call('DELETE', `/team/members/${v2.userId}`, v1.tok)).status, 403);
  assert.equal((await call('DELETE', `/team/members/${v1.userId}`, v1.tok)).status, 200, 'keluar sendiri');
});

test('switch-tenant: hanya workspace milik sendiri; validasi; API key tidak boleh', { skip }, async () => {
  const a = await reg(); const b = await reg();
  assert.equal((await call('POST', '/auth/switch-tenant', a.tok, { tenant_id: b.tenantId })).status, 404, 'bukan anggota = tidak ada');
  assert.equal((await call('POST', '/auth/switch-tenant', a.tok, { tenant_id: 'bukan-uuid' })).status, 400);
  assert.equal((await call('POST', '/auth/switch-tenant', a.tok, { tenant_id: a.tenantId, x: 1 })).status, 400);
  assert.equal((await call('POST', '/auth/switch-tenant', undefined, { tenant_id: a.tenantId })).status, 401);
  const self = await call('POST', '/auth/switch-tenant', a.tok, { tenant_id: a.tenantId });
  assert.equal(self.status, 200); assert.equal(self.body.data.tenant.id, a.tenantId);
  const key = (await call('POST', '/api-keys', a.tok, { name: 'kunci-uji', scopes: ['sessions:read'] })).body.data.key;
  assert.equal((await call('POST', '/auth/switch-tenant', undefined, { tenant_id: a.tenantId }, { 'x-api-key': key })).status, 403);
  // anggota yang ditangguhkan tidak dapat berpindah ke tenant itu
  const m = await join(a, 'MEMBER');
  await call('PATCH', `/team/members/${m.userId}`, a.tok, { status: 'SUSPENDED' });
  const mTok = await login(m.email); // login memilih tenant aktif miliknya sendiri
  assert.equal((await call('POST', '/auth/switch-tenant', mTok, { tenant_id: a.tenantId })).status, 404, 'keanggotaan ditangguhkan tidak dapat dipakai');
});
