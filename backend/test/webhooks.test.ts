import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createWebhookDeliverer } = await import('../src/modules/engine/webhook-delivery.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { isBlockedIp, parseWebhookUrl, assertPublicHost, BlockedTargetError } = await import('../src/security/ssrf.js');
const { signWebhook, verifyWebhook, webhookSecretAad } = await import('../src/security/webhook-signature.js');

const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const LAB = { allowHttp: true, allowPrivate: true };
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: LAB });
const sessions = skip ? (null as any) : createSessionService(db, { crypto: cr });
const messages = skip ? (null as any) : createMessageService(db);
const relay = skip ? (null as any) : createOutboxRelay(db);
const mkDeliverer = (opts: any = {}) => createWebhookDeliverer({ db, crypto: cr, log: { warn: (o: any) => console.error('DELIVERER WARN', o) }, opts: { retryBaseMs: 5, retryMaxMs: 20, random: () => 0, policy: LAB, timeoutMs: 800, ...opts } });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions, messages, webhooks: wsvc, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const servers: http.Server[] = [];
after(async () => { for (const s of servers) s.closeAllConnections?.(), s.close(); await app?.close(); await t?.drop(); });

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
async function newTenant() {
  const label = `w${++n}`;
  const reg = await createIdentityService(db).register({ email: `${label}@x.test`, password: 'correct-horse-battery', tenantName: `T ${label}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string, tok: reg.accessToken as string, userId: reg.user.id as string };
}
type Hit = { headers: http.IncomingHttpHeaders; body: string };
/** Penerima webhook lokal. `respond` menentukan balasan per permintaan ke-n (mulai 1). */
async function receiver(respond: (n: number, res: http.ServerResponse) => void = (_n, res) => res.writeHead(200).end('ok')) {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { hits.push({ headers: req.headers, body }); respond(hits.length, res); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { hits, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook` };
}
/** Pesan PENDING pada sesi baru, lalu dipaksa ke status tertentu seolah engine yang menyelesaikannya. */
async function message(tn: any) {
  const s = await sessions.create(tn.principal, { name: `ws${++n}`, autoConnect: true });
  const m = await messages.send(tn.principal, { sessionId: s.id, to: '6281234567890', text: 'rahasia-isi-pesan', priority: 5 });
  return { sessionId: s.id as string, jobId: m.job_id as string };
}
const setStatus = (id: string, status: string, extra = '') => db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_queue SET status = $2 ${extra} WHERE id = $1`, [id, status]));
const outboxOf = (tenantId: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT event_type, status, payload, aggregate_id FROM outbox_events WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])).rows);
const deliveriesOf = (endpointId: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at', [endpointId])).rows);

// ---------- SSRF & tanda tangan (murni) ----------

test('isBlockedIp: privat/loopback/link-local/metadata/IPv6 khusus diblokir, publik lolos', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'bukan-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedIp(ip), false, ip);
});

test('parseWebhookUrl: skema, kredensial, host internal ditolak pada kebijakan produksi', () => {
  const prod = { allowHttp: false, allowPrivate: false };
  for (const u of ['http://example.com/h', 'ftp://example.com', 'javascript:alert(1)', 'https://user:pw@example.com/', 'https://localhost/h',
    'https://127.0.0.1/h', 'https://[::1]/h', 'https://169.254.169.254/latest', 'https://svc.internal/h', 'https://printer.local/', 'bukan url']) {
    assert.throws(() => parseWebhookUrl(u, prod), BlockedTargetError, u);
  }
  assert.equal(parseWebhookUrl('https://example.com:8443/h?x=1', prod).port, '8443');
  assert.doesNotThrow(() => parseWebhookUrl('http://127.0.0.1:9/h', LAB)); // mode lab
});

test('assertPublicHost: satu alamat privat di hasil DNS cukup untuk menolak (anti rebinding)', async () => {
  const prod = { allowHttp: false, allowPrivate: false };
  await assert.rejects(assertPublicHost('evil.example', prod, async () => ['8.8.8.8', '10.0.0.5']), (e: any) => e.code === 'BLOCKED_TARGET');
  await assert.rejects(assertPublicHost('nx.example', prod, async () => { throw new Error('ENOTFOUND'); }), (e: any) => e.code === 'DNS_FAILED');
  await assert.doesNotReject(assertPublicHost('ok.example', prod, async () => ['93.184.216.34']));
  await assert.rejects(assertPublicHost('127.0.0.1', prod), (e: any) => e.code === 'BLOCKED_TARGET');
});

test('tanda tangan HMAC: valid, tamper body/secret/timestamp ditolak, timestamp basi ditolak', () => {
  const secret = 'whsec_abc'; const body = '{"a":1}'; const ts = 1_700_000_000;
  const sig = signWebhook(secret, ts, body);
  assert.match(sig, /^v1=[0-9a-f]{64}$/);
  assert.equal(verifyWebhook(secret, String(ts), body, sig, 300, ts + 10), true);
  assert.equal(verifyWebhook(secret, String(ts), body + ' ', sig, 300, ts + 10), false);
  assert.equal(verifyWebhook('whsec_lain', String(ts), body, sig, 300, ts + 10), false);
  assert.equal(verifyWebhook(secret, String(ts + 1), body, sig, 300, ts + 10), false);
  assert.equal(verifyWebhook(secret, String(ts), body, sig, 300, ts + 301), false, 'replay basi');
  assert.equal(verifyWebhook(secret, 'abc', body, sig), false);
});

// ---------- Outbox transaksional ----------

test('outbox: perubahan status sesi & pesan menulis event dalam transaksi yang sama, tanpa isi pesan', { skip }, async () => {
  const tn = await newTenant();
  const { sessionId, jobId } = await message(tn);
  await setStatus(jobId, 'SENT', `, provider_message_id = 'PM1'`);
  await setStatus(jobId, 'DELIVERED');
  const ev = await outboxOf(tn.tenantId);
  assert.deepEqual(ev.map((e: any) => e.event_type), ['session.status', 'session.status', 'message.sent', 'message.delivered']);
  const sent = ev.find((e: any) => e.event_type === 'message.sent');
  assert.equal(sent.payload.message_id, jobId);
  assert.equal(sent.payload.provider_message_id, 'PM1');
  assert.equal(sent.payload.session_id, sessionId);
  assert.ok(!JSON.stringify(ev).includes('rahasia-isi-pesan'), 'isi pesan tidak boleh masuk event');
});

test('outbox: rollback transaksi membatalkan event; perubahan tanpa status baru tidak membuat event', { skip }, async () => {
  const tn = await newTenant();
  const { jobId } = await message(tn);
  const before = (await outboxOf(tn.tenantId)).length;
  await assert.rejects(db.tx({ platform: true }, async (c: any) => {
    await c.query(`UPDATE message_queue SET status = 'SENT' WHERE id = $1`, [jobId]);
    throw new Error('batal');
  }));
  assert.equal((await outboxOf(tn.tenantId)).length, before);
  await setStatus(jobId, 'PENDING'); // status sama
  await setStatus(jobId, 'PROCESSING', `, processing_expires_at = now() + interval '1 minute'`); // tidak bermakna bagi klien
  assert.equal((await outboxOf(tn.tenantId)).length, before);
});

test('outbox: tenant tidak bisa membaca/mengubah/menghapus outbox (hanya platform)', { skip }, async () => {
  const tn = await newTenant();
  await message(tn);
  await db.tx({ tenantId: tn.tenantId }, async (c: any) => {
    assert.equal((await c.query('SELECT 1 FROM outbox_events')).rowCount, 0);
    assert.equal((await c.query(`UPDATE outbox_events SET status = 'DISPATCHED', dispatched_at = now()`)).rowCount, 0);
    assert.equal((await c.query('DELETE FROM outbox_events')).rowCount, 0);
  });
  assert.ok((await outboxOf(tn.tenantId)).length > 0);
});

// ---------- Layanan endpoint ----------

test('create: secret tampil sekali, tersimpan terenkripsi (AAD terikat), tidak muncul di list/log', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] });
  assert.match(ep.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(ep.secret_hint, ep.secret.slice(-4));
  const list = await wsvc.list(tn.tenantId, { page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.ok(!JSON.stringify(list).includes(ep.secret));
  const row = (await db.tx({ platform: true }, (c: any) => c.query('SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1', [ep.id]))).rows[0];
  assert.ok(!row.secret_ciphertext.includes(Buffer.from(ep.secret)), 'secret tidak boleh tersimpan polos');
  assert.equal(cr.decrypt(row.secret_ciphertext, webhookSecretAad(tn.tenantId, ep.id)).toString(), ep.secret);
  assert.throws(() => cr.decrypt(row.secret_ciphertext, webhookSecretAad(tn.tenantId, crypto.randomUUID())), /gagal/);
});

test('create: URL privat/ber-kredensial/http ditolak 422 pada kebijakan produksi; tanpa kunci enkripsi => 503', { skip }, async () => {
  const tn = await newTenant();
  const prod = createWebhookService(db, { crypto: cr, policy: { allowHttp: false, allowPrivate: false }, resolve: async (h) => (h === 'rebind.example' ? ['10.0.0.1'] : ['93.184.216.34']) });
  for (const url of ['http://example.com/h', 'https://127.0.0.1/h', 'https://x:y@example.com/h', 'https://rebind.example/h', 'https://169.254.169.254/']) {
    await assert.rejects(prod.create(tn.tenantId, { url, events: ['*'] }), (e: any) => e.status === 422 && e.code === 'INVALID_WEBHOOK_URL', url);
  }
  await assert.doesNotReject(prod.create(tn.tenantId, { url: 'https://example.com/h', events: ['*'] }));
  const noKey = createWebhookService(db, { policy: LAB });
  await assert.rejects(noKey.create(tn.tenantId, { url: 'http://127.0.0.1:9/h', events: ['*'] }), (e: any) => e.status === 503);
});

test('kuota endpoint per tenant dipaksakan', { skip }, async () => {
  const tn = await newTenant();
  const { config } = await import('../src/config/env.js');
  for (let i = 0; i < config.WEBHOOK_MAX_ENDPOINTS; i++) await wsvc.create(tn.tenantId, { url: `http://127.0.0.1:9/h${i}`, events: ['*'] });
  await assert.rejects(wsvc.create(tn.tenantId, { url: 'http://127.0.0.1:9/lagi', events: ['*'] }), (e: any) => e.code === 'QUOTA_EXCEEDED');
});

