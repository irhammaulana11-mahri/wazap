import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, dbAvailable } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { fetchMedia, MediaError } = await import('../src/modules/media/fetch.js');
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
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { config } = await import('../src/config/env.js');

const LAB = { allowHttp: true, allowPrivate: true };
const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases, { retryBaseMs: 10, retryMaxMs: 40, random: () => 0 });
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const msgs = skip ? (null as any) : createMessageService(db, { mediaPolicy: LAB });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: svc, messages: msgs, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const servers: http.Server[] = []; const runtimes: any[] = [];
after(async () => {
  for (const r of runtimes) await r.crash().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await app?.close(); await t?.drop();
});

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const stopAll = () => db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));
async function newTenant() {
  const label = `md${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string };
}
async function newEngine() {
  await stopAll();
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    fetchMedia: (url, kind, hint) => fetchMedia(url, kind, { maxBytes: 2048, timeoutMs: 500, policy: LAB, hintMime: hint }),
    opts: {
      nodeName: `meng-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: 1, syncIntervalMs: 10_000,
      reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0 },
    },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
async function connected(tn: any, e: any) {
  const s = await svc.create(tn.principal, { name: `mds${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const fake = await waitFor(async () => e.adapters.last(s.id), 'adapter');
  fake.open(`62${800000000 + n}`);
  await waitFor(async () => (await svc.get(tn.tenantId, s.id)).status === 'CONNECTED', 'CONNECTED');
  return { id: s.id as string, fake };
}
/** Server media lokal. `handler` menentukan balasan; `last` mencatat jumlah permintaan. */
async function mediaServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, k: number) => void) {
  let k = 0;
  const srv = http.createServer((req, res) => handler(req, res, ++k));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/m`, count: () => k };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const post = (tok: string, url: string, payload: any, headers: any = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...bearer(tok), ...headers }, payload });
const job = async (id: string) => (await q('SELECT status, attempts, last_error_code FROM message_queue WHERE id = $1', [id]))[0];

// ---------- fetchMedia ----------

test('fetchMedia: sukses, tipe konten, hint mimetype dokumen', async () => {
  const srv = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'image/png; charset=binary' }).end(PNG));
  const m = await fetchMedia(srv.url, 'image', { maxBytes: 1024, timeoutMs: 1000, policy: LAB });
  assert.equal(m.mimetype, 'image/png'); assert.deepEqual(m.data, PNG);
  const doc = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('PDFDATA'));
  assert.equal((await fetchMedia(doc.url, 'document', { maxBytes: 1024, timeoutMs: 1000, policy: LAB, hintMime: 'application/pdf' })).mimetype, 'application/pdf');
  assert.equal((await fetchMedia(doc.url, 'document', { maxBytes: 1024, timeoutMs: 1000, policy: LAB })).mimetype, 'application/octet-stream');
});

test('fetchMedia: galat permanen vs sementara diklasifikasi benar', async () => {
  const run = async (handler: any, kind: any = 'image', o: any = {}) => {
    const srv = await mediaServer(handler);
    return fetchMedia(srv.url, kind, { maxBytes: 1024, timeoutMs: 400, policy: LAB, ...o }).then(() => null, (e: any) => e);
  };
  const e404 = await run((_r: any, res: any) => res.writeHead(404).end());
  assert.deepEqual([e404.code, e404.retryable], ['MEDIA_HTTP_404', false]);
  const e500 = await run((_r: any, res: any) => res.writeHead(503).end());
  assert.deepEqual([e500.code, e500.retryable], ['MEDIA_HTTP_503', true]);
  const e429 = await run((_r: any, res: any) => res.writeHead(429).end());
  assert.equal(e429.retryable, true);
  const redir = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  const e302 = await run((_r: any, res: any) => res.writeHead(302, { location: redir.url }).end());
  assert.deepEqual([e302.code, e302.retryable], ['MEDIA_REDIRECT_NOT_FOLLOWED', false]);
  assert.equal(redir.count(), 0, 'redirect tidak diikuti');
  const eType = await run((_r: any, res: any) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'));
  assert.deepEqual([eType.code, eType.retryable], ['MEDIA_TYPE_INVALID', false]);
  const eHtmlDoc = await run((_r: any, res: any) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'), 'document');
  assert.equal(eHtmlDoc.code, 'MEDIA_TYPE_INVALID', 'dokumen pun tidak boleh HTML');
  const eLen = await run((_r: any, res: any) => res.writeHead(200, { 'content-type': 'image/png', 'content-length': '999999' }).end());
  assert.equal(eLen.code, 'MEDIA_TOO_LARGE');
  const eStream = await run((_r: any, res: any) => { res.writeHead(200, { 'content-type': 'image/png' }); res.write(Buffer.alloc(900)); res.end(Buffer.alloc(900)); }); // chunked, tanpa Content-Length
  assert.deepEqual([eStream.code, eStream.retryable], ['MEDIA_TOO_LARGE', false]);
  const eEmpty = await run((_r: any, res: any) => res.writeHead(200, { 'content-type': 'image/png' }).end());
  assert.equal(eEmpty.code, 'MEDIA_EMPTY');
  const t0 = Date.now();
  const eSlow = await run((_r: any, res: any) => setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG), 3000).unref());
  assert.deepEqual([eSlow.code, eSlow.retryable], ['MEDIA_FETCH_TIMEOUT', true]);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(e404 instanceof MediaError);
});

