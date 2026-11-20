import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { extractIncoming, extractReceipt } = await import('../src/modules/whatsapp/baileys-adapter.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createChatService } = await import('../src/modules/chats/chats.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases, { retryBaseMs: 10, retryMaxMs: 40, random: () => 0 });
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const msgs = skip ? (null as any) : createMessageService(db);
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: svc, messages: msgs, chats: createChatService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const runtimes: any[] = [];
after(async () => { for (const r of runtimes) await r.crash().catch(() => {}); await app?.close(); await t?.drop(); });

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
async function newTenant() {
  const label = `i${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
const stopAll = () => db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));
async function newEngine() {
  await stopAll(); // engine dari tes lain masih HEALTHY dan bisa mengambil sesi baru
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: {
      nodeName: `ieng-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0 },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
async function connected(tn: any, e: any) {
  const s = await svc.create(tn.principal, { name: `is${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter');
  fake.open(`62${800000000 + n}`);
  await waitFor(async () => (await svc.get(tn.tenantId, s.id)).status === 'CONNECTED', 'CONNECTED');
  return { id: s.id as string, fake };
}
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const outbox = (tenantId: string, type: string) => q('SELECT payload FROM outbox_events WHERE tenant_id = $1 AND event_type = $2 ORDER BY created_at, id', [tenantId, type]);
const get = (tok: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: bearer(tok) });


// ---------- identitas chat: JID nomor vs LID (0018) ----------

const LID = (n: number) => `${100918964056000 + n}@lid`;
const chatsOf = (sessionId: string) => q('SELECT id, remote_jid, lid_jid, contact_phone, display_name FROM wa_chats WHERE session_id = $1 ORDER BY created_at, id', [sessionId]);
const msgsOf = (sessionId: string) => q('SELECT direction, body, chat_id FROM wa_messages WHERE session_id = $1 ORDER BY occurred_at, id', [sessionId]);
async function bareSession() { // sesi tanpa engine: resolve_chat hanya butuh baris wa_sessions
  const tn = await newTenant();
  const s = await svc.create(tn.principal, { name: `bs${++n}` });
  return { tn, id: s.id as string };
}
const resolve = (tn: any, sid: string, jid: string, phone: string | null, name: string | null = null) =>
  q('SELECT resolve_chat($1,$2,$3,$4,$5,now()) AS id', [tn.tenantId, sid, jid, phone, name]).then((r: any) => r[0].id as string);

test('0018 kasus nyata: pesan keluar (JID nomor) lalu balasan masuk (LID + nomor) => SATU chat', { skip }, async () => {
  const { tn, id } = await bareSession();
  const out = await resolve(tn, id, '6281913311558@s.whatsapp.net', '6281913311558');
  const inn = await resolve(tn, id, LID(1), '6281913311558', 'Mahri M');
  assert.equal(inn, out);
  const c = await chatsOf(id);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].remote_jid, c[0].lid_jid, c[0].contact_phone, c[0].display_name], ['6281913311558@s.whatsapp.net', LID(1), '6281913311558', 'Mahri M']);
});

test('0018: LID masuk lebih dahulu, lalu pesan keluar ke nomor itu => SATU chat dan JID kanonik = nomor', { skip }, async () => {
  const { tn, id } = await bareSession();
  const a = await resolve(tn, id, LID(2), '6285500009999', 'Budi');
  const b = await resolve(tn, id, '6285500009999@s.whatsapp.net', '6285500009999');
  assert.equal(a, b);
  const c = await chatsOf(id);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].remote_jid, c[0].lid_jid, c[0].display_name], ['6285500009999@s.whatsapp.net', LID(2), 'Budi'], 'nama tidak hilang oleh pesan keluar');
});

test('0018: LID tanpa nomor setelah pasangannya dikenal => chat yang sama (lewat lid_jid)', { skip }, async () => {
  const { tn, id } = await bareSession();
  const a = await resolve(tn, id, LID(3), '6285500001234');
  const b = await resolve(tn, id, LID(3), null);
  assert.equal(a, b);
  assert.equal((await chatsOf(id)).length, 1);
});

test('0018: LID tanpa pasangan tetap terpisah; begitu nomor diketahui => digabung, pesan dipindah tanpa hilang', { skip }, async () => {
  const { tn, id } = await bareSession();
  const lidOnly = await resolve(tn, id, LID(4), null, 'Siti');
  const phoneChat = await resolve(tn, id, '6285500004444@s.whatsapp.net', '6285500004444');
  assert.notEqual(lidOnly, phoneChat, 'tanpa bukti kesamaan jangan digabung');
  await q(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at)
           VALUES ($1,$2,$3,'IN','L1','text','dari lid','RECEIVED',now()), ($1,$2,$4,'OUT','P1','text','ke nomor','SENT',now())`, [tn.tenantId, id, lidOnly, phoneChat]);
  const merged = await resolve(tn, id, LID(4), '6285500004444');
  assert.equal(merged, phoneChat, 'kanonik = chat ber-JID nomor');
  const c = await chatsOf(id);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].lid_jid, c[0].display_name], [LID(4), 'Siti']);
  const m = await msgsOf(id);
  assert.equal(m.length, 2, 'tidak ada pesan hilang');
  assert.ok(m.every((x: any) => x.chat_id === phoneChat));
});