test('isolasi tenant: tenant lain tidak dapat melihat/ubah/hapus/rotate/test/replay endpoint', { skip }, async () => {
  const a = await newTenant(); const b = await newTenant();
  const ep = await wsvc.create(a.tenantId, { url: 'http://127.0.0.1:9/h', events: ['*'] });
  const nf = (e: any) => e.status === 404;
  await assert.rejects(wsvc.update(b.tenantId, ep.id, { active: false }), nf);
  await assert.rejects(wsvc.remove(b.tenantId, ep.id), nf);
  await assert.rejects(wsvc.rotateSecret(b.tenantId, ep.id), nf);
  await assert.rejects(wsvc.test(b.tenantId, ep.id), nf);
  await assert.rejects(wsvc.deliveries(b.tenantId, ep.id, { page: 1, pageSize: 10 }), nf);
  await assert.rejects(wsvc.replay(b.tenantId, ep.id, crypto.randomUUID()), nf);
  assert.equal((await wsvc.list(b.tenantId, { page: 1, pageSize: 10 })).total, 0);
  assert.equal((await wsvc.list(a.tenantId, { page: 1, pageSize: 10 })).total, 1);
  await assert.rejects(wsvc.update(a.tenantId, 'bukan-uuid', { active: false }), nf);
});