test('fetchMedia: kebijakan produksi memblokir alamat internal tanpa koneksi', async () => {
  const srv = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  const prod = { allowHttp: true, allowPrivate: false };
  const e = await fetchMedia(srv.url, 'image', { maxBytes: 1024, timeoutMs: 500, policy: prod }).catch((x) => x);
  assert.equal(e.code, 'MEDIA_URL_BLOCKED'); assert.equal(e.retryable, false); assert.equal(srv.count(), 0);
  const rebind = await fetchMedia('http://rebind.example/x.png', 'image', { maxBytes: 1024, timeoutMs: 500, policy: prod, resolve: async () => ['8.8.8.8', '10.0.0.1'] }).catch((x) => x);
  assert.equal(rebind.code, 'MEDIA_URL_BLOCKED', 'satu alamat privat di hasil DNS menolak seluruh koneksi');
  assert.equal((await fetchMedia('ftp://x/y', 'image', { maxBytes: 1, timeoutMs: 100, policy: prod }).catch((x) => x)).code, 'MEDIA_URL_BLOCKED');
});

// ---------- enqueue send-media ----------

test('send-media: antre dengan tipe & payload, tampil di GET, idempotensi, validasi, scope', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const body = { session_id: s.id, to: '+62 812-3456-7890', type: 'image', url: 'http://127.0.0.1:9/a.png', caption: 'lihat ini' };
  const r1 = await post(tn.tok, '/messages/send-media', body, { 'idempotency-key': 'm-1' });
  assert.equal(r1.statusCode, 202);
  const id = r1.json().data.job_id;
  const r2 = await post(tn.tok, '/messages/send-media', body, { 'idempotency-key': 'm-1' });
  assert.equal(r2.headers['idempotent-replayed'], 'true'); assert.equal(r2.json().data.job_id, id);
  const diff = await post(tn.tok, '/messages/send-media', { ...body, caption: 'lain' }, { 'idempotency-key': 'm-1' });
  assert.equal(diff.statusCode, 422); assert.equal(diff.json().error.code, 'IDEMPOTENCY_CONFLICT');
  await stopAll(); // jangan sampai terkirim ke 127.0.0.1:9
  const row = (await q('SELECT message_type, payload, recipient FROM message_queue WHERE id = $1', [id]))[0];
  assert.deepEqual([row.message_type, row.recipient, row.payload.url, row.payload.caption], ['image', '6281234567890', 'http://127.0.0.1:9/a.png', 'lihat ini']);
  const view = (await app.inject({ url: `/api/v1/messages/${id}`, headers: bearer(tn.tok) })).json().data;
  assert.equal(view.type, 'image'); assert.equal(view.message, 'lihat ini'); assert.equal(view.media.url, 'http://127.0.0.1:9/a.png');

  const bad = (extra: any) => post(tn.tok, '/messages/send-media', { ...body, ...extra });
  assert.equal((await bad({ type: 'sticker' })).statusCode, 400);
  assert.equal((await bad({ type: 'audio', caption: 'x' })).statusCode, 400, 'audio tanpa caption');
  assert.equal((await bad({ filename: 'a.png' })).statusCode, 400, 'filename hanya untuk document');
  assert.equal((await bad({ mimetype: 'bukan mime' })).statusCode, 400);
  assert.equal((await bad({ url: undefined })).statusCode, 400);
  assert.equal((await bad({ extra: 1 })).statusCode, 400);
  assert.equal((await bad({ caption: 'x'.repeat(1025) })).statusCode, 400);
  assert.equal((await bad({ to: '0812345' })).statusCode, 400);
  assert.equal((await bad({ session_id: crypto.randomUUID() })).statusCode, 404);
  const key = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(tn.tok), payload: { name: 'k' + ++n, scopes } })).json().data.key as string;
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/messages/send-media', headers: { 'x-api-key': await key(['messages:read']) }, payload: body })).statusCode, 403);
});

