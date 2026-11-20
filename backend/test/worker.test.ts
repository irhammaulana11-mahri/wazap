import './worker-env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { createTestDb, dbAvailable, config } from './helpers.js';
import { FakeAdapterFactory } from './fake-adapter.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createShutdown } = await import('../src/runtime/shutdown.js');
const { parseRoles, startWorkers } = await import('../src/runtime/workers.js');
const { startHealthServer } = await import('../src/runtime/health-server.js');
const { acquireEngineSingleton, EngineAlreadyRunningError } = await import('../src/runtime/engine-singleton.js');
const { assertSchemaMigrated } = await import('../src/runtime/db-guard.js');

const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const cr = (await import('../src/security/credential-crypto.js')).createCredentialCrypto((await import('../src/security/credential-crypto.js')).parseKeyring(process.env.CREDENTIAL_ENCRYPTION_KEYS!));
const identity = skip ? (null as any) : createIdentityService(db);
const svc = skip ? (null as any) : createSessionService(db, { crypto: cr });
const msgs = skip ? (null as any) : createMessageService(db);
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
const admin = skip ? (null as any) : new pg.Client({ host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE, user: config.DB_USERNAME, password: config.DB_PASSWORD || undefined });
if (!skip) await admin.connect();
const children: ChildProcess[] = [];
const closers: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const c of children) c.kill('SIGKILL');
  for (const c of closers) await c().catch(() => {});
  await t?.drop(); await admin?.end();
});

let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(25); }
}
const engineRow = (node: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT id, status FROM engine_nodes WHERE node_name = $1', [node])).rows[0]);
const sessStatus = async (id: string) => (await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT status FROM wa_sessions WHERE id = $1', [id])).rows[0])).status;
const stopAll = () => db.tx({ platform: true }, (c: any) => c.query(`UPDATE engine_nodes SET status = 'STOPPED'`));
/** Shutdown yang tidak mematikan proses tes: mencatat kode keluar. */
const mkShutdown = () => { const exits: number[] = []; return { sd: createShutdown({ timeoutMs: 8000, log: { info() {}, error() {} }, exit: (c) => void exits.push(c) }), exits }; };

// ------------------------------------------------------------------ unit

test('parseRoles: peran valid dipetakan; nama tak dikenal dan kosong ditolak (salah ketik tidak diam-diam menonaktifkan peran)', () => {
  assert.deepEqual(parseRoles('engine, control-plane'), { engine: true, controlPlane: true, webhook: false, retention: false });
  assert.deepEqual(parseRoles('webhook,retention'), { engine: false, controlPlane: false, webhook: true, retention: true });
  assert.throws(() => parseRoles('engine,controlplane'), /tidak dikenal "controlplane"/);
  assert.throws(() => parseRoles(' , '), /kosong/);
});

test('shutdown fatal: berhenti rapi tetapi keluar dengan kode 1; shutdown biasa kode 0', async () => {
  const a = mkShutdown(); let ran = 0; a.sd.register('x', async () => { ran++; });
  await a.sd.run('engine_singleton_lost', true); assert.deepEqual(a.exits, [1]); assert.equal(ran, 1);
  const b = mkShutdown(); await b.sd.run('SIGTERM'); assert.deepEqual(b.exits, [0]);
});

test('health server: live selalu 200, ready mengikuti kondisi, hanya GET, jalur lain 404', async () => {
  let ready = true;
  const h = await startHealthServer({ port: 0, host: '127.0.0.1', isReady: async () => ready, info: () => ({ node: 'x', roles: ['engine'] }) });
  closers.push(() => h.close());
  const get = (path: string, method = 'GET') => new Promise<{ code: number; body: any }>((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: h.port, path, method }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ code: x.statusCode!, body: JSON.parse(b) })); });
    r.on('error', rej); r.end();
  });
  assert.equal((await get('/health/live')).code, 200);
  const ok = await get('/health/ready'); assert.equal(ok.code, 200); assert.deepEqual(ok.body, { status: 'READY', node: 'x', roles: ['engine'] });
  ready = false;
  assert.equal((await get('/health/ready')).code, 503);
  assert.equal((await get('/health/live')).code, 200, 'liveness tetap 200 saat belum ready');
  assert.equal((await get('/health/ready', 'POST')).code, 405);
  assert.equal((await get('/apa-saja')).code, 404);
  await h.close();
});

// ------------------------------------------------------------------ singleton engine

