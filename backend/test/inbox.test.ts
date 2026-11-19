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

// ---------- ekstraksi (murni) ----------

const key = (o: any = {}) => ({ id: 'ABC1', remoteJid: '6281234567890@s.whatsapp.net', fromMe: false, ...o });
test('extractIncoming: tipe pesan, caption, nomor telepon, timestamp, pemotongan', () => {
  const text = extractIncoming({ key: key(), message: { conversation: 'halo' }, messageTimestamp: 1_700_000_000, pushName: 'Budi' } as any)!;
  assert.deepEqual([text.type, text.text, text.phone, text.pushName, text.timestamp.getTime()], ['text', 'halo', '6281234567890', 'Budi', 1_700_000_000_000]);
  assert.equal(extractIncoming({ key: key(), message: { extendedTextMessage: { text: 'balasan' } } } as any)!.text, 'balasan');
  const img = extractIncoming({ key: key(), message: { imageMessage: { caption: 'lihat' } } } as any)!;
  assert.deepEqual([img.type, img.text], ['image', 'lihat']);
  assert.equal(extractIncoming({ key: key(), message: { audioMessage: {} } } as any)!.type, 'audio');
  assert.equal(extractIncoming({ key: key(), message: { stickerMessage: {} } } as any)!.type, 'sticker');
  assert.equal(extractIncoming({ key: key(), message: { locationMessage: {} } } as any)!.type, 'location');
  assert.equal(extractIncoming({ key: key(), message: { ephemeralMessage: { message: { conversation: 'sementara' } } } } as any)!.text, 'sementara');
  assert.equal(extractIncoming({ key: key(), message: { conversation: 'x'.repeat(40_000) } } as any)!.text!.length, 16_384);
  assert.equal(extractIncoming({ key: key(), message: { conversation: 'a' }, messageTimestamp: Long0() } as any)!.timestamp instanceof Date, true);
});
function Long0() { return { toNumber: () => 0, valueOf: () => 0 }; }

test('extractIncoming: pesan sendiri, grup, status, broadcast, newsletter, sistem, tanpa id/isi => diabaikan', () => {
  const none = (m: any) => assert.equal(extractIncoming(m), null);
  none({ key: key({ fromMe: true }), message: { conversation: 'a' } });
  none({ key: key({ remoteJid: '1203630@g.us' }), message: { conversation: 'a' } });
  none({ key: key({ remoteJid: 'status@broadcast' }), message: { conversation: 'a' } });
  none({ key: key({ remoteJid: '1234@newsletter' }), message: { conversation: 'a' } });
  none({ key: key({ remoteJid: '1234@broadcast' }), message: { conversation: 'a' } });
  none({ key: key({ id: undefined }), message: { conversation: 'a' } });
  none({ key: key({ remoteJid: undefined }), message: { conversation: 'a' } });
  none({ key: key(), message: undefined });
  none({ key: key(), message: { reactionMessage: { text: '👍' } } });
  none({ key: key(), message: { protocolMessage: { type: 0 } } });
  none({ key: key(), message: { senderKeyDistributionMessage: {} } });
});

test('extractIncoming: JID @lid memakai pasangan nomor bila ada, bila tidak phone kosong', () => {
  const withAlt = extractIncoming({ key: key({ remoteJid: '99887766@lid', remoteJidAlt: '6285500001111@s.whatsapp.net' }), message: { conversation: 'a' } } as any)!;
  assert.equal(withAlt.phone, '6285500001111'); assert.equal(withAlt.jid, '99887766@lid');
  const noAlt = extractIncoming({ key: key({ remoteJid: '99887766@lid' }), message: { conversation: 'a' } } as any)!;
  assert.equal(noAlt.phone, undefined);
  assert.equal(extractIncoming({ key: key({ remoteJid: '6281234567890:12@s.whatsapp.net' }), message: { conversation: 'a' } } as any)!.phone, '6281234567890', 'sufiks device dibuang');
});

test('extractReceipt: 3 => DELIVERED, 4/5 => READ; lainnya/ bukan pesan keluar diabaikan', () => {
  const k = (o: any = {}) => ({ id: 'M1', fromMe: true, remoteJid: 'x@s.whatsapp.net', ...o });
  assert.deepEqual(extractReceipt({ key: k(), update: { status: 3 } }), { providerMessageId: 'M1', status: 'DELIVERED' });
  assert.equal(extractReceipt({ key: k(), update: { status: 4 } })!.status, 'READ');
  assert.equal(extractReceipt({ key: k(), update: { status: 5 } })!.status, 'READ');
  for (const u of [{ key: k(), update: { status: 2 } }, { key: k(), update: { status: 0 } }, { key: k(), update: {} }, { key: k({ fromMe: false }), update: { status: 3 } }, { key: k({ id: undefined }), update: { status: 3 } }]) {
    assert.equal(extractReceipt(u as any), null);
  }
});