test('0018: kontak berbeda tidak pernah digabung; sesi berbeda tidak saling menggabung', { skip }, async () => {
  const a = await bareSession();
  const s2 = await svc.create(a.tn.principal, { name: `bs${++n}` });
  const c1 = await resolve(a.tn, a.id, '6285500005551@s.whatsapp.net', '6285500005551');
  const c2 = await resolve(a.tn, a.id, '6285500005552@s.whatsapp.net', '6285500005552');
  const c3 = await resolve(a.tn, s2.id, '6285500005551@s.whatsapp.net', '6285500005551');
  assert.equal(new Set([c1, c2, c3]).size, 3);
  assert.equal((await chatsOf(a.id)).length, 2);
});

test('0018: penulis paralel untuk kontak yang sama tidak membuat duplikat', { skip }, async () => {
  const { tn, id } = await bareSession();
  const ids = await Promise.all([
    resolve(tn, id, '6285500006666@s.whatsapp.net', '6285500006666'), resolve(tn, id, LID(6), '6285500006666', 'Rani'),
    resolve(tn, id, '6285500006666@s.whatsapp.net', '6285500006666'), resolve(tn, id, LID(6), '6285500006666'),
    resolve(tn, id, LID(6), null), resolve(tn, id, '6285500006666@s.whatsapp.net', '6285500006666'),
  ]);
  assert.equal(new Set(ids).size, 1);
  assert.equal((await chatsOf(id)).length, 1);
});

test('0018: duplikat lama (dibuat sebelum perbaikan) pulih pada penulisan berikutnya, riwayat utuh', { skip }, async () => {
  const { tn, id } = await bareSession();
  const mk = (jid: string, name: string | null) => q(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, display_name, last_message_at)
    VALUES ($1,$2,$3,'6285500007777',$4, now()) RETURNING id`, [tn.tenantId, id, jid, name]).then((r: any) => r[0].id as string);
  const phoneChat = await mk('6285500007777@s.whatsapp.net', null);
  const lidChat = await mk(LID(7), 'Mahri M'); // persis bentuk data yang ditemukan di staging
  await q(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at)
           VALUES ($1,$2,$3,'OUT','O1','text','test pesan','READ',now()), ($1,$2,$4,'IN','I1','text','Tes','RECEIVED',now())`, [tn.tenantId, id, phoneChat, lidChat]);
  const r = await resolve(tn, id, LID(7), '6285500007777');
  assert.equal(r, phoneChat);
  const c = await chatsOf(id);
  assert.equal(c.length, 1);
  assert.equal(c[0].display_name, 'Mahri M');
  assert.equal((await msgsOf(id)).length, 2);
});

test('0018 E2E: kirim lewat gateway lalu balasan datang dengan LID => API /chats menampilkan SATU chat berisi kedua pesan', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const m = await msgs.send(tn.principal, { sessionId: s.id, to: '6281913311558', text: 'test pesan', priority: 5 });
  await waitFor(async () => (await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status === 'SENT', 'SENT');
  s.fake.incoming({ providerMessageId: 'LID-1', jid: LID(9), phone: '6281913311558', pushName: 'Mahri M', text: 'Tes' });
  s.fake.incoming({ providerMessageId: 'LID-2', jid: LID(9), phone: '6281913311558', text: 'Oke' });
  await waitFor(async () => (await q(`SELECT 1 FROM wa_messages WHERE session_id = $1 AND direction = 'IN'`, [s.id])).length === 2, 'dua balasan');
  const chats = (await get(tn.tok, '/chats')).json();
  assert.equal(chats.meta.total, 1, 'satu nomor = satu chat');
  assert.equal(chats.data[0].name, 'Mahri M');
  const hist = (await get(tn.tok, `/chats/${chats.data[0].id}/messages`)).json();
  assert.deepEqual(hist.data.map((x: any) => [x.direction, x.text]).sort(), [['IN', 'Oke'], ['IN', 'Tes'], ['OUT', 'test pesan']]);
  s.fake.incoming({ providerMessageId: 'LID-3', jid: LID(9), text: 'tanpa nomor' }); // LID tanpa pasangan nomor pada pesan ini
  await waitFor(async () => (await q(`SELECT 1 FROM wa_messages WHERE session_id = $1 AND direction = 'IN'`, [s.id])).length === 3, 'pesan ketiga');
  assert.equal((await chatsOf(s.id)).length, 1, 'lid_jid yang tersimpan mengenali kontak walau pesan tanpa nomor');
});
