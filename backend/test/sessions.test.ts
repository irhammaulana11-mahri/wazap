import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb();
const db = t?.db as any;
const engines = skip ? (null as any) : createEngineService(db);
const cp = skip ? (null as any) : createControlPlane(db, engines, { info() {}, warn() {}, error: console.error });
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: createSessionService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
async function tenant() {
  const label = `s${++n}`;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: `${label}@x.test`, password: 'correct-horse-battery', tenant_name: `WS ${label}` } });
  const d = r.json().data;
  return { tok: d.access_token as string, tenantId: d.tenant.id as string, userId: d.user.id as string, label };
}
const create = (tok: string, body: any = {}) => app.inject({ method: 'POST', url: '/api/v1/sessions', headers: bearer(tok), payload: { session_name: `dev ${++n}`, ...body } });
const act = (tok: string, id: string, verb: string) => app.inject({ method: verb === 'delete' ? 'DELETE' : 'POST', url: verb === 'delete' ? `/api/v1/sessions/${id}` : `/api/v1/sessions/${id}/${verb}`, headers: bearer(tok) });
const get = (tok: string, id: string) => app.inject({ url: `/api/v1/sessions/${id}`, headers: bearer(tok) });
const events = async (tok: string, id: string) => (await app.inject({ url: `/api/v1/sessions/${id}/events?page_size=100`, headers: bearer(tok) })).json().data.map((e: any) => e.event_type);

test('create: 201, auto_connect => PENDING_ASSIGNMENT, tanpa field internal; auto_connect=false => CREATED', { skip }, async () => {
  const a = await tenant();
  const r = await create(a.tok);
  assert.equal(r.statusCode, 201);
  const s = r.json().data;
  assert.equal(s.status, 'PENDING_ASSIGNMENT'); assert.equal(s.desired_state, 'CONNECTED');
  for (const k of ['engine_id', 'tenant_id', 'auth_version', 'storage_key']) assert.equal(s[k], undefined, k);
  const c = await create(a.tok, { auto_connect: false });
  assert.equal(c.json().data.status, 'CREATED');
  assert.deepEqual(await events(a.tok, c.json().data.id), ['session.created']);
});

test('create: validasi, tenant_id klien ditolak, nama duplikat 409 (case-insensitive), nama bebas lagi setelah delete', { skip }, async () => {
  const a = await tenant(); const b = await tenant();
  for (const body of [{ session_name: 'x' }, { session_name: '<script>' }, { session_name: 'ok name', tenant_id: a.tenantId }, { session_name: 'ok name', engine_id: 'x' }]) {
    const r = await create(a.tok, body); assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
  const ok = await create(a.tok, { session_name: 'Toko Utama', auto_connect: false });
  assert.equal(ok.statusCode, 201);
  const dup = await create(a.tok, { session_name: 'toko utama' });
  assert.equal(dup.statusCode, 409); assert.equal(dup.json().error.code, 'SESSION_NAME_TAKEN');
  assert.equal((await create(b.tok, { session_name: 'Toko Utama' })).statusCode, 201, 'tenant lain boleh memakai nama sama');
  assert.equal((await act(a.tok, ok.json().data.id, 'delete')).statusCode, 202);
  assert.equal((await create(a.tok, { session_name: 'Toko Utama' })).statusCode, 201);
});

test('kuota max_sessions dipaksakan (session yang dihapus tidak dihitung)', { skip }, async () => {
  const a = await tenant();
  await db.tx({ tenantId: a.tenantId }, (c: any) => c.query('UPDATE tenant_settings SET max_sessions = 2 WHERE tenant_id=$1', [a.tenantId]));
  const s1 = await create(a.tok); await create(a.tok);
  const over = await create(a.tok);
  assert.equal(over.statusCode, 409); assert.equal(over.json().error.code, 'QUOTA_EXCEEDED');
  await act(a.tok, s1.json().data.id, 'delete');
  assert.equal((await create(a.tok)).statusCode, 201);
});

test('list: paginasi + filter status, hanya milik tenant', { skip }, async () => {
  const a = await tenant(); const b = await tenant();
  for (let i = 0; i < 3; i++) await create(a.tok, { auto_connect: i === 0 });
  await create(b.tok);
  const l = (await app.inject({ url: '/api/v1/sessions?page=1&page_size=2', headers: bearer(a.tok) })).json();
  assert.equal(l.meta.total, 3); assert.equal(l.data.length, 2);
  const f = (await app.inject({ url: '/api/v1/sessions?status=CREATED', headers: bearer(a.tok) })).json();
  assert.equal(f.meta.total, 2);
  assert.equal((await app.inject({ url: '/api/v1/sessions?status=BOGUS', headers: bearer(a.tok) })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/v1/sessions?page_size=1000', headers: bearer(a.tok) })).statusCode, 400);
});

test('ISOLASI TENANT: A tidak bisa get/status/events/connect/disconnect/reconnect/delete sesi B (404)', { skip }, async () => {
  const a = await tenant(); const b = await tenant();
  const sb = (await create(b.tok)).json().data.id;
  for (const r of [await get(a.tok, sb), await app.inject({ url: `/api/v1/sessions/${sb}/status`, headers: bearer(a.tok) }),
    await app.inject({ url: `/api/v1/sessions/${sb}/events`, headers: bearer(a.tok) }),
    await act(a.tok, sb, 'connect'), await act(a.tok, sb, 'disconnect'), await act(a.tok, sb, 'reconnect'), await act(a.tok, sb, 'delete')])
    assert.equal(r.statusCode, 404);
  assert.equal((await get(a.tok, 'not-a-uuid')).statusCode, 404);
  assert.equal((await get(b.tok, sb)).json().data.status, 'PENDING_ASSIGNMENT', 'sesi B tidak berubah');
  assert.deepEqual(await events(b.tok, sb), ['session.status_changed', 'session.created'], 'event terbaru lebih dulu; tidak ada event baru dari A');
});

test('role & scope: VIEWER hanya baca; API key butuh sessions:write', { skip }, async () => {
  const a = await tenant(); const v = await tenant();
  await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'VIEWER')`, [a.tenantId, v.userId]));
  const vt = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${v.label}@x.test`, password: 'correct-horse-battery', tenant_id: a.tenantId } })).json().data.access_token;
  const s = (await create(a.tok)).json().data.id;
  assert.equal((await get(vt, s)).statusCode, 200);
  assert.equal((await create(vt)).statusCode, 403);
  assert.equal((await act(vt, s, 'delete')).statusCode, 403);
  const mk = async (scopes: string[]) => (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: bearer(a.tok), payload: { name: 'k1', scopes } })).json().data.key;
  const ro = await mk(['sessions:read']), rw = await mk(['sessions:write']), other = await mk(['messages:send']);
  assert.equal((await get(ro, s)).statusCode, 200);
  assert.equal((await create(ro)).statusCode, 403);
  assert.equal((await act(rw, s, 'disconnect')).statusCode, 202);
  assert.equal((await get(rw, s)).statusCode, 403, 'write tidak otomatis mencakup read');
  assert.equal((await get(other, s)).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/sessions' })).statusCode, 401);
});