// ---------- Relay + pengiriman ----------

test('E2E: event terkirim ke endpoint berlangganan dengan header & tanda tangan valid; filter langganan dihormati', { skip }, async () => {
  const tn = await newTenant();
  const all = await receiver(); const onlyFail = await receiver();
  const epAll = await wsvc.create(tn.tenantId, { url: all.url, events: ['*'] });
  const epFail = await wsvc.create(tn.tenantId, { url: onlyFail.url, events: ['message.failed'] });
  const off = await wsvc.create(tn.tenantId, { url: (await receiver()).url, events: ['*'] });
  await wsvc.update(tn.tenantId, off.id, { active: false });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT', `, provider_message_id = 'PM9'`);

  while ((await relay.runOnce()) > 0) { /* kuras */ }
  const d = mkDeliverer();
  await waitFor(async () => { await d.runOnce(); const rs = await deliveriesOf(epAll.id); return rs.length >= 2 && rs.every((r: any) => r.status === 'DELIVERED'); }, 'pengiriman');

  const sentHit = all.hits.map((h) => ({ h, b: JSON.parse(h.body) })).find((x) => x.b.event === 'message.sent')!;
  assert.equal(sentHit.b.data.message_id, jobId);
  assert.match(sentHit.b.event_id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(sentHit.b.occurred_at)));
  const hd = sentHit.h.headers;
  assert.equal(hd['x-wazap-event'], 'message.sent');
  assert.equal(hd['x-wazap-event-id'], sentHit.b.event_id);
  assert.equal(verifyWebhook(epAll.secret, hd['x-wazap-timestamp'] as string, sentHit.h.body, hd['x-wazap-signature'] as string), true);
  assert.equal(verifyWebhook(epFail.secret, hd['x-wazap-timestamp'] as string, sentHit.h.body, hd['x-wazap-signature'] as string), false, 'secret endpoint lain tidak cocok');
  assert.equal(onlyFail.hits.length, 0, 'event yang tidak dilanggan tidak dikirim');
  assert.equal((await deliveriesOf(off.id)).length, 0, 'endpoint nonaktif tidak dibuatkan delivery');
  const rows = await deliveriesOf(epAll.id);
  assert.ok(rows.every((r: any) => r.status === 'DELIVERED' && r.attempts === 1 && r.last_status_code === 200));
});

