import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, dbAvailable, config } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { SendError } = await import('../src/modules/whatsapp/adapter.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService, FencedError } = await import('../src/modules/engine/lease.service.js');
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
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: svc, messages: createMessageService(db), checkDb: async () => true,
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
const stopAll = () => db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));

async function newTenant() {
  const label = `m${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
async function newEngine(send: any = {}) {
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: {
      nodeName: `meng-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0, ...send },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
/** Sesi CONNECTED di engine e (adapter palsu terbuka). */
async function connected(tn: any, e: any) {
  const s = await svc.create(tn.principal, { name: `ms${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter');
  fake.open(`62${800000000 + n}`);
  await waitFor(async () => (await svc.get(tn.tenantId, s.id)).status === 'CONNECTED', 'CONNECTED');
  return { id: s.id as string, fake };
}
const send = (tok: string, body: any, headers: any = {}) => app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: { ...bearer(tok), ...headers }, payload: { type: 'text', ...body } });
const job = async (tenantId: string, id: string) => (await app.inject({ url: `/api/v1/messages/${id}`, headers: bearer((await tokOf(tenantId))) })).json().data;
const toks = new Map<string, string>(); const tokOf = async (tid: string) => toks.get(tid)!;
const jobRow = (id: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT * FROM message_queue WHERE id = $1', [id])).rows[0]);
const attempts = (id: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT attempt_number, outcome, error_code FROM message_attempts WHERE job_id = $1 ORDER BY attempt_number', [id])).rows);
const statusOf = async (id: string) => (await jobRow(id)).status;
async function tenantWithSession(e?: any) {
  const tn = await newTenant(); toks.set(tn.tenantId, tn.tok);
  const s = e ? await connected(tn, e) : { id: (await svc.create(tn.principal, { name: `ms${++n}`, autoConnect: true })).id, fake: null as any };
  return { tn, ...s };
}

// ---------------------------------------------------------------- API

test('validasi: nomor, field tak dikenal, tipe, panjang; normalisasi nomor; sesi tenant lain 404; sesi tak tersambung 409', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const b = await tenantWithSession();
  for (const to of ['081234567890', 'abc', '12345', '+0628123456789', '6281234567890123456', '']) {
    const r = await send(a.tn.tok, { session_id: a.id, to, message: 'x' }); assert.equal(r.statusCode, 400, `to=${to}`);
  }
  for (const body of [{ tenant_id: a.tn.tenantId }, { engine_id: 'x' }, { type: 'image' }, { message: '' }, { message: 'x'.repeat(config.MESSAGE_MAX_LENGTH + 1) }, { priority: 10 }, { scheduled_at: new Date(Date.now() + 9 * 86400e3).toISOString() }]) {
    const r = await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'x', ...body }); assert.equal(r.statusCode, 400, JSON.stringify(body).slice(0, 60));
  }
  const ok = await send(a.tn.tok, { session_id: a.id, to: '+62 812-3456-7890', message: 'halo' });
  assert.equal(ok.statusCode, 202); assert.equal(ok.json().data.status, 'PENDING');
  assert.equal((await jobRow(ok.json().data.job_id)).recipient, '6281234567890');
  assert.equal((await send(a.tn.tok, { session_id: b.id, to: '6281234567890', message: 'x' })).statusCode, 404, 'sesi tenant lain');
  assert.equal((await send(a.tn.tok, { session_id: crypto.randomUUID(), to: '6281234567890', message: 'x' })).statusCode, 404);
  const created = await svc.create(a.tn.principal, { name: 'belum', autoConnect: false });
  const r = await send(a.tn.tok, { session_id: created.id, to: '6281234567890', message: 'x' });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'SESSION_UNAVAILABLE');
  assert.equal((await send('', { session_id: a.id })).statusCode, 401);
});

test('otorisasi API key: scope messages:send diperlukan; messages:read hanya baca; VIEWER tidak boleh kirim', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession();
  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tn.tok), payload: { name: 'k' + ++n, scopes } })).json().data.key as string;
  const body = { session_id: a.id, to: '6281234567890', type: 'text', message: 'x' };
  const post = (key: string) => app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: { 'x-api-key': key }, payload: body });
  assert.equal((await post(await mk(['sessions:write', 'messages:read']))).statusCode, 403);
  const sendKey = await mk(['messages:send']);
  const r = await post(sendKey); assert.equal(r.statusCode, 202);
  assert.equal((await app.inject({ url: '/api/v1/messages', headers: { 'x-api-key': sendKey } })).statusCode, 403, 'send tidak mencakup read');
  const readKey = await mk(['messages:read']);
  const l = await app.inject({ url: '/api/v1/messages', headers: { 'x-api-key': readKey } });
  assert.equal(l.statusCode, 200); assert.equal(l.json().meta.total, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/messages/${r.json().data.job_id}/cancel`, headers: { 'x-api-key': readKey } })).statusCode, 403);
});

