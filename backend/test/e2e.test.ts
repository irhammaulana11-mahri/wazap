/**
 * Jalur emas end-to-end: registrasi -> webhook + socket -> sesi (QR -> CONNECTED) -> kirim -> receipt -> pesan masuk ->
 * chat -> hapus sesi, dengan tenant kedua sebagai pembanding isolasi. Semua komponen nyata kecuali adapter WhatsApp (palsu).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createTestDb, dbAvailable } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createChatService } = await import('../src/modules/chats/chats.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createWebhookDeliverer } = await import('../src/modules/engine/webhook-delivery.js');
const { createRetention } = await import('../src/modules/engine/retention.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { attachRealtime } = await import('../src/modules/realtime/realtime.js');
const { verifyWebhook } = await import('../src/security/webhook-signature.js');

const LAB = { allowHttp: true, allowPrivate: true };
const t = skip ? null : await createTestDb(25);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const identity = skip ? (null as any) : createIdentityService(db);
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases, { retryBaseMs: 10, retryMaxMs: 40, random: () => 0 });
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const relay = skip ? (null as any) : createOutboxRelay(db);
const deliverer = skip ? (null as any) : createWebhookDeliverer({ db, crypto: cr, log: noLog, opts: { retryBaseMs: 5, retryMaxMs: 20, random: () => 0, policy: LAB, timeoutMs: 1000 } });
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: LAB });
const app = skip ? (null as any) : buildApp({
  identity, sessions: createSessionService(db, { crypto: cr }), messages: createMessageService(db), chats: createChatService(db), webhooks: wsvc, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const servers: http.Server[] = []; const socks: Socket[] = []; const runtimes: any[] = []; let rt: any;
after(async () => {
  for (const s of socks) s.close();
  for (const r of runtimes) await r.crash().catch(() => {});
  await rt?.close().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await app?.close(); await t?.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(20); }
}
const call = async (method: string, url: string, tok: string | undefined, payload?: any, headers: any = {}) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload });
  return { status: r.statusCode as number, body: r.json() as any, headers: r.headers };
};
const pump = async () => { while ((await relay.runOnce()) > 0) { /* kuras outbox */ } await deliverer.runOnce(); };

