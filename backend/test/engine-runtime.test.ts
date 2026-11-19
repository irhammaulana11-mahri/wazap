import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, dbAvailable } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService, FencedError } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb(15);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const authStore = skip ? (null as any) : createAuthStore({ db, leases, crypto: cr });
const qrStore = skip ? (null as any) : createQrStore({ db, leases, crypto: cr });
const queue = skip ? (null as any) : createMessageQueue(db, leases);
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: svc, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const runtimes: any[] = [];
after(async () => { for (const r of runtimes) await r.crash().catch(() => {}); await app?.close(); await t?.drop(); });

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}

async function newTenant() {
  const label = `r${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
/** Runtime baru dengan adapter palsu. node name unik per rig kecuali ditentukan. */
async function newEngine(opts: { node?: string; maxAttempts?: number; maxSessions?: number } = {}) {
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore, qrStore, queue, adapters, log: noLog,
    opts: {
      nodeName: opts.node ?? `eng-${++n}`, version: 't', capacity: { maxSessions: opts.maxSessions ?? 50 },
      heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: opts.maxAttempts ?? 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
const row = (id: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT s.status, s.status_reason, s.phone_number, s.desired_state, s.engine_id, s.auth_version, l.engine_id AS lease_engine, l.fencing_token FROM wa_sessions s JOIN session_leases l ON l.session_id = s.id WHERE s.id = $1', [id])).rows[0]);
const status = async (id: string) => (await row(id)).status;
const evs = async (tenantId: string, id: string) => (await svc.events(tenantId, id, 1, 100)).rows.reverse();
const count = (sql: string, args: any[]) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows[0].n as number);
const authCount = (id: string) => count('SELECT count(*)::int n FROM session_auth_state WHERE session_id = $1', [id]);

/** Sesi baru -> ditempatkan control-plane -> runner mulai (adapter dibuat). */
async function startSession(tn: any, e: any) {
  const s = await svc.create(tn.principal, { name: `s${++n}`, autoConnect: true });
  await cp.reconcile();
  assert.equal(await status(s.id), 'INITIALIZING');
  await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter dibuat');
  return { id: s.id as string, fake };
}
const stopAll = async () => { await db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`)); };

