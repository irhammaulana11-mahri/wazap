import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createUsageService, resolveRange, validTimeZone } = await import('../src/modules/usage/usage.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { config } = await import('../src/config/env.js');

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);
const app = skip ? (null as any) : buildApp({
  identity, usage: createUsageService(db), messages: createMessageService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (url: string, tok?: string, headers: any = {}) => {
  const r = await app.inject({ url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers } });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body };
};
async function reg() {
  const email = `us${++n}@x.test`;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: PW, tenant_name: `Usage ${n}` } });
  const d = r.json().data;
  return { tok: d.access_token as string, tenantId: d.tenant.id as string, userId: d.user.id as string, email };
}
const Z = (s: string) => `${s}Z`;

interface Seeded { A: Awaited<ReturnType<typeof reg>>; s1: string; s2: string }
let seeded: Seeded | undefined;
/** Data dengan batas yang disengaja tajam (tengah malam UTC dan Asia/Jakarta, batas eksklusif). Tenant A. */
async function seed(): Promise<Seeded> {
  if (seeded) return seeded;
  const A = await reg();
  const ses = async (name: string, status: string) => (await q(`INSERT INTO wa_sessions (tenant_id, session_name, status, desired_state) VALUES ($1,$2,$3,'CONNECTED') RETURNING id`, [A.tenantId, name, status]))[0].id as string;
  const s1 = await ses('s1', 'CONNECTED'); const s2 = await ses('s2', 'DISCONNECTED');
  const out = (sid: string, at: string, status: string) => q(
    `INSERT INTO message_queue (tenant_id, session_id, recipient, payload, status, created_at, scheduled_at, completed_at, actor)
     VALUES ($1,$2,'6281234567890','{"text":"x"}', $3::varchar, $4::timestamptz, $4::timestamptz, CASE WHEN $3::varchar = 'PENDING' THEN NULL ELSE $4::timestamptz END, 'SYSTEM')`, [A.tenantId, sid, status, at]);
  // dalam rentang utama [2026-11-10T00:00Z, 2026-11-13T00:00Z)
  await out(s1, Z('2026-11-10T05:00:00'), 'SENT'); await out(s1, Z('2026-11-10T05:30:00'), 'DELIVERED'); await out(s1, Z('2026-11-10T23:30:00'), 'READ');
  await out(s2, Z('2026-11-11T00:30:00'), 'FAILED'); await out(s1, Z('2026-11-11T12:00:00'), 'PENDING');
  await out(s2, Z('2026-11-12T10:00:00'), 'UNKNOWN'); await out(s1, Z('2026-11-12T22:00:00'), 'CANCELLED');
  // di luar rentang: 1 detik sebelum from, dan tepat pada to (eksklusif)
  await out(s1, Z('2026-11-09T23:59:59'), 'SENT'); await out(s1, Z('2026-11-13T00:00:00'), 'SENT');
  const chat = async (sid: string, jid: string) => (await q(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone) VALUES ($1,$2,$3,'62855') RETURNING id`, [A.tenantId, sid, jid]))[0].id as string;
  const c1 = await chat(s1, '6285500000001@s.whatsapp.net'); const c2 = await chat(s2, '6285500000002@s.whatsapp.net');
  const inc = (sid: string, cid: string, at: string, dir = 'IN') => q(
    `INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at, created_at)
     VALUES ($1,$2,$3,$4::varchar,$5,'text','x', CASE WHEN $4::varchar = 'IN' THEN 'RECEIVED' ELSE 'SENT' END, $6::timestamptz, $6::timestamptz)`, [A.tenantId, sid, cid, dir, 'W' + crypto.randomUUID(), at]);
  await inc(s1, c1, Z('2026-11-10T06:00:00')); await inc(s1, c1, Z('2026-11-11T07:00:00')); await inc(s2, c2, Z('2026-11-12T08:00:00'));
  await inc(s1, c1, Z('2026-11-13T01:00:00'));                 // masuk di luar rentang
  await inc(s1, c1, Z('2026-11-10T09:00:00'), 'OUT');          // keluar di wa_messages: BUKAN pesan masuk
  return (seeded = { A, s1, s2 });
}
const RANGE = 'from=2026-11-10T00:00:00Z&to=2026-11-13T00:00:00Z';

// ---------- unit ----------

test('resolveRange: default 24 jam, batas 92 hari, from < to; validTimeZone', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  const d = resolveRange({}, now);
  assert.deepEqual([d.from.toISOString(), d.to.toISOString()], ['2026-11-18T10:00:00.000Z', '2026-11-19T10:00:00.000Z']);
  assert.equal(resolveRange({ to: '2026-11-10T00:00:00Z' }, now).from.toISOString(), '2026-11-09T00:00:00.000Z');
  assert.throws(() => resolveRange({ from: '2026-11-19T00:00:00Z', to: '2026-11-19T00:00:00Z' }), (e: any) => e.code === 'INVALID_RANGE');
  assert.throws(() => resolveRange({ from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' }), (e: any) => e.code === 'INVALID_RANGE');
  assert.doesNotThrow(() => resolveRange({ from: '2026-08-19T00:00:00Z', to: '2026-11-19T00:00:00Z' })); // tepat 92 hari
  assert.throws(() => resolveRange({ from: '2026-08-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }), (e: any) => e.code === 'INVALID_RANGE');
  assert.equal(validTimeZone('Asia/Jakarta'), true); assert.equal(validTimeZone('UTC'), true);
  assert.equal(validTimeZone('Mars/Phobos'), false); assert.equal(validTimeZone("'; DROP TABLE x;--"), false);
});

// ---------- ringkasan ----------

test('summary: hitungan per status, turunan, masuk, snapshot sesi/antrean, kuota; batas rentang inklusif-eksklusif', { skip }, async () => {
  const { A } = await seed();
  await call('/api-keys', A.tok); // pastikan route lain tak mengganggu
  const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { authorization: `Bearer ${A.tok}` }, payload: { name: 'kunci-uji', scopes: ['usage:read'] } });
  assert.equal(key.statusCode, 201);
  const r = await call(`/usage/summary?${RANGE}`, A.tok);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.deepEqual(d.period, { from: '2026-11-10T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' });
  assert.deepEqual(d.messages.by_status, { SENT: 1, DELIVERED: 1, READ: 1, FAILED: 1, PENDING: 1, UNKNOWN: 1, CANCELLED: 1 });
  assert.deepEqual([d.messages.total, d.messages.sent, d.messages.delivered, d.messages.read, d.messages.failed, d.messages.unknown, d.messages.cancelled], [7, 3, 2, 1, 1, 1, 1],
    'sent mencakup DELIVERED/READ; baris pada tepat `to` dan 1 detik sebelum `from` tidak ikut');
  assert.equal(d.incoming.total, 3, 'hanya direction IN dalam rentang');
  assert.deepEqual(d.sessions, { total: 2, connected: 1, by_status: { CONNECTED: 1, DISCONNECTED: 1 } });
  assert.deepEqual(d.queue, { pending: 1, processing: 0 });
  assert.deepEqual(d.quotas, {
    sessions: { used: 2, max: 3 }, api_keys: { used: 1, max: 20 }, members: { used: 1, max: 10 },
    webhooks: { used: 0, max: config.WEBHOOK_MAX_ENDPOINTS }, messages_per_minute: 60,
  });
  // offset zona waktu pada query setara dengan UTC
  const off = await call(`/usage/summary?from=2026-11-10T07:00:00%2B07:00&to=2026-11-13T07:00:00%2B07:00`, A.tok);
  assert.deepEqual(off.body.data.messages.by_status, d.messages.by_status);
  // rentang kosong -> nol, bentuk tetap
  const empty = await call(`/usage/summary?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`, A.tok);
  assert.deepEqual([empty.body.data.messages.total, empty.body.data.messages.by_status, empty.body.data.incoming.total], [0, {}, 0]);
});

test('summary: default = 24 jam terakhir; hanya data tenant sendiri; kuota tenant lain terpisah', { skip }, async () => {
  const { A, s1 } = await seed();
  await q(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, status, created_at, completed_at, actor) VALUES ($1,$2,'6281234567890','{"text":"x"}','SENT', now() - interval '1 hour', now(), 'SYSTEM')`, [A.tenantId, s1]);
  await q(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, status, created_at, completed_at, actor) VALUES ($1,$2,'6281234567890','{"text":"x"}','SENT', now() - interval '3 days', now(), 'SYSTEM')`, [A.tenantId, s1]);
  const def = await call('/usage/summary', A.tok);
  assert.equal(def.body.data.messages.total, 1, 'hanya yang dalam 24 jam terakhir');
  const B = await reg();
  const b = (await call(`/usage/summary?${RANGE}`, B.tok)).body.data;
  assert.deepEqual([b.messages.total, b.incoming.total, b.sessions.total, b.quotas.sessions.used, b.quotas.members.used], [0, 0, 0, 0, 1]);
});

// ---------- deret waktu ----------

test('deret harian UTC: bucket terisi nol bila kosong, jumlah benar, meta lengkap', { skip }, async () => {
  const { A } = await seed();
  const r = await call(`/usage/messages?${RANGE}&group_by=day`, A.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.meta, { from: '2026-11-10T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z', group_by: 'day', tz: 'UTC' });
  assert.deepEqual(r.body.data, [
    { bucket: '2026-11-10T00:00:00.000Z', total: 3, sent: 3, delivered: 2, read: 1, failed: 0, incoming: 1 },
    { bucket: '2026-11-11T00:00:00.000Z', total: 2, sent: 0, delivered: 0, read: 0, failed: 1, incoming: 1 },
    { bucket: '2026-11-12T00:00:00.000Z', total: 2, sent: 0, delivered: 0, read: 0, failed: 0, incoming: 1 },
  ]);
  const gap = await call(`/usage/messages?from=2025-01-01T00:00:00Z&to=2025-01-04T00:00:00Z&group_by=day`, A.tok); // jauh dari data seed mana pun
  assert.equal(gap.body.data.length, 3); assert.ok(gap.body.data.every((x: any) => x.total === 0 && x.incoming === 0), 'bucket kosong tetap ada (siap digambar)');
});

test('deret harian Asia/Jakarta: hari mengikuti zona waktu; bucket diberi stempel instan awal hari lokal', { skip }, async () => {
  const { A } = await seed();
  const r = await call(`/usage/messages?${RANGE}&group_by=day&tz=Asia/Jakarta`, A.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((x: any) => [x.bucket, x.total, x.incoming]), [
    ['2026-11-09T17:00:00.000Z', 2, 1],   // 10 Nov lokal: 12:00 SENT, 12:30 DELIVERED; masuk 13:00
    ['2026-11-10T17:00:00.000Z', 3, 1],   // 11 Nov lokal: 06:30 READ, 07:30 FAILED, 19:00 PENDING; masuk 14:00
    ['2026-11-11T17:00:00.000Z', 1, 1],   // 12 Nov lokal: 17:00 UNKNOWN; masuk 15:00
    ['2026-11-12T17:00:00.000Z', 1, 0],   // 13 Nov lokal: 05:00 CANCELLED
  ]);
  const total = r.body.data.reduce((a: number, x: any) => a + x.total, 0);
  assert.equal(total, 7, 'jumlah seluruh bucket = jumlah pesan dalam rentang (tidak ada yang hilang/ganda)');
  // tepat di tengah malam lokal: 16:59:59Z (23:59:59 lokal) vs 17:00:00Z (00:00:00 lokal berikutnya)
  const E = await reg();
  const sid = (await q(`INSERT INTO wa_sessions (tenant_id, session_name, status, desired_state) VALUES ($1,'ee','CONNECTED','CONNECTED') RETURNING id`, [E.tenantId]))[0].id;
  for (const at of ['2026-11-18T16:59:59Z', '2026-11-18T17:00:00Z']) {
    await q(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, status, created_at, completed_at, actor) VALUES ($1,$2,'6281234567890','{"text":"x"}','SENT',$3::timestamptz,$3::timestamptz,'SYSTEM')`, [E.tenantId, sid, at]);
  }
  const edge = await call(`/usage/messages?from=2026-11-18T00:00:00Z&to=2026-11-19T12:00:00Z&group_by=day&tz=Asia/Jakarta`, E.tok);
  const nz = edge.body.data.filter((x: any) => x.total > 0).map((x: any) => [x.bucket, x.total]);
  assert.deepEqual(nz, [['2026-11-17T17:00:00.000Z', 1], ['2026-11-18T17:00:00.000Z', 1]], 'dua pesan berbeda hari lokal');
});

