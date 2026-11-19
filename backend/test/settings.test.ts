import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSettingsService } = await import('../src/modules/tenant/settings.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { config } = await import('../src/config/env.js');

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const app = skip ? (null as any) : buildApp({
  identity: createIdentityService(db), sessions: createSessionService(db, { crypto: cr }), team: createTeamService(db), settings: createSettingsService(db), audit: createAuditService(db), checkDb: async () => true,
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
  apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
});
after(async () => { await app?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const call = async (method: string, url: string, tok?: string, payload?: any, headers: any = {}, remoteAddress?: string) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload, remoteAddress });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body };
};
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `st${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Set ${n}` });
  return { tok: r.body.data.access_token, userId: r.body.data.user.id, email, tenantId: r.body.data.tenant.id };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  const tok = (await call('POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId })).body.data.access_token;
  return { ...u, tenantId: owner.tenantId, tok };
}
const get = (u: U) => call('GET', '/tenant/settings', u.tok);
const patch = (u: U, body: any, ip?: string) => call('PATCH', '/tenant/settings', u.tok, body, {}, ip);
const mkSession = (u: U, name: string) => call('POST', '/sessions', u.tok, { session_name: name, auto_connect: false });
const auditOf = async (u: U) => (await call('GET', '/audit-logs?page_size=100&action=settings.updated', u.tok)).body.data as any[];

test('GET /tenant/settings: batas, batas atas (ceiling), minimum, pemakaian; semua peran; API key butuh usage:read', { skip }, async () => {
  const o = await reg(); const v = await join(o, 'VIEWER');
  const r = await get(o);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 });
  assert.deepEqual(r.body.data.ceilings, { max_sessions: config.LIMIT_CEIL_SESSIONS, max_api_keys: config.LIMIT_CEIL_API_KEYS, max_members: config.LIMIT_CEIL_MEMBERS, messages_per_minute: config.LIMIT_CEIL_MESSAGES_PER_MINUTE });
  assert.deepEqual(r.body.data.minimums, { max_sessions: 1, max_api_keys: 0, max_members: 1, messages_per_minute: 1 });
  assert.deepEqual(r.body.data.used, { sessions: 0, api_keys: 0, members: 2 }, 'anggota = OWNER + VIEWER');
  assert.equal((await get(v)).status, 200, 'VIEWER boleh membaca');
  const mk = async (scopes: string[]) => (await call('POST', '/api-keys', o.tok, { name: 'kunci-' + ++n, scopes })).body.data.key as string;
  assert.equal((await call('GET', '/tenant/settings', undefined, undefined, { 'x-api-key': await mk(['usage:read']) })).status, 200);
  assert.equal((await call('GET', '/tenant/settings', undefined, undefined, { 'x-api-key': await mk(['messages:read']) })).status, 403);
  assert.equal((await call('GET', '/tenant/settings')).status, 401);
});

test('PATCH: hanya OWNER dashboard; ADMIN/MEMBER/VIEWER dan API key ditolak', { skip }, async () => {
  const o = await reg(); const a = await join(o, 'ADMIN'); const m = await join(o, 'MEMBER'); const v = await join(o, 'VIEWER');
  for (const u of [a, m, v]) assert.equal((await patch(u, { max_sessions: 4 })).status, 403);
  const key = (await call('POST', '/api-keys', o.tok, { name: 'kunci-uji', scopes: ['usage:read', 'sessions:write'] })).body.data.key;
  assert.equal((await call('PATCH', '/tenant/settings', undefined, { max_sessions: 4 }, { 'x-api-key': key })).status, 403);
  assert.equal((await call('PATCH', '/tenant/settings', undefined, { max_sessions: 4 })).status, 401);
  assert.equal((await get(o)).body.data.limits.max_sessions, 3, 'tidak ada yang berubah');
  assert.equal((await patch(o, { max_sessions: 4 })).status, 200);
});

