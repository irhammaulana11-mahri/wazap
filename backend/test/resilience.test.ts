import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { io as connect, type Socket } from 'socket.io-client';
import { createTestDb, dbAvailable, config } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

/**
 * Uji ketahanan: gangguan infrastruktur (koneksi DB diputus, DB tidak terjangkau, proses mati di tengah kerja, dua
 * instans berebut peran). Setiap tes menegaskan DUA hal: tidak ada kerusakan data (pesan tidak hilang/ganda, tidak ada
 * dua pemilik) dan sistem pulih sendiri tanpa restart.
 */
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createGatewayDb } = await import('../src/database/gateway.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane, startControlPlaneLoop } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createWebhookDeliverer } = await import('../src/modules/engine/webhook-delivery.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { attachRealtime } = await import('../src/modules/realtime/realtime.js');
const { notifyEvents } = await import('../src/modules/realtime/event-channel.js');
const { startPoller } = await import('../src/runtime/poller.js');
const { isDbUnavailable } = await import('../src/http/errors.js');

const t = skip ? null : await createTestDb(30);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const LAB = { allowHttp: true, allowPrivate: true };
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const identity = skip ? (null as any) : createIdentityService(db);
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases);
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const msgs = skip ? (null as any) : createMessageService(db);
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: LAB });
const relay = skip ? (null as any) : createOutboxRelay(db);
const app = skip ? (null as any) : buildApp({
  identity, sessions: svc, messages: msgs, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});

const admin = skip ? (null as any) : new pg.Client({ host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE, user: config.DB_USERNAME, password: config.DB_PASSWORD || undefined });
if (!skip) await admin.connect();
const runtimes: any[] = [];
const servers: http.Server[] = [];
const socks: Socket[] = [];
const closers: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const s of socks) s.close();
  for (const r of runtimes) await r.crash().catch(() => {});
  for (const c of closers) await c().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await app?.close(); await t?.drop(); await admin?.end();
});

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false, what: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(20); }
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const stopAll = () => db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));

/** PID backend PostgreSQL milik pool tes ini saja (tes lain berjalan paralel di database yang sama: jangan menyentuhnya). */
async function myPids(): Promise<number[]> {
  const cs = await Promise.all(Array.from({ length: Math.max(1, db.pool.options.max - 3) }, () => db.pool.connect())); // sisakan slot: LISTEN realtime dll. menahan koneksi
  const pids = cs.map((c: any) => c.processID as number);
  cs.forEach((c: any) => c.release());
  return [...new Set(pids)];
}
async function kill(pids: number[]) {
  await admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);
  await sleep(150); // beri waktu event 'error'/'end' sampai ke pool
}
const killAllMine = async () => kill(await myPids());

