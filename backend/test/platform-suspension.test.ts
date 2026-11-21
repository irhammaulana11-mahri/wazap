import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';

process.env.PLATFORM_MAX_FAILED_OTP = '20';
process.env.ALERTS_RETRY_BASE_MS = '1';

const { createTestDb, dbAvailable } = await import('./helpers.js');
const { FakeAdapterFactory } = await import('./fake-adapter.js');
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createMessageService } = await import('../src/modules/messaging/messages.service.js');
const { createAuditService } = await import('../src/modules/audit/audit.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createAlertService } = await import('../src/modules/alerts/alerts.service.js');
const { createAlertEvaluator } = await import('../src/modules/engine/alert-evaluator.js');
const { createAlertSender } = await import('../src/modules/engine/alert-sender.js');
const { createOutboxRelay } = await import('../src/modules/engine/outbox-relay.js');
const { createWebhookDeliverer } = await import('../src/modules/engine/webhook-delivery.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createControlPlane } = await import('../src/modules/engine/control-plane.js');
const { createLeaseService } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createQrStore } = await import('../src/modules/engine/qr-store.js');
const { createMessageQueue } = await import('../src/modules/engine/message-queue.js');
const { createEngineRuntime } = await import('../src/modules/engine/engine-runtime.js');
const { createPlatformService } = await import('../src/modules/platform/platform.service.js');
const { attachRealtime } = await import('../src/modules/realtime/realtime.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');
const { base32Decode, totpAt } = await import('../src/security/totp.js');

const LAB = { allowHttp: true, allowPrivate: true };
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const t = skip ? null : await createTestDb(30);
const db = t?.db as any;
const noLog = { info() {}, warn() {}, error: (o: any) => console.error('LOG ERROR', o) };
let clock = 1_900_000_000;
const identity = skip ? (null as any) : createIdentityService(db);
const platform = skip ? (null as any) : createPlatformService(db, { crypto: cr, now: () => clock });
const sessions = skip ? (null as any) : createSessionService(db, { crypto: cr });
const messages = skip ? (null as any) : createMessageService(db);
const wsvc = skip ? (null as any) : createWebhookService(db, { crypto: cr, policy: LAB });
const relay = skip ? (null as any) : createOutboxRelay(db, { maxAttempts: 1 });
const deliverer = skip ? (null as any) : createWebhookDeliverer({ db, crypto: cr, log: noLog, opts: { retryBaseMs: 5, retryMaxMs: 20, random: () => 0, policy: LAB, timeoutMs: 2000 } as any });
let posted: { url: string; body: any }[] = [];
const fakePost = async (url: string, body: string) => { posted.push({ url, body: JSON.parse(body) }); return { statusCode: 200, durationMs: 1 }; };
const alerts = skip ? (null as any) : createAlertService(db, { crypto: cr, post: fakePost, resolve: async () => ['93.184.216.34'] });
const evaluator = skip ? (null as any) : createAlertEvaluator({ db });
const sender = skip ? (null as any) : createAlertSender({ db, crypto: cr, opts: { post: fakePost, random: () => 0 } });
const engines = skip ? (null as any) : createEngineService(db);
const leases = skip ? (null as any) : createLeaseService(db);
const queue = skip ? (null as any) : createMessageQueue(db, leases);
const cp = skip ? (null as any) : createControlPlane(db, engines, noLog);
const app = skip ? (null as any) : buildApp({
  identity, team: createTeamService(db), sessions, messages, alerts, platform, audit: createAuditService(db), checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 },
  limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })(),
});
const runtimes: any[] = []; const servers: http.Server[] = []; const rts: any[] = []; const socks: Socket[] = [];
after(async () => { for (const s of socks) s.close(); for (const r of runtimes) await r.crash().catch(() => {}); for (const r of rts) await r.close().catch(() => {}); for (const s of servers) { s.closeAllConnections?.(); s.close(); } await app?.close(); await t?.drop(); });