test('lifecycle via API: connect idempoten, disconnect dari pending => DISCONNECTED, connect ulang, reconnect', { skip }, async () => {
  const a = await tenant(); const id = (await create(a.tok, { auto_connect: false })).json().data.id;
  assert.equal((await act(a.tok, id, 'connect')).json().data.status, 'PENDING_ASSIGNMENT');
  assert.equal((await act(a.tok, id, 'connect')).statusCode, 202, 'idempoten');
  assert.equal((await act(a.tok, id, 'disconnect')).json().data.status, 'DISCONNECTED');
  assert.equal((await act(a.tok, id, 'disconnect')).statusCode, 202, 'idempoten');
  assert.equal((await act(a.tok, id, 'connect')).json().data.status, 'PENDING_ASSIGNMENT');
  assert.equal((await act(a.tok, id, 'reconnect')).statusCode, 202);
  const ev = await events(a.tok, id);
  assert.equal(ev[ev.length - 1], 'session.created');
  assert.equal(ev.filter((e: string) => e === 'session.status_changed').length, 3, 'reconnect pada PENDING_ASSIGNMENT adalah no-op');
});

test('end-to-end dengan control-plane: assign -> reconnect melepas lease & menaikkan token -> delete -> DELETED', { skip }, async () => {
  await db.tx({ platform: true }, async (c: any) => {
    await c.query(`UPDATE engine_nodes SET status='STOPPED'`);
    await c.query(`UPDATE wa_sessions SET status='DISCONNECTED', desired_state='DISCONNECTED' WHERE status='PENDING_ASSIGNMENT'`); // antrean sisa tes lain
  });
  const e = await engines.register({ nodeName: 'api-e2e', hostname: 'h', version: '1', capacity: { maxSessions: 5 } });
  const a = await tenant(); const id = (await create(a.tok)).json().data.id;
  await cp.reconcile();
  assert.equal((await get(a.tok, id)).json().data.status, 'INITIALIZING');
  const tok = async () => Number((await db.tx({ platform: true }, (c: any) => c.query('SELECT fencing_token FROM session_leases WHERE session_id=$1', [id]))).rows[0].fencing_token);
  const t1 = await tok();
  assert.equal((await act(a.tok, id, 'reconnect')).json().data.status, 'PENDING_ASSIGNMENT');
  assert.equal((await db.tx({ platform: true }, (c: any) => c.query('SELECT engine_id FROM session_leases WHERE session_id=$1', [id]))).rows[0].engine_id, null);
  await cp.reconcile();
  assert.ok(await tok() > t1, 'owner baru => fencing token naik');
  assert.equal((await act(a.tok, id, 'delete')).json().data.status, 'DELETING');
  assert.equal((await create(a.tok, { session_name: 'baru setelah hapus' })).statusCode, 201);
  await cp.reconcile();
  assert.equal((await get(a.tok, id)).statusCode, 404, 'DELETED tidak terlihat');
  assert.equal((await act(a.tok, id, 'connect')).statusCode, 404);
  await engines.setStatus(e.id, 'STOPPED');
});