async function newTenant() {
  const label = `z${++n}`;
  const reg = await identity.register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
async function newEngine(opts: { node?: string; send?: any; heartbeatSeconds?: number } = {}) {
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: {
      nodeName: opts.node ?? `reng-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: opts.heartbeatSeconds ?? 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0, ...opts.send },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
async function connected(tn: any, e: any) {
  const s = await svc.create(tn.principal, { name: `zs${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter');
  fake.open(`62${700000000 + n}`);
  await waitFor(async () => (await svc.get(tn.tenantId, s.id)).status === 'CONNECTED', 'CONNECTED');
  return { id: s.id as string, fake };
}
const sendMsg = async (tn: any, sessionId: string, message: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: bearer(tn.tok), payload: { type: 'text', session_id: sessionId, to: '6281234567890', message } });
  assert.equal(r.statusCode, 202, r.body);
  return r.json().data.job_id as string;
};
const jobRow = (id: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT * FROM message_queue WHERE id = $1', [id])).rows[0]);
const sessStatus = async (id: string) => (await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT status FROM wa_sessions WHERE id = $1', [id])).rows[0])).status;

// ------------------------------------------------------------------ koneksi database

test('koneksi idle diputus server (restart/failover DB): proses tidak crash, query berikutnya memakai koneksi baru', { skip }, async () => {
  assert.ok(db.pool.listenerCount('error') >= 1, 'pool wajib punya listener error: tanpa itu Node melempar uncaughtException dan proses mati');
  await db.pool.query('SELECT 1');
  await killAllMine();
  for (let i = 0; i < 3; i++) assert.equal((await db.pool.query('SELECT 1 AS x')).rows[0].x, 1);
  // layanan tingkat atas juga pulih (bukan hanya pool mentah)
  const tn = await newTenant();
  assert.equal((await svc.list(tn.tenantId, { page: 1, pageSize: 10 })).total, 0);
});

test('koneksi putus di tengah transaksi: tx menolak, pool pulih, konteks RLS tidak bocor ke koneksi berikutnya', { skip }, async () => {
  const tn = await newTenant();
  await assert.rejects(db.tx({ tenantId: tn.tenantId }, async (c: any) => {
    await c.query('SELECT 1');
    const pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    await kill([pid]);
    await c.query('SELECT 1'); // koneksi sudah mati
  }));
  // tx berikutnya (koneksi baru) tidak mewarisi tenant sebelumnya
  const ctx = await db.tx({}, async (c: any) => (await c.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t);
  assert.ok(!ctx, `konteks bocor: ${ctx}`);
  // dan data tenant tetap tidak terlihat tanpa konteks (RLS fail-closed)
  const rows = await db.tx({}, async (c: any) => (await c.query('SELECT count(*)::int n FROM wa_sessions')).rows[0].n);
  assert.equal(rows, 0);
});

test('klasifikasi galat: koneksi/ketersediaan DB => 503 SERVICE_UNAVAILABLE tanpa membocorkan host/port/galat internal; galat lain tetap 500', async () => {
  for (const e of [{ code: 'ECONNREFUSED' }, { code: '57P01' }, { code: '53300' }, { message: 'Connection terminated unexpectedly' }, { message: 'timeout exceeded when trying to connect' },
    { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] }]) assert.equal(isDbUnavailable(e), true, JSON.stringify(e));
  for (const e of [{ code: '23505' }, { message: 'boom' }, new TypeError('x'), { errors: [{ code: 'ECONNREFUSED' }, { code: '23505' }] }, undefined]) assert.equal(isDbUnavailable(e), false, JSON.stringify(e));
});

test('DB tidak terjangkau: API menjawab 503 cepat dengan envelope aman (tanpa host/port/stack), proses tetap hidup', async () => {
  const dead = createGatewayDb('gateway', { pool: new pg.Pool({ host: '127.0.0.1', port: 1, user: 'x', database: 'x', connectionTimeoutMillis: 500, max: 2 }) });
  const a = buildApp({
    identity: createIdentityService(dead), checkDb: async () => false,
    limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  });
  try {
    const t0 = Date.now();
    const r = await a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x@x.test', password: 'correct-horse-battery' } });
    assert.equal(r.statusCode, 503, r.body);
    assert.ok(Date.now() - t0 < 3000, 'harus gagal cepat, bukan menggantung');
    assert.equal(r.headers['retry-after'], '2');
    const b = r.json();
    assert.equal(b.error.code, 'SERVICE_UNAVAILABLE');
    for (const leak of ['127.0.0.1', 'ECONNREFUSED', 'port', ' at ', 'pg']) assert.ok(!r.body.includes(leak), `bocor: ${leak}`);
    assert.equal((await a.inject({ url: '/health/live' })).statusCode, 200, 'liveness tetap 200 (jangan restart proses karena DB mati)');
    assert.equal((await a.inject({ url: '/health/ready' })).statusCode, 503);
  } finally { await a.close(); await dead.close(); }
});

// ------------------------------------------------------------------ engine

test('engine selamat dari putus koneksi DB: tick berikutnya pulih, sesi tetap CONNECTED, pesan tetap terkirim tepat sekali', { skip }, async () => {
  await stopAll();
  const e = await newEngine(); const tn = await newTenant(); const s = await connected(tn, e);
  const before = await jobRow(await sendMsg(tn, s.id, 'sebelum-gangguan'));
  await waitFor(async () => (await jobRow(before.id)).status === 'SENT', 'SENT sebelum gangguan');

  await killAllMine();
  await e.rt.tick().catch(() => {}); // boleh gagal sekali; yang penting tidak melempar uncaughtException
  await e.rt.tick();                 // koneksi baru: harus berhasil

  const id = await sendMsg(tn, s.id, 'sesudah-gangguan');
  await waitFor(async () => (await jobRow(id)).status === 'SENT', 'SENT setelah gangguan');
  assert.equal(await sessStatus(s.id), 'CONNECTED');
  assert.deepEqual(s.fake.sent.map((m: any) => m.text), ['sebelum-gangguan', 'sesudah-gangguan'], 'tidak ada pesan ganda atau hilang');
});

test('stop engine saat pesan sedang dikirim: pengiriman diselesaikan (SENT, bukan UNKNOWN), sesi kembali ke antrean tanpa lease', { skip }, async () => {
  await stopAll();
  const e = await newEngine(); const tn = await newTenant(); const s = await connected(tn, e);
  s.fake.sendScript.push({ delayMs: 400 });
  const id = await sendMsg(tn, s.id, 'sedang-jalan');
  await waitFor(async () => (await jobRow(id)).status === 'PROCESSING', 'PROCESSING');
  await e.rt.stop();
  const r = await jobRow(id);
  assert.equal(r.status, 'SENT', 'drain menunggu kirim yang berjalan');
  assert.equal(s.fake.sent.length, 1);
  assert.equal(await sessStatus(s.id), 'PENDING_ASSIGNMENT');
  const lease = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT engine_id FROM session_leases WHERE session_id = $1', [s.id])).rows[0].engine_id);
  assert.equal(lease, null);
});

// ------------------------------------------------------------------ control-plane

const leadersHolding = async (schema: string) => (await admin.query(
  `SELECT count(*)::int AS n FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295) AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
  [`wazap:control-plane:${schema}`])).rows[0].n as number;

test('control-plane: tepat satu leader; leader diputus => instans lain mengambil alih dan rekonsiliasi tetap jalan (tidak pernah dua leader)', { skip }, async () => {
  await stopAll();
  const logs: string[][] = [[], []];
  const mkLog = (i: number) => ({ info: (_o: any, m?: string) => { if (m) logs[i].push(m); }, warn: (_o: any, m?: string) => { if (m) logs[i].push(m); }, error: (o: any, m?: string) => { logs[i].push(`ERR ${m ?? ''} ${(o?.err as Error)?.message ?? ''}`); } });
  const loops = [0, 1].map((i) => startControlPlaneLoop(db, createControlPlane(db, engines, mkLog(i)), mkLog(i), 40));
  const stopLoops = () => Promise.all(loops.map((l) => l.stop()));
  closers.push(stopLoops);
  try {
    const lead = (i: number) => logs[i].includes('control-plane: menjadi leader');
    await waitFor(() => lead(0) || lead(1), 'ada leader');
    await sleep(200);
    assert.equal(logs[0].filter((m) => m === 'control-plane: menjadi leader').length + logs[1].filter((m) => m === 'control-plane: menjadi leader').length, 1, 'hanya satu yang menjadi leader');
    assert.equal(await leadersHolding(db.schema), 1);

    // leader diputus paksa (lock lepas otomatis di PostgreSQL)
    const holder = (await admin.query(
      `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295) AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
      [`wazap:control-plane:${db.schema}`])).rows[0].pid as number;
    const oldLeader = lead(0) ? 0 : 1;
    await admin.query('SELECT pg_terminate_backend($1)', [holder]);

    // pemimpin baru (instans lain ATAU instans yang sama setelah memilih ulang) dan tidak pernah lebih dari satu pemegang lock
    const samples: number[] = [];
    await waitFor(async () => { samples.push(await leadersHolding(db.schema)); return samples.length > 10 && samples[samples.length - 1] === 1; }, 'leader baru', 8000);
    assert.ok(samples.every((x) => x <= 1), `dua leader terdeteksi: ${samples}`);
    assert.ok(logs[0].concat(logs[1]).filter((m) => m === 'control-plane: menjadi leader').length >= 2, 'leader baru terpilih');
    assert.ok(logs[oldLeader].some((m) => m.includes('koneksi leader putus')), `leader lama menyadari kehilangan peran: ${logs[oldLeader]}`);

    // rekonsiliasi benar-benar berjalan di bawah leader baru
    const e = await newEngine(); const tn = await newTenant();
    const sess = await svc.create(tn.principal, { name: `zs${++n}`, autoConnect: true });
    await waitFor(async () => (await sessStatus(sess.id)) === 'INITIALIZING', 'sesi ditempatkan oleh leader baru');
    void e;
  } finally {
    await stopLoops(); // loop tidak boleh tersisa ke tes berikutnya walau ada assertion yang gagal
  }
  assert.equal(await leadersHolding(db.schema), 0, 'lock dilepas saat berhenti');
});

