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
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { attachRealtime } = await import('../src/modules/realtime/realtime.js');
const { notifyEvents, toSocketEvents, parseChannelEvent, channelFor } = await import('../src/modules/realtime/event-channel.js');

const t = skip ? null : await createTestDb(25);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const identity = skip ? (null as any) : createIdentityService(db);
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases);
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const relay = skip ? (null as any) : createOutboxRelay(db);
const app = skip ? (null as any) : buildApp({
  identity, sessions: svc, messages: createMessageService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});

const httpSrvs: http.Server[] = [];
const rts: any[] = [];
const socks: Socket[] = [];
const runtimes: any[] = [];
async function startRealtime(opts: any = {}) {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const rt = attachRealtime({ httpServer: srv, identity, db, log: noLog, opts: { revalidateMs: 100, ...opts } });
  await rt.ready();
  httpSrvs.push(srv); rts.push(rt);
  return { rt, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}
let sharedRt: Promise<{ rt: any; url: string }> | undefined;
/** Satu server realtime bersama (opsi default) agar koneksi LISTEN tidak menghabiskan pool tes. */
const shared = () => (sharedRt ??= startRealtime());
async function stopRealtime(x: { rt: any }) {
  await x.rt.close();
  const i = rts.indexOf(x.rt); if (i >= 0) rts.splice(i, 1);
}
after(async () => {
  for (const s of socks) s.close();
  for (const r of runtimes) await r.crash().catch(() => {});
  for (const r of rts) await r.close().catch(() => {});
  for (const s of httpSrvs) { s.closeAllConnections?.(); s.close(); }
  await app?.close(); await t?.drop();
});

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
async function newTenant() {
  const label = `r${++n}`;
  const reg = await identity.register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { label, principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string, userId: reg.user.id as string };
}
/** Anggota ber-role tertentu di tenant `a` dan token aksesnya. */
async function member(a: any, role: string) {
  const m = await newTenant();
  await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,$3)`, [a.tenantId, m.userId, role]));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${m.label}@x.test`, password: 'correct-horse-battery', tenant_id: a.tenantId } });
  return { tok: login.json().data.access_token as string, userId: m.userId as string };
}
interface Client { s: Socket; got: Record<string, any[]> }
async function client(url: string, token: string | undefined, extra: any = {}): Promise<Client> {
  const s = connect(url, { path: '/api/v1/realtime', auth: token === undefined ? {} : { token }, transports: ['websocket'], reconnection: false, forceNew: true, ...extra });
  socks.push(s);
  const got: Record<string, any[]> = {};
  s.onAny((ev, payload) => (got[ev] ??= []).push(payload));
  await new Promise<void>((res, rej) => { s.once('ready', () => res()); s.once('connect_error', rej); });
  return { s, got };
}
const refused = (url: string, auth: any, extra: any = {}) => new Promise<any>((res, rej) => {
  const s = connect(url, { path: '/api/v1/realtime', auth, transports: ['websocket'], reconnection: false, forceNew: true, ...extra });
  socks.push(s);
  s.once('connect', () => rej(new Error('seharusnya ditolak')));
  s.once('connect_error', (e) => res(e));
});
const flush = async () => { while ((await relay.runOnce()) > 0) { /* kuras */ } await sleep(60); };
async function newEngine() {
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: {
      nodeName: `rteng-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0 },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}

// ---------- unit ----------

test('toSocketEvents: pemetaan nama & room; event tak dikenal diabaikan', () => {
  const mk = (event: string, data: any = {}) => ({ tenantId: 't', id: 'i', event, occurredAt: 'x', data });
  assert.deepEqual(toSocketEvents(mk('session.status', { status: 'CONNECTED' })).map((e) => e.name), ['session.status', 'session.connected']);
  assert.deepEqual(toSocketEvents(mk('session.status', { status: 'LOGGED_OUT' })).map((e) => e.name), ['session.status', 'session.disconnected']);
  assert.deepEqual(toSocketEvents(mk('session.status', { status: 'RECONNECTING' })).map((e) => e.name), ['session.status', 'session.reconnecting']);
  assert.deepEqual(toSocketEvents(mk('session.status', { status: 'CREATED' })).map((e) => e.name), ['session.status', 'session.created']);
  assert.deepEqual(toSocketEvents(mk('message.failed')).map((e) => e.name), ['message.status', 'message.failed']);
  assert.deepEqual(toSocketEvents(mk('message.sent')).map((e) => e.name), ['message.status']);
  assert.deepEqual(toSocketEvents(mk('session.qr')), [{ name: 'session.qr', room: 'qr' }]);
  assert.deepEqual(toSocketEvents(mk('webhook.test')), []);
  assert.equal(parseChannelEvent('bukan json'), null);
  assert.equal(parseChannelEvent(JSON.stringify({ t: 1 })), null);
  assert.notEqual(channelFor('a'), channelFor('b'));
});

// ---------- handshake & otorisasi ----------

test('handshake: tanpa/ salah token, token di query string, API key tanpa scope => ditolak', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  for (const auth of [{}, { token: '' }, { token: 'sampah' }, { token: 123 }, { token: 'gwk_tidak-ada' }]) {
    const e = await refused(url, auth);
    assert.equal(e.data?.code, 'UNAUTHENTICATED', JSON.stringify(auth));
  }
  const q = await refused(url, {}, { query: { token: a.tok } });
  assert.equal(q.data?.code, 'UNAUTHENTICATED', 'token di query string tidak diterima');
  const key = (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k1', scopes: ['usage:read'] } })).json().data.key;
  assert.equal((await refused(url, { token: key })).data?.code, 'FORBIDDEN');
});

test('handshake sukses: server menentukan room dari principal; klien tidak bisa memilih room', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const b = await newTenant();
  const owner = await client(url, a.tok);
  const viewer = await client(url, (await member(a, 'VIEWER')).tok);
  assert.deepEqual(owner.got.ready![0].rooms, ['sessions', 'messages', 'qr']);
  assert.deepEqual(viewer.got.ready![0].rooms, ['sessions', 'messages']);
  assert.equal(owner.got.ready![0].tenant_id, a.tenantId);
  // Klien mencoba bergabung ke room tenant lain: tidak ada handler, tidak ada efek.
  const other = await client(url, b.tok);
  owner.s.emit('join', `t:${b.tenantId}:messages`);
  owner.s.emit('subscribe', { room: `t:${b.tenantId}:sessions` });
  await sleep(50);
  await db.tx({ platform: true }, (c: any) => notifyEvents(c, [{ tenantId: b.tenantId, id: crypto.randomUUID(), event: 'message.sent', occurredAt: new Date().toISOString(), data: { message_id: 'm' } }]));
  await waitFor(() => other.got['message.status']?.length, 'event milik B');
  await sleep(100);
  assert.equal(owner.got['message.status'], undefined, 'A tidak boleh menerima event B');
});

test('API key: room mengikuti scope; kunci tanpa sessions:write tidak mendapat sinyal QR', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k' + ++n, scopes } })).json().data.key as string;
  const msgOnly = await client(url, await mk(['messages:read']));
  const mgr = await client(url, await mk(['sessions:read', 'sessions:write']));
  assert.deepEqual(msgOnly.got.ready![0].rooms, ['messages']);
  assert.deepEqual(mgr.got.ready![0].rooms, ['sessions', 'qr']);
});

// ---------- aliran event end-to-end ----------

test('E2E: sesi + pesan lewat engine => event realtime tenant yang benar; QR hanya sinyal & hanya untuk pengelola', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant(); const b = await newTenant();
  const owner = await client(url, a.tok);
  const viewer = await client(url, (await member(a, 'VIEWER')).tok);
  const outsider = await client(url, b.tok);
  const e = await newEngine();

  const s = await svc.create(a.principal, { name: `rt${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter');
  fake.qr('QR-PAYLOAD-RAHASIA-123');
  await waitFor(async () => (await svc.get(a.tenantId, s.id)).status === 'QR_REQUIRED', 'QR_REQUIRED');
  fake.open('6281200000001');
  await waitFor(async () => (await svc.get(a.tenantId, s.id)).status === 'CONNECTED', 'CONNECTED');
  await flush();

  await waitFor(() => owner.got['session.connected']?.length, 'session.connected');
  const st = owner.got['session.status']!.map((p) => p.data.status);
  assert.ok(st.includes('CREATED') && st.includes('QR_REQUIRED') && st.includes('CONNECTED'), st.join());
  const env = owner.got['session.connected']![0];
  assert.equal(env.v, 1); assert.equal(env.event, 'session.connected'); assert.equal(env.tenant_id, a.tenantId);
  assert.equal(env.data.session_id, s.id);
  assert.match(env.event_id, /^[0-9a-f-]{36}$/); assert.ok(!Number.isNaN(Date.parse(env.occurred_at)));

  // QR: sinyal tanpa isi QR, hanya untuk pengelola
  assert.ok(owner.got['session.qr']?.length >= 1, 'pengelola menerima sinyal QR');
  assert.equal(viewer.got['session.qr'], undefined, 'VIEWER tidak menerima sinyal QR');
  assert.equal(outsider.got['session.qr'], undefined);
  const all = JSON.stringify([owner.got, viewer.got, outsider.got]);
  assert.ok(!all.includes('QR-PAYLOAD-RAHASIA'), 'isi QR tidak boleh lewat socket');
  assert.equal(owner.got['session.qr']![0].data.session_id, s.id);
  assert.ok(viewer.got['session.status']?.length, 'VIEWER tetap menerima status sesi');
  assert.equal(outsider.got['session.status'], undefined, 'tenant lain tidak menerima event sesi');

  // Pesan: SENT lalu gagal
  const m = await createMessageService(db).send(a.principal, { sessionId: s.id, to: '6281234567890', text: 'halo-rahasia', priority: 5 });
  await waitFor(async () => (await db.tx({ platform: true }, (c: any) => c.query('SELECT status FROM message_queue WHERE id = $1', [m.job_id]))).rows[0].status === 'SENT', 'SENT');
  await flush();
  const ms = await waitFor(() => owner.got['message.status']?.find((p) => p.data.message_id === m.job_id), 'message.status');
  assert.equal(ms.data.status, 'SENT'); assert.match(ms.data.provider_message_id, /^PM-/);
  assert.ok(viewer.got['message.status']?.length);
  assert.equal(outsider.got['message.status'], undefined);
  assert.ok(!JSON.stringify(owner.got).includes('halo-rahasia'), 'isi pesan tidak ikut event');
});

test('multi-instans: event yang sama diterima klien pada dua server realtime berbeda', { skip }, async () => {
  const one = await startRealtime(); const two = await startRealtime();
  const a = await newTenant();
  const c1 = await client(one.url, a.tok); const c2 = await client(two.url, a.tok);
  await db.tx({ platform: true }, (c: any) => notifyEvents(c, [{ tenantId: a.tenantId, id: 'e-1', event: 'message.delivered', occurredAt: new Date().toISOString(), data: { message_id: 'x', status: 'DELIVERED' } }]));
  const [p1, p2] = await Promise.all([waitFor(() => c1.got['message.status']?.[0], 'inst1'), waitFor(() => c2.got['message.status']?.[0], 'inst2')]);
  assert.equal(p1.event_id, 'e-1'); assert.equal(p2.event_id, 'e-1');
  c1.s.close(); c2.s.close(); await stopRealtime(one); await stopRealtime(two);
});

test('NOTIFY dalam transaksi yang di-rollback tidak sampai ke klien', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const c = await client(url, a.tok);
  await assert.rejects(db.tx({ platform: true }, async (cl: any) => {
    await notifyEvents(cl, [{ tenantId: a.tenantId, id: 'batal', event: 'message.sent', occurredAt: new Date().toISOString(), data: {} }]);
    throw new Error('rollback');
  }));
  await sleep(150);
  assert.equal(c.got['message.status'], undefined);
});