// ---------- alur engine + DB ----------

test('pesan masuk: tersimpan (chat+pesan), event message.incoming dengan teks, duplikat diabaikan', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  s.fake.incoming({ providerMessageId: 'IN-1', phone: '6285500001111', pushName: 'Siti', text: 'selamat pagi' });
  await waitFor(async () => (await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length === 1, 'tersimpan');
  s.fake.incoming({ providerMessageId: 'IN-1', phone: '6285500001111', text: 'selamat pagi' }); // dikirim ulang WhatsApp
  s.fake.incoming({ providerMessageId: 'IN-2', phone: '6285500001111', text: 'apa kabar' });
  await waitFor(async () => (await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length === 2, 'pesan kedua');
  await sleep(100);
  assert.equal((await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length, 2, 'duplikat tidak menambah baris');
  const chats = await q('SELECT contact_phone, display_name, remote_jid FROM wa_chats WHERE session_id = $1', [s.id]);
  assert.deepEqual(chats, [{ contact_phone: '6285500001111', display_name: 'Siti', remote_jid: '6285500001111@s.whatsapp.net' }]);
  const ev = await outbox(tn.tenantId, 'message.incoming');
  assert.equal(ev.length, 2, 'satu event per pesan unik');
  assert.equal(ev[0].payload.text, 'selamat pagi'); assert.equal(ev[0].payload.from, '6285500001111'); assert.equal(ev[0].payload.from_name, 'Siti');
  assert.equal(ev[0].payload.session_id, s.id); assert.equal(ev[0].payload.type, 'text');
});

test('pesan keluar dicerminkan; receipt DELIVERED/READ hanya maju; receipt asing diabaikan', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const m = await msgs.send(tn.principal, { sessionId: s.id, to: '6281234567890', text: 'pesan keluar', priority: 5 });
  await waitFor(async () => (await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status === 'SENT', 'SENT');
  const out = (await q('SELECT direction, status, body, provider_message_id, queue_id FROM wa_messages WHERE session_id = $1', [s.id]))[0];
  assert.deepEqual([out.direction, out.status, out.body, out.queue_id], ['OUT', 'SENT', 'pesan keluar', m.job_id]);
  const pm = out.provider_message_id as string;

  s.fake.receipt('PM-TIDAK-ADA', 'READ'); // bukan pesan kita
  s.fake.receipt(pm, 'DELIVERED');
  await waitFor(async () => (await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status === 'DELIVERED', 'DELIVERED');
  assert.equal((await q('SELECT status FROM wa_messages WHERE queue_id = $1', [m.job_id]))[0].status, 'DELIVERED');
  s.fake.receipt(pm, 'READ');
  await waitFor(async () => (await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status === 'READ', 'READ');
  s.fake.receipt(pm, 'DELIVERED'); // receipt terlambat tidak boleh memundurkan
  await sleep(120);
  assert.equal((await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status, 'READ');
  assert.equal((await q('SELECT status FROM wa_messages WHERE queue_id = $1', [m.job_id]))[0].status, 'READ');
  const types = (await q(`SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY created_at, id`, [tn.tenantId, m.job_id])).map((r: any) => r.event_type);
  assert.deepEqual(types, ['message.sent', 'message.delivered', 'message.read']);
  assert.equal((await q('SELECT count(*)::int n FROM wa_messages WHERE queue_id = $1', [m.job_id]))[0].n, 1, 'cermin tidak digandakan');
});

test('fencing: engine yang kehilangan lease tidak menyimpan pesan masuk', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`, [s.id]));
  s.fake.incoming({ providerMessageId: 'IN-ZOMBI', text: 'tidak boleh tersimpan' });
  await sleep(250);
  assert.equal((await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length, 0);
});

test('tenant tidak dapat menulis chat/pesan langsung (hanya engine); baca tetap terisolasi', { skip }, async () => {
  const a = await newTenant(); const b = await newTenant(); const e = await newEngine();
  const s = await connected(a, e);
  s.fake.incoming({ providerMessageId: 'IN-A', text: 'milik A' });
  await waitFor(async () => (await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length === 1, 'tersimpan');
  await assert.rejects(db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid) VALUES ($1,$2,'x@s.whatsapp.net')`, [a.tenantId, s.id])), /row-level security/);
  await db.tx({ tenantId: a.tenantId }, async (c: any) => {
    assert.equal((await c.query(`UPDATE wa_messages SET body = 'diubah'`)).rowCount, 0);
    assert.equal((await c.query(`DELETE FROM wa_messages`)).rowCount, 0);
  });
  await db.tx({ tenantId: b.tenantId }, async (c: any) => {
    assert.equal((await c.query('SELECT 1 FROM wa_messages')).rowCount, 0);
    assert.equal((await c.query('SELECT 1 FROM wa_chats')).rowCount, 0);
  });
});

// ---------- API ----------

test('API chat/kontak: daftar, riwayat urut terbaru, paginasi, isolasi tenant, scope, id tidak valid', { skip }, async () => {
  const a = await newTenant(); const b = await newTenant(); const e = await newEngine();
  const s = await connected(a, e);
  s.fake.incoming({ providerMessageId: 'C1', phone: '6285500002222', pushName: 'Andi', text: 'satu', timestamp: new Date(Date.now() - 3000) });
  s.fake.incoming({ providerMessageId: 'C2', phone: '6285500002222', text: 'dua', timestamp: new Date(Date.now() - 2000) });
  s.fake.incoming({ providerMessageId: 'C3', phone: '6285500003333', pushName: 'Rina', text: 'tiga', timestamp: new Date(Date.now() - 1000) });
  await waitFor(async () => (await q('SELECT 1 FROM wa_messages WHERE session_id = $1', [s.id])).length === 3, 'tiga pesan');
  const m = await msgs.send(a.principal, { sessionId: s.id, to: '6285500002222', text: 'balasan kami', priority: 5 });
  await waitFor(async () => (await q('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))[0].status === 'SENT', 'SENT');

  const chats = (await get(a.tok, '/chats')).json();
  assert.equal(chats.meta.total, 2);
  const andi = chats.data.find((c: any) => c.phone === '6285500002222');
  assert.equal(andi.name, 'Andi'); assert.equal(andi.session_id, s.id); assert.equal(andi.jid, '6285500002222@s.whatsapp.net');
  assert.equal(chats.data[0].phone, '6285500002222', 'chat dengan aktivitas terbaru (balasan kami) di atas');

  const hist = (await get(a.tok, `/chats/${andi.id}/messages`)).json();
  assert.equal(hist.meta.total, 3);
  assert.deepEqual(hist.data.map((x: any) => [x.direction, x.text]), [['OUT', 'balasan kami'], ['IN', 'dua'], ['IN', 'satu']]);
  assert.equal(hist.meta.chat.id, andi.id);
  const p2 = (await get(a.tok, `/chats/${andi.id}/messages?page=2&page_size=2`)).json();
  assert.deepEqual(p2.data.map((x: any) => x.text), ['satu']);
  assert.equal(hist.data[0].job_id, m.job_id);
  assert.equal(hist.data[1].text_purged, false);

  const contacts = (await get(a.tok, '/contacts')).json();
  assert.equal(contacts.meta.total, 2);
  assert.deepEqual(contacts.data.map((c: any) => c.phone).sort(), ['6285500002222', '6285500003333']);
  assert.equal(contacts.data.find((c: any) => c.phone === '6285500003333').name, 'Rina');

  assert.equal((await get(a.tok, `/chats?session_id=${crypto.randomUUID()}`)).json().meta.total, 0);
  assert.equal((await get(b.tok, `/chats/${andi.id}/messages`)).statusCode, 404, 'tenant lain tidak bisa membaca chat');
  assert.equal((await get(b.tok, '/chats')).json().meta.total, 0);
  assert.equal((await get(b.tok, '/contacts')).json().meta.total, 0);
  assert.equal((await get(a.tok, '/chats/bukan-uuid/messages')).statusCode, 404);
  assert.equal((await get(a.tok, '/chats?page_size=500')).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/v1/chats' })).statusCode, 401);

  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k' + ++n, scopes } })).json().data.key as string;
  const msgKey = await mk(['messages:read']); const ctKey = await mk(['contacts:read']);
  assert.equal((await app.inject({ url: '/api/v1/chats', headers: { 'x-api-key': msgKey } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/contacts', headers: { 'x-api-key': msgKey } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/contacts', headers: { 'x-api-key': ctKey } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/chats', headers: { 'x-api-key': ctKey } })).statusCode, 403);
});