test('send-media: URL internal ditolak 422 pada kebijakan produksi', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const prod = createMessageService(db, { mediaPolicy: { allowHttp: false, allowPrivate: false }, resolve: async (h) => (h === 'rebind.example' ? ['10.0.0.9'] : ['93.184.216.34']) });
  for (const url of ['http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://169.254.169.254/x', 'https://rebind.example/a.png', 'https://u:p@example.com/a.png']) {
    await assert.rejects(prod.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'image', url, priority: 5 }), (er: any) => er.status === 422 && er.code === 'INVALID_MEDIA_URL', url);
  }
  await assert.doesNotReject(prod.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'image', url: 'https://example.com/a.png', priority: 5 }));
});

// ---------- pengiriman media lewat engine ----------

test('E2E media: diunduh, dikirim lewat adapter dengan tipe/caption/nama berkas; dicerminkan ke riwayat', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const img = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  const pdf = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('%PDF-1.4 isi'));
  const m1 = await msgs.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'image', url: img.url, caption: 'foto', priority: 5 });
  const m2 = await msgs.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'document', url: pdf.url, filename: 'laporan.pdf', mimetype: 'application/pdf', caption: 'terlampir', priority: 5 });
  await waitFor(async () => (await job(m1.job_id)).status === 'SENT' && (await job(m2.job_id)).status === 'SENT', 'terkirim');
  const sent = s.fake.media;
  assert.deepEqual(sent.map((x: any) => [x.kind, x.bytes, x.caption, x.filename, x.mimetype]), [
    ['image', PNG.length, 'foto', undefined, 'image/png'],
    ['document', 12, 'terlampir', 'laporan.pdf', 'application/pdf'],
  ]);
  const hist = await q(`SELECT message_type, body, status FROM wa_messages WHERE session_id = $1 ORDER BY occurred_at, id`, [s.id]);
  assert.deepEqual(hist.map((h: any) => [h.message_type, h.body, h.status]).sort(), [['document', 'terlampir', 'SENT'], ['image', 'foto', 'SENT']]);
});

test('E2E media: audio dikirim tanpa caption', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const au = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'audio/ogg' }).end('OggS...'));
  const m = await msgs.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'audio', url: au.url, priority: 5 });
  await waitFor(async () => (await job(m.job_id)).status === 'SENT', 'SENT');
  assert.deepEqual([s.fake.media[0].kind, s.fake.media[0].caption, s.fake.media[0].mimetype], ['audio', undefined, 'audio/ogg']);
});

test('E2E media: 404/ukuran/tipe => FAILED permanen satu percobaan, tidak ada yang terkirim', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const nf = await mediaServer((_r, res) => res.writeHead(404).end());
  const big = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(5000)));
  const html = await mediaServer((_r, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>x</h1>'));
  const ids = await Promise.all([nf, big, html].map((m) => msgs.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'image', url: m.url, priority: 5 })));
  await waitFor(async () => (await Promise.all(ids.map((i) => job(i.job_id)))).every((j) => j.status === 'FAILED'), 'semua FAILED');
  const js = await Promise.all(ids.map((i) => job(i.job_id)));
  assert.deepEqual(js.map((j) => [j.last_error_code, j.attempts]), [['MEDIA_HTTP_404', 1], ['MEDIA_TOO_LARGE', 1], ['MEDIA_TYPE_INVALID', 1]]);
  assert.equal(s.fake.media.length, 0); assert.equal(s.fake.sent.length, 0);
});

test('E2E media: 503 sementara dicoba ulang lalu terkirim (aman: belum ada yang keluar)', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const flaky = await mediaServer((_r, res, k) => (k < 3 ? res.writeHead(503).end() : res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)));
  const m = await msgs.sendMedia(tn.principal, { sessionId: s.id, to: '6281234567890', type: 'image', url: flaky.url, priority: 5 });
  await waitFor(async () => (await job(m.job_id)).status === 'SENT', 'SENT setelah retry');
  assert.equal((await job(m.job_id)).attempts, 3);
  assert.equal(s.fake.media.length, 1, 'terkirim tepat sekali');
});

// ---------- bulk ----------

test('bulk: atomik, urutan batch dipertahankan saat dikirim, respons per item', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  const items = ['6281000000011', '6281000000012', '6281000000013', '6281000000014'].map((to, i) => ({ to, message: `pesan ${i + 1}` }));
  const r = await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: items });
  assert.equal(r.statusCode, 202);
  const data = r.json().data;
  assert.equal(data.count, 4);
  assert.deepEqual(data.jobs.map((j: any) => [j.index, j.to]), items.map((it, i) => [i, it.to]));
  await waitFor(async () => s.fake.sent.length === 4, 'empat terkirim');
  assert.deepEqual(s.fake.sent.map((x: any) => x.text), ['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4'], 'urutan batch = urutan kirim');
  assert.equal(s.fake.maxConcurrent, 1, 'lane serial per sesi');
});