test('event tidak pernah memuat QR/kredensial/token; event immutable di level DB', { skip }, async () => {
  const a = await tenant(); const id = (await create(a.tok)).json().data.id;
  await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(
    `INSERT INTO wa_session_events (tenant_id, session_id, event_type, actor, payload) VALUES ($1,$2,'x','SYSTEM','{}')`, [a.tenantId, id]));
  const rows = await db.tx({ tenantId: a.tenantId }, async (c: any) => (await c.query('SELECT payload FROM wa_session_events')).rows);
  assert.ok(!/qr|creds|token|secret/i.test(JSON.stringify(rows)));
  const upd = await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`UPDATE wa_session_events SET event_type='tampered'`));
  assert.equal(upd.rowCount, 0, 'tidak ada kebijakan UPDATE');
  const del = await db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`DELETE FROM wa_session_events`));
  assert.equal(del.rowCount, 0, 'tidak ada kebijakan DELETE');
});

test('RLS tabel sesi: tanpa konteks kosong; tenant tidak melihat sesi/lease/event/engine/credential tenant lain', { skip }, async () => {
  const a = await tenant(); const b = await tenant();
  await create(a.tok); await create(b.tok);
  const cnt = (ctx: any, tb: string) => db.tx(ctx, async (c: any) => (await c.query(`SELECT count(*)::int n FROM ${tb}`)).rows[0].n);
  for (const tb of ['wa_sessions', 'wa_session_events', 'session_leases', 'engine_nodes', 'session_credentials']) assert.equal(await cnt({}, tb), 0, tb);
  assert.equal(await cnt({ tenantId: a.tenantId }, 'engine_nodes'), 0, 'tenant tidak melihat engine');
  assert.equal(await cnt({ tenantId: a.tenantId }, 'session_credentials'), 0);
  const only = await db.tx({ tenantId: a.tenantId }, async (c: any) => (await c.query('SELECT DISTINCT tenant_id FROM wa_sessions')).rows);
  assert.deepEqual(only.map((r: any) => r.tenant_id), [a.tenantId]);
  await assert.rejects(() => db.tx({ tenantId: a.tenantId }, (c: any) => c.query(
    `INSERT INTO wa_sessions (tenant_id, session_name) VALUES ($1,'sneaky')`, [b.tenantId])), /row-level security/);
  await assert.rejects(() => db.tx({ tenantId: a.tenantId }, (c: any) => c.query(
    `INSERT INTO engine_nodes (node_name,hostname,version,capacity_config) VALUES ('evil','h','1','{"max_sessions":1}')`)), /row-level security/);
  // composite FK: event dengan tenant_id tidak cocok dengan sesi ditolak
  const sidB = (await db.tx({ tenantId: b.tenantId }, async (c: any) => (await c.query('SELECT id FROM wa_sessions LIMIT 1')).rows[0])).id;
  await assert.rejects(() => db.tx({ platform: true }, (c: any) => c.query(
    `INSERT INTO wa_session_events (tenant_id, session_id, event_type, actor) VALUES ($1,$2,'x','SYSTEM')`, [a.tenantId, sidB])), /foreign key/);
  assert.equal((await app.inject({ url: '/api/v1/sessions', headers: bearer(a.tok) })).json().meta.total, 1);
});

test('nomor telepon unik per tenant untuk sesi aktif', { skip }, async () => {
  const a = await tenant(); const b = await tenant();
  const s1 = (await create(a.tok)).json().data.id, s2 = (await create(a.tok)).json().data.id, s3 = (await create(b.tok)).json().data.id;
  const setPhone = (tn: any, id: string) => db.tx({ tenantId: tn.tenantId }, (c: any) => c.query(`UPDATE wa_sessions SET phone_number='6281234567890' WHERE id=$1`, [id]));
  await setPhone(a, s1);
  await assert.rejects(() => setPhone(a, s2), /uq_wa_sessions_phone/);
  await setPhone(b, s3);
});
