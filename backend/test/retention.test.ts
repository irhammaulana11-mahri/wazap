import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createChatService } = await import('../src/modules/chats/chats.service.js');
const { createRetention, defaultPolicy } = await import('../src/modules/engine/retention.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const msgs = skip ? (null as any) : createMessageService(db, { mediaPolicy: { allowHttp: true, allowPrivate: true } });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: svc, messages: msgs, chats: createChatService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const POLICY = { contentDays: 30, rowDays: 180, outboxDays: 7, deliveryDays: 30, batch: 10 };
const ret = skip ? (null as any) : createRetention(db, () => POLICY);
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
async function newTenant() {
  const label = `rt${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const sess = async (tn: any) => (await svc.create(tn.principal, { name: `rts${++n}`, autoConnect: true })).id as string;
/** Job dalam status akhir `status`, selesai `ageDays` hari lalu. */
async function job(tn: any, sid: string, o: { status?: string; ageDays: number; to?: string; text?: string; media?: boolean }) {
  const to = o.to ?? '6281234567890';
  const m = o.media
    ? await msgs.sendMedia(tn.principal, { sessionId: sid, to, type: 'image', url: 'http://127.0.0.1:9/x.png', caption: 'cap rahasia', priority: 5 })
    : await msgs.send(tn.principal, { sessionId: sid, to, text: o.text ?? 'isi rahasia', priority: 5 });
  const st = o.status ?? 'SENT';
  if (st !== 'PENDING') {
    await q(`UPDATE message_queue SET status = $2::varchar, provider_message_id = CASE WHEN $2::varchar IN ('SENT','DELIVERED','READ') THEN $3::varchar ELSE NULL END WHERE id = $1`, [m.job_id, st, 'PM-' + crypto.randomUUID().slice(0, 8)]);
    await q(`UPDATE message_queue SET completed_at = now() - make_interval(days => $2) WHERE id = $1`, [m.job_id, o.ageDays]);
  }
  return m.job_id as string;
}
const row = async (id: string) => (await q('SELECT status, recipient, payload, content_purged_at, completed_at FROM message_queue WHERE id = $1', [id]))[0];

test('policy: ROW_DAYS < CONTENT_DAYS ditolak; default env sesuai keputusan (30/180/7/30)', async () => {
  await assert.rejects(createRetention(db ?? ({} as any), () => ({ ...POLICY, rowDays: 10 })).runOnce(), /RETENTION_ROW_DAYS/);
  const d = defaultPolicy();
  assert.deepEqual([d.contentDays, d.rowDays, d.outboxDays, d.deliveryDays], [30, 180, 7, 30]);
});

test('antrean: isi dihapus & nomor dimasker setelah 30 hari; status/aktif tidak tersentuh; idempoten', { skip }, async () => {
  const tn = await newTenant(); const sid = await sess(tn);
  const old = await job(tn, sid, { ageDays: 31, text: 'rahasia lama' });
  const oldFailed = await job(tn, sid, { ageDays: 40, status: 'FAILED', to: '6289999999999' });
  const oldUnknown = await job(tn, sid, { ageDays: 35, status: 'UNKNOWN' });
  const fresh = await job(tn, sid, { ageDays: 29 });
  const today = await job(tn, sid, { ageDays: 0 });
  const pending = await job(tn, sid, { ageDays: 0, status: 'PENDING' });
  await q(`UPDATE message_queue SET scheduled_at = now() - interval '90 days' WHERE id = $1`, [pending]); // antre sangat lama, belum final
  const media = await job(tn, sid, { ageDays: 32, media: true });

  const r1 = await ret.runOnce();
  assert.ok(r1.contentPurged >= 4);
  for (const id of [old, oldFailed, oldUnknown, media]) assert.notEqual((await row(id)).content_purged_at, null, id);
  const o = await row(old);
  assert.deepEqual(o.payload, { text: '' });
  assert.equal(o.recipient, '*********7890', 'panjang dipertahankan, 4 digit terakhir terlihat');
  assert.equal((await row(oldFailed)).recipient, '*********9999');
  assert.equal(o.status, 'SENT', 'status tidak berubah');
  assert.deepEqual((await row(media)).payload, { url: '[purged]' });
  for (const id of [fresh, today, pending]) { const r = await row(id); assert.equal(r.content_purged_at, null); assert.equal(r.recipient, '6281234567890'); }
  assert.equal((await row(pending)).payload.text, 'isi rahasia');

  const r2 = await ret.runOnce();
  assert.equal(r2.contentPurged, 0, 'idempoten'); assert.equal(r2.rowsDeleted, 0);

  // API: isi tidak lagi dikembalikan; retry ditolak
  const v = (await app.inject({ url: `/api/v1/messages/${old}`, headers: bearer(tn.tok) })).json().data;
  assert.deepEqual([v.message, v.content_purged, v.to], [null, true, '*********7890']);
  const mv = (await app.inject({ url: `/api/v1/messages/${media}`, headers: bearer(tn.tok) })).json().data;
  assert.deepEqual([mv.message, mv.media, mv.content_purged], [null, null, true]);
  const rr = await app.inject({ method: 'POST', url: `/api/v1/messages/${oldUnknown}/retry`, headers: bearer(tn.tok), payload: { confirm_duplicate_risk: true } });
  assert.equal(rr.statusCode, 409); assert.equal(rr.json().error.code, 'CONTENT_PURGED');
  const fv = (await app.inject({ url: `/api/v1/messages/${fresh}`, headers: bearer(tn.tok) })).json().data;
  assert.deepEqual([fv.message, fv.content_purged], ['isi rahasia', false]);
});

test('antrean: baris dihapus setelah 180 hari beserta riwayat percobaan; yang lebih muda tetap', { skip }, async () => {
  const tn = await newTenant(); const sid = await sess(tn);
  const ancient = await job(tn, sid, { ageDays: 200 });
  const mid = await job(tn, sid, { ageDays: 100 });
  await q(`INSERT INTO message_attempts (tenant_id, job_id, attempt_number, outcome) VALUES ($1,$2,1,'SENT')`, [tn.tenantId, ancient]);
  const r = await ret.runOnce();
  assert.ok(r.rowsDeleted >= 1);
  assert.equal((await q('SELECT 1 FROM message_queue WHERE id = $1', [ancient])).length, 0);
  assert.equal((await q('SELECT 1 FROM message_attempts WHERE job_id = $1', [ancient])).length, 0, 'percobaan ikut terhapus');
  assert.equal((await row(mid)).content_purged_at !== null, true, 'berusia 100 hari: terhapus isinya, barisnya masih ada');
});

test('riwayat chat: isi dihapus 30 hari, baris 180 hari, chat kosong dibersihkan; chat aktif dipertahankan', { skip }, async () => {
  const tn = await newTenant(); const sid = await sess(tn);
  const chat = async (jid: string, lastDays: number) => (await q(
    `INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at) VALUES ($1,$2,$3,$4, now() - make_interval(days => $5)) RETURNING id`,
    [tn.tenantId, sid, jid, jid.split('@')[0], lastDays]))[0].id as string;
  const msg = async (chatId: string, ageDays: number, body = 'isi chat') => (await q(
    `INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at, created_at)
     VALUES ($1,$2,$3,'IN',$4,'text',$5,'RECEIVED', now() - make_interval(days => $6), now() - make_interval(days => $6)) RETURNING id`,
    [tn.tenantId, sid, chatId, 'P-' + crypto.randomUUID().slice(0, 8), body, ageDays]))[0].id as string;
  const active = await chat('6285000000001@s.whatsapp.net', 1);
  const mFresh = await msg(active, 1); const mOld = await msg(active, 31); const mAncient = await msg(active, 200);
  const dead = await chat('6285000000002@s.whatsapp.net', 250);
  await msg(dead, 250);
  const empty = await chat('6285000000003@s.whatsapp.net', 250);
  const recentEmpty = await chat('6285000000004@s.whatsapp.net', 10);

  const r = await ret.runOnce();
  assert.ok(r.historyPurged >= 1 && r.historyDeleted >= 2 && r.chatsDeleted >= 2);
  const body = async (id: string) => (await q('SELECT body, body_purged_at FROM wa_messages WHERE id = $1', [id]))[0];
  assert.equal((await body(mFresh)).body, 'isi chat');
  const old = await body(mOld); assert.deepEqual([old.body, old.body_purged_at !== null], [null, true]);
  assert.equal((await q('SELECT 1 FROM wa_messages WHERE id = $1', [mAncient])).length, 0);
  assert.equal((await q('SELECT 1 FROM wa_chats WHERE id = $1', [active])).length, 1, 'chat aktif tetap');
  assert.equal((await q('SELECT 1 FROM wa_chats WHERE id = $1', [dead])).length, 0, 'chat yang semua pesannya kedaluwarsa dihapus');
  assert.equal((await q('SELECT 1 FROM wa_chats WHERE id = $1', [empty])).length, 0);
  assert.equal((await q('SELECT 1 FROM wa_chats WHERE id = $1', [recentEmpty])).length, 1, 'chat baru tanpa pesan belum dihapus');
  const hist = (await app.inject({ url: `/api/v1/chats/${active}/messages`, headers: bearer(tn.tok) })).json();
  assert.deepEqual(hist.data.map((m: any) => [m.text, m.text_purged]), [['isi chat', false], [null, true]]);
});

test('integrasi: outbox DISPATCHED > 7 hari & delivery selesai > 30 hari dihapus; PENDING tidak pernah', { skip }, async () => {
  const tn = await newTenant();
  const ev = async (status: string, ageDays: number) => (await q(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, status, created_at, dispatched_at)
     VALUES ($1,'message',$2,'message.sent','{}', $3::varchar, now() - make_interval(days => $4), CASE WHEN $3::varchar = 'DISPATCHED' THEN now() - make_interval(days => $4) END) RETURNING id`,
    [tn.tenantId, crypto.randomUUID(), status, ageDays]))[0].id as string;
  const oldDone = await ev('DISPATCHED', 8); const freshDone = await ev('DISPATCHED', 6); const oldPending = await ev('PENDING', 90);
  const has = async (id: string) => (await q('SELECT 1 FROM outbox_events WHERE id = $1', [id])).length === 1;

  const ep = (await q(`INSERT INTO webhook_endpoints (tenant_id, url, secret_ciphertext, secret_key_version, secret_hint) VALUES ($1,'http://127.0.0.1:9/h','\\x00',1,'abcd') RETURNING id`, [tn.tenantId]))[0].id as string;
  const dl = async (status: string, ageDays: number) => (await q(
    `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status, created_at)
     VALUES ($1,$2,gen_random_uuid(),'message.incoming','{"data":{"text":"rahasia"}}', $3, now() - make_interval(days => $4)) RETURNING id`,
    [tn.tenantId, ep, status, ageDays]))[0].id as string;
  const dOld = await dl('DELIVERED', 31); const dDead = await dl('DEAD', 45); const dFresh = await dl('DELIVERED', 29); const dPend = await dl('PENDING', 60);
  await q(`INSERT INTO webhook_delivery_attempts (tenant_id, delivery_id, attempt_number, outcome) VALUES ($1,$2,1,'DELIVERED')`, [tn.tenantId, dOld]);
  const hasD = async (id: string) => (await q('SELECT 1 FROM webhook_deliveries WHERE id = $1', [id])).length === 1;

  const r = await ret.runOnce();
  assert.ok(r.outboxDeleted >= 1 && r.deliveriesDeleted >= 2);
  assert.deepEqual([await has(oldDone), await has(freshDone), await has(oldPending)], [false, true, true]);
  assert.deepEqual([await hasD(dOld), await hasD(dDead), await hasD(dFresh), await hasD(dPend)], [false, false, true, true]);
  assert.equal((await q('SELECT 1 FROM webhook_delivery_attempts WHERE delivery_id = $1', [dOld])).length, 0, 'attempt ikut terhapus');
});