test('dua control-plane merekonsiliasi paralel berulang kali: setiap sesi ditempatkan tepat satu kali, tanpa melebihi kapasitas', { skip }, async () => {
  await stopAll();
  const e1 = await newEngine(); const e2 = await newEngine();
  const cps = [cp, createControlPlane(db, engines, noLog), createControlPlane(db, engines, noLog)];
  const ids: string[] = [];
  for (let k = 0; k < 4; k++) { const tn = await newTenant(); for (let i = 0; i < 3; i++) ids.push((await svc.create(tn.principal, { name: `zp${++n}`, autoConnect: true })).id); }
  for (let round = 0; round < 4; round++) await Promise.all(cps.map((c) => c.reconcile()));
  const rows = await db.tx({ platform: true }, async (c: any) => (await c.query(
    `SELECT s.id, s.status, l.engine_id, l.fencing_token FROM wa_sessions s JOIN session_leases l ON l.session_id = s.id WHERE s.id = ANY($1::uuid[])`, [ids])).rows);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r: any) => r.status === 'INITIALIZING' && [e1.rt.engineId, e2.rt.engineId].includes(r.engine_id)), JSON.stringify(rows));
  assert.ok(rows.every((r: any) => Number(r.fencing_token) === 1), 'fencing token naik sekali per penempatan (tidak ada tempat ganda)');
});