test('deret per jam, filter sesi, dan validasi parameter', { skip }, async () => {
  const { A, s1, s2 } = await seed();
  const h = await call(`/usage/messages?from=2026-11-10T04:00:00Z&to=2026-11-10T07:00:00Z&group_by=hour`, A.tok);
  assert.deepEqual(h.body.data.map((x: any) => [x.bucket, x.total, x.incoming]), [
    ['2026-11-10T04:00:00.000Z', 0, 0], ['2026-11-10T05:00:00.000Z', 2, 0], ['2026-11-10T06:00:00.000Z', 0, 1]]);
  const only2 = await call(`/usage/messages?${RANGE}&group_by=day&session_id=${s2}`, A.tok);
  assert.deepEqual(only2.body.data.map((x: any) => [x.total, x.failed, x.incoming]), [[0, 0, 0], [1, 1, 0], [1, 0, 1]]);
  const foreign = await call(`/usage/messages?${RANGE}&group_by=day&session_id=${crypto.randomUUID()}`, A.tok);
  assert.ok(foreign.body.data.every((x: any) => x.total === 0), 'sesi tak dikenal = nol, bukan galat/kebocoran');
  void s1;
  const bad = async (qs: string, code?: string) => { const r = await call(`/usage/messages?${qs}`, A.tok); assert.equal(r.status, 400, qs); if (code) assert.equal(r.body.error.code, code, qs); };
  await bad(`${RANGE}&group_by=week`);
  await bad(`${RANGE}&tz=Mars/Phobos`, 'VALIDATION_ERROR');
  await bad(`${RANGE}&tz=${encodeURIComponent("x'; select 1;--")}`);
  await bad(`from=2026-11-10T00:00:00Z&to=2026-11-10T00:00:00Z`, 'INVALID_RANGE');
  await bad(`from=2026-11-12T00:00:00Z&to=2026-11-10T00:00:00Z`, 'INVALID_RANGE');
  await bad(`from=2026-08-01T00:00:00Z&to=2026-11-19T00:00:00Z`, 'INVALID_RANGE');
  await bad(`from=2026-11-01T00:00:00Z&to=2026-11-10T00:00:00Z&group_by=hour`, 'INVALID_RANGE');
  await bad(`from=kemarin&to=2026-11-10T00:00:00Z`);
  await bad(`${RANGE}&session_id=bukan-uuid`);
  assert.equal((await call(`/usage/messages?from=2026-11-10T00:00:00Z&to=2026-11-10T00:00:00Z`, undefined)).status, 401);
});