test('idempotensi: replay mengembalikan job sama; payload beda 422; tenant berbeda independen; 10 request paralel => 1 job', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const b = await tenantWithSession();
  const body = { session_id: a.id, to: '6281234567890', message: 'satu' };
  const r1 = await send(a.tn.tok, body, { 'idempotency-key': 'order-1' });
  const r2 = await send(a.tn.tok, body, { 'idempotency-key': 'order-1' });
  assert.equal(r1.statusCode, 202); assert.equal(r2.statusCode, 202);
  assert.equal(r2.json().data.job_id, r1.json().data.job_id); assert.equal(r2.headers['idempotent-replayed'], 'true'); assert.equal(r1.headers['idempotent-replayed'], undefined);
  const diff = await send(a.tn.tok, { ...body, message: 'dua' }, { 'idempotency-key': 'order-1' });
  assert.equal(diff.statusCode, 422); assert.equal(diff.json().error.code, 'IDEMPOTENCY_CONFLICT');
  const other = await send(b.tn.tok, { session_id: b.id, to: '6281234567890', message: 'satu' }, { 'idempotency-key': 'order-1' });
  assert.equal(other.statusCode, 202); assert.notEqual(other.json().data.job_id, r1.json().data.job_id);
  assert.equal((await send(a.tn.tok, body, { 'idempotency-key': 'bad key with space' })).statusCode, 400);
  const par = await Promise.all(Array.from({ length: 10 }, () => send(a.tn.tok, { ...body, message: 'paralel' }, { 'idempotency-key': 'par-1' })));
  assert.ok(par.every((r: any) => r.statusCode === 202));
  assert.equal(new Set(par.map((r: any) => r.json().data.job_id)).size, 1);
  const n1 = await db.tx({ platform: true }, async (c: any) => (await c.query(`SELECT count(*)::int n FROM message_queue WHERE tenant_id = $1 AND idempotency_key = 'par-1'`, [a.tn.tenantId])).rows[0].n);
  assert.equal(n1, 1);
  // tanpa Idempotency-Key => tidak dedupe
  const x = await send(a.tn.tok, body); const y = await send(a.tn.tok, body);
  assert.notEqual(x.json().data.job_id, y.json().data.job_id);
});

test('batas antrean per tenant => 429 QUEUE_FULL (replay idempoten tetap lolos)', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const orig = config.MAX_PENDING_PER_TENANT;
  try {
    (config as any).MAX_PENDING_PER_TENANT = 2;
    const body = { session_id: a.id, to: '6281234567890', message: 'q' };
    assert.equal((await send(a.tn.tok, body, { 'idempotency-key': 'k1' })).statusCode, 202);
    assert.equal((await send(a.tn.tok, body)).statusCode, 202);
    const full = await send(a.tn.tok, body); assert.equal(full.statusCode, 429); assert.equal(full.json().error.code, 'QUEUE_FULL');
    assert.equal((await send(a.tn.tok, body, { 'idempotency-key': 'k1' })).statusCode, 202, 'replay tidak ditolak');
  } finally { (config as any).MAX_PENDING_PER_TENANT = orig; }
});