test('bulk: idempotensi per batch (replay sama, isi beda 422), duplikat dalam batch ditolak', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  await stopAll(); // biarkan PENDING agar deterministik
  const body = { session_id: s.id, messages: [{ to: '6281000000021', message: 'a' }, { to: '6281000000022', message: 'b' }] };
  const r1 = await post(tn.tok, '/messages/bulk', body, { 'idempotency-key': 'batch-1' });
  assert.equal(r1.statusCode, 202);
  const r2 = await post(tn.tok, '/messages/bulk', body, { 'idempotency-key': 'batch-1' });
  assert.equal(r2.headers['idempotent-replayed'], 'true');
  assert.deepEqual(r2.json().data.jobs.map((j: any) => j.job_id), r1.json().data.jobs.map((j: any) => j.job_id));
  assert.equal((await q(`SELECT count(*)::int n FROM message_queue WHERE session_id = $1`, [s.id]))[0].n, 2, 'replay tidak menambah job');
  const diff = await post(tn.tok, '/messages/bulk', { ...body, messages: [{ to: '6281000000021', message: 'a' }, { to: '6281000000022', message: 'BEDA' }] }, { 'idempotency-key': 'batch-1' });
  assert.equal(diff.statusCode, 422); assert.equal(diff.json().error.code, 'IDEMPOTENCY_CONFLICT');
  const dup = await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [{ to: '6281000000031', message: 'x' }, { to: '6281000000031', message: 'x' }] });
  assert.equal(dup.statusCode, 422); assert.equal(dup.json().error.code, 'DUPLICATE_ITEM');
  assert.equal((await q(`SELECT count(*)::int n FROM message_queue WHERE session_id = $1`, [s.id]))[0].n, 2, 'batch ditolak tidak menyisakan job');
  // kunci milik single-send dan bulk tidak saling bentrok
  const single = await post(tn.tok, '/messages/send', { session_id: s.id, to: '6281000000041', type: 'text', message: 'x' }, { 'idempotency-key': 'batch-1' });
  assert.equal(single.statusCode, 202);
});

test('bulk: validasi (kosong, terlalu banyak, nomor salah, field asing), sesi tak tersedia, atomik saat gagal', { skip }, async () => {
  const tn = await newTenant(); const e = await newEngine();
  const s = await connected(tn, e);
  await stopAll();
  const ok = { to: '6281000000051', message: 'x' };
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [] })).statusCode, 400);
  const many = Array.from({ length: config.BULK_MAX_MESSAGES + 1 }, (_, i) => ({ to: `62810000${String(10000 + i)}`, message: 'x' }));
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: many })).statusCode, 400);
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [ok, { to: '0812', message: 'x' }] })).statusCode, 400, 'satu item salah menolak seluruh batch');
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [{ ...ok, extra: 1 }] })).statusCode, 400);
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: crypto.randomUUID(), messages: [ok] })).statusCode, 404);
  assert.equal((await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [ok] }, { 'idempotency-key': 'k'.repeat(201) })).statusCode, 400);
  assert.equal((await q(`SELECT count(*)::int n FROM message_queue WHERE session_id = $1`, [s.id]))[0].n, 0, 'tidak ada job yang bocor');
  await svc.disconnect(tn.principal, s.id);
  const un = await post(tn.tok, '/messages/bulk', { session_id: s.id, messages: [ok] });
  assert.equal(un.statusCode, 409); assert.equal(un.json().error.code, 'SESSION_UNAVAILABLE');
});

test('bulk: tenant lain tidak bisa memakai sesi kita; batas pesan/menit tenant tetap berlaku', { skip }, async () => {
  const a = await newTenant(); const b = await newTenant(); const e = await newEngine();
  const s = await connected(a, e);
  await stopAll();
  const r = await post(b.tok, '/messages/bulk', { session_id: s.id, messages: [{ to: '6281000000061', message: 'x' }] });
  assert.equal(r.statusCode, 404);
  // batas per menit: tenant dengan 2 pesan/menit hanya mengirim 2 dari 4 dalam jendela
  await db.tx({ tenantId: a.tenantId }, async (c: any) => assert.equal((await c.query(`UPDATE tenant_settings SET messages_per_minute = 2 WHERE tenant_id = $1`, [a.tenantId])).rowCount, 1));
  const e2 = await newEngine();
  const s2 = await connected(a, e2);
  const items = ['6281000000071', '6281000000072', '6281000000073', '6281000000074'].map((to) => ({ to, message: 'x' }));
  await post(a.tok, '/messages/bulk', { session_id: s2.id, messages: items });
  await waitFor(async () => s2.fake.sent.length >= 2, 'dua pertama terkirim');
  await sleep(300);
  assert.equal(s2.fake.sent.length, 2, 'sisanya menunggu jendela batas pesan/menit');
});