test('alur penuh: QR -> CONNECTED; QR terenkripsi, tidak ada di event, hilang setelah terhubung', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  fake.qr('QR-PAYLOAD-1');
  await waitFor(async () => (await status(id)) === 'QR_REQUIRED', 'QR_REQUIRED');
  assert.equal((await svc.getQr(tn.tenantId, id)).qr, 'QR-PAYLOAD-1');
  fake.qr('QR-PAYLOAD-2');
  await waitFor(async () => (await svc.getQr(tn.tenantId, id)).qr === 'QR-PAYLOAD-2', 'QR rotasi');
  const stored = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT ciphertext FROM session_qr WHERE session_id = $1', [id])).rows[0].ciphertext);
  assert.ok(!stored.includes(Buffer.from('QR-PAYLOAD')));

  // via HTTP: no-store, butuh scope/role, tenant lain 404
  const http = await app.inject({ url: `/api/v1/sessions/${id}/qr`, headers: { authorization: `Bearer ${tn.tok}` } });
  assert.equal(http.statusCode, 200); assert.equal(http.headers['cache-control'], 'no-store');
  assert.equal(http.json().data.qr, 'QR-PAYLOAD-2'); assert.match(http.json().data.qr_data_url, /^data:image\/png/);
  const other = await newTenant();
  assert.equal((await app.inject({ url: `/api/v1/sessions/${id}/qr`, headers: { authorization: `Bearer ${other.tok}` } })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/v1/sessions/${id}/qr` })).statusCode, 401);

  fake.open('628111');
  await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  assert.equal((await row(id)).phone_number, '628111');
  assert.equal(await count('SELECT count(*)::int n FROM session_qr WHERE session_id = $1', [id]), 0);
  await assert.rejects(svc.getQr(tn.tenantId, id), /QR tidak tersedia/);

  const list = await evs(tn.tenantId, id);
  assert.deepEqual(list.filter((x: any) => x.event_type === 'session.status_changed').map((x: any) => x.to_status), ['PENDING_ASSIGNMENT', 'QR_REQUIRED', 'CONNECTED']);
  assert.ok(!JSON.stringify(list).includes('QR-PAYLOAD'));
  assert.ok(list.some((x: any) => x.actor === 'ENGINE'));
});

test('connection_lost -> RECONNECTING dengan backoff -> CONNECTED; hitungan percobaan direset', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine({ maxAttempts: 2 });
  const { id, fake } = await startSession(tn, e);
  fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  for (let round = 0; round < 3; round++) { // 3 ronde > maxAttempts=2 hanya lolos bila hitungan direset saat open
    const cur = e.adapters.last(id); const before = e.adapters.forSession(id).length;
    cur.close('connection_lost', 408);
    await waitFor(async () => (await status(id)) === 'RECONNECTING', 'RECONNECTING');
    await waitFor(async () => e.adapters.forSession(id).length === before + 1, 'adapter baru setelah backoff');
    e.adapters.last(id).open();
    await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED lagi');
  }
});

test('gagal terus: melewati batas percobaan -> ERROR, lease dilepas, runner berhenti; connect() melempar dianggap putus', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine({ maxAttempts: 2 });
  const { id, fake } = await startSession(tn, e);
  fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  for (let i = 0; i < 2; i++) { // percobaan 1 & 2: tiap putus memicu spawn ulang
    const before = e.adapters.forSession(id).length;
    e.adapters.last(id).close('connection_lost');
    await waitFor(async () => e.adapters.forSession(id).length === before + 1, 'spawn ulang');
    assert.equal(await status(id), 'RECONNECTING');
  }
  e.adapters.last(id).close('connection_lost'); // putus ke-3 > maxAttempts
  await waitFor(async () => (await status(id)) === 'ERROR', 'ERROR');
  const r = await row(id);
  assert.equal(r.status_reason, 'max_reconnect_attempts'); assert.equal(r.lease_engine, null); assert.equal(r.engine_id, null);
  assert.equal(e.rt.getRunner(id), undefined);
  // connect() melempar => diperlakukan sebagai putus (RECONNECTING)
  const s2 = await svc.create(tn.principal, { name: `s${++n}`, autoConnect: true });
  e.adapters.nextConnectError = new Error('boom');
  await cp.reconcile(); await e.rt.tick();
  await waitFor(async () => (await status(s2.id)) === 'RECONNECTING', 'RECONNECTING karena connect gagal');
});

test('logged_out: LOGGED_OUT, auth state terhapus, lease lepas; connect ulang => pairing baru (creds baru)', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  await fake.ctx.auth.saveCreds(); fake.ctx.auth.state.creds.registered = true; await fake.ctx.auth.saveCreds();
  fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  assert.ok((await authCount(id)) > 0);
  fake.close('logged_out', 401);
  await waitFor(async () => (await status(id)) === 'LOGGED_OUT', 'LOGGED_OUT');
  const r = await row(id);
  assert.equal(r.lease_engine, null); assert.equal(r.desired_state, 'DISCONNECTED'); assert.equal(await authCount(id), 0);
  assert.equal(e.rt.getRunner(id), undefined);
  // pair ulang
  await svc.connect(tn.principal, id); await cp.reconcile(); await e.rt.tick();
  const f2 = await waitFor(async () => e.adapters.forSession(id)[1], 'adapter baru');
  assert.equal(f2.ctx.auth.registered, false, 'creds lama sudah terhapus: mulai dari awal');
});

test('restart_required setelah pairing: QR_REQUIRED -> CONNECTING -> CONNECTED dengan socket baru', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  fake.qr('Q'); await waitFor(async () => (await status(id)) === 'QR_REQUIRED', 'QR');
  fake.close('restart_required', 515);
  await waitFor(async () => e.adapters.forSession(id).length === 2, 'socket baru');
  assert.equal(await status(id), 'CONNECTING');
  e.adapters.last(id).open('62999'); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
});

test('QR tidak dipindai (putus saat QR_REQUIRED) -> ERROR qr_timeout; connection_replaced -> ERROR', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const a = await startSession(tn, e);
  a.fake.qr('Q'); await waitFor(async () => (await status(a.id)) === 'QR_REQUIRED', 'QR');
  a.fake.close('connection_lost', 408);
  await waitFor(async () => (await status(a.id)) === 'ERROR', 'ERROR');
  assert.equal((await row(a.id)).status_reason, 'qr_timeout');
  assert.equal(await count('SELECT count(*)::int n FROM session_qr WHERE session_id = $1', [a.id]), 0);
  const b = await startSession(tn, e);
  b.fake.open(); await waitFor(async () => (await status(b.id)) === 'CONNECTED', 'CONNECTED');
  b.fake.close('replaced', 440);
  await waitFor(async () => (await status(b.id)) === 'ERROR', 'ERROR replaced');
  assert.equal((await row(b.id)).status_reason, 'connection_replaced');
  assert.equal(e.adapters.forSession(b.id).length, 1, 'tidak berebut sesi: tanpa reconnect otomatis');
});

test('disconnect oleh user: socket ditutup tanpa logout, kredensial dipertahankan, DISCONNECTED, lease lepas', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  await fake.ctx.auth.saveCreds(); fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  await svc.disconnect(tn.principal, id);
  assert.equal(await status(id), 'DISCONNECTING');
  await e.rt.tick();
  await waitFor(async () => (await status(id)) === 'DISCONNECTED', 'DISCONNECTED');
  assert.deepEqual(fake.calls, ['connect', 'disconnect']);
  const r = await row(id); assert.equal(r.lease_engine, null); assert.equal(r.desired_state, 'DISCONNECTED');
  assert.ok((await authCount(id)) > 0, 'creds tetap ada untuk connect berikutnya');
  assert.equal(e.rt.getRunner(id), undefined);
});

test('delete: runner kehilangan lease -> logout best-effort; control-plane menghapus semua auth state -> DELETED', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  await fake.ctx.auth.saveCreds(); fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  await svc.remove(tn.principal, id);
  await e.rt.tick();
  await waitFor(async () => fake.calls.includes('logout'), 'logout dipanggil');
  await cp.reconcile();
  assert.equal(await status(id), 'DELETED');
  assert.equal(await authCount(id), 0);
  assert.equal(await count('SELECT count(*)::int n FROM session_credentials WHERE session_id = $1', [id]), 0);
});

test('reconnect oleh user: runner lama berhenti (tanpa logout), sesi ditempatkan ulang dengan fencing token baru', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const { id, fake } = await startSession(tn, e);
  fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  const tok1 = Number((await row(id)).fencing_token);
  await svc.reconnect(tn.principal, id);
  await e.rt.tick();
  await waitFor(async () => fake.calls.includes('disconnect'), 'runner lama berhenti');
  assert.ok(!fake.calls.includes('logout'));
  await cp.reconcile(); await e.rt.tick();
  await waitFor(async () => e.adapters.forSession(id).length === 2, 'runner baru');
  assert.ok(Number((await row(id)).fencing_token) > tok1);
});

test('takeover: engine lama (zombie) ditolak menulis setelah lease berpindah; tidak ada event/kredensial dari engine lama', { skip }, async () => {
  await stopAll(); const tn = await newTenant();
  const A = await newEngine({ node: `A-${++n}` });
  const { id, fake: fa } = await startSession(tn, A);
  await fa.ctx.auth.saveCreds(); fa.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED di A');
  const idA = A.rt.engineId;
  // A "macet": lease kedaluwarsa. B hidup; A tidak lagi menerima sesi.
  await engines.setStatus(idA, 'DRAINING');
  const B = await newEngine({ node: `B-${++n}` });
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`, [id]));
  await cp.reconcile(); // lease kedaluwarsa -> PENDING -> B
  await B.rt.tick();
  const fb = await waitFor(async () => B.adapters.last(id), 'runner di B');
  assert.equal((await row(id)).lease_engine, B.rt.engineId);
  const eventsBefore = (await evs(tn.tenantId, id)).length; const authV = (await row(id)).auth_version;

  // zombie A masih memegang socket dan mencoba menulis
  fa.close('logged_out', 401); // A mencoba menghapus auth + LOGGED_OUT
  await assert.rejects(fa.ctx.auth.saveCreds(), FencedError);
  await assert.rejects(fa.ctx.auth.state.keys.set({ session: { z: Buffer.from('z') } }), FencedError);
  await sleep(150);
  assert.equal(await status(id), 'INITIALIZING', 'tidak berubah oleh A');
  assert.equal((await row(id)).auth_version, authV);
  assert.equal((await evs(tn.tenantId, id)).length, eventsBefore);
  assert.ok((await authCount(id)) > 0, 'auth state tidak dihapus oleh zombie');
  await A.rt.tick(); // A sadar kehilangan lease
  assert.equal(A.rt.getRunner(id), undefined);
  fb.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED di B');
});