test('list/get/status/cancel/retry: isolasi tenant (404), filter, paginasi, cancel hanya PENDING', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const b = await tenantWithSession();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: `m${i}` })).json().data.job_id);
  const L = await app.inject({ url: '/api/v1/messages?page_size=2&status=PENDING', headers: bearer(a.tn.tok) });
  assert.equal(L.json().data.length, 2); assert.equal(L.json().meta.total, 3);
  assert.equal((await app.inject({ url: '/api/v1/messages', headers: bearer(b.tn.tok) })).json().meta.total, 0);
  assert.equal((await app.inject({ url: `/api/v1/messages?session_id=${b.id}`, headers: bearer(a.tn.tok) })).json().meta.total, 0);
  for (const [m, u] of [['GET', ''], ['GET', '/status'], ['POST', '/cancel'], ['POST', '/retry']] as const) {
    const r = await app.inject({ method: m, url: `/api/v1/messages/${ids[0]}${u}`, headers: bearer(b.tn.tok) }); assert.equal(r.statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await app.inject({ url: '/api/v1/messages/not-a-uuid', headers: bearer(a.tn.tok) })).statusCode, 404);
  const g = (await app.inject({ url: `/api/v1/messages/${ids[0]}`, headers: bearer(a.tn.tok) })).json().data;
  assert.equal(g.message, 'm0'); assert.equal(g.to, '6281234567890'); assert.deepEqual(g.attempt_history, []);
  for (const k of ['tenant_id', 'payload', 'request_hash', 'idempotency_key', 'processing_engine_id']) assert.equal(g[k], undefined, k);
  const c1 = await app.inject({ method: 'POST', url: `/api/v1/messages/${ids[0]}/cancel`, headers: bearer(a.tn.tok) });
  assert.equal(c1.json().data.status, 'CANCELLED');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/messages/${ids[0]}/cancel`, headers: bearer(a.tn.tok) })).statusCode, 200, 'cancel idempoten');
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_queue SET status = 'SENT', completed_at = now() WHERE id = $1`, [ids[1]]));
  const c2 = await app.inject({ method: 'POST', url: `/api/v1/messages/${ids[1]}/cancel`, headers: bearer(a.tn.tok) });
  assert.equal(c2.statusCode, 409); assert.equal(c2.json().error.code, 'INVALID_STATE');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/messages/${ids[1]}/retry`, headers: bearer(a.tn.tok) })).statusCode, 409, 'SENT tidak bisa di-retry');
});

test('message_attempts append-only; tenant tidak dapat menulis percobaan', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession();
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'x' })).json().data.job_id;
  await assert.rejects(db.tx({ tenantId: a.tn.tenantId }, (c: any) => c.query(`INSERT INTO message_attempts (tenant_id, job_id, attempt_number) VALUES ($1,$2,1)`, [a.tn.tenantId, id])), /row-level security/);
  await db.tx({ platform: true }, async (c: any) => {
    await c.query(`INSERT INTO message_attempts (tenant_id, job_id, attempt_number) VALUES ($1,$2,1)`, [a.tn.tenantId, id]);
    await c.query(`UPDATE message_attempts SET outcome = 'SENT', finished_at = now() WHERE job_id = $1`, [id]);
  });
  await assert.rejects(db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_attempts SET outcome = 'FAILED' WHERE job_id = $1`, [id])), /tidak dapat diubah/);
  // DELETE langsung: RLS tidak punya kebijakan DELETE (0 baris terhapus) dan trigger menolak bila lolos.
  const del = await db.tx({ platform: true }, (c: any) => c.query(`DELETE FROM message_attempts WHERE job_id = $1`, [id]));
  assert.equal(del.rowCount, 0);
  assert.equal((await attempts(id)).length, 1);
});

// ---------------------------------------------------------------- pengiriman (engine)