test('perubahan berlaku seketika: sesi ke-4 ditolak lalu diizinkan setelah dinaikkan; dibatasi pemakaian saat ini', { skip }, async () => {
  const o = await reg();
  for (const nm of ['s1', 's2', 's3']) assert.equal((await mkSession(o, nm)).status, 201);
  const full = await mkSession(o, 's4');
  assert.deepEqual([full.status, full.body.error.code], [409, 'QUOTA_EXCEEDED']);
  const up = await patch(o, { max_sessions: 5 });
  assert.equal(up.status, 200); assert.equal(up.body.data.limits.max_sessions, 5); assert.equal(up.body.data.used.sessions, 3);
  assert.equal((await mkSession(o, 's4')).status, 201, 'berlaku seketika tanpa restart');
  // tidak boleh di bawah pemakaian
  const low = await patch(o, { max_sessions: 3 });
  assert.deepEqual([low.status, low.body.error.code], [409, 'LIMIT_BELOW_USAGE']);
  assert.equal((await get(o)).body.data.limits.max_sessions, 5, 'gagal = tidak berubah');
  assert.equal((await patch(o, { max_sessions: 4 })).status, 200, 'sama dengan pemakaian: boleh');
  assert.equal((await mkSession(o, 's5')).body.error.code, 'QUOTA_EXCEEDED');
  // kunci API
  await call('POST', '/api-keys', o.tok, { name: 'kunci-satu', scopes: ['usage:read'] });
  assert.equal((await patch(o, { max_api_keys: 1 })).status, 200);
  assert.equal((await call('POST', '/api-keys', o.tok, { name: 'kunci-dua', scopes: ['usage:read'] })).body.error.code, 'QUOTA_EXCEEDED');
  assert.equal((await patch(o, { max_api_keys: 0 })).body.error.code, 'LIMIT_BELOW_USAGE');
  // anggota (anggota + undangan tertunda dihitung)
  await call('POST', '/team/invitations', o.tok, { email: 'p1@x.test', role: 'VIEWER' });
  assert.equal((await patch(o, { max_members: 1 })).body.error.code, 'LIMIT_BELOW_USAGE');
  assert.equal((await patch(o, { max_members: 2 })).status, 200);
  assert.equal((await call('POST', '/team/invitations', o.tok, { email: 'p2@x.test', role: 'VIEWER' })).body.error.code, 'QUOTA_EXCEEDED');
  // pesan/menit: tanpa pemakaian, bebas dalam rentang
  const mpm = await patch(o, { messages_per_minute: 5 });
  assert.equal(mpm.body.data.limits.messages_per_minute, 5);
  const dbv = await db.tx({ tenantId: o.tenantId }, async (c: any) => (await c.query('SELECT messages_per_minute n FROM tenant_settings WHERE tenant_id = $1', [o.tenantId])).rows[0].n);
  assert.equal(dbv, 5, 'nilai yang dibaca penegak klaim pesan ikut berubah');
});

