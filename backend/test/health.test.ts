import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config/env.js');
const { createShutdown } = await import('../src/runtime/shutdown.js');

test('loadConfig menolak secret lemah tanpa membocorkan nilainya', () => {
  assert.throws(() => loadConfig({ JWT_SECRET: 'abc' } as any), (e: Error) =>
    /JWT_SECRET/.test(e.message) && !e.message.includes('abc'));
});

test('loadConfig menerapkan default dan coercion', () => {
  const c = loadConfig({ JWT_SECRET: 'y'.repeat(32), PORT: '3000' } as any);
  assert.equal(c.PORT, 3000);
  assert.equal(c.DB_POOL_MAX, 10);
});

test('/health/live selalu 200', async () => {
  const app = buildApp({ checkDb: async () => false });
  const r = await app.inject('/health/live');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'UP');
  await app.close();
});

test('/health/ready 200 saat DB up, 503 saat DB down', async () => {
  const up = buildApp({ checkDb: async () => true });
  assert.equal((await up.inject('/health/ready')).statusCode, 200);
  await up.close();
  const down = buildApp({ checkDb: async () => { throw new Error('boom'); } });
  const r = await down.inject('/health/ready');
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().checks.database, 'DOWN');
  await down.close();
});

test('/health/ready 503 saat shutdown', async () => {
  const app = buildApp({ checkDb: async () => true, isShuttingDown: () => true });
  assert.equal((await app.inject('/health/ready')).statusCode, 503);
  await app.close();
});

test('rute terproteksi menolak tanpa kredensial', async () => {
  const app = buildApp({ checkDb: async () => true });
  const r = await app.inject('/api/v1/sessions');
  assert.equal(r.statusCode, 401);
  await app.close();
});

test('shutdown menjalankan hook LIFO, idempoten, exit 0', async () => {
  const order: string[] = [];
  let code = -1;
  const sd = createShutdown({ timeoutMs: 1000, log: { info() {}, error() {} }, exit: (c) => { code = c; } });
  sd.register('a', async () => { order.push('a'); });
  sd.register('b', async () => { order.push('b'); });
  await Promise.all([sd.run('t'), sd.run('t')]);
  assert.deepEqual(order, ['b', 'a']);
  assert.equal(code, 0);
});

test('shutdown exit 1 bila hook gagal', async () => {
  let code = -1;
  const sd = createShutdown({ timeoutMs: 1000, log: { info() {}, error() {} }, exit: (c) => { code = c; } });
  sd.register('bad', async () => { throw new Error('x'); });
  await sd.run('t');
  assert.equal(code, 1);
});