test('pengiriman: PENDING -> SENT, provider id tercatat, riwayat percobaan; pesan ke adapter sesuai', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  const id = (await send(a.tn.tok, { session_id: a.id, to: '+62 812 3456 7890', message: 'halo dunia' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'SENT', 'SENT');
  const r = await jobRow(id);
  assert.equal(r.provider_message_id, 'PM-1'); assert.ok(r.completed_at); assert.equal(r.attempts, 1); assert.equal(r.processing_engine_id, null);
  assert.deepEqual(a.fake.sent, [{ to: '6281234567890', text: 'halo dunia' }]);
  assert.deepEqual(await attempts(id), [{ attempt_number: 1, outcome: 'SENT', error_code: null }]);
  const g = (await app.inject({ url: `/api/v1/messages/${id}/status`, headers: bearer(a.tn.tok) })).json().data;
  assert.equal(g.status, 'SENT');
});

test('lane serial per sesi: urut prioritas lalu FIFO, tidak pernah paralel, ada jeda antar kirim', { skip }, async () => {
  await stopAll(); const e = await newEngine({ intervalMs: 40 });
  const a = await tenantWithSession(e);
  a.fake.sendScript.push({ delayMs: 30 }, { delayMs: 30 }, { delayMs: 30 }, { delayMs: 30 });
  // antre saat pompa belum sempat jalan: tahan dengan scheduled_at sama (segera) -> urutan oleh prioritas
  const mk = (message: string, priority: number) => send(a.tn.tok, { session_id: a.id, to: '6281234567890', message, priority });
  const ids = [(await mk('low-1', 1)).json().data.job_id, (await mk('hi-1', 9)).json().data.job_id, (await mk('low-2', 1)).json().data.job_id, (await mk('hi-2', 9)).json().data.job_id];
  await waitFor(async () => (await Promise.all(ids.map(statusOf))).every((s) => s === 'SENT'), 'semua SENT');
  const order = a.fake.sent.map((m: any) => m.text);
  // job pertama yang sempat diklaim boleh berupa apa saja; sisanya harus patuh prioritas+FIFO
  const rest = order.slice(1);
  const rank = (m: string) => (m.startsWith('hi') ? 0 : 1);
  assert.deepEqual([...rest].sort((x: string, y: string) => rank(x) - rank(y) || order.indexOf(x) - order.indexOf(y)), rest, `urutan: ${order}`);
  assert.equal(a.fake.maxConcurrent, 1);
  const gaps = a.fake.sendTimes.slice(1).map((v: number, i: number) => v - a.fake.sendTimes[i]);
  assert.ok(gaps.every((g: number) => g >= 40), `jeda antar kirim: ${gaps}`);
});

test('gagal sebelum terkirim di-retry dengan backoff; melewati batas => FAILED MAX_ATTEMPTS_REACHED', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  a.fake.sendScript.push(new SendError('not_connected', 'NOT_CONNECTED'), new SendError('transient', 'RECIPIENT_CHECK_FAILED'));
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'retry' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'SENT', 'SENT setelah retry');
  assert.deepEqual((await attempts(id)).map((x: any) => x.outcome), ['RETRY', 'RETRY', 'SENT']);
  assert.equal((await jobRow(id)).attempts, 3);

  a.fake.sendScript.push(new SendError('not_connected', 'NOT_CONNECTED'), new SendError('not_connected', 'NOT_CONNECTED'), new SendError('not_connected', 'NOT_CONNECTED'));
  const id2 = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'habis' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id2)) === 'FAILED', 'FAILED');
  assert.equal((await jobRow(id2)).last_error_code, 'MAX_ATTEMPTS_REACHED');
  assert.deepEqual((await attempts(id2)).map((x: any) => x.outcome), ['RETRY', 'RETRY', 'FAILED']);
});