// ---------- siklus hidup kredensial ----------

test('token kedaluwarsa memutus socket (auth.expired); API key yang dicabut juga diputus', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const { signAccessToken } = await import('../src/modules/identity/tokens.js');
  const short = await client(url, signAccessToken(a.userId, a.tenantId, 1));
  const k2 = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k' + ++n, scopes: ['messages:read'] } });
  const keyId = k2.json().data.id; const raw = k2.json().data.key;
  const kc = await client(url, raw);
  await waitFor(() => !short.s.connected, 'token kedaluwarsa memutus', 4000);
  assert.ok(short.got['auth.expired']?.length >= 1);
  assert.equal(kc.s.connected, true);
  await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${keyId}`, headers: bearer(a.tok) });
  await waitFor(() => !kc.s.connected, 'API key dicabut memutus', 4000);
});

test('perubahan role dinilai ulang: OWNER -> VIEWER kehilangan room QR tanpa putus', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const m = await member(a, 'MEMBER');
  const c = await client(url, m.tok);
  assert.deepEqual(c.got.ready![0].rooms, ['sessions', 'messages', 'qr']);
  await db.tx({ tenantId: a.tenantId }, (cl: any) => cl.query(`UPDATE tenant_memberships SET role = 'VIEWER' WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, m.userId]));
  await sleep(450);
  await db.tx({ platform: true }, (cl: any) => notifyEvents(cl, [{ tenantId: a.tenantId, id: crypto.randomUUID(), event: 'session.qr', occurredAt: new Date().toISOString(), data: { session_id: 's' } }]));
  await db.tx({ platform: true }, (cl: any) => notifyEvents(cl, [{ tenantId: a.tenantId, id: crypto.randomUUID(), event: 'message.sent', occurredAt: new Date().toISOString(), data: {} }]));
  await waitFor(() => c.got['message.status']?.length, 'masih menerima pesan');
  assert.equal(c.s.connected, true);
  assert.equal(c.got['session.qr'], undefined, 'room QR dilepas setelah role turun');
});

test('batas koneksi per tenant', { skip }, async () => {
  const lim = await startRealtime({ maxSocketsPerTenant: 2 }); const url = lim.url;
  const a = await newTenant();
  await client(url, a.tok); await client(url, a.tok);
  assert.equal((await refused(url, { token: a.tok })).data?.code, 'TOO_MANY_CONNECTIONS');
  const b = await newTenant();
  await client(url, b.tok); // tenant lain tidak terpengaruh
  await stopRealtime(lim);
});

test('klien tidak dapat mengirim event berukuran besar (batas buffer)', { skip }, async () => {
  const { url } = await shared();
  const a = await newTenant();
  const c = await client(url, a.tok);
  c.s.emit('x', 'A'.repeat(20_000));
  await waitFor(() => !c.s.connected, 'koneksi ditutup karena payload terlalu besar', 3000);
});