// ------------------------------------------------------------------ outbox & webhook

type Hit = { headers: http.IncomingHttpHeaders; body: string };
async function receiver() {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => { hits.push({ headers: req.headers, body }); res.writeHead(200).end('ok'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { hits, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook` };
}
const deliveriesOf = (endpointId: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at', [endpointId])).rows);
const pendingOutbox = (tenantId: string) => db.tx({ platform: true }, async (c: any) => (await c.query(`SELECT count(*)::int n FROM outbox_events WHERE tenant_id = $1 AND status = 'PENDING'`, [tenantId])).rows[0].n as number);
/** GatewayDb yang "mati" tepat sebelum COMMIT: kerja di dalam transaksi dijalankan penuh lalu dibatalkan. */
const crashBeforeCommit = (real: any) => ({ ...real, tx: (ctx: any, fn: any) => real.tx(ctx, async (c: any) => { await fn(c); throw new Error('proses mati sebelum commit'); }) });

test('relay outbox mati sebelum commit: event tetap PENDING, tanpa delivery/notify; relay berikutnya mengirim tepat sekali', { skip }, async () => {
  const tn = await newTenant(); const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['*'] });
  await svc.create(tn.principal, { name: `zo${++n}`, autoConnect: true }); // menghasilkan event outbox
  const before = await pendingOutbox(tn.tenantId);
  assert.ok(before > 0);

  const notifications: string[] = [];
  const listener = await db.pool.connect();
  await listener.query(`LISTEN wazap_ev_${crypto.createHash('md5').update(db.schema).digest('hex')}`);
  listener.on('notification', (m: any) => notifications.push(m.payload));
  try {
    await assert.rejects(createOutboxRelay(crashBeforeCommit(db)).runOnce(), /sebelum commit/);
    await sleep(100);
    assert.equal(await pendingOutbox(tn.tenantId), before, 'tidak ada event yang ditandai DISPATCHED');
    assert.equal((await deliveriesOf(ep.id)).length, 0, 'tidak ada delivery setengah jadi');
    assert.equal(notifications.length, 0, 'NOTIFY ikut dibatalkan');

    while ((await relay.runOnce()) > 0) { /* kuras */ }
    await sleep(100);
    assert.equal(await pendingOutbox(tn.tenantId), 0);
    const ds = await deliveriesOf(ep.id);
    assert.equal(ds.length, before, 'satu delivery per event, tanpa ganda');
    assert.equal(new Set(ds.map((d: any) => d.event_id)).size, before);
    assert.ok(notifications.length >= before);
  } finally { listener.release(true); }
});

test('pengirim webhook mati setelah mengirim tapi sebelum mencatat hasil: dikirim ulang setelah klaim habis (at-least-once, event_id sama)', { skip }, async () => {
  const tn = await newTenant(); const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['session.status'] });
  const s = await svc.create(tn.principal, { name: `zw${++n}`, autoConnect: true });
  void s;
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  assert.equal((await deliveriesOf(ep.id)).length >= 1, true);
  const mk = (d: any, extra: any = {}) => createWebhookDeliverer({ db: d, crypto: cr, log: { warn() {} }, opts: { retryBaseMs: 5, retryMaxMs: 20, random: () => 0, policy: LAB, timeoutMs: 800, claimSeconds: 1, ...extra } });

  // A: klaim lalu kirim; semua penulisan setelah klaim gagal ("proses mati").
  let claimed = false;
  const dying = { ...db, tx: (ctx: any, fn: any) => { if (claimed) return Promise.reject(new Error('mati')); return db.tx(ctx, async (c: any) => { const r = await fn(c); claimed = true; return r; }); } };
  // klaim memakai tx pertama; pembacaan endpoint dan pencatatan hasil memakai tx berikutnya => gagal. Pembacaan endpoint harus lolos:
  let calls = 0;
  const dying2 = { ...db, tx: (ctx: any, fn: any) => (++calls <= 2 ? db.tx(ctx, fn) : Promise.reject(new Error('mati'))) };
  void dying;
  await mk(dying2).runOnce();
  const first = rcv.hits.length;
  assert.ok(first >= 1, 'penerima menerima kiriman pertama');
  const stuck = await deliveriesOf(ep.id);
  assert.ok(stuck.every((d: any) => d.status === 'PENDING' && d.attempts === 0), 'hasil tidak tercatat: masih PENDING');

  // B: belum lewat masa klaim => tidak diambil ganda
  await mk(db, { claimSeconds: 30 }).runOnce();
  await sleep(1200); // masa klaim A (1 dtk) habis
  await waitFor(async () => { await mk(db).runOnce(); return (await deliveriesOf(ep.id)).every((d: any) => d.status === 'DELIVERED'); }, 'terkirim ulang');
  const ids = rcv.hits.map((h) => JSON.parse(h.body).event_id);
  assert.ok(rcv.hits.length > first, 'dikirim ulang');
  for (const id of new Set(ids)) assert.ok(ids.filter((x) => x === id).length >= 1);
  const byEvent = new Map<string, Set<string>>();
  for (const h of rcv.hits) { const k = JSON.parse(h.body).event_id; (byEvent.get(k) ?? byEvent.set(k, new Set()).get(k)!).add(h.headers['x-wazap-delivery-id'] as string); }
  assert.ok([...byEvent.values()].every((v) => v.size === 1), 'event_id dan delivery_id stabil antar pengiriman ulang (penerima dapat dedup)');
});

// ------------------------------------------------------------------ realtime & runtime

test('realtime: koneksi LISTEN diputus => server menyambung ulang, klien menerima realtime.resync, event berikutnya tetap sampai', { skip }, async () => {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  const rt = attachRealtime({ httpServer: srv, identity, db, log: noLog, opts: { revalidateMs: 60_000 } });
  closers.push(() => rt.close());
  await rt.ready();
  const tn = await newTenant();
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const s = connect(url, { path: '/api/v1/realtime', auth: { token: tn.tok }, transports: ['websocket'], reconnection: false, forceNew: true });
  socks.push(s);
  const got: Record<string, any[]> = {};
  s.onAny((ev, p) => (got[ev] ??= []).push(p));
  await new Promise<void>((res, rej) => { s.once('ready', () => res()); s.once('connect_error', rej); });

  // Kanal diturunkan dari schema tes ini (unik): hanya backend LISTEN milik server realtime tes ini yang cocok.
  const channel = `wazap_ev_${crypto.createHash('md5').update(db.schema).digest('hex')}`;
  const listenPid = (await admin.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = $1`, [`LISTEN ${channel}`])).rows[0]?.pid as number | undefined;
  assert.ok(listenPid, 'koneksi LISTEN ditemukan');
  await kill([listenPid!]);
  await waitFor(() => got['realtime.resync']?.length, 'realtime.resync', 8000);

  await db.tx({ platform: true }, (c: any) => notifyEvents(c, [{ tenantId: tn.tenantId, id: 'pasca-pulih', event: 'message.sent', occurredAt: new Date().toISOString(), data: { message_id: 'm' } }]));
  const ev = await waitFor(() => got['message.status']?.[0], 'event setelah pulih');
  assert.equal(ev.event_id, 'pasca-pulih');
});

test('poller: galat sementara tidak menghentikan loop; stop() menunggu iterasi berjalan', async () => {
  const errors: unknown[] = [];
  let runs = 0; let finished = 0;
  const p = startPoller('uji', async () => {
    runs++;
    if (runs <= 2) throw new Error('DB putus');
    await sleep(120); finished++;
    return 0;
  }, 10, { error: (o) => errors.push(o) });
  await waitFor(() => runs >= 3, 'loop lanjut setelah galat');
  await p.stop();
  assert.equal(errors.length, 2);
  assert.equal(finished, 1, 'iterasi yang sedang berjalan diselesaikan sebelum stop() kembali');
  const after = runs; await sleep(80);
  assert.equal(runs, after, 'tidak ada iterasi baru setelah stop');
});
