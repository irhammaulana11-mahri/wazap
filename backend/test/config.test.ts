import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'x'.repeat(40);
const { loadConfig } = await import('../src/config/env.js');
const base = { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const ok = (extra: Record<string, string>) => loadConfig({ ...base, ...extra } as NodeJS.ProcessEnv);
const bad = (extra: Record<string, string>, part = 'DASHBOARD_BASE_URL') => assert.throws(() => ok(extra), (e: Error) => e.message.includes(part), JSON.stringify(extra));

test('DASHBOARD_BASE_URL: kosong diizinkan; alamat dashboard yang wajar diterima', () => {
  assert.equal(ok({}).DASHBOARD_BASE_URL, undefined);
  for (const v of ['https://wa.contoh.co.id', 'https://wa.contoh.co.id/', 'https://intranet.contoh.co.id/wazap', 'https://wa.contoh.co.id:8443', 'http://localhost:5173']) {
    assert.equal(ok({ DASHBOARD_BASE_URL: v }).DASHBOARD_BASE_URL, v, v);
  }
});

test('DASHBOARD_BASE_URL: nilai berbahaya atau salah bentuk ditolak saat start (fail fast)', () => {
  for (const v of ['wa.contoh.co.id', 'javascript:alert(1)', 'ftp://wa.contoh.co.id', 'https://user:pw@wa.contoh.co.id', 'https://wa.contoh.co.id/?x=1', 'https://wa.contoh.co.id/#frag', 'data:text/html,x', '']) {
    bad({ DASHBOARD_BASE_URL: v });
  }
});

test('DASHBOARD_BASE_URL: di production wajib https', () => {
  const prod = { NODE_ENV: 'production' };
  assert.equal(ok({ ...prod, DASHBOARD_BASE_URL: 'https://wa.contoh.co.id' }).DASHBOARD_BASE_URL, 'https://wa.contoh.co.id');
  bad({ ...prod, DASHBOARD_BASE_URL: 'http://wa.contoh.co.id' });
  bad({ ...prod, DASHBOARD_BASE_URL: 'http://localhost:5173' });
  assert.equal(ok({ ...prod }).DASHBOARD_BASE_URL, undefined, 'production tanpa nilai tetap sah');
});