test('relay idempoten: dijalankan berulang/paralel tidak menggandakan delivery', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  await Promise.all([relay.runOnce(), relay.runOnce(), relay.runOnce()]);
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  assert.equal((await deliveriesOf(ep.id)).length, 1);
  assert.equal((await outboxOf(tn.tenantId)).every((e: any) => e.status === 'DISPATCHED'), true);
});

test('retry: 500 dicoba ulang dengan backoff lalu sukses; riwayat percobaan tercatat tanpa body respons', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver((k, res) => (k < 3 ? res.writeHead(500).end('SECRET-DETAIL-DARI-PENERIMA') : res.writeHead(204).end()));
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  const d = mkDeliverer();
  const row = await waitFor(async () => { await d.runOnce(); const r = (await deliveriesOf(ep.id))[0]; return r?.status === 'DELIVERED' && r; }, 'sukses setelah retry');
  assert.equal(row.attempts, 3);
  assert.equal(rcv.hits.length, 3);
  const eventIds = new Set(rcv.hits.map((h) => JSON.parse(h.body).event_id));
  assert.equal(eventIds.size, 1, 'event_id sama pada setiap percobaan (dedup oleh penerima)');
  const det = await wsvc.delivery(tn.tenantId, ep.id, row.id);
  assert.deepEqual(det.attempt_history.map((a: any) => [a.outcome, a.status_code]), [['RETRY', 500], ['RETRY', 500], ['DELIVERED', 204]]);
  assert.ok(!JSON.stringify(det).includes('SECRET-DETAIL'), 'body respons tidak disimpan');
});