test('nomor tidak terdaftar => FAILED permanen tanpa retry', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  a.fake.sendScript.push(new SendError('recipient_invalid', 'RECIPIENT_NOT_ON_WHATSAPP'));
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'x' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'FAILED', 'FAILED');
  const r = await jobRow(id); assert.equal(r.last_error_code, 'RECIPIENT_NOT_ON_WHATSAPP'); assert.equal(r.attempts, 1);
  assert.equal(a.fake.calls.filter((c: string) => c === 'send').length, 1);
});

test('hasil ambigu => UNKNOWN, TIDAK di-retry otomatis; retry manual wajib konfirmasi risiko duplikat', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  a.fake.sendScript.push(new SendError('ambiguous', 'SEND_OUTCOME_UNKNOWN'));
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'ambigu' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'UNKNOWN', 'UNKNOWN');
  await sleep(200);
  assert.equal(await statusOf(id), 'UNKNOWN'); assert.equal(a.fake.calls.filter((c: string) => c === 'send').length, 1, 'tidak dikirim ulang');
  const no = await app.inject({ method: 'POST', url: `/api/v1/messages/${id}/retry`, headers: bearer(a.tn.tok), payload: {} });
  assert.equal(no.statusCode, 409); assert.equal(no.json().error.code, 'CONFIRMATION_REQUIRED');
  const yes = await app.inject({ method: 'POST', url: `/api/v1/messages/${id}/retry`, headers: bearer(a.tn.tok), payload: { confirm_duplicate_risk: true } });
  assert.equal(yes.statusCode, 202); assert.equal(yes.json().data.status, 'PENDING');
  await waitFor(async () => (await statusOf(id)) === 'SENT', 'SENT setelah retry manual');
  assert.deepEqual((await attempts(id)).map((x: any) => x.outcome), ['UNKNOWN', 'SENT']);
});

test('engine mati saat kirim: job PROCESSING direkonsiliasi => RECONCILIATION_REQUIRED, tidak dikirim ulang engine lain', { skip }, async () => {
  await stopAll(); const e1 = await newEngine();
  const a = await tenantWithSession(e1);
  a.fake.sendScript.push({ delayMs: 600_000 }); // "hang": proses mati di tengah kirim
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'mati' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'PROCESSING', 'PROCESSING');
  await e1.rt.crash();
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_queue SET processing_expires_at = now() - interval '1 second' WHERE id = $1`, [id]));
  const rep = await cp.reconcile();
  assert.equal(rep.messages.abandoned, 1);
  const r = await jobRow(id); assert.equal(r.status, 'RECONCILIATION_REQUIRED'); assert.equal(r.last_error_code, 'PROCESSING_TIMEOUT');
  assert.deepEqual((await attempts(id)).map((x: any) => x.outcome), ['ABANDONED']);
  // engine lain mengambil sesi: job tidak dikirim ulang
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`, [a.id]));
  await engines.setStatus(e1.rt.engineId, 'DRAINING'); // e1 "mati": tidak boleh menerima sesi lagi
  const e2 = await newEngine(); await cp.reconcile(); await e2.rt.tick();
  const f2 = await waitFor(async () => e2.adapters.last(a.id), 'adapter e2'); f2.open('628111222');
  await waitFor(async () => (await svc.get(a.tn.tenantId, a.id)).status === 'CONNECTED', 'CONNECTED e2');
  await sleep(200);
  assert.equal(f2.sent.length, 0); assert.equal(await statusOf(id), 'RECONCILIATION_REQUIRED');
});

