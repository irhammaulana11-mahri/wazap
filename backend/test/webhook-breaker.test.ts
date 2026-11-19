import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createWebhookDeliverer } = await import('../src/modules/engine/webhook-delivery.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');

const LAB = { allowHttp: true, allowPrivate: true };
const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: LAB });
const sessions = skip ? (null as any) : createSessionService(db, { crypto: cr });
const messages = skip ? (null as any) : createMessageService(db);
const relay = skip ? (null as any) : createOutboxRelay(db, { maxAttempts: 1 }); // satu kegagalan = DEAD
const warns: any[] = [];
const deliverer = (autoDisableAfter: number) => createWebhookDeliverer({ db, crypto: cr, log: { warn: (o: any) => warns.push(o) }, opts: { retryBaseMs: 5, retryMaxMs: 20, random: () => 0, policy: LAB, timeoutMs: 800, autoDisableAfter } });
const servers: http.Server[] = [];
after(async () => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } await t?.drop(); });

let n = 0;
async function newTenant() {
  const reg = await createIdentityService(db).register({ email: `br${++n}@x.test`, password: 'correct-horse-battery', tenantName: `T${n}` });
  return { principal: { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, tenantId: reg.tenant.id as string };
}
async function receiver(respond: (k: number, res: http.ServerResponse) => void) {
  let k = 0;
  const srv = http.createServer((_q, res) => respond(++k, res));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/h`, count: () => k };
}
/** Satu event message.sent baru untuk tenant (sesi + pesan baru). */
async function emitSent(tn: any) {
  tn.sid ??= (await sessions.create(tn.principal, { name: `brs${++n}`, autoConnect: true })).id; // satu sesi per tenant (kuota)
  const m = await messages.send(tn.principal, { sessionId: tn.sid, to: '6281234567890', text: 'x', priority: 5 });
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE message_queue SET status = 'SENT' WHERE id = $1`, [m.job_id]));
}
const flush = async (d: any) => { while ((await relay.runOnce()) > 0) { /* kuras */ } for (let i = 0; i < 5; i++) await d.runOnce(); };
const ep = async (id: string) => (await db.tx({ platform: true }, (c: any) => c.query('SELECT active, consecutive_failures AS f, disabled_at, disabled_reason FROM webhook_endpoints WHERE id = $1', [id]))).rows[0];

test('N delivery DEAD berturut-turut menonaktifkan endpoint otomatis; sisa antrean DEAD tanpa dikirim; event baru tidak di-fan-out', { skip }, async () => {
  const tn = await newTenant();
  const bad = await receiver((_k, res) => res.writeHead(500).end());
  const e = await wsvc.create(tn.tenantId, { url: bad.url, events: ['message.sent'] });
  const d = deliverer(3);
  for (let i = 0; i < 3; i++) { await emitSent(tn); await flush(d); }
  const row = await ep(e.id);
  assert.deepEqual([row.active, row.f, row.disabled_reason], [false, 3, 'AUTO_CONSECUTIVE_FAILURES']);
  assert.ok(row.disabled_at);
  assert.equal(warns.length, 1); assert.equal(warns[0].endpointId, e.id);
  assert.ok(!JSON.stringify(warns).includes('127.0.0.1'), 'URL tidak boleh masuk log');
  const hits = bad.count();
  await emitSent(tn); await flush(d);
  assert.equal(bad.count(), hits, 'endpoint nonaktif tidak menerima apa pun lagi');
  const deliveries = (await db.tx({ platform: true }, (c: any) => c.query('SELECT status FROM webhook_deliveries WHERE endpoint_id = $1', [e.id]))).rows;
  assert.equal(deliveries.length, 3, 'event setelah dinonaktifkan tidak dibuatkan delivery');
  const view = (await wsvc.list(tn.tenantId, { page: 1, pageSize: 10 })).rows[0];
  assert.deepEqual([view.active, view.disabled_reason, view.consecutive_failures], [false, 'AUTO_CONSECUTIVE_FAILURES', 3]);
});

