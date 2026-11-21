import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createJoinService, normalizeJoinCode } = await import('../src/modules/team/join.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { sha256hex } = await import('../src/modules/identity/tokens.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), team: createTeamService(db), join: createJoinService(db), audit: createAuditService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const q = (ctx: any, sql: string, args: any[] = []) => db.tx(ctx, async (c: any) => { const r = await c.query(sql, args); return r.rows; });
const call = async (method: string, url: string, tok?: string, payload?: any) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body };
};
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `jn${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Join ${n}` });
  assert.equal(r.status, 201);
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id };
}
const code = async (o: U) => { const r = await call('PUT', '/team/join-code', o.tok); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.join_code as string; };
const apply = (joinCode: string, email: string, password = PW) => call('POST', '/auth/join-requests', undefined, { join_code: joinCode, email, password });
const loginRes = (email: string, tenantId?: string, password = PW) => call('POST', '/auth/login', undefined, { email, password, tenant_id: tenantId });
const pending = async (o: U) => (await call('GET', '/team/join-requests?status=PENDING', o.tok)).body.data as any[];
async function joinAs(o: U, role: string): Promise<U> { // anggota biasa lewat alur undangan, untuk menguji peran OWNER/MEMBER
  const u = await reg();
  const inv = await call('POST', '/team/invitations', o.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  const l = await loginRes(u.email, o.tenantId);
  return { ...u, tenantId: o.tenantId, tok: l.body.data.access_token };
}

test('normalisasi kode: huruf kecil, tanpa tanda hubung, awalan WJ opsional; kode inti boleh diawali "WJ"', () => {
  assert.equal(normalizeJoinCode('wj-abcde-fghjk-mnpqr-stuvw'), 'ABCDEFGHJKMNPQRSTUVW');
  assert.equal(normalizeJoinCode('ABCDEFGHJKMNPQRSTUVW'), 'ABCDEFGHJKMNPQRSTUVW');
  assert.equal(normalizeJoinCode('WJBCDEFGHJKMNPQRSTUV'), 'WJBCDEFGHJKMNPQRSTUV', 'inti berawalan WJ tidak boleh terpotong');
  assert.equal(normalizeJoinCode('WJ-ABCDE'), null);
  assert.equal(normalizeJoinCode('ABCDEFGHJKMNPQRSTUV0'), null, 'karakter di luar alfabet');
});

test('kode workspace: OWNER saja; tampil sekali; GET tidak membocorkan kode; hash saja di DB', { skip }, async () => {
  const o = await reg(); const m = await joinAs(o, 'MEMBER');
  assert.equal((await call('GET', '/team/join-code', o.tok)).body.data.enabled, false);
  const r = await call('PUT', '/team/join-code', o.tok);
  assert.equal(r.status, 200);
  assert.match(r.body.data.join_code, /^WJ(-[A-Z2-9]{5}){4}$/);
  const g = (await call('GET', '/team/join-code', o.tok)).body.data;
  assert.equal(g.enabled, true); assert.equal(g.join_code, undefined);
  const rows = await q({ tenantId: o.tenantId }, 'SELECT code_hash, tenant_name FROM tenant_join_codes WHERE tenant_id = $1', [o.tenantId]);
  assert.match(rows[0].code_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(rows).includes(r.body.data.join_code.replace(/-/g, '')));
  assert.equal((await call('PUT', '/team/join-code', m.tok)).status, 403);
  assert.equal((await call('DELETE', '/team/join-code', m.tok)).status, 403);
  assert.equal((await call('GET', '/team/join-code')).status, 401);
});

test('alur penuh: daftar dengan kata sandi sendiri -> menunggu -> disetujui -> login dengan kata sandi yang sama', { skip }, async () => {
  const o = await reg(); const c = await code(o);
  const email = `calon${++n}@x.test`;
  const r = await apply(c, email);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'PENDING'); assert.match(r.body.data.tenant_name, /^Join \d+$/, 'nama workspace');
  const l1 = await loginRes(email);
  assert.equal(l1.status, 403); assert.equal(l1.body.error.code, 'JOIN_PENDING');
  assert.equal((await loginRes(email, undefined, 'salah-salah-12345')).status, 401, 'kata sandi salah tetap 401 (tidak membocorkan status)');
  const list = await pending(o);
  assert.equal(list.length, 1); assert.equal(list[0].email, email); assert.equal(list[0].status, 'PENDING');
  const ap = await call('POST', `/team/join-requests/${list[0].id}/approve`, o.tok, { role: 'MEMBER' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.equal(ap.body.data.status, 'APPROVED'); assert.equal(ap.body.data.role, 'MEMBER');
  const l2 = await loginRes(email);
  assert.equal(l2.status, 200, JSON.stringify(l2.body)); assert.equal(l2.body.data.role, 'MEMBER'); assert.equal(l2.body.data.tenant.id, o.tenantId);
  const members = (await call('GET', '/team/members', o.tok)).body.data;
  assert.ok(members.some((x: any) => x.email === email && x.role === 'MEMBER'));
  const au = (await call('GET', '/audit-logs?page_size=20', o.tok)).body.data.map((a: any) => a.action);
  assert.ok(au.includes('join_request.approved') && au.includes('join_code.rotated'), 'audit: ' + JSON.stringify(au));
  assert.equal((await call('POST', `/team/join-requests/${list[0].id}/approve`, o.tok, {})).status, 409, 'sudah diputuskan');
});

test('kode tidak valid/dinonaktifkan/diputar dijawab seragam 404; kode lama hangus setelah diputar', { skip }, async () => {
  const o = await reg(); const c1 = await code(o);
  assert.equal((await apply('WJ-AAAAA-AAAAA-AAAAA-AAAAA', `x${++n}@x.test`)).body.error.code, 'INVALID_JOIN_CODE');
  assert.equal((await apply('bukan-kode', `x${++n}@x.test`)).body.error.code, 'INVALID_JOIN_CODE');
  const c2 = await code(o);
  assert.notEqual(c1, c2);
  assert.equal((await apply(c1, `x${++n}@x.test`)).status, 404, 'kode lama hangus');
  assert.equal((await apply(c2.toLowerCase().replace(/-/g, ''), `x${++n}@x.test`)).status, 201, 'input dinormalisasi');
  assert.equal((await call('DELETE', '/team/join-code', o.tok)).body.data.enabled, false);
  assert.equal((await apply(c2, `x${++n}@x.test`)).status, 404, 'dinonaktifkan');
  // penolakan kode tidak membuat akun
  const stray = `stray${++n}@x.test`; await apply(c2, stray);
  assert.equal((await q({ loginEmail: stray }, 'SELECT 1 FROM users WHERE email = $1', [stray])).length, 0);
});

test('email yang sudah terdaftar harus membuktikan kata sandi; tidak membuat akun kedua; workspace lama tetap bisa dipakai', { skip }, async () => {
  const o = await reg(); const other = await reg(); const c = await code(o);
  const bad = await apply(c, other.email, 'salah-salah-12345');
  assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal((await pending(o)).length, 0, 'tanpa bukti kata sandi tidak ada permintaan');
  const ok = await apply(c, other.email);
  assert.equal(ok.status, 201); assert.equal(ok.body.data.existing_account, true);
  assert.equal((await apply(c, other.email)).body.error.code, 'JOIN_REQUEST_EXISTS', 'duplikat tertunda');
  assert.equal((await loginRes(other.email)).status, 200, 'workspace sendiri tidak terganggu');
  const id = (await pending(o))[0].id;
  assert.equal((await call('POST', `/team/join-requests/${id}/approve`, o.tok, { role: 'VIEWER' })).status, 200);
  assert.equal((await loginRes(other.email, o.tenantId)).body.data.role, 'VIEWER');
  assert.equal((await apply(c, other.email)).body.error.code, 'ALREADY_MEMBER');
});

test('wewenang penyetuju: hanya OWNER; MEMBER/API key tidak dapat mengelola; peran ADMIN tidak sah (ADR-053)', { skip }, async () => {
  const o = await reg(); const own2 = await joinAs(o, 'OWNER'); const mem = await joinAs(o, 'MEMBER'); const c = await code(o);
  await apply(c, `p${++n}@x.test`); await apply(c, `p${++n}@x.test`);
  const [a, b] = await pending(o);
  assert.equal((await call('POST', `/team/join-requests/${a.id}/approve`, mem.tok, { role: 'MEMBER' })).status, 403);
  assert.equal((await call('GET', '/team/join-requests', mem.tok)).status, 403);
  assert.equal((await call('POST', `/team/join-requests/${a.id}/approve`, own2.tok, { role: 'ADMIN' })).status, 400, 'peran ADMIN dihapus');
  assert.equal((await call('POST', `/team/join-requests/${a.id}/approve`, own2.tok, { role: 'MEMBER' })).status, 200, 'OWNER kedua boleh menyetujui');
  assert.equal((await call('POST', `/team/join-requests/${b.id}/approve`, o.tok, { role: 'OWNER', x: 1 })).status, 400, 'strict');
  assert.equal((await call('POST', `/team/join-requests/${b.id}/approve`, o.tok, { role: 'OWNER' })).status, 200, 'OWNER dapat memberi OWNER');
});

test('tolak: pemohon melihat JOIN_REJECTED, dapat mengajukan ulang; permintaan kedaluwarsa tidak dapat disetujui dan dapat diajukan ulang', { skip }, async () => {
  const o = await reg(); const c = await code(o); const email = `r${++n}@x.test`;
  await apply(c, email);
  const id = (await pending(o))[0].id;
  assert.equal((await call('POST', `/team/join-requests/${id}/reject`, o.tok)).body.data.status, 'REJECTED');
  const l = await loginRes(email); assert.equal(l.status, 403); assert.equal(l.body.error.code, 'JOIN_REJECTED');
  assert.equal((await apply(c, email)).status, 201, 'boleh mengajukan ulang');
  const id2 = (await pending(o))[0].id;
  await q({ tenantId: o.tenantId }, `UPDATE tenant_join_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id2]);
  assert.equal((await call('GET', '/team/join-requests?status=EXPIRED', o.tok)).body.data.length, 1);
  assert.equal((await call('POST', `/team/join-requests/${id2}/approve`, o.tok, { role: 'MEMBER' })).body.error.code, 'REQUEST_EXPIRED');
  assert.equal((await loginRes(email)).body.error.code, 'JOIN_REJECTED', 'kedaluwarsa = tidak lagi menunggu');
  assert.equal((await apply(c, email)).status, 201, 'pengajuan ulang setelah kedaluwarsa');
});

test('kuota anggota diperiksa saat persetujuan', { skip }, async () => {
  const o = await reg(); const c = await code(o);
  await q({ tenantId: o.tenantId }, 'UPDATE tenant_settings SET max_members = 1 WHERE tenant_id = $1', [o.tenantId]);
  await apply(c, `k${++n}@x.test`);
  const r = await call('POST', `/team/join-requests/${(await pending(o))[0].id}/approve`, o.tok, { role: 'MEMBER' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'QUOTA_EXCEEDED');
});

test('validasi: kata sandi pendek 400, field asing 400, tanpa autentikasi untuk jalur publik, id acak 404', { skip }, async () => {
  const o = await reg(); const c = await code(o);
  assert.equal((await apply(c, `v${++n}@x.test`, 'pendek')).status, 400);
  assert.equal((await call('POST', '/auth/join-requests', undefined, { join_code: c, email: `v${++n}@x.test`, password: PW, role: 'OWNER' })).status, 400);
  assert.equal((await call('POST', '/team/join-requests/not-a-uuid/approve', o.tok, {})).status, 404);
  assert.equal((await call('POST', '/team/join-requests/00000000-0000-4000-8000-000000000000/reject', o.tok)).status, 404);
});

test('RLS: pemohon tidak dapat menyetujui diri sendiri, membuat keanggotaan, atau membuat permintaan tanpa kode valid; tenant lain tidak melihat permintaan', { skip }, async () => {
  const o = await reg(); const rival = await reg(); const c = await code(o);
  const email = `rls${++n}@x.test`; await apply(c, email);
  const reqRow = (await q({ tenantId: o.tenantId }, 'SELECT id, user_id, tenant_id FROM tenant_join_requests WHERE email = $1', [email]))[0];
  const asReq = { userId: reqRow.user_id };
  // setuju sendiri
  assert.equal((await q(asReq, `UPDATE tenant_join_requests SET status = 'APPROVED', decided_at = now(), decided_role = 'OWNER' WHERE id = $1 RETURNING id`, [reqRow.id])).length, 0);
  // membership langsung
  await assert.rejects(q(asReq, `INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,'OWNER',$3)`, [o.tenantId, reqRow.user_id, email]), /row-level security/);
  // permintaan tanpa kode / dengan kode milik tenant lain / email palsu
  await assert.rejects(q(asReq, `INSERT INTO tenant_join_requests (tenant_id, user_id, email, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [rival.tenantId, reqRow.user_id, email]), /row-level security/);
  const rc = await code(rival);
  const rivalHash = sha256hex('wj:' + rc.replace(/-/g, '').replace(/^WJ/, ''));
  await assert.rejects(q({ ...asReq, joinHash: rivalHash }, `INSERT INTO tenant_join_requests (tenant_id, user_id, email, expires_at) VALUES ($1,$2,'palsu@x.test', now() + interval '1 day')`, [rival.tenantId, reqRow.user_id]), /row-level security/, 'email harus = email akun');
  await assert.rejects(q({ userId: rival.userId, joinHash: rivalHash }, `INSERT INTO tenant_join_requests (tenant_id, user_id, email, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [rival.tenantId, reqRow.user_id, email]), /row-level security/, 'user_id harus milik konteks');
  // tenant lain tidak melihat; pemohon hanya melihat miliknya
  assert.equal((await q({ tenantId: rival.tenantId }, 'SELECT 1 FROM tenant_join_requests WHERE email = $1', [email])).length, 0);
  assert.equal((await q({ tenantId: rival.tenantId }, 'SELECT 1 FROM tenant_join_codes WHERE tenant_id = $1', [o.tenantId])).length, 0, 'kode tenant lain tak terlihat');
  assert.equal((await q(asReq, 'SELECT 1 FROM tenant_join_requests')).length, 1);
  // pemohon boleh menutup permintaan kedaluwarsa miliknya, tetapi tidak yang masih hidup
  assert.equal((await q(asReq, `UPDATE tenant_join_requests SET status = 'REJECTED', decided_at = now() WHERE id = $1 RETURNING id`, [reqRow.id])).length, 0);
});

// ---------- batas antrean dan retensi ----------
const { config } = await import('../src/config/env.js');
const { createRetention } = await import('../src/modules/engine/retention.js');
async function withCap<T>(cap: number, fn: () => Promise<T>): Promise<T> {
  const prev = (config as any).JOIN_MAX_PENDING; (config as any).JOIN_MAX_PENDING = cap;
  try { return await fn(); } finally { (config as any).JOIN_MAX_PENDING = prev; }
}
const usersWith = async (email: string) => (await q({ loginEmail: email }, 'SELECT 1 FROM users WHERE email = $1', [email])).length;

test('batas antrean: pengajuan di atas batas ditolak 409 tanpa membuat akun; menolak/menyetujui membebaskan tempat; tenant lain tidak terpengaruh', { skip }, async () => {
  const o = await reg(); const other = await reg(); const c = await code(o); const oc = await code(other);
  await withCap(2, async () => {
    const e1 = `q${++n}@x.test`, e2 = `q${++n}@x.test`, e3 = `q${++n}@x.test`;
    assert.equal((await apply(c, e1)).status, 201); assert.equal((await apply(c, e2)).status, 201);
    const full = await apply(c, e3);
    assert.equal(full.status, 409); assert.equal(full.body.error.code, 'JOIN_QUEUE_FULL');
    assert.equal(await usersWith(e3), 0, 'penolakan antrean penuh tidak meninggalkan akun');
    assert.equal((await apply(oc, e3)).status, 201, 'antrean tenant lain terpisah');
    assert.equal((await apply(c, e1)).body.error.code, 'JOIN_REQUEST_EXISTS', 'pengajuan ganda dijawab spesifik walau antrean penuh');
    const first = (await pending(o))[0];
    assert.equal((await call('POST', `/team/join-requests/${first.id}/reject`, o.tok)).status, 200);
    assert.equal((await apply(c, `q${++n}@x.test`)).status, 201, 'tempat bebas setelah ditolak');
  });
});

test('batas antrean: permintaan kedaluwarsa tidak dihitung; pengajuan serentak tidak melampaui batas', { skip }, async () => {
  const o = await reg(); const c = await code(o);
  await withCap(3, async () => {
    for (let i = 0; i < 3; i++) await apply(c, `x${++n}@x.test`);
    assert.equal((await apply(c, `x${++n}@x.test`)).status, 409);
    await q({ tenantId: o.tenantId }, `UPDATE tenant_join_requests SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1`, [o.tenantId]);
    const res = await Promise.all(Array.from({ length: 6 }, () => apply(c, `par${++n}@x.test`)));
    const created = res.filter((r) => r.status === 201).length;
    assert.equal(created, 3, 'tepat 3 berhasil walau 6 serentak: ' + res.map((r) => r.status).join(','));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'JOIN_QUEUE_FULL'));
    assert.equal((await pending(o)).length, 3);
  });
});

test('RLS antrean: dengan hash kode, pemohon hanya dapat melihat baris PENDING yang berlaku milik tenant itu (bukan yang diputuskan/kedaluwarsa/tenant lain)', { skip }, async () => {
  const o = await reg(); const other = await reg(); const c = await code(o); const oc = await code(other);
  const hash = (cd: string) => sha256hex('wj:' + cd.replace(/-/g, '').replace(/^WJ/, ''));
  const a = `qa${++n}@x.test`, b = `qb${++n}@x.test`, d = `qd${++n}@x.test`, z = `qz${++n}@x.test`;
  await apply(c, a); await apply(c, b); await apply(c, d); await apply(oc, z);
  const ids = await pending(o);
  await call('POST', `/team/join-requests/${ids.find((x: any) => x.email === b).id}/reject`, o.tok);
  await q({ tenantId: o.tenantId }, `UPDATE tenant_join_requests SET expires_at = now() - interval '1 minute' WHERE email = $1`, [d]);
  const stranger = (await reg()).userId; // pengguna lain yang kebetulan memegang kode
  const seen = await q({ userId: stranger, joinHash: hash(c) }, 'SELECT email FROM tenant_join_requests ORDER BY email');
  assert.deepEqual(seen.map((r: any) => r.email), [a], 'hanya PENDING yang berlaku milik tenant pemilik kode');
  assert.equal((await q({ userId: stranger }, 'SELECT 1 FROM tenant_join_requests')).length, 0, 'tanpa hash kode tidak ada yang terlihat');
  assert.equal((await q({ userId: stranger, joinHash: hash(oc) }, 'SELECT 1 FROM tenant_join_requests')).length, 1, 'kode tenant lain hanya membuka tenant itu');
  assert.equal((await q({ userId: stranger, joinHash: hash(c) }, `UPDATE tenant_join_requests SET status = 'REJECTED', decided_at = now() RETURNING id`)).length, 0, 'tidak dapat mengubah');
});

test('retensi: permintaan yang sudah diputuskan/kedaluwarsa lama dihapus; yang baru dan yang masih menunggu tetap; idempoten', { skip }, async () => {
  const o = await reg(); const c = await code(o);
  const emails = Array.from({ length: 5 }, () => `ret${++n}@x.test`);
  for (const e of emails) await apply(c, e);
  const rows = await pending(o);
  const id = (e: string) => rows.find((r: any) => r.email === e).id;
  await call('POST', `/team/join-requests/${id(emails[0])}/approve`, o.tok, { role: 'MEMBER' });  // diputuskan, akan dituakan
  await call('POST', `/team/join-requests/${id(emails[1])}/reject`, o.tok);                       // ditolak, akan dituakan
  await call('POST', `/team/join-requests/${id(emails[2])}/reject`, o.tok);                       // ditolak, tetap baru
  await q({ tenantId: o.tenantId }, `UPDATE tenant_join_requests SET decided_at = now() - interval '100 days' WHERE email = ANY($1)`, [[emails[0], emails[1]]]);
  await q({ tenantId: o.tenantId }, `UPDATE tenant_join_requests SET expires_at = now() - interval '100 days' WHERE email = $1`, [emails[3]]); // tertunda tetapi sudah lama kedaluwarsa
  const ret = createRetention(db, () => ({ contentDays: 30, rowDays: 180, outboxDays: 7, deliveryDays: 30, auditDays: 365, joinRequestDays: 90, batch: 10 }));
  assert.equal((await ret.runOnce()).joinRequestsDeleted, 3);
  const left = (await q({ tenantId: o.tenantId }, 'SELECT email FROM tenant_join_requests ORDER BY email')).map((r: any) => r.email);
  assert.deepEqual(left, [emails[2], emails[4]].sort(), 'tersisa: ditolak baru dan tertunda yang masih berlaku');
  assert.equal((await ret.runOnce()).joinRequestsDeleted, 0, 'idempoten');
  assert.equal((await q({ tenantId: o.tenantId }, 'SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND member_email = $2', [o.tenantId, emails[0]])).length, 1, 'keanggotaan hasil persetujuan tidak ikut terhapus');
});