test('dead-letter: habis percobaan => DEAD; replay manual memberi anggaran baru dan berhasil', { skip }, async () => {
  const tn = await newTenant();
  let fail = true;
  const rcv = await receiver((_k, res) => (fail ? res.writeHead(503).end() : res.writeHead(200).end()));
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  await db.tx({ platform: true }, (c: any) => c.query('UPDATE webhook_deliveries SET max_attempts = 2 WHERE endpoint_id = $1', [ep.id]));
  const d = mkDeliverer();
  const dead = await waitFor(async () => { await d.runOnce(); const r = (await deliveriesOf(ep.id))[0]; return r?.status === 'DEAD' && r; }, 'DEAD');
  assert.equal(dead.attempts, 2); assert.equal(dead.last_status_code, 503); assert.equal(dead.last_error_code, 'HTTP_ERROR');
  await d.runOnce(); assert.equal(rcv.hits.length, 2, 'DEAD tidak dikirim lagi');

  fail = false;
  await assert.rejects(wsvc.replay(tn.tenantId, ep.id, crypto.randomUUID()), (e: any) => e.status === 404);
  const rp = await wsvc.replay(tn.tenantId, ep.id, dead.id);
  assert.equal(rp.status, 'PENDING');
  await waitFor(async () => { await d.runOnce(); return (await deliveriesOf(ep.id))[0].status === 'DELIVERED'; }, 'replay berhasil');
  assert.equal((await deliveriesOf(ep.id))[0].attempts, 3);
  await wsvc.replay(tn.tenantId, ep.id, dead.id); // DELIVERED boleh dikirim ulang atas permintaan klien
  await assert.rejects(wsvc.replay(tn.tenantId, ep.id, dead.id), (e: any) => e.status === 409 && e.code === 'INVALID_STATE', 'sedang antre: tolak replay ganda');
});

test('redirect tidak diikuti (3xx = gagal) dan timeout dibatasi', { skip }, async () => {
  const tn = await newTenant();
  const target = await receiver();
  const redir = await receiver((_k, res) => res.writeHead(302, { location: target.url }).end());
  const slow = await receiver((_k, res) => setTimeout(() => res.writeHead(200).end(), 3000).unref());
  const e1 = await wsvc.create(tn.tenantId, { url: redir.url, events: ['message.sent'] });
  const e2 = await wsvc.create(tn.tenantId, { url: slow.url, events: ['message.sent'] });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  const t0 = Date.now();
  await mkDeliverer({ timeoutMs: 300 }).runOnce();
  assert.ok(Date.now() - t0 < 2500, 'tidak menunggu respons lambat');
  assert.equal(target.hits.length, 0, 'redirect tidak diikuti');
  const r1 = (await deliveriesOf(e1.id))[0]; const r2 = (await deliveriesOf(e2.id))[0];
  assert.equal(r1.last_status_code, 302); assert.equal(r1.status, 'PENDING');
  assert.equal(r2.last_error_code, 'TIMEOUT'); assert.equal(r2.status, 'PENDING');
});

test('SSRF saat pengiriman: target internal diblokir permanen (DEAD) dan tidak ada koneksi keluar', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] }); // dibuat dengan kebijakan lab
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  await mkDeliverer({ policy: { allowHttp: true, allowPrivate: false } }).runOnce();
  const r = (await deliveriesOf(ep.id))[0];
  assert.equal(r.status, 'DEAD'); assert.equal(r.last_error_code, 'BLOCKED_TARGET'); assert.equal(r.attempts, 1);
  assert.equal(rcv.hits.length, 0);
  // DNS rebinding: nama publik saat dibuat, privat saat koneksi
  const ep2 = await wsvc.create(tn.tenantId, { url: 'http://rebind.test:9/h', events: ['message.failed'] }).catch(() => null);
  assert.equal(ep2, null, 'host yang tidak bisa di-resolve ditolak saat dibuat');
});