// ---------- per sesi ----------

test('usage per sesi: keluar, gagal, masuk per sesi; sesi DELETED tidak muncul', { skip }, async () => {
  const { A, s1, s2 } = await seed();
  const r = await call(`/usage/sessions?${RANGE}`, A.tok);
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.data.map((x: any) => [x.session_id, x]));
  assert.deepEqual([by[s1].session_name, by[s1].status, by[s1].outgoing, by[s1].failed, by[s1].incoming], ['s1', 'CONNECTED', 5, 0, 2]);
  assert.deepEqual([by[s2].session_name, by[s2].outgoing, by[s2].failed, by[s2].incoming], ['s2', 2, 1, 1]);
  const D = await reg();
  const del = (await q(`INSERT INTO wa_sessions (tenant_id, session_name, status, desired_state, deleted_at) VALUES ($1,'hapus','DELETED','DISCONNECTED', now()) RETURNING id`, [D.tenantId]))[0].id;
  const dr = await call(`/usage/sessions?${RANGE}`, D.tok);
  assert.ok(!dr.body.data.some((x: any) => x.session_id === del));
});

// ---------- otorisasi ----------

test('otorisasi: semua peran dashboard boleh baca; API key butuh usage:read; tanpa token 401', { skip }, async () => {
  const { A } = await seed();
  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { authorization: `Bearer ${A.tok}` }, payload: { name: 'k' + ++n + '-uji', scopes } })).json().data.key as string;
  const okKey = await mk(['usage:read']); const noKey = await mk(['messages:read', 'sessions:read']);
  for (const path of ['/usage/summary', '/usage/messages', '/usage/sessions']) {
    assert.equal((await call(`${path}?${RANGE}`, undefined, { 'x-api-key': okKey })).status, 200, path);
    assert.equal((await call(`${path}?${RANGE}`, undefined, { 'x-api-key': noKey })).status, 403, path);
    assert.equal((await call(`${path}?${RANGE}`)).status, 401, path);
  }
  // VIEWER
  const v = await reg();
  await db.tx({ tenantId: A.tenantId }, (c: any) => c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,'VIEWER',$3)`, [A.tenantId, v.userId, v.email]));
  const vtok = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: v.email, password: PW, tenant_id: A.tenantId } })).json().data.access_token;
  assert.equal((await call(`/usage/summary?${RANGE}`, vtok)).status, 200);
});

// ---------- filter tanggal pada GET /messages ----------

test('GET /messages?from&to: from inklusif, to eksklusif, offset zona waktu, kombinasi filter, validasi', { skip }, async () => {
  const { A, s2 } = await seed();
  const list = async (qs: string) => { const r = await call(`/messages?${qs}`, A.tok); return r; };
  const all = await list(`${RANGE}&page_size=50`);
  assert.equal(all.body.meta.total, 7); assert.equal(all.body.data.length, 7);
  assert.ok(all.body.data.every((m: any) => m.created_at >= '2026-11-10T00:00:00.000Z' && m.created_at < '2026-11-13T00:00:00.000Z'));
  // batas: tepat pada from ikut; tepat pada to tidak
  assert.equal((await list('from=2026-11-13T00:00:00Z')).body.meta.total >= 1, true, 'from inklusif (baris tepat 2026-11-13T00:00Z ikut)');
  assert.equal((await list('to=2026-11-10T05:00:00Z&from=2026-11-10T00:00:00Z')).body.meta.total, 0, 'to eksklusif (baris tepat 05:00Z tidak ikut)');
  assert.equal((await list('from=2026-11-10T05:00:00Z&to=2026-11-10T05:00:01Z')).body.meta.total, 1);
  // offset zona waktu
  const wib = await list('from=2026-11-10T07:00:00%2B07:00&to=2026-11-13T07:00:00%2B07:00');
  assert.equal(wib.body.meta.total, 7);
  // kombinasi
  assert.equal((await list(`${RANGE}&status=FAILED`)).body.meta.total, 1);
  assert.equal((await list(`${RANGE}&session_id=${s2}`)).body.meta.total, 2);
  // hanya from / hanya to
  assert.equal((await list('to=2026-11-10T00:00:00Z')).body.meta.total, 1, 'satu baris sebelum 10 Nov (23:59:59 tanggal 9)');
  // paginasi tetap benar dalam filter
  const p2 = await list(`${RANGE}&page=2&page_size=3`);
  assert.deepEqual([p2.body.data.length, p2.body.meta.total], [3, 7]);
  // validasi
  for (const qs of ['from=2026-11-13T00:00:00Z&to=2026-11-10T00:00:00Z', 'from=2026-11-10T00:00:00Z&to=2026-11-10T00:00:00Z', 'from=kemarin', 'to=2026-13-45T00:00:00Z', 'from=2026-11-10']) {
    assert.equal((await list(qs)).status, 400, qs);
  }
  // tenant lain tidak melihat apa pun
  const B = await reg();
  assert.equal((await call(`/messages?${RANGE}`, B.tok)).body.meta.total, 0);
});