test('batas pesan/menit tenant: klaim ditunda (wait) setelah batas; tenant lain tidak terpengaruh', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const b = await tenantWithSession();
  await db.tx({ tenantId: a.tn.tenantId }, (c: any) => c.query('UPDATE tenant_settings SET messages_per_minute = 2 WHERE tenant_id = $1', [a.tn.tenantId]));
  const eid = (await engines.register({ nodeName: `rl-${++n}`, hostname: 'h', version: '1', capacity: { maxSessions: 9 } })).id;
  const la = (await leases.acquire(a.id, eid))!; const lb = (await leases.acquire(b.id, eid))!;
  for (let i = 0; i < 4; i++) await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: `a${i}` });
  await send(b.tn.tok, { session_id: b.id, to: '6281234567890', message: 'b0' });
  assert.equal((await queue.claim(la, a.tn.tenantId)).kind, 'job');
  assert.equal((await queue.claim(la, a.tn.tenantId)).kind, 'job');
  const w = await queue.claim(la, a.tn.tenantId);
  assert.equal(w.kind, 'wait'); assert.ok(w.waitMs >= 100 && w.waitMs <= 60_000, String(w.waitMs));
  assert.equal((await queue.claim(lb, b.tn.tenantId)).kind, 'job', 'tenant B tidak terpengaruh batas tenant A');
  const left = await db.tx({ platform: true }, async (c: any) => (await c.query(`SELECT count(*)::int n FROM message_queue WHERE tenant_id = $1 AND status = 'PENDING'`, [a.tn.tenantId])).rows[0].n);
  assert.equal(left, 2, 'job sisa tetap PENDING, tidak hilang');
});

test('klaim konkuren: tiap job diklaim tepat sekali; hasil dari engine yang kehilangan lease ditolak (fencing)', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession();
  await db.tx({ tenantId: a.tn.tenantId }, (c: any) => c.query('UPDATE tenant_settings SET messages_per_minute = 1000 WHERE tenant_id = $1', [a.tn.tenantId]));
  const e1 = (await engines.register({ nodeName: `c1-${++n}`, hostname: 'h', version: '1', capacity: { maxSessions: 9 } })).id;
  const e2 = (await engines.register({ nodeName: `c2-${++n}`, hostname: 'h', version: '1', capacity: { maxSessions: 9 } })).id;
  const l1 = (await leases.acquire(a.id, e1))!;
  for (let i = 0; i < 6; i++) await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: `c${i}` });
  const res = await Promise.all(Array.from({ length: 12 }, () => queue.claim(l1, a.tn.tenantId)));
  const claimed = res.filter((r: any) => r.kind === 'job').map((r: any) => r.job.id);
  assert.equal(claimed.length, 6); assert.equal(new Set(claimed).size, 6);
  // takeover: l1 kedaluwarsa, e2 mengambil alih; hasil dari l1 ditolak
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`, [a.id]));
  assert.ok(await leases.acquire(a.id, e2));
  const j = (res.find((r: any) => r.kind === 'job') as any).job;
  await assert.rejects(queue.complete(l1, j, { kind: 'sent', providerMessageId: 'ZZ' }), FencedError);
  assert.equal(await statusOf(j.id), 'PROCESSING');
});

test('fairness antar tenant: tenant kecil tidak menunggu antrean tenant besar (lane per sesi)', { skip }, async () => {
  await stopAll(); const e = await newEngine({ intervalMs: 30 });
  const big = await tenantWithSession(e); const small = await tenantWithSession(e);
  for (const x of [big, small]) await db.tx({ tenantId: x.tn.tenantId }, (c: any) => c.query('UPDATE tenant_settings SET messages_per_minute = 1000 WHERE tenant_id = $1', [x.tn.tenantId]));
  const bigIds: string[] = [];
  for (let i = 0; i < 8; i++) bigIds.push((await send(big.tn.tok, { session_id: big.id, to: '6281234567890', message: `big${i}` })).json().data.job_id);
  const sid = (await send(small.tn.tok, { session_id: small.id, to: '6281234567890', message: 'kecil' })).json().data.job_id;
  await waitFor(async () => (await statusOf(sid)) === 'SENT', 'tenant kecil SENT');
  const done = (await Promise.all(bigIds.map(statusOf))).filter((s) => s === 'SENT').length;
  assert.ok(done < 8, `tenant kecil selesai sebelum antrean besar habis (besar selesai: ${done})`);
});

test('cancel tidak dapat menarik job yang sedang diproses; disconnect user menunggu pengiriman berjalan selesai (bukan UNKNOWN)', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  a.fake.sendScript.push({ delayMs: 250 });
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'lambat' })).json().data.job_id;
  await waitFor(async () => (await statusOf(id)) === 'PROCESSING', 'PROCESSING');
  const c = await app.inject({ method: 'POST', url: `/api/v1/messages/${id}/cancel`, headers: bearer(a.tn.tok) });
  assert.equal(c.statusCode, 409);
  await svc.disconnect(a.tn.principal, a.id); await e.rt.tick();
  await waitFor(async () => (await svc.get(a.tn.tenantId, a.id)).status === 'DISCONNECTED', 'DISCONNECTED');
  assert.equal(await statusOf(id), 'SENT');
  assert.deepEqual(a.fake.calls.filter((x: string) => x === 'send' || x === 'disconnect'), ['send', 'disconnect']);
});

test('kedaluwarsa: PENDING lewat TTL => FAILED EXPIRED; sesi dihapus => PENDING dibatalkan SESSION_DELETED', { skip }, async () => {
  await stopAll();
  const a = await tenantWithSession(); const b = await tenantWithSession();
  const old = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'lama' })).json().data.job_id;
  const fresh = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'baru' })).json().data.job_id;
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_queue SET scheduled_at = now() - interval '2 days' WHERE id = $1`, [old]));
  const rep = await cp.reconcile(); assert.ok(rep.messages.expired >= 1);
  assert.equal(await statusOf(old), 'FAILED'); assert.equal((await jobRow(old)).last_error_code, 'EXPIRED'); assert.equal(await statusOf(fresh), 'PENDING');
  const pend = (await send(b.tn.tok, { session_id: b.id, to: '6281234567890', message: 'akan batal' })).json().data.job_id;
  await svc.remove(b.tn.principal, b.id); await cp.reconcile();
  assert.equal(await statusOf(pend), 'CANCELLED'); assert.equal((await jobRow(pend)).last_error_code, 'SESSION_DELETED');
});