test('restart node: lease inkarnasi lama dipulihkan, sesi kembali ke antrean lalu tersambung dengan kredensial tersimpan', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const node = `R-${++n}`;
  const e1 = await newEngine({ node });
  const { id, fake } = await startSession(tn, e1);
  await fake.ctx.auth.saveCreds(); fake.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED');
  await e1.rt.crash(); // proses mati tanpa menulis apa pun
  assert.equal((await row(id)).lease_engine, e1.rt.engineId, 'lease masih tercatat');
  const e2 = await newEngine({ node }); // start() memulihkan yatim
  assert.equal(await status(id), 'PENDING_ASSIGNMENT');
  assert.equal((await row(id)).lease_engine, null);
  assert.ok((await evs(tn.tenantId, id)).some((x: any) => x.event_type === 'session.lease_expired'));
  await cp.reconcile(); await e2.rt.tick();
  const f2 = await waitFor(async () => e2.adapters.last(id), 'adapter baru');
  f2.open(); await waitFor(async () => (await status(id)) === 'CONNECTED', 'CONNECTED lagi');
  assert.ok((await authCount(id)) > 0);
});

test('stop rapi: socket ditutup, lease dilepas, sesi kembali PENDING_ASSIGNMENT, engine STOPPED', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const a = await startSession(tn, e); const b = await startSession(tn, e);
  a.fake.open('628001'); b.fake.open('628002');
  await waitFor(async () => (await status(a.id)) === 'CONNECTED' && (await status(b.id)) === 'CONNECTED', 'CONNECTED');
  await e.rt.stop();
  for (const s of [a, b]) {
    assert.equal(await status(s.id), 'PENDING_ASSIGNMENT'); assert.equal((await row(s.id)).lease_engine, null);
    assert.ok(s.fake.calls.includes('disconnect')); assert.ok(!s.fake.calls.includes('logout'));
  }
  const st = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT status FROM engine_nodes WHERE id = $1', [e.rt.engineId])).rows[0].status);
  assert.equal(st, 'STOPPED');
});

test('nomor telepon sudah dipakai sesi lain di tenant yang sama -> ERROR duplicate_phone_number, socket ditutup, lease dilepas', { skip }, async () => {
  await stopAll(); const tn = await newTenant(); const e = await newEngine();
  const a = await startSession(tn, e); const b = await startSession(tn, e);
  a.fake.open('62877'); await waitFor(async () => (await status(a.id)) === 'CONNECTED', 'A CONNECTED');
  b.fake.open('62877');
  await waitFor(async () => (await status(b.id)) === 'ERROR', 'B ERROR');
  assert.equal((await row(b.id)).status_reason, 'duplicate_phone_number');
  assert.equal((await row(b.id)).lease_engine, null);
  assert.ok(b.fake.calls.includes('disconnect'));
  assert.equal(await status(a.id), 'CONNECTED');
});

test('kode engine/adapter tidak pernah mengirim QR/kredensial ke log', () => {
  const dirs = ['src/modules/engine', 'src/modules/whatsapp'];
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    const src = fs.readFileSync(path.join(d, f), 'utf8');
    assert.ok(!/log\.(info|warn|error|debug)\([^)]*\b(qr|creds|auth\.state)\b/.test(src), `${d}/${f}`);
  }
});
