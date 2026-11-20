import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { installContractCheck, violations } = await import('../src/http/openapi/conformance.js');

// Skenario operasi yang TIDAK tersentuh tes lain (webhook dan logout/health), divalidasi terhadap skema yang diterbitkan.
const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: { allowHttp: true, allowPrivate: true } });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: createSessionService(db, { crypto: cr }), messages: createMessageService(db), webhooks: wsvc, checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
if (app) installContractCheck(app);
after(async () => { await app?.close(); await t?.drop(); });

test('webhook: siklus penuh (buat, daftar, ubah, putar secret, test, pengiriman, detail, replay, hapus) sesuai kontrak', { skip }, async () => {
  const before = violations.length;
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'ct1@x.test', password: 'correct-horse-battery', tenant_name: 'CT' } });
  assert.equal(reg.statusCode, 201);
  const h = { authorization: `Bearer ${reg.json().data.access_token}` };
  const call = async (method: string, url: string, payload?: unknown, want = 200) => {
    const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: h, payload: payload as any });
    assert.equal(r.statusCode, want, `${method} ${url}: ${r.body}`);
    return r.json();
  };
  const ep = (await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['*'] }, 201)).data;
  assert.ok(ep.secret);
  assert.equal((await call('GET', '/webhooks')).data.length, 1);
  assert.equal((await call('PATCH', `/webhooks/${ep.id}`, { description: 'uji kontrak' })).data.description, 'uji kontrak');
  const rot = (await call('POST', `/webhooks/${ep.id}/rotate-secret`)).data;
  assert.ok(rot.secret && rot.secret !== ep.secret, 'secret baru berbeda');
  await call('POST', `/webhooks/${ep.id}/test`, undefined, 202);
  await createOutboxRelay(db).runOnce(); // outbox -> baris delivery
  const dl = (await call('GET', `/webhooks/${ep.id}/deliveries`)).data;
  assert.ok(dl.length >= 1, 'ada pengiriman dari webhook.test');
  const one = (await call('GET', `/webhooks/${ep.id}/deliveries/${dl[0].id}`)).data;
  assert.equal(one.id, dl[0].id);
  // replay hanya untuk DEAD: jadikan DEAD secara langsung agar jalur replay tercakup
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE webhook_deliveries SET status = 'DEAD' WHERE id = $1`, [dl[0].id]));
  await call('POST', `/webhooks/${ep.id}/deliveries/${dl[0].id}/replay`, undefined, 202);
  assert.equal((await call('DELETE', `/webhooks/${ep.id}`)).data.deleted, true);
  assert.equal(violations.length, before, JSON.stringify(violations.slice(before)));
});

test('logout, logout-all, health, dan galat standar sesuai kontrak', { skip }, async () => {
  const before = violations.length;
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'ct2@x.test', password: 'correct-horse-battery', tenant_name: 'CT2' } });
  const tok = reg.json().data.access_token;
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: { authorization: `Bearer ${tok}` } })).statusCode, 204);
  for (const url of ['/health', '/health/live', '/health/ready']) assert.equal((await app.inject({ url })).statusCode, 200, url);
  assert.equal((await app.inject({ url: '/api/v1/sessions' })).statusCode, 401); // galat standar
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'bukan-email' } })).statusCode, 400);
  assert.equal(violations.length, before, JSON.stringify(violations.slice(before)));
});
