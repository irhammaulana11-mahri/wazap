import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { signAccessToken } = await import('../src/modules/identity/tokens.js');

const t = skip ? null : await createTestDb();
const identity = skip ? (null as any) : createIdentityService(t!.db);
const app = skip ? (null as any) : buildApp({ identity, sessions: createSessionService(t!.db), checkDb: async () => true, limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
after(async () => { await app?.close(); await t?.drop(); });


const PW = 'correct-horse-battery';
let n = 0;
const reg = async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: `eb${++n}@x.test`, password: PW, tenant_name: `EB ${n}` } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().data.access_token as string;
};
const JSON_CT = { 'content-type': 'application/json' };

test('body JSON kosong pada rute tanpa body => 200 (kasus nyata: konfirmasi kode pemulihan dari browser)', { skip }, async () => {
  const tok = await reg();
  const auth = { ...JSON_CT, authorization: `Bearer ${tok}` };
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/recovery-codes/confirm', headers: auth }); // tanpa payload, content-type json
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().data, { confirmed: true });
  const spaces = await app.inject({ method: 'POST', url: '/api/v1/auth/recovery-codes/confirm', headers: auth, payload: '   ' });
  assert.equal(spaces.statusCode, 200, 'body hanya spasi sama dengan kosong');
  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: JSON_CT });
  assert.notEqual(logout.statusCode, 400, 'logout dari browser tanpa body tidak boleh 400');
});

test('rute yang butuh body: body kosong tetap ditolak 400 oleh validasi (bukan 500, bukan diterima)', { skip }, async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'VALIDATION_ERROR');
  const reg2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: JSON_CT, payload: '' });
  assert.equal(reg2.statusCode, 400);
});

test('JSON rusak dan prototype poisoning tetap ditolak 400 (perlindungan parser bawaan tidak hilang)', { skip }, async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT, payload: '{"email":' });
  assert.equal(bad.statusCode, 400);
  const pp = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT, payload: '{"email":"a@b.test","password":"x","__proto__":{"admin":true}}' });
  assert.equal(pp.statusCode, 400, 'prototype poisoning harus ditolak');
  const ctor = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT, payload: '{"constructor":{"prototype":{"x":1}}}' });
  assert.equal(ctor.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT, payload: JSON.stringify({ email: 'tidak-ada@x.test', password: 'salah-salah-1' }) });
  assert.equal(ok.statusCode, 401, 'JSON valid tetap diproses normal');
});

test('batas ukuran body tetap berlaku', { skip }, async () => {
  const big = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: JSON_CT, payload: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(1024 * 1024 + 10) }) });
  assert.equal(big.statusCode, 413);
});