test('batch kecil + banyak baris: semua terproses dalam satu putaran; dua penyapu paralel tidak bentrok', { skip }, async () => {
  const tn = await newTenant(); const sid = await sess(tn);
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push(await job(tn, sid, { ageDays: 31, to: `62811000${String(10000 + i)}` }));
  const [a, b] = await Promise.all([ret.runOnce(), ret.runOnce()]);
  assert.equal(a.contentPurged + b.contentPurged >= 25, true);
  const left = (await q(`SELECT count(*)::int n FROM message_queue WHERE id = ANY($1::uuid[]) AND content_purged_at IS NULL`, [ids]))[0].n;
  assert.equal(left, 0);
  const masked = await q(`SELECT recipient FROM message_queue WHERE id = ANY($1::uuid[])`, [ids]);
  assert.ok(masked.every((m: any) => /^\*{9}\d{4}$/.test(m.recipient)));
});

test('constraint: nomor termasker hanya sah bila format tepat; tenant tidak dapat menghapus/mengubah via RLS', { skip }, async () => {
  const tn = await newTenant(); const sid = await sess(tn);
  const id = await job(tn, sid, { ageDays: 0 });
  await assert.rejects(q(`UPDATE message_queue SET recipient = '**1234' WHERE id = $1`, [id]), /message_queue_recipient_check/);
  await assert.rejects(q(`UPDATE message_queue SET recipient = 'abc' WHERE id = $1`, [id]), /message_queue_recipient_check/);
  await assert.rejects(q(`UPDATE message_queue SET content_purged_at = now(), completed_at = NULL WHERE id = $1`, [id]), /purge_consistency|status_check|check/);
});