test('keberhasilan mereset hitungan; kegagalan tidak berturut-turut tidak menonaktifkan', { skip }, async () => {
  const tn = await newTenant();
  let mode: 'fail' | 'ok' = 'fail';
  const r = await receiver((_k, res) => (mode === 'fail' ? res.writeHead(500) : res.writeHead(200)).end());
  const e = await wsvc.create(tn.tenantId, { url: r.url, events: ['message.sent'] });
  const d = deliverer(3);
  for (let i = 0; i < 2; i++) { await emitSent(tn); await flush(d); }
  assert.equal((await ep(e.id)).f, 2);
  mode = 'ok'; await emitSent(tn); await flush(d);
  assert.deepEqual([(await ep(e.id)).f, (await ep(e.id)).active], [0, true]);
  mode = 'fail';
  for (let i = 0; i < 2; i++) { await emitSent(tn); await flush(d); }
  assert.deepEqual([(await ep(e.id)).f, (await ep(e.id)).active], [2, true], 'hitungan mulai dari nol lagi');
});

test('percobaan RETRY, webhook.test, dan ambang 0 tidak memicu penonaktifan', { skip }, async () => {
  const tn = await newTenant();
  const bad = await receiver((_k, res) => res.writeHead(500).end());
  const e = await wsvc.create(tn.tenantId, { url: bad.url, events: ['message.sent'] });
  const d = deliverer(1);
  // webhook.test gagal (DEAD, 1 percobaan) tidak dihitung
  await wsvc.test(tn.tenantId, e.id); await flush(d);
  assert.deepEqual([(await ep(e.id)).f, (await ep(e.id)).active], [0, true]);
  // RETRY (belum final) tidak dihitung: relay biasa dengan 8 percobaan
  const relay8 = createOutboxRelay(db, { maxAttempts: 8 });
  await emitSent(tn); while ((await relay8.runOnce()) > 0) { /* kuras */ }
  await d.runOnce();
  const row = (await db.tx({ platform: true }, (c: any) => c.query(`SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id = $1 AND event_type = 'message.sent'`, [e.id]))).rows[0];
  assert.deepEqual([row.status, row.attempts], ['PENDING', 1]);
  assert.deepEqual([(await ep(e.id)).f, (await ep(e.id)).active], [0, true]);
  // ambang 0 = fitur mati
  const tn2 = await newTenant();
  const e2 = await wsvc.create(tn2.tenantId, { url: bad.url, events: ['message.sent'] });
  const off = deliverer(0);
  for (let i = 0; i < 3; i++) { await emitSent(tn2); await flush(off); }
  assert.deepEqual([(await ep(e2.id)).active, (await ep(e2.id)).f], [true, 3]);
});

test('PATCH active=true mengaktifkan ulang dan mereset penanda; nonaktif manual tidak memberi alasan otomatis', { skip }, async () => {
  const tn = await newTenant();
  const bad = await receiver((_k, res) => res.writeHead(500).end());
  const e = await wsvc.create(tn.tenantId, { url: bad.url, events: ['message.sent'] });
  const d = deliverer(2);
  for (let i = 0; i < 2; i++) { await emitSent(tn); await flush(d); }
  assert.equal((await ep(e.id)).active, false);
  const re = await wsvc.update(tn.tenantId, e.id, { active: true });
  assert.deepEqual([re.active, re.consecutive_failures, re.disabled_at, re.disabled_reason], [true, 0, null, null]);
  const manual = await wsvc.update(tn.tenantId, e.id, { active: false });
  assert.deepEqual([manual.active, manual.disabled_reason], [false, null]);
  await assert.rejects(db.tx({ platform: true }, (c: any) => c.query(`UPDATE webhook_endpoints SET disabled_at = now(), active = true WHERE id = $1`, [e.id])), /disabled_consistency/);
});