test('pesan terjadwal: tidak dikirim sebelum waktunya', { skip }, async () => {
  await stopAll(); const e = await newEngine();
  const a = await tenantWithSession(e);
  const when = new Date(Date.now() + 700).toISOString();
  const id = (await send(a.tn.tok, { session_id: a.id, to: '6281234567890', message: 'nanti', scheduled_at: when })).json().data.job_id;
  await sleep(300);
  assert.equal(await statusOf(id), 'PENDING'); assert.equal(a.fake.sent.length, 0);
  await waitFor(async () => (await statusOf(id)) === 'SENT', 'SENT setelah jadwal');
  assert.ok(a.fake.sendTimes[0] >= Date.parse(when) - 20);
});

test('control-plane: sesi PENDING yang lease-nya masih dipegang pihak lain dilewati, tidak menghentikan penempatan sesi lain', { skip }, async () => {
  await stopAll();
  const blocked = await tenantWithSession();
  const holder = (await engines.register({ nodeName: `h-${++n}`, hostname: 'h', version: '1', capacity: { maxSessions: 9 } })).id;
  assert.ok(await leases.acquire(blocked.id, holder));
  const e = await newEngine();
  const ok = await tenantWithSession();
  const rep = await cp.reconcile(); await e.rt.tick();
  assert.ok(rep.assigned >= 1);
  await waitFor(async () => e.adapters.last(ok.id), 'sesi lain tetap ditempatkan');
});

test('isi pesan dan nomor tujuan tidak pernah masuk log engine/messaging', () => {
  for (const d of ['src/modules/engine', 'src/modules/messaging', 'src/modules/whatsapp']) for (const f of fs.readdirSync(d)) {
    const src = fs.readFileSync(path.join(d, f), 'utf8');
    assert.ok(!/log\.(info|warn|error|debug)\([^)]*\b(text|recipient|message|payload)\b/.test(src), `${d}/${f}`);
  }
});
