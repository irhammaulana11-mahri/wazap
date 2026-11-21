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
  assert.deepEqual([r.body.data.editable, r.body.data.managed_by], [false, 'platform'], 'kuota hanya-baca bagi workspace (ADR-054)');
  assert.equal((await get(v)).status, 200, 'VIEWER boleh membaca');
  const mk = async (scopes: string[]) => (await call('POST', '/api-keys', o.tok, { name: 'kunci-' + ++n, scopes })).body.data.key as string;
  assert.equal((await call('GET', '/tenant/settings', undefined, undefined, { 'x-api-key': await mk(['usage:read']) })).status, 200);
  assert.equal((await call('GET', '/tenant/settings', undefined, undefined, { 'x-api-key': await mk(['messages:read']) })).status, 403);
  assert.equal((await call('GET', '/tenant/settings')).status, 401);
});

test('PATCH /tenant/settings: OWNER pun DITOLAK (kuota diatur pemilik platform, ADR-054) dengan kode khusus; MEMBER/VIEWER/API key/tanpa kredensial ditolak seperti biasa; tidak ada yang berubah', { skip }, async () => {
  const o = await reg(); const m = await join(o, 'MEMBER'); const v = await join(o, 'VIEWER');
  const own = await patch(o, { max_sessions: 4 });
  assert.deepEqual([own.status, own.body.error.code], [403, 'QUOTA_MANAGED_BY_PLATFORM']);
  assert.match(own.body.error.message, /pemilik platform/i, 'pesan menunjuk ke pemilik platform');
  for (const u of [m, v]) { const r = await patch(u, { max_sessions: 4 }); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'FORBIDDEN', 'bukan OWNER: ditolak guard peran'); }
  const key = (await call('POST', '/api-keys', o.tok, { name: 'kunci-uji', scopes: ['usage:read', 'sessions:write'] })).body.data.key;
  assert.equal((await call('PATCH', '/tenant/settings', undefined, { max_sessions: 4 }, { 'x-api-key': key })).status, 403);
  assert.equal((await call('PATCH', '/tenant/settings', undefined, { max_sessions: 4 })).status, 401);
  assert.equal((await patch(o, {})).status, 400, 'body tetap divalidasi (strict) sebelum ditolak');
  assert.equal((await patch(o, { max_sessions: 4, extra: 1 })).status, 400);
  assert.deepEqual((await get(o)).body.data.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 }, 'tidak ada yang berubah');
});

test('kuota awal workspace baru berasal dari kuota bawaan platform (platform_defaults), bukan nilai tetap di kode', { skip }, async () => {
  const before = await reg();
  assert.deepEqual((await get(before)).body.data.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 });
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE platform_defaults SET max_sessions = 7, max_api_keys = 9, max_members = 4, messages_per_minute = 33`));
  try {
    const after2 = await reg();
    assert.deepEqual((await get(after2)).body.data.limits, { max_sessions: 7, max_api_keys: 9, max_members: 4, messages_per_minute: 33 }, 'workspace baru memakai bawaan platform');
    assert.deepEqual((await get(before)).body.data.limits, { max_sessions: 3, max_api_keys: 20, max_members: 10, messages_per_minute: 60 }, 'workspace lama tidak berubah');
  } finally { await db.tx({ platform: true }, (c: any) => c.query(`UPDATE platform_defaults SET max_sessions = 3, max_api_keys = 20, max_members = 10, messages_per_minute = 60`)); }
});

test('peran dibaca ulang: OWNER yang baru diturunkan tidak berwenang dengan token lamanya (403 FORBIDDEN, bukan kode kuota)', { skip }, async () => {
  const o = await reg(); const o2 = await join(o, 'OWNER');
  assert.equal((await call('PATCH', `/team/members/${o2.userId}`, o.tok, { role: 'VIEWER' })).status, 200);
  const r = await patch(o2, { max_sessions: 5 });
  assert.deepEqual([r.status, r.body.error.code], [403, 'FORBIDDEN'], 'token lama tidak memberi wewenang; requireRole membaca peran terbaru');
  assert.equal((await get(o)).body.data.limits.max_sessions, 3);
});