test('rentang: di atas ceiling, di bawah minimum, bukan bilangan bulat, tipe salah, field asing, kosong => 400', { skip }, async () => {
  const o = await reg();
  const bad = async (body: any, path?: string) => {
    const r = await patch(o, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    if (path) assert.ok(r.body.error.details.some((d: any) => d.path === path), `${path}: ${JSON.stringify(r.body.error.details)}`);
  };
  await bad({ max_sessions: config.LIMIT_CEIL_SESSIONS + 1 }, 'max_sessions');
  await bad({ max_sessions: 0 }, 'max_sessions');
  await bad({ max_members: 0 }, 'max_members');
  await bad({ max_api_keys: -1 }, 'max_api_keys');
  await bad({ messages_per_minute: 0 }, 'messages_per_minute');
  await bad({ messages_per_minute: config.LIMIT_CEIL_MESSAGES_PER_MINUTE + 1 }, 'messages_per_minute');
  await bad({ max_api_keys: config.LIMIT_CEIL_API_KEYS + 1 }, 'max_api_keys');
  await bad({ max_members: config.LIMIT_CEIL_MEMBERS + 1 }, 'max_members');
  await bad({ max_sessions: 2.5 }); await bad({ max_sessions: '4' }); await bad({ max_sessions: null });
  await bad({ tenant_id: crypto.randomUUID() }); await bad({ max_sessions: 4, extra: 1 }); await bad({});
  // batas tepat pada ceiling/minimum diterima
  assert.equal((await patch(o, { max_sessions: config.LIMIT_CEIL_SESSIONS, messages_per_minute: 1, max_api_keys: 0, max_members: config.LIMIT_CEIL_MEMBERS })).status, 200);
  const l = (await get(o)).body.data.limits;
  assert.deepEqual(l, { max_sessions: config.LIMIT_CEIL_SESSIONS, max_api_keys: 0, max_members: config.LIMIT_CEIL_MEMBERS, messages_per_minute: 1 });
  // satu nilai salah membatalkan seluruh permintaan (tidak ada perubahan sebagian)
  const mixed = await patch(o, { max_sessions: 2, messages_per_minute: config.LIMIT_CEIL_MESSAGES_PER_MINUTE + 5 });
  assert.equal(mixed.status, 400); assert.equal((await get(o)).body.data.limits.max_sessions, config.LIMIT_CEIL_SESSIONS);
});

test('audit: perubahan tercatat (sebelum/sesudah, pelaku, ip); no-op dan penolakan tidak mencatat; tenant lain tidak terpengaruh', { skip }, async () => {
  const o = await reg(); const other = await reg();
  assert.equal((await patch(o, { max_sessions: 4, messages_per_minute: 30 }, '10.4.3.2')).status, 200);
  const a = await auditOf(o);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].action, a[0].actor.user_id, a[0].actor.role, a[0].target.type, a[0].target.id, a[0].ip], ['settings.updated', o.userId, 'OWNER', 'settings', o.tenantId, '10.4.3.2']);
  assert.deepEqual(a[0].details.changes, { max_sessions: { from: 3, to: 4 }, messages_per_minute: { from: 60, to: 30 } });
  // no-op (nilai sama) dan penolakan tidak mencatat
  assert.equal((await patch(o, { max_sessions: 4 })).status, 200);
  assert.equal((await patch(o, { max_sessions: 999 })).status, 400);
  assert.equal((await patch(o, { max_sessions: 1 })).status, 200); // sah (di atas pemakaian 0) -> tercatat
  assert.equal((await auditOf(o)).length, 2);
  // tenant lain
  assert.deepEqual((await get(other)).body.data.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 });
  assert.equal((await auditOf(other)).length, 0);
  assert.equal((await patch(other, { max_sessions: 2 })).status, 200);
  assert.equal((await get(o)).body.data.limits.max_sessions, 1, 'perubahan tenant lain tidak menimpa');
});

test('ceiling dikendalikan operator lewat env: menurunkan LIMIT_CEIL_* langsung membatasi apa yang boleh diatur OWNER', { skip }, async () => {
  const o = await reg();
  const prev = config.LIMIT_CEIL_SESSIONS;
  (config as any).LIMIT_CEIL_SESSIONS = 4;
  try {
    assert.equal((await patch(o, { max_sessions: 5 })).status, 400, 'di atas ceiling baru');
    assert.equal((await patch(o, { max_sessions: 4 })).status, 200);
    assert.equal((await get(o)).body.data.ceilings.max_sessions, 4);
  } finally { (config as any).LIMIT_CEIL_SESSIONS = prev; }
});

test('peran dibaca ulang di dalam lock: OWNER yang baru diturunkan tidak dapat mengubah kuota dengan token lamanya', { skip }, async () => {
  const o = await reg(); const o2 = await join(o, 'OWNER');
  assert.equal((await call('PATCH', `/team/members/${o2.userId}`, o.tok, { role: 'VIEWER' })).status, 200);
  const r = await patch(o2, { max_sessions: 5 });
  assert.equal(r.status, 403, 'token lama tidak memberi wewenang; requireRole membaca peran terbaru');
  assert.equal((await get(o)).body.data.limits.max_sessions, 3);
});
