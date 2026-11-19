import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createEngineService, chooseEngine, lockPlacement } = await import('../src/modules/engine/engine.service.js');
const { createLeaseService, FencedError } = await import('../src/modules/engine/lease.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');

const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db, { ttlSeconds: 30 });
const sessions = skip ? (null as any) : createSessionService(db);
const log = { info() {}, warn() {}, error(o: any) { console.error('CP ERROR', o); } };
const cp = skip ? (null as any) : createControlPlane(db, engines, log);
after(async () => { await t?.drop(); });

const sql = (q: string, p: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(q, p)).rows);
let n = 0;
async function tenant() {
  const tenantId = crypto.randomUUID(), userId = crypto.randomUUID(), label = `t${++n}${crypto.randomBytes(3).toString('hex')}`;
  await db.tx({ tenantId, userId }, async (c: any) => {
    await c.query(`INSERT INTO users (id,email,password_hash) VALUES ($1,$2,'h')`, [userId, `${label}@x.test`]);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)`, [tenantId, label, `${label}-ws`]);
    await c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')`, [tenantId, userId]);
    await c.query(`INSERT INTO tenant_settings (tenant_id, max_sessions) VALUES ($1, 100)`, [tenantId]);
  });
  return { tenantId, p: { type: 'user' as const, userId, tenantId, role: 'OWNER' as const } };
}
const newEngine = (name = `e${++n}${crypto.randomBytes(2).toString('hex')}`, max = 3, weight = 1) =>
  engines.register({ nodeName: name, hostname: 'h', version: '1', capacity: { maxSessions: max, weight } }) as Promise<{ id: string }>;