let n = 0; const PW = 'kata-sandi-panjang-1';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null> | T | false, what: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(15); }
}
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (method: string, url: string, tok?: string, payload?: any, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload });
  let body: any; try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode as number, body, cookies: r.cookies as { name: string; value: string }[] };
};
interface U { tok: string; userId: string; email: string; tenantId: string; principal: any }
async function reg(): Promise<U> {
  const email = `sp${++n}@x.test`;
  const r = await call('POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Susp ${n}` });
  assert.equal(r.status, 201); const b = r.body.data;
  return { tok: b.access_token, userId: b.user.id, email, tenantId: b.tenant.id, principal: { type: 'user', tenantId: b.tenant.id, userId: b.user.id, role: 'OWNER' } };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call('POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call('POST', '/team/invitations/accept', u.tok, { token: inv.body.data.token });
  const tok = (await call('POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId })).body.data.access_token;
  return { ...u, tenantId: owner.tenantId, tok };
}
const ADMIN = skip ? (null as any) : await (async () => {
  const u = await reg(); const e = await platform.createAdmin(u.email); const secret = base32Decode(e.secretBase32);
  const code = () => totpAt(secret, clock);
  clock += 30; const l = await call('POST', '/platform/auth/login', undefined, { email: u.email, password: PW });
  const v = await call('POST', '/platform/auth/verify', undefined, { mfa_token: l.body.data.mfa_token, code: code() });
  return { u, code, tok: v.body.data.access_token as string };
})();
const act = (kind: 'suspend' | 'activate', tenantId: string, extra: any = {}) => { clock += 30; return call('POST', `/platform/workspaces/${tenantId}/${kind}`, ADMIN.tok, { reason: 'uji penangguhan', otp: ADMIN.code(), ...extra }); };
const stateOf = async (id: string) => (await plat(`SELECT status, desired_state, resume_connect, status_reason FROM wa_sessions WHERE id = $1`, [id]))[0];
const tstatus = async (id: string) => (await plat(`SELECT status, suspended_at FROM tenants WHERE id = $1`, [id]))[0];
async function newEngine() {
  const adapters = new FakeAdapterFactory();
  const rt = createEngineRuntime({
    db, engines, leases, authStore: createAuthStore({ db, leases, crypto: cr }), qrStore: createQrStore({ db, leases, crypto: cr }), queue, adapters, log: noLog,
    opts: { nodeName: `susp-${++n}`, version: 't', capacity: { maxSessions: 50 }, heartbeatSeconds: 1, syncIntervalMs: 10_000, reconnect: { baseMs: 5, maxMs: 20, maxAttempts: 3, random: () => 0 },
      send: { intervalMs: 5, pollMs: 20, timeoutMs: 2000, verifyRecipient: false, random: () => 0 } },
  });
  await rt.start(); runtimes.push(rt);
  return { rt, adapters };
}
async function receiver() {
  let k = 0; const srv = http.createServer((_q, res) => { k++; res.writeHead(200).end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/h`, count: () => k };
}

test('akses berhenti seketika dan pulih: token akses, API key, refresh, login, pindah workspace, terima undangan; workspace lain milik pengguna yang sama tidak terpengaruh', { skip }, async () => {
  const a = await reg(); const m = await join(a, 'MEMBER');           // m adalah MEMBER di A dan OWNER di workspace-nya sendiri (B)
  const key = (await call('POST', '/api-keys', a.tok, { name: 'kunci-uji', scopes: ['sessions:read'] })).body.data.key;
  const login = await call('POST', '/auth/login', undefined, { email: a.email, password: PW });
  const refresh = login.cookies.find((c) => c.name === 'wzp_rt')!.value;
  const newUser = await reg();
  const inv = await call('POST', '/team/invitations', a.tok, { email: newUser.email, role: 'VIEWER' });   // undangan terikat ke surel penerima
  const refreshCall = () => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { wzp_rt: refresh } });
  assert.equal((await call('GET', '/sessions', a.tok)).status, 200); assert.equal((await call('GET', '/sessions', undefined, undefined, { 'x-api-key': key })).status, 200);
  assert.equal((await refreshCall()).statusCode, 200, 'sebelum ditangguhkan, refresh sah');

  const s = await act('suspend', a.tenantId);
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.data.status, 'SUSPENDED'); assert.ok(s.body.data.suspended_at);
  assert.equal((await call('GET', '/sessions', a.tok)).status, 401, 'token akses OWNER langsung mati');
  assert.equal((await call('GET', '/sessions', m.tok)).status, 401, 'token anggota langsung mati');
  assert.equal((await call('GET', '/sessions', undefined, undefined, { 'x-api-key': key })).status, 401, 'API key langsung mati');
  assert.equal((await refreshCall()).statusCode, 401, 'refresh ditolak');
  const lg = await call('POST', '/auth/login', undefined, { email: a.email, password: PW, tenant_id: a.tenantId });
  assert.deepEqual([lg.status, lg.body.error.code], [403, 'WORKSPACE_SUSPENDED'], 'login ke workspace ditangguhkan: galat khusus yang jelas');
  assert.match(lg.body.error.message, /pemilik platform/i);
  const lg2 = await call('POST', '/auth/login', undefined, { email: a.email, password: PW });
  assert.deepEqual([lg2.status, lg2.body.error.code], [403, 'WORKSPACE_SUSPENDED'], 'pengguna yang hanya punya workspace ini diberi tahu penyebabnya');
  assert.deepEqual([(await call('POST', '/auth/login', undefined, { email: a.email, password: 'salah-salah-12345' })).body.error.code], ['INVALID_CREDENTIALS'], 'kata sandi salah tetap seragam: status penangguhan tidak bocor');
  const mb = await call('POST', '/auth/login', undefined, { email: m.email, password: PW });
  assert.equal(mb.status, 200, 'pengguna dengan workspace lain tetap dapat masuk'); assert.notEqual(mb.body.data.tenant.id, a.tenantId);
  assert.equal((await call('POST', '/auth/switch-tenant', mb.body.data.access_token, { tenant_id: a.tenantId })).status, 404, 'pindah ke workspace ditangguhkan ditolak');
  assert.equal((await call('POST', '/team/invitations/accept', newUser.tok, { token: inv.body.data.token })).status, 404, 'undangan ke workspace ditangguhkan tidak dapat diterima');

  const r = await act('activate', a.tenantId);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.data.status, r.body.data.suspended_at], ['ACTIVE', null]);
  assert.equal((await call('GET', '/sessions', a.tok)).status, 200, 'token yang sama berfungsi lagi (tidak dicabut)');
  assert.equal((await call('GET', '/sessions', undefined, undefined, { 'x-api-key': key })).status, 200, 'API key berfungsi lagi');
  assert.equal((await call('POST', '/auth/login', undefined, { email: a.email, password: PW })).status, 200);
  assert.equal((await call('POST', '/team/invitations/accept', newUser.tok, { token: inv.body.data.token })).status, 200, 'undangan sah lagi');
});

test('keamanan dan keadaan: TOTP segar dan alasan wajib, input tidak sah tidak menghabiskan kode, 404 id tidak ada/terhapus, 409 ganda, audit platform dan jejak transparansi', { skip }, async () => {
  const a = await reg();
  assert.equal((await call('POST', `/platform/workspaces/${a.tenantId}/suspend`, ADMIN.tok, { reason: 'uji penangguhan' })).status, 400, 'tanpa otp');
  assert.equal((await call('POST', `/platform/workspaces/${a.tenantId}/suspend`, ADMIN.tok, { otp: '123456' })).status, 400, 'tanpa alasan');
  assert.equal((await call('POST', `/platform/workspaces/${a.tenantId}/suspend`, ADMIN.tok, { otp: '123456', reason: 'uji', extra: 1 })).status, 400, 'strict');
  clock += 30;
  const wrong = await call('POST', `/platform/workspaces/${a.tenantId}/suspend`, ADMIN.tok, { reason: 'uji penangguhan', otp: '000000' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'INVALID_OTP']); assert.equal((await tstatus(a.tenantId)).status, 'ACTIVE');
  // aktifkan workspace yang tidak ditangguhkan: ditolak SEBELUM kode dikonsumsi (kode yang sama masih sah untuk permintaan benar)
  const code = ADMIN.code();
  const notSusp = await call('POST', `/platform/workspaces/${a.tenantId}/activate`, ADMIN.tok, { reason: 'uji penangguhan', otp: code });
  assert.deepEqual([notSusp.status, notSusp.body.error.code], [409, 'INVALID_STATE']);
  const good = await call('POST', `/platform/workspaces/${a.tenantId}/suspend`, ADMIN.tok, { reason: 'penyalahgunaan dilaporkan tiket #77', otp: code });
  assert.equal(good.status, 200, 'kode tidak terpakai oleh permintaan yang ditolak pra-periksa');
  const dup = await act('suspend', a.tenantId); assert.deepEqual([dup.status, dup.body.error.code], [409, 'INVALID_STATE']);
  assert.equal((await act('suspend', crypto.randomUUID())).status, 404); assert.equal((await act('suspend', 'bukan-uuid')).status, 404); assert.equal((await act('activate', 'bukan-uuid')).status, 404);
  const pa = (await plat(`SELECT admin_email, action, details, reason FROM platform_audit_logs WHERE tenant_id = $1 ORDER BY id`, [a.tenantId])).map((x: any) => [x.action, x.reason]);
  assert.deepEqual(pa, [['tenant.suspended', 'penyalahgunaan dilaporkan tiket #77']]);
  await act('activate', a.tenantId);
  const wa = (await call('GET', '/audit-logs?page_size=100', a.tok)).body.data.filter((x: any) => /^tenant\.(suspended|reactivated)$/.test(x.action));
  assert.deepEqual(wa.map((x: any) => [x.action, x.actor.email, x.details.source]).reverse(), [['tenant.suspended', 'platform', 'platform'], ['tenant.reactivated', 'platform', 'platform']]);
  assert.ok(!JSON.stringify(wa).includes('tiket #77') && !JSON.stringify(wa).includes(ADMIN.u.email), 'alasan internal dan identitas operator tidak bocor ke workspace');
  await plat(`UPDATE tenants SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [a.tenantId]);
  assert.equal((await act('suspend', a.tenantId)).status, 404, 'workspace terhapus'); assert.equal((await act('activate', a.tenantId)).status, 404);
});

test('sesi pada engine SUNGGUHAN: yang tersambung diputus lewat jalur putus biasa (adapter ditutup), niat disambung ditandai, yang sengaja diputus pengguna tidak ikut; aktifkan menyambung lagi otomatis', { skip }, async () => {
  const a = await reg(); const e = await newEngine();
  await plat(`UPDATE tenant_settings SET max_sessions = 6 WHERE tenant_id = $1`, [a.tenantId]);
  const s1 = await sessions.create(a.principal, { name: `c${++n}`, autoConnect: true });     // akan tersambung
  const s2 = await sessions.create(a.principal, { name: `d${++n}`, autoConnect: true });     // akan diputus pengguna
  const s3 = await sessions.create(a.principal, { name: `n${++n}`, autoConnect: false });    // tidak pernah disambungkan (CREATED)
  await cp.reconcile(); await e.rt.tick();
  for (const sid of [s1.id, s2.id]) { const f = await waitFor(async () => e.adapters.last(sid), 'adapter'); f.qr('QR'); await waitFor(async () => (await stateOf(sid)).status === 'QR_REQUIRED', 'QR'); f.open('62812000000' + (sid === s1.id ? '1' : '2')); await waitFor(async () => (await stateOf(sid)).status === 'CONNECTED', 'CONNECTED'); }
  await sessions.disconnect(a.principal, s2.id); await e.rt.tick(); await cp.reconcile(); await waitFor(async () => (await stateOf(s2.id)).status === 'DISCONNECTED', 's2 diputus pengguna');
  const authRows = async (sid: string) => (await plat(`SELECT count(*)::int n FROM session_auth_state WHERE session_id = $1`, [sid]))[0].n;
  const before = await authRows(s1.id);

  const susp = await act('suspend', a.tenantId);
  assert.equal(susp.status, 200); assert.equal(susp.body.data.sessions_affected, 1, 'satu sesi sedang berjalan yang dihentikan');
  assert.deepEqual(await stateOf(s1.id), { status: 'DISCONNECTING', desired_state: 'DISCONNECTED', resume_connect: true, status_reason: 'tenant_suspended' });
  assert.equal((await stateOf(s2.id)).resume_connect, false, 'yang sengaja diputus pengguna TIDAK ditandai untuk disambung lagi');
  assert.equal((await stateOf(s3.id)).resume_connect, false); assert.equal((await stateOf(s3.id)).status, 'CREATED');
  const fake1 = e.adapters.last(s1.id)!;
  await e.rt.tick(); await waitFor(async () => fake1.closed, 'adapter ditutup'); await cp.reconcile();
  await waitFor(async () => (await stateOf(s1.id)).status === 'DISCONNECTED', 'DISCONNECTED setelah dilepas');
  assert.equal((await stateOf(s1.id)).desired_state, 'DISCONNECTED'); assert.equal(await authRows(s1.id), before, 'kredensial sesi utuh (penangguhan tidak merusak)');
  assert.equal((await plat(`SELECT count(*)::int n FROM wa_sessions WHERE tenant_id = $1 AND status IN ('DELETING','DELETED')`, [a.tenantId]))[0].n, 0, 'tidak ada sesi yang dihapus');
  await cp.reconcile(); await e.rt.tick(); assert.equal((await stateOf(s1.id)).status, 'DISCONNECTED', 'engine tidak menjalankannya lagi selama ditangguhkan');

  const res = await act('activate', a.tenantId);
  assert.equal(res.status, 200); assert.equal(res.body.data.sessions_affected, 1);
  assert.deepEqual(await stateOf(s1.id), { status: 'PENDING_ASSIGNMENT', desired_state: 'CONNECTED', resume_connect: false, status_reason: 'tenant_reactivated' });
  await cp.reconcile(); await e.rt.tick();
  const fake1b = await waitFor(async () => { const f = e.adapters.last(s1.id); return f && f !== fake1 ? f : false; }, 'adapter baru');
  fake1b.open('628120000001'); await waitFor(async () => (await stateOf(s1.id)).status === 'CONNECTED', 'tersambung lagi');
  assert.equal((await stateOf(s2.id)).status, 'DISCONNECTED'); assert.equal((await stateOf(s2.id)).desired_state, 'DISCONNECTED', 'sesi yang diputus pengguna tetap terputus');
  assert.equal((await stateOf(s3.id)).status, 'CREATED');
  assert.equal((await plat(`SELECT count(*)::int n FROM wa_sessions WHERE tenant_id = $1 AND resume_connect`, [a.tenantId]))[0].n, 0, 'semua penanda dibersihkan');
});

test('balapan: diaktifkan lagi saat sesi MASIH melepas koneksi (DISCONNECTING) tetap berakhir tersambung kembali (control-plane menempatkan ulang setelah lease dilepas)', { skip }, async () => {
  const a = await reg(); const e = await newEngine();
  const s = await sessions.create(a.principal, { name: `r${++n}`, autoConnect: true });
  await cp.reconcile(); await e.rt.tick();
  const f1 = await waitFor(async () => e.adapters.last(s.id), 'adapter'); f1.qr('QR'); await waitFor(async () => (await stateOf(s.id)).status === 'QR_REQUIRED', 'QR'); f1.open('628130000009'); await waitFor(async () => (await stateOf(s.id)).status === 'CONNECTED', 'CONNECTED');
  assert.equal((await act('suspend', a.tenantId)).status, 200);
  assert.equal((await stateOf(s.id)).status, 'DISCONNECTING');
  assert.equal((await act('activate', a.tenantId)).status, 200, 'aktifkan sebelum engine/control-plane sempat menuntaskan');
  assert.deepEqual([(await stateOf(s.id)).status, (await stateOf(s.id)).desired_state, (await stateOf(s.id)).resume_connect], ['DISCONNECTING', 'CONNECTED', false]);
  await e.rt.tick(); await waitFor(async () => f1.closed, 'adapter lama ditutup'); await cp.reconcile();
  await waitFor(async () => { await cp.reconcile(); return ['PENDING_ASSIGNMENT', 'INITIALIZING'].includes((await stateOf(s.id)).status); }, 'ditempatkan ulang setelah dilepas (reconcile menempatkannya langsung)');
  await e.rt.tick();
  const f2 = await waitFor(async () => { const f = e.adapters.last(s.id); return f && f !== f1 ? f : false; }, 'adapter baru');
  f2.open('628130000009'); await waitFor(async () => (await stateOf(s.id)).status === 'CONNECTED', 'tersambung lagi');
});

test('webhook: pengiriman ditahan (tidak dibuang, tidak DEAD) selama ditangguhkan dan lanjut setelah diaktifkan; tenant lain tetap terkirim', { skip }, async () => {
  const a = await reg(); const b = await reg(); const rx = await receiver(); const rxb = await receiver();
  await wsvc.create(a.tenantId, { url: rx.url, events: ['message.sent'] }); await wsvc.create(b.tenantId, { url: rxb.url, events: ['message.sent'] });
  const sent = async (u: U) => { const sid = (await sessions.create(u.principal, { name: `w${++n}`, autoConnect: true })).id; const m = await messages.send(u.principal, { sessionId: sid, to: '6281234567890', text: 'x', priority: 5 }); await plat(`UPDATE message_queue SET status = 'SENT' WHERE id = $1`, [m.job_id]); };
  const flush = async () => { while ((await relay.runOnce()) > 0) { /* kuras */ } for (let i = 0; i < 4; i++) await deliverer.runOnce(); };
  await sent(a); await sent(b);
  assert.equal((await act('suspend', a.tenantId)).status, 200);
  await flush();
  assert.equal(rx.count(), 0, 'workspace ditangguhkan: tidak ada pengiriman keluar'); assert.equal(rxb.count(), 1, 'workspace lain tetap terkirim');
  const pend = await plat(`SELECT status FROM webhook_deliveries WHERE tenant_id = $1`, [a.tenantId]);
  assert.ok(pend.length >= 1 && pend.every((x: any) => x.status === 'PENDING'), `ditahan, bukan dibuang: ${JSON.stringify(pend)}`);
  assert.equal((await act('activate', a.tenantId)).status, 200);
  await flush();
  assert.ok(rx.count() >= 1, 'setelah diaktifkan, pengiriman yang tertahan lanjut');
  assert.ok((await plat(`SELECT status FROM webhook_deliveries WHERE tenant_id = $1`, [a.tenantId])).every((x: any) => x.status === 'SUCCEEDED' || x.status === 'DELIVERED' || x.status === 'SENT'), 'berstatus berhasil');
});

test('alarm: tenant ditangguhkan tidak dievaluasi dan pesan tertunda tidak dikirim; lanjut setelah diaktifkan; tenant lain tetap berjalan', { skip }, async () => {
  const a = await reg(); const b = await reg(); posted = [];
  const mk = async (u: U) => {
    const ch = (await call('POST', '/alerts/channels', u.tok, { type: 'TELEGRAM', name: 'Tim', token: TOKEN, chat_id: '-1001234567890', password: PW })).body.data.id;
    assert.equal((await call('PUT', '/alerts/rules/session.logged_out', u.tok, { enabled: true, channel_ids: [ch] })).status, 200);
    return ch as string;
  };
  await mk(a); await mk(b);
  const logout = async (u: U) => { const sid = (await sessions.create(u.principal, { name: `l${++n}`, autoConnect: false })).id; await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [u.tenantId, sid]); };
  assert.equal((await act('suspend', a.tenantId)).status, 200);
  await logout(a); await logout(b);
  await evaluator.runOnce(); await sender.runOnce();
  const dl = async (u: U) => (await plat(`SELECT status FROM alert_deliveries WHERE tenant_id = $1`, [u.tenantId])).map((x: any) => x.status);
  assert.deepEqual(await dl(a), [], 'tenant ditangguhkan tidak dievaluasi: tidak ada antrean alarm');
  assert.deepEqual(await dl(b), ['SENT'], 'tenant lain tetap berjalan'); assert.equal(posted.length, 1);
  // diaktifkan: kejadian yang terjadi selama penangguhan dan masih dalam jendela lookback dievaluasi (satu pemberitahuan per kejadian, idempoten)
  assert.equal((await act('activate', a.tenantId)).status, 200);
  await evaluator.runOnce(); await evaluator.runOnce();
  const queued = await dl(a); assert.deepEqual(queued, ['PENDING'], 'dievaluasi lagi setelah diaktifkan, tanpa duplikat');
  // antrean yang sudah ada tidak dikirim selama ditangguhkan
  assert.equal((await act('suspend', a.tenantId)).status, 200);
  posted = []; await sender.runOnce();
  assert.deepEqual(await dl(a), ['PENDING'], 'pesan tertunda tidak dikirim selama ditangguhkan'); assert.equal(posted.length, 0);
  assert.equal((await act('activate', a.tenantId)).status, 200);
  await sender.runOnce();
  assert.deepEqual(await dl(a), ['SENT'], 'lanjut terkirim setelah diaktifkan'); assert.equal(posted.length, 1);
});

test('realtime: koneksi Socket.IO workspace yang ditangguhkan diputus (auth.expired) pada penyapuan berikutnya; koneksi baru ditolak', { skip }, async () => {
  const srv = http.createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv);
  const rt = attachRealtime({ httpServer: srv, identity, db, log: noLog, opts: { revalidateMs: 100 } }); await rt.ready(); rts.push(rt);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const a = await reg(); const b = await reg();
  const cli = async (tok: string) => { const s = connect(url, { path: '/api/v1/realtime', auth: { token: tok }, transports: ['websocket'], reconnection: false, forceNew: true }); socks.push(s); const got: Record<string, any[]> = {}; s.onAny((ev, p) => (got[ev] ??= []).push(p)); await new Promise<void>((res, rej) => { s.once('ready', () => res()); s.once('connect_error', rej); }); return { s, got }; };
  const ca = await cli(a.tok); const cb = await cli(b.tok);
  assert.equal((await act('suspend', a.tenantId)).status, 200);
  await waitFor(() => !ca.s.connected, 'koneksi workspace ditangguhkan diputus', 4000);
  assert.ok(ca.got['auth.expired']?.length >= 1); assert.equal(cb.s.connected, true, 'workspace lain tidak terpengaruh');
  const refused = await new Promise<any>((res) => { const s = connect(url, { path: '/api/v1/realtime', auth: { token: a.tok }, transports: ['websocket'], reconnection: false, forceNew: true }); socks.push(s); s.once('connect', () => res(null)); s.once('connect_error', (e) => res(e)); });
  assert.ok(refused, 'koneksi baru ditolak');
  assert.equal((await act('activate', a.tenantId)).status, 200);
  const again = await cli(a.tok); assert.equal(again.s.connected, true, 'pulih setelah diaktifkan');
});