test('singleton: nama node yang sama ditolak; nama lain boleh; setelah dilepas dapat diambil lagi', { skip }, async () => {
  const a = await acquireEngineSingleton(db, 'eng-A', noLog, () => assert.fail('tidak boleh fatal'));
  await assert.rejects(acquireEngineSingleton(db, 'eng-A', noLog, () => {}), EngineAlreadyRunningError);
  const b = await acquireEngineSingleton(db, 'eng-B', noLog, () => {});
  await a.release();
  const a2 = await acquireEngineSingleton(db, 'eng-A', noLog, () => {});
  await Promise.all([a2.release(), b.release()]);
});

const holderPid = async (node: string) => (await admin.query(
  `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295) AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
  [`wazap:engine:${db.schema}:${node}`])).rows[0]?.pid as number | undefined;

test('singleton: koneksi kunci putus sesaat => kunci direbut kembali dan tetap eksklusif', { skip }, async () => {
  let fatal = 0;
  const s = await acquireEngineSingleton(db, 'eng-blip', noLog, () => fatal++, { retries: 5, retryMs: 50 });
  const before = await holderPid('eng-blip'); assert.ok(before);
  await admin.query('SELECT pg_terminate_backend($1)', [before]);
  const after = await waitFor(async () => { const p = await holderPid('eng-blip'); return p && p !== before ? p : false; }, 'kunci direbut kembali');
  assert.notEqual(after, before);
  assert.equal(fatal, 0);
  await assert.rejects(acquireEngineSingleton(db, 'eng-blip', noLog, () => {}), EngineAlreadyRunningError, 'tetap eksklusif setelah pulih');
  await s.release();
});

test('singleton: pihak lain merebut kunci saat koneksi putus => onFatal (tidak boleh ada dua pemilik)', { skip }, async () => {
  let gate!: () => void; const open = new Promise<void>((r) => (gate = r));
  let calls = 0;
  // Koneksi pertama normal; percobaan rebut-kembali ditahan sampai pesaing sempat mengambil kunci (menghilangkan balapan pada tes).
  const slow = { schema: db.schema, pool: { connect: async () => (++calls === 1 ? db.pool.connect() : (await open, db.pool.connect())) } } as any;
  let fatal = ''; let fatalSeen!: () => void; const seen = new Promise<void>((r) => (fatalSeen = r));
  const s = await acquireEngineSingleton(slow, 'eng-race', noLog, (why) => { fatal = why; fatalSeen(); }, { retries: 2, retryMs: 20 });
  const victim = await holderPid('eng-race'); assert.ok(victim);
  const rival = new pg.Client({ host: config.DB_HOST, port: config.DB_PORT, database: config.DB_DATABASE, user: config.DB_USERNAME, password: config.DB_PASSWORD || undefined });
  await rival.connect();
  try {
    await admin.query('SELECT pg_terminate_backend($1)', [victim]);
    await waitFor(async () => (await rival.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`wazap:engine:${db.schema}:eng-race`])).rows[0].ok, 'pesaing mengambil kunci');
    gate();
    await Promise.race([seen, sleep(5000).then(() => { throw new Error('onFatal tidak dipanggil'); })]);
    assert.equal(fatal, 'engine_singleton_lost');
  } finally { await rival.end(); await s.release(); }
});

test('assertSchemaMigrated: schema lengkap lolos; schema kosong gagal dengan pesan yang jelas', { skip }, async () => {
  await assertSchemaMigrated(db);
  await db.pool.query('CREATE SCHEMA gw_empty_probe');
  try {
    const empty = { schema: 'gw_empty_probe', pool: db.pool } as any;
    await assert.rejects(assertSchemaMigrated(empty), /belum dimigrasi.*engine_nodes/);
  } finally { await db.pool.query('DROP SCHEMA gw_empty_probe'); }
});

// ------------------------------------------------------------------ komposisi pekerja (in-process, adapter palsu)

test('pekerja terpisah dari API: control-plane + engine menempatkan sesi, menyambungkan, mengirim pesan; shutdown rapi melepas semuanya', { skip }, async () => {
  await stopAll();
  const adapters = new FakeAdapterFactory();
  const { sd, exits } = mkShutdown();
  const node = `w-${crypto.randomBytes(3).toString('hex')}`;
  process.env.ENGINE_NODE_NAME = node; (config as any).ENGINE_NODE_NAME = node;
  const w = await startWorkers({ db, log: noLog, sd, roles: parseRoles('engine,control-plane'), adapters, intervals: { controlPlaneMs: 50, engineSyncMs: 50 }, singleton: { retryMs: 20 } });
  assert.ok(w.engine);

  // salah-start dua kali dengan nama node yang sama ditolak (mencegah dua pemilik sesi)
  await assert.rejects(startWorkers({ db, log: noLog, sd: mkShutdown().sd, roles: parseRoles('engine'), adapters }), EngineAlreadyRunningError);

  // "API" (tanpa pekerja) hanya menulis ke DB; seluruh kerja berat dilakukan pekerja terpisah.
  const reg = await identity.register({ email: `w${++n}@x.test`, password: 'correct-horse-battery', tenantName: `T w${n}` });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await svc.create(principal, { name: `ws${++n}`, autoConnect: true });
  const fake = await waitFor(async () => adapters.last(s.id), 'sesi ditempatkan dan runner dibuat oleh pekerja');
  fake.open('6281200000001');
  await waitFor(async () => (await sessStatus(s.id)) === 'CONNECTED', 'CONNECTED');
  const m = await msgs.send(principal, { sessionId: s.id, to: '6281234567890', text: 'dari-pekerja', priority: 5 } as any);
  await waitFor(async () => (await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT status FROM message_queue WHERE id = $1', [m.job_id])).rows[0])).status === 'SENT', 'SENT');
  assert.deepEqual(fake.sent.map((x: any) => x.text), ['dari-pekerja']);

  await sd.run('SIGTERM');
  assert.deepEqual(exits, [0]);
  assert.equal((await engineRow(node)).status, 'STOPPED');
  assert.equal(await sessStatus(s.id), 'PENDING_ASSIGNMENT', 'sesi dikembalikan ke antrean agar diambil engine lain');
  assert.equal(await holderPid(node), undefined, 'kunci singleton dilepas setelah engine berhenti');
});

// ------------------------------------------------------------------ proses sungguhan (src/worker.ts)

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
function runWorker(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = ''; child.stdout!.on('data', (d) => (out += d)); child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code, sig) => r(code ?? (sig ? 128 : null))));
  return { child, exited, output: () => out };
}
const readyJson = (port: number) => new Promise<any>((res) => {
  const r = http.get({ host: '127.0.0.1', port, path: '/health/ready' }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ code: x.statusCode, body: JSON.parse(b || '{}') })); });
  r.on('error', () => res({ code: 0, body: {} }));
});

test('proses worker.ts: start, siap (health), menolak nama node ganda, SIGTERM => berhenti rapi kode 0 dan engine STOPPED', { skip, timeout: 60_000 }, async () => {
  await stopAll();
  const port = await freePort(); const node = `proc-${crypto.randomBytes(3).toString('hex')}`;
  const base = { DB_SCHEMA: db.schema, ENGINE_NODE_NAME: node, WORKER_ROLES: 'engine,control-plane', WORKER_HEALTH_PORT: String(port) };
  const a = runWorker(base);
  const ready = await waitFor(async () => { const r = await readyJson(port); return r.code === 200 && r; }, `worker siap\n${a.output()}`, 20_000);
  assert.deepEqual(ready.body.roles.sort(), ['controlPlane', 'engine']);
  assert.equal(ready.body.node, node);
  const row = await waitFor(async () => { const r = await engineRow(node); return r?.status === 'HEALTHY' && r; }, 'engine terdaftar HEALTHY');
  assert.equal(ready.body.engine_id, row.id);

  // proses kedua dengan nama node sama harus gagal start, tidak mengganggu yang pertama
  const dup = runWorker({ ...base, WORKER_HEALTH_PORT: '0' });
  assert.equal(await dup.exited, 1, dup.output());
  assert.match(dup.output(), /sudah berjalan di proses lain/);
  assert.equal((await readyJson(port)).code, 200, 'worker pertama tetap sehat');

  a.child.kill('SIGTERM');
  assert.equal(await a.exited, 0, a.output());
  assert.equal((await engineRow(node)).status, 'STOPPED');
  assert.equal(await holderPid(node), undefined);
  assert.ok(!/ERROR|"level":50|"level":60/.test(a.output()), `log bersih: ${a.output()}`);
});

test('proses worker.ts: schema belum dimigrasi => gagal cepat kode 1 dengan pesan jelas; peran salah ketik => kode 1', { skip, timeout: 60_000 }, async () => {
  const a = runWorker({ DB_SCHEMA: 'gw_belum_ada', ENGINE_NODE_NAME: 'x', WORKER_ROLES: 'engine', WORKER_HEALTH_PORT: '0' });
  assert.equal(await a.exited, 1); assert.match(a.output(), /belum dimigrasi/);
  const b = runWorker({ DB_SCHEMA: db.schema, WORKER_ROLES: 'engin', WORKER_HEALTH_PORT: '0' });
  assert.equal(await b.exited, 1); assert.match(b.output(), /tidak dikenal .{1,3}engin/);
});