async function pendingSession(tn: Awaited<ReturnType<typeof tenant>>, name?: string) {
  return sessions.create(tn.p, { name: name ?? `s${++n}`, autoConnect: true });
}
const status = async (id: string) => (await sql('SELECT status, engine_id FROM wa_sessions WHERE id=$1', [id]))[0];
const lease = async (id: string) => (await sql('SELECT * FROM session_leases WHERE session_id=$1', [id]))[0];
const expire = (id: string) => sql(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id=$1`, [id]);

test('register engine: upsert berdasarkan node_name, heartbeat memulihkan SUSPECT', { skip }, async () => {
  const a = await newEngine('node-x'); const b = await newEngine('node-x');
  assert.equal(a.id, b.id);
  await sql(`UPDATE engine_nodes SET status='SUSPECT' WHERE id=$1`, [a.id]);
  assert.equal(await engines.heartbeat(a.id, { mem_free_mb: 100 }), true);
  assert.equal((await sql('SELECT status, resource_snapshot FROM engine_nodes WHERE id=$1', [a.id]))[0].status, 'HEALTHY');
  await engines.setStatus(a.id, 'STOPPED');
  assert.equal(await engines.heartbeat(a.id), false, 'STOPPED tidak hidup kembali lewat heartbeat');
});

test('sweep: heartbeat usang HEALTHY -> SUSPECT -> UNHEALTHY', { skip }, async () => {
  const e = await newEngine();
  await sql(`UPDATE engine_nodes SET heartbeat_at = now() - interval '40 seconds' WHERE id=$1`, [e.id]);
  await engines.sweep({ suspectAfterSec: 30, unhealthyAfterSec: 60 });
  assert.equal((await sql('SELECT status FROM engine_nodes WHERE id=$1', [e.id]))[0].status, 'SUSPECT');
  await sql(`UPDATE engine_nodes SET heartbeat_at = now() - interval '70 seconds' WHERE id=$1`, [e.id]);
  await engines.sweep({ suspectAfterSec: 30, unhealthyAfterSec: 60 });
  assert.equal((await sql('SELECT status FROM engine_nodes WHERE id=$1', [e.id]))[0].status, 'UNHEALTHY');
  await sql(`UPDATE engine_nodes SET status='STOPPED' WHERE id=$1`, [e.id]);
});

test('lease: acquire hanya satu pemenang di bawah konkurensi; token monoton', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const es = await Promise.all(Array.from({ length: 8 }, () => newEngine()));
  const res = await Promise.all(es.map((e) => leases.acquire(s.id, e.id)));
  const winners = res.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].fencingToken, 1);
  const w = winners[0];
  assert.equal(await leases.acquire(s.id, es[0].id), null, 'lease aktif tidak bisa diambil');
  assert.equal(await leases.release(w), true);
  const again = await leases.acquire(s.id, es[1].id);
  assert.equal(again.fencingToken, 2, 'token monoton melewati release');
  await expire(s.id);
  const third = await leases.acquire(s.id, es[2].id);
  assert.equal(third.fencingToken, 3, 'takeover setelah kedaluwarsa menaikkan token');
  assert.equal((await status(s.id)).engine_id, es[2].id);
  for (const e of es) await engines.setStatus(e.id, 'STOPPED');
});

test('lease: engine tidak sehat/STOPPED tidak boleh mengambil lease', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const e = await newEngine(); await engines.setStatus(e.id, 'DRAINING');
  assert.equal(await leases.acquire(s.id, e.id), null);
  await engines.setStatus(e.id, 'STOPPED');
});

test('lease: renew hanya oleh owner+token yang cocok; owner lama gagal setelah takeover', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const e1 = await newEngine(), e2 = await newEngine();
  const l1 = await leases.acquire(s.id, e1.id);
  assert.equal(await leases.renew(l1), true);
  assert.equal(await leases.renew({ ...l1, fencingToken: l1.fencingToken + 1 }), false);
  assert.equal(await leases.renew({ ...l1, engineId: e2.id }), false);
  await expire(s.id);
  const l2 = await leases.acquire(s.id, e2.id);
  assert.equal(await leases.renew(l1), false, 'owner lama harus berhenti');
  assert.equal(await leases.release(l1), false);
  assert.equal(await leases.renew(l2), true);
  await engines.setStatus(e1.id, 'STOPPED'); await engines.setStatus(e2.id, 'STOPPED');
});

test('fencing: engine lama ditolak menulis setelah takeover; engine sah boleh', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const e1 = await newEngine(), e2 = await newEngine();
  const l1 = await leases.acquire(s.id, e1.id);
  assert.equal(await leases.withFence(l1, async () => 'ok'), 'ok');
  await expire(s.id);
  const l2 = await leases.acquire(s.id, e2.id);
  await assert.rejects(() => leases.withFence(l1, async () => 'tulis'), FencedError);
  assert.equal(await leases.withFence(l2, async () => 'ok'), 'ok');
  await expire(s.id);
  await assert.rejects(() => leases.withFence(l2, async () => 'x'), FencedError, 'lease kedaluwarsa juga ditolak');
  await engines.setStatus(e1.id, 'STOPPED'); await engines.setStatus(e2.id, 'STOPPED');
});

test('fencing: takeover menunggu penulisan berfencing yang sedang berjalan (tidak ada tulis setelah kehilangan owner)', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const e1 = await newEngine(), e2 = await newEngine();
  const l1 = await leases.acquire(s.id, e1.id);
  await sql(`UPDATE session_leases SET lease_expires_at = now() + interval '1 second' WHERE session_id=$1`, [s.id]);
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  let started!: () => void; const inside = new Promise<void>((r) => (started = r));
  const writer = leases.withFence(l1, async () => { started(); await gate; return 'done'; });
  await inside;
  await new Promise((r) => setTimeout(r, 1300)); // lease kedaluwarsa secara alami saat penulisan berjalan
  let takeoverDone = false;
  const takeover = leases.acquire(s.id, e2.id).then((r: any) => { takeoverDone = true; return r; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(takeoverDone, false, 'takeover harus menunggu transaksi penulisan');
  release();
  assert.equal(await writer, 'done');
  const l2 = await takeover;
  assert.equal(l2.fencingToken, 2);
  await engines.setStatus(e1.id, 'STOPPED'); await engines.setStatus(e2.id, 'STOPPED');
});

test('DB menolak fencing_token turun atau pindah owner tanpa menaikkan token', { skip }, async () => {
  const tn = await tenant(); const s = await pendingSession(tn);
  const e1 = await newEngine(), e2 = await newEngine();
  await leases.acquire(s.id, e1.id);
  await assert.rejects(() => sql('UPDATE session_leases SET fencing_token = 0 WHERE session_id=$1', [s.id]), /tidak boleh turun/);
  await assert.rejects(() => sql(`UPDATE session_leases SET engine_id=$2, lease_expires_at=now()+interval '1 min' WHERE session_id=$1`, [s.id, e2.id]), /wajib menaikkan/);
  await engines.setStatus(e1.id, 'STOPPED'); await engines.setStatus(e2.id, 'STOPPED');
});

async function stopAll() {
  // Reset: engine berhenti, sesi sisa dari tes lain keluar dari antrean, lease dilepas.
  await sql(`UPDATE engine_nodes SET status='STOPPED'`);
  await sql(`UPDATE session_leases SET engine_id=NULL, lease_expires_at=NULL`);
  await sql(`UPDATE wa_sessions SET status='DISCONNECTED', desired_state='DISCONNECTED', engine_id=NULL WHERE status NOT IN ('DELETED')`);
}

test('placement: weighted least-loaded, patuh kapasitas, abaikan engine tidak sehat/draining', { skip }, async () => {
  await stopAll();
  const small = await newEngine('p-small', 2, 1), big = await newEngine('p-big', 10, 4), drain = await newEngine('p-drain', 10, 100);
  await engines.setStatus(drain.id, 'DRAINING');
  const tn = await tenant();
  const placed: string[] = [];
  for (let i = 0; i < 5; i++) { const s = await pendingSession(tn); await cp.assignPending(); placed.push((await status(s.id)).engine_id); }
  assert.ok(!placed.includes(drain.id));
  assert.ok(placed.every(Boolean));
  assert.ok(placed.filter((x) => x === big.id).length >= 3, 'engine berbobot besar menerima lebih banyak');
  assert.ok(placed.filter((x) => x === small.id).length <= 2, 'kapasitas small tidak terlampaui');
  await stopAll();
});

test('placement: guard memori minimum mengecualikan engine', { skip }, async () => {
  await stopAll();
  const e = await engines.register({ nodeName: 'mem', hostname: 'h', version: '1', capacity: { maxSessions: 5, minFreeMemMb: 500 } });
  await engines.heartbeat(e.id, { mem_free_mb: 100 });
  const tn = await tenant(); const s = await pendingSession(tn);
  await cp.assignPending();
  assert.equal((await status(s.id)).status, 'PENDING_ASSIGNMENT');
  await engines.heartbeat(e.id, { mem_free_mb: 900 });
  await cp.assignPending();
  assert.equal((await status(s.id)).status, 'INITIALIZING');
  await stopAll();
});

test('tanpa kapasitas sesi tetap PENDING_ASSIGNMENT; tidak ada overcommit di bawah konkurensi', { skip }, async () => {
  await stopAll();
  const tn = await tenant();
  const ss = await Promise.all(Array.from({ length: 8 }, () => pendingSession(tn)));
  await cp.assignPending();
  assert.equal((await sql(`SELECT count(*)::int n FROM wa_sessions WHERE id = ANY($1) AND status='PENDING_ASSIGNMENT'`, [ss.map((x: any) => x.id)]))[0].n, 8);
  const e = await newEngine('cap', 3);
  await Promise.all([cp.assignPending(), cp.assignPending(), cp.assignPending(), cp.assignPending()]);
  const owned = (await sql(`SELECT count(*)::int n FROM session_leases WHERE engine_id=$1`, [e.id]))[0].n;
  assert.equal(owned, 3, 'tepat sesuai kapasitas');
  assert.equal((await sql(`SELECT count(*)::int n FROM wa_sessions WHERE id = ANY($1) AND status='INITIALIZING'`, [ss.map((x: any) => x.id)]))[0].n, 3);
  await stopAll();
});

test('fair scheduling: tenant kecil tidak kelaparan oleh tenant besar', { skip }, async () => {
  await stopAll();
  const big = await tenant(), small = await tenant();
  const bigS = []; for (let i = 0; i < 6; i++) bigS.push(await pendingSession(big));
  const smallS = await pendingSession(small); // dibuat paling akhir
  await newEngine('fair', 2);
  await cp.assignPending();
  assert.equal((await status(smallS.id)).status, 'INITIALIZING', 'tenant kecil mendapat slot meski antrean tenant besar lebih dulu');
  const bigAssigned = (await sql(`SELECT count(*)::int n FROM wa_sessions WHERE id = ANY($1) AND status='INITIALIZING'`, [bigS.map((x: any) => x.id)]))[0].n;
  assert.equal(bigAssigned, 1);
  await stopAll();
});

test('control-plane: lease kedaluwarsa -> sesi kembali PENDING lalu pindah ke engine lain dengan token naik', { skip }, async () => {
  await stopAll();
  const e1 = await newEngine('f1', 5);
  const tn = await tenant(); const s = await pendingSession(tn);
  await cp.reconcile();
  assert.equal((await status(s.id)).engine_id, e1.id);
  const tok1 = Number((await lease(s.id)).fencing_token);
  await engines.setStatus(e1.id, 'STOPPED'); // engine mati
  const e2 = await newEngine('f2', 5);
  await expire(s.id);
  const rep = await cp.reconcile();
  assert.equal(rep.leasesExpired >= 1, true);
  const st = await status(s.id);
  assert.equal(st.status, 'INITIALIZING'); assert.equal(st.engine_id, e2.id);
  assert.ok(Number((await lease(s.id)).fencing_token) > tok1);
  const ev = (await sql(`SELECT event_type FROM wa_session_events WHERE session_id=$1 ORDER BY id`, [s.id])).map((r: any) => r.event_type);
  assert.deepEqual(ev, ['session.created', 'session.status_changed', 'session.assigned', 'session.lease_expired', 'session.assigned']);
  await stopAll();
});

test('control-plane: sesi yang diminta DISCONNECTED tidak dipulihkan; DISCONNECTING/DELETING difinalisasi', { skip }, async () => {
  await stopAll();
  const e = await newEngine('fin', 5);
  const tn = await tenant();
  const a = await pendingSession(tn), b = await pendingSession(tn);
  await cp.reconcile();
  await sessions.disconnect(tn.p, a.id);               // INITIALIZING -> DISCONNECTING (engine masih pegang lease)
  assert.equal((await status(a.id)).status, 'DISCONNECTING');
  await cp.reconcile();
  assert.equal((await status(a.id)).status, 'DISCONNECTING', 'menunggu owner');
  await expire(a.id); await cp.reconcile();
  assert.equal((await status(a.id)).status, 'DISCONNECTED');
  await sessions.remove(tn.p, b.id);
  assert.equal((await lease(b.id)).engine_id, null, 'delete mencabut lease');
  await sql(`INSERT INTO session_credentials (session_id, tenant_id, storage_key, encryption_key_version) VALUES ($1,$2,'k',1)`, [b.id, tn.tenantId]);
  await cp.reconcile();
  assert.equal((await status(b.id)).status, 'DELETED');
  assert.equal((await sql('SELECT count(*)::int n FROM session_credentials WHERE session_id=$1', [b.id]))[0].n, 0, 'referensi kredensial dihapus');
  await engines.setStatus(e.id, 'STOPPED');
});

test('reconcile idempoten dan chooseEngine tanpa engine => null', { skip }, async () => {
  await stopAll();
  const r1 = await cp.reconcile(), r2 = await cp.reconcile();
  assert.equal(r1.assigned + r2.assigned, 0);
  const picked = await db.tx({ platform: true }, async (c: any) => { await lockPlacement(c); return chooseEngine(c); });
  assert.equal(picked, null);
});