test('jalur emas end-to-end dengan isolasi tenant', { skip }, async () => {
  // --- registrasi dua tenant lewat HTTP ---
  const reg = async (email: string, name: string) => (await call('POST', '/auth/register', undefined, { email, password: 'correct-horse-battery', tenant_name: name })).body.data;
  const A = await reg('e2e-a@x.test', 'Tenant A'); const B = await reg('e2e-b@x.test', 'Tenant B');
  const tokA = A.access_token as string; const tokB = B.access_token as string;
  assert.ok(tokA && tokB);

  // --- realtime: klien A dan B ---
  const srv = http.createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv);
  rt = attachRealtime({ httpServer: srv, identity, db, log: noLog, opts: { revalidateMs: 60_000 } }); await rt.ready();
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const sock = async (tok: string) => {
    const s = connect(url, { path: '/api/v1/realtime', auth: { token: tok }, transports: ['websocket'], reconnection: false, forceNew: true }); socks.push(s);
    const got: Record<string, any[]> = {}; s.onAny((ev, p) => (got[ev] ??= []).push(p));
    await new Promise<void>((res, rej) => { s.once('ready', () => res()); s.once('connect_error', rej); });
    return got;
  };
  const sa = await sock(tokA); const sb = await sock(tokB);

  // --- webhook tenant A (dan B untuk pembanding) ---
  const hits: { headers: any; body: string }[] = []; const hitsB: any[] = [];
  const mkRcv = async (sink: any[]) => {
    const s = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { sink.push({ headers: q.headers, body: b }); r.writeHead(200).end('ok'); }); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/h`;
  };
  const wh = await call('POST', '/webhooks', tokA, { url: await mkRcv(hits), events: ['*'] });
  assert.equal(wh.status, 201); const secret = wh.body.data.secret as string;
  assert.equal((await call('POST', '/webhooks', tokB, { url: await mkRcv(hitsB), events: ['*'] })).status, 201);

  // --- sesi: buat -> penempatan -> QR -> CONNECTED ---
  const adapters = new FakeAdapterFactory();
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));
  const engine = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: { nodeName: 'e2e-eng', version: 't', capacity: { maxSessions: 10 }, heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 }, send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0 } },
  });
  await engine.start(); runtimes.push(engine);
  const created = await call('POST', '/sessions', tokA, { session_name: 'utama', auto_connect: true });
  assert.equal(created.status, 201); const sid = created.body.data.id as string;
  await cp.reconcile(); await engine.tick();
  const fake = await waitFor(async () => adapters.last(sid), 'adapter');
  fake.qr('QR-E2E-RAHASIA');
  const qr = await waitFor(async () => { const r = await call('GET', `/sessions/${sid}/qr`, tokA); return r.status === 200 && r.body; }, 'QR tersedia');
  assert.match(qr.data.qr_data_url, /^data:image\/png;base64,/);
  assert.equal((await call('GET', `/sessions/${sid}/qr`, tokB)).status, 404, 'tenant B tidak dapat mengambil QR sesi A');
  fake.open('6281200000099');
  await waitFor(async () => (await call('GET', `/sessions/${sid}/status`, tokA)).body.data.status === 'CONNECTED', 'CONNECTED');

  // --- kirim pesan + idempotensi ---
  const send = () => call('POST', '/messages/send', tokA, { session_id: sid, to: '6281234567890', type: 'text', message: 'halo dari e2e' }, { 'idempotency-key': 'e2e-1' });
  const s1 = await send(); const s2 = await send();
  assert.equal(s1.status, 202); assert.equal(s2.body.data.job_id, s1.body.data.job_id); assert.equal(s2.headers['idempotent-replayed'], 'true');
  const jid = s1.body.data.job_id as string;
  await waitFor(async () => (await call('GET', `/messages/${jid}/status`, tokA)).body.data.status === 'SENT', 'SENT');
  assert.equal(fake.sent.length, 1, 'terkirim tepat sekali walau dikirim dua kali');
  const pm = (await call('GET', `/messages/${jid}`, tokA)).body.data.provider_message_id as string;
  fake.receipt(pm, 'DELIVERED'); fake.receipt(pm, 'READ');
  await waitFor(async () => (await call('GET', `/messages/${jid}/status`, tokA)).body.data.status === 'READ', 'READ');

  // --- pesan masuk + chat ---
  fake.incoming({ providerMessageId: 'E2E-IN-1', phone: '6285512340000', pushName: 'Pelanggan', text: 'halo admin' });
  const chats = await waitFor(async () => { const r = await call('GET', '/chats', tokA); return r.body.data.length === 2 && r.body; }, 'chat masuk + keluar');
  const inChat = chats.data.find((c: any) => c.phone === '6285512340000');
  const hist = (await call('GET', `/chats/${inChat.id}/messages`, tokA)).body.data;
  assert.deepEqual(hist.map((m: any) => [m.direction, m.text]), [['IN', 'halo admin']]);
  assert.equal((await call('GET', '/contacts', tokA)).body.meta.total, 2);

  // --- webhook: semua event, tanda tangan valid, dedup event_id ---
  await waitFor(async () => { await pump(); const ev = new Set(hits.map((h) => h.headers['x-wazap-event'])); return ['session.status', 'message.sent', 'message.delivered', 'message.read', 'message.incoming'].every((e) => ev.has(e)); }, 'semua event webhook');
  for (const h of hits) assert.equal(verifyWebhook(secret, h.headers['x-wazap-timestamp'], h.body, h.headers['x-wazap-signature']), true, h.headers['x-wazap-event']);
  const ids = hits.map((h) => JSON.parse(h.body).event_id); assert.equal(new Set(ids).size, ids.length, 'tiap event terkirim sekali (event_id unik)');
  assert.ok(!hits.some((h) => h.body.includes('QR-E2E-RAHASIA') || h.body.includes('halo dari e2e')), 'QR dan isi pesan keluar tidak pernah masuk webhook');

  // --- socket A menerima; socket B tidak menerima apa pun dari A ---
  await waitFor(() => sa['session.connected'] && sa['message.status']?.length >= 3 && sa['message.incoming'], 'event socket A');
  assert.deepEqual(sa['message.status'].map((p: any) => p.data.status).sort(), ['DELIVERED', 'READ', 'SENT']);
  assert.ok(sa['session.qr']?.length >= 1); assert.ok(!JSON.stringify(sa).includes('QR-E2E-RAHASIA'));
  await sleep(100);
  assert.deepEqual(Object.keys(sb).sort(), ['ready'], 'tenant B tidak menerima event tenant A');
  assert.equal(hitsB.length, 0, 'webhook tenant B tidak menerima event tenant A');
  assert.equal((await call('GET', '/chats', tokB)).body.meta.total, 0);
  assert.equal((await call('GET', `/messages/${jid}`, tokB)).status, 404);
  assert.equal((await call('POST', '/messages/send', tokB, { session_id: sid, to: '6281234567890', type: 'text', message: 'x' })).status, 404);

  // --- hapus sesi: pesan tertunda dibatalkan, kredensial terhapus, event DELETED ---
  const pending = await call('POST', '/messages/send', tokA, { session_id: sid, to: '6281234567891', type: 'text', message: 'menunggu', scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(pending.status, 202);
  assert.equal((await call('DELETE', `/sessions/${sid}`, tokA)).status, 202, 'hapus bersifat asinkron');
  await waitFor(async () => { await cp.reconcile(); return (await call('GET', `/sessions/${sid}`, tokA)).status === 404; }, 'sesi DELETED');
  const left = (await db.tx({ platform: true }, async (c: any) => ({
    auth: (await c.query('SELECT 1 FROM session_auth_state WHERE session_id = $1', [sid])).rowCount,
    qr: (await c.query('SELECT 1 FROM session_qr WHERE session_id = $1', [sid])).rowCount,
    job: (await c.query('SELECT status, last_error_code FROM message_queue WHERE id = $1', [pending.body.data.job_id])).rows[0],
  })));
  assert.deepEqual([left.auth, left.qr, left.job.status, left.job.last_error_code], [0, 0, 'CANCELLED', 'SESSION_DELETED']);
  await waitFor(async () => { await pump(); return hits.some((h) => { const b = JSON.parse(h.body); return b.event === 'session.status' && b.data.status === 'DELETED'; }); }, 'webhook DELETED');
  await waitFor(() => sa['session.status']?.some((p: any) => p.data.status === 'DELETED'), 'socket DELETED');

  // --- retensi tidak menyentuh yang masih baru ---
  const rep = await createRetention(db).runOnce();
  assert.equal(rep.contentPurged, 0); assert.equal(rep.rowsDeleted, 0);
  assert.equal((await call('GET', `/messages/${jid}`, tokA)).body.data.message, 'halo dari e2e');
});