test('rotasi secret: yang lama tidak lagi valid, yang baru valid; test ping melewati filter', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.failed'] });
  const rot = await wsvc.rotateSecret(tn.tenantId, ep.id);
  assert.notEqual(rot.secret, ep.secret);
  assert.equal(rot.secret_hint, rot.secret.slice(-4));
  const ping = await wsvc.test(tn.tenantId, ep.id);
  assert.equal(ping.event, 'webhook.test');
  const d = mkDeliverer();
  await waitFor(async () => { await d.runOnce(); return rcv.hits.length > 0; }, 'ping');
  const h = rcv.hits[0]!;
  const ts = h.headers['x-wazap-timestamp'] as string, sig = h.headers['x-wazap-signature'] as string;
  assert.equal(verifyWebhook(ep.secret, ts, h.body, sig), false, 'secret lama ditolak');
  assert.equal(verifyWebhook(rot.secret, ts, h.body, sig), true);
  assert.equal(JSON.parse(h.body).event, 'webhook.test');
});

test('endpoint dihapus saat delivery tertunda: delivery ikut terhapus (cascade), tidak ada pengiriman', { skip }, async () => {
  const tn = await newTenant();
  const rcv = await receiver();
  const ep = await wsvc.create(tn.tenantId, { url: rcv.url, events: ['message.sent'] });
  const { jobId } = await message(tn);
  await setStatus(jobId, 'SENT');
  while ((await relay.runOnce()) > 0) { /* kuras */ }
  await wsvc.remove(tn.tenantId, ep.id);
  await mkDeliverer().runOnce();
  assert.equal(rcv.hits.length, 0);
  assert.equal((await deliveriesOf(ep.id)).length, 0);
});

// ---------- Rute HTTP ----------

test('rute: RBAC (MEMBER/VIEWER 403), API key butuh scope webhooks:manage, secret tidak di-cache, validasi strict', { skip }, async () => {
  const a = await newTenant();
  const rcv = await receiver();
  const create = (tok: any, payload: any, h: any = bearer(tok)) => app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: h, payload });
  const ok = await create(a.tok, { url: rcv.url, events: ['message.sent'] });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.json().data.secret, /^whsec_/);

  const m = await newTenant();
  await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'MEMBER')`, [a.tenantId, m.userId]));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `w${n}@x.test`, password: 'correct-horse-battery', tenant_id: a.tenantId } });
  const memberTok = login.json().data.access_token;
  assert.equal((await create(memberTok, { url: rcv.url })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/webhooks', headers: bearer(memberTok) })).statusCode, 403);

  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k' + ++n, scopes } })).json().data.key as string;
  assert.equal((await app.inject({ url: '/api/v1/webhooks', headers: { 'x-api-key': await mk(['messages:send']) } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/webhooks', headers: { 'x-api-key': await mk(['webhooks:manage']) } })).statusCode, 200);

  assert.equal((await create(a.tok, { url: rcv.url, extra: 1 })).statusCode, 400, 'field asing ditolak');
  assert.equal((await create(a.tok, { url: rcv.url, events: ['evil.event'] })).statusCode, 400);
  assert.equal((await create(a.tok, { url: rcv.url, events: [] })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/webhooks/${ok.json().data.id}`, headers: bearer(a.tok), payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/v1/webhooks' })).statusCode, 401);

  const list = await app.inject({ url: '/api/v1/webhooks', headers: bearer(a.tok) });
  assert.ok(!list.body.includes(ok.json().data.secret), 'list tidak membocorkan secret');
  const del = await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${ok.json().data.id}`, headers: bearer(a.tok) });
  assert.equal(del.statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${ok.json().data.id}`, headers: bearer(a.tok) })).statusCode, 404);
});
