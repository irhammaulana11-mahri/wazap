import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env sebelum modul dimuat (config dibaca sekali): ambang kecil agar perilaku batas dapat diuji.
process.env.ALERTS_AUTO_DISABLE_AFTER = '2';
process.env.ALERTS_MAX_PER_CHANNEL_PER_HOUR = '3';
process.env.ALERTS_MAX_ATTEMPTS = '2';
process.env.ALERTS_RETRY_BASE_MS = '1';
process.env.ALERTS_TEST_PER_HOUR = '2';

const { createTestDb, dbAvailable } = await import('./helpers.js'); // setelah env: helpers memuat config
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createAlertService } = await import('../src/modules/alerts/alerts.service.js');
const { createAlertEvaluator } = await import('../src/modules/engine/alert-evaluator.js');
const { createAlertSender } = await import('../src/modules/engine/alert-sender.js');
const { buildAlertText, RULES } = await import('../src/modules/alerts/rules.js');
const { createKeyRotator } = await import('../src/runtime/rotate-keys.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');
const { createRetention } = await import('../src/modules/engine/retention.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const k1 = crypto.randomBytes(32).toString('base64'), k2 = crypto.randomBytes(32).toString('base64');
const cr = createCredentialCrypto(parseKeyring(`1:${k1}`));
const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);

interface Posted { url: string; body: any }
let posted: Posted[] = []; let respond: (url: string) => { statusCode?: number; errorCode?: string } = () => ({ statusCode: 200 });
const fakePost = async (url: string, body: string) => { posted.push({ url, body: JSON.parse(body) }); return { ...respond(url), durationMs: 1 }; };
const alerts = skip ? (null as any) : createAlertService(db, { crypto: cr, post: fakePost, resolve: async (h) => (h === 'rebind.example' ? ['10.0.0.1'] : ['93.184.216.34']) });
const evaluator = skip ? (null as any) : createAlertEvaluator({ db });
const sender = skip ? (null as any) : createAlertSender({ db, crypto: cr, opts: { post: fakePost, random: () => 0 } });
const mk = (extra: any = {}) => buildApp({ identity, team: createTeamService(db), sessions: createSessionService(db), alerts, checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 }, ...extra });
const app = skip ? (null as any) : mk({ limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
const strict = skip ? (null as any) : mk(); // pembatas laju nyata
after(async () => { await app?.close(); await strict?.close(); await t?.drop(); });

let n = 0; const PW = 'kata-sandi-panjang-1';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX';
const q = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
const call = async (a: any, method: string, url: string, tok?: string, payload?: any) =>
  (await a.inject({ method, url: `/api/v1${url}`, headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload })) as any;
interface U { tok: string; userId: string; email: string; tenantId: string }
async function reg(): Promise<U> {
  const email = `al${++n}@x.test`;
  const r = await call(app, 'POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Alarm ${n}` });
  assert.equal(r.statusCode, 201); const b = r.json().data;
  return { tok: b.access_token, userId: b.user.id, email, tenantId: b.tenant.id };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call(app, 'POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call(app, 'POST', '/team/invitations/accept', u.tok, { token: inv.json().data.token });
  const lg = await call(app, 'POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId });
  return { ...u, tenantId: owner.tenantId, tok: lg.json().data.access_token };
}
const tg = (o: U, name = 'Telegram tim', extra: any = {}) => call(app, 'POST', '/alerts/channels', o.tok, { type: 'TELEGRAM', name, token: TOKEN, chat_id: '-1001234567890', password: PW, ...extra });
const sl = (o: U, name = 'Slack tim', extra: any = {}) => call(app, 'POST', '/alerts/channels', o.tok, { type: 'SLACK', name, url: SLACK, password: PW, ...extra });
const rule = (o: U, code: string, body: any) => call(app, 'PUT', `/alerts/rules/${code}`, o.tok, body);
async function session(o: U, name: string) {
  return (await createSessionService(db).create({ type: 'user', tenantId: o.tenantId, userId: o.userId, role: 'OWNER' } as any, { name, autoConnect: false })).id as string;
}
const run = async () => { const e = await evaluator.runOnce(); let s = 0; for (let i = 0; i < 5; i++) { const k = await sender.runOnce(); s += k; if (!k) break; } return { queued: e, sent: s }; };
const deliveries = (tenantId: string) => q(tenantId, `SELECT rule_code, status, attempts, last_error_code, last_status_code FROM alert_deliveries WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId]);

// ---------- teks pesan ----------

test('teks notifikasi: aman dari karakter kontrol, tidak memuat nomor telepon, rahasia, atau URL penuh', () => {
  const t1 = buildAlertText('session.logged_out', { session_name: 'Toko\u0000\n[EVIL]\u0007', phone: '6281234567890', token: 'SECRET' }, 'https://app.example.com');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(t1.replace(/\n/g, '')), 'tanpa karakter kontrol');
  assert.ok(!t1.includes('6281234567890') && !t1.includes('SECRET'), 'hanya fakta yang dikenal dipakai');
  assert.match(t1, /Sesi: Toko/); assert.match(t1, /https:\/\/app\.example\.com$/);
  const w = buildAlertText('webhook.endpoint_disabled', { endpoint_host: 'api.klien.test', reason: 'AUTO_CONSECUTIVE_FAILURES', url: 'https://api.klien.test/hook?token=RAHASIA' });
  assert.ok(!w.includes('RAHASIA') && w.includes('api.klien.test'));
  for (const r of RULES) assert.ok(buildAlertText(r.code, {}).startsWith('[WAZAP]'), `aturan ${r.code} punya teks`);
  assert.ok(buildAlertText('channel.test', {}).includes('Pesan uji'));
});

// ---------- hak akses dan kata sandi ----------

test('hak akses: MEMBER/VIEWER dan API key ditolak; katalog boleh dibaca semua anggota', { skip }, async () => {
  const owner = await reg(); const member = await join(owner, 'MEMBER'); const viewer = await join(owner, 'VIEWER'); const admin = await join(owner, 'OWNER');
  for (const u of [member, viewer]) {
    for (const [m, url] of [['GET', '/alerts/channels'], ['GET', '/alerts/rules'], ['GET', '/alerts/deliveries']] as const) assert.equal((await call(app, m, url, u.tok)).statusCode, 403, `${u.email} ${url}`);
    assert.equal((await tg(u)).statusCode, 403);
    assert.equal((await rule(u, 'session.logged_out', { enabled: false, channel_ids: [] })).statusCode, 403);
    assert.equal((await call(app, 'GET', '/alerts/catalog', u.tok)).statusCode, 200);
  }
  assert.equal((await call(app, 'GET', '/alerts/channels')).statusCode, 401);
  assert.equal((await tg(admin)).statusCode, 201, 'OWNER kedua boleh');
  const key = (await call(app, 'POST', '/api-keys', owner.tok, { name: 'kunci-uji', scopes: ['usage:read'] })).json().data.key;
  for (const [m, url] of [['GET', '/alerts/channels'], ['GET', '/alerts/rules'], ['GET', '/alerts/deliveries']] as const)
    assert.equal((await app.inject({ method: m, url: `/api/v1${url}`, headers: { 'x-api-key': key } })).statusCode, 403, `API key ${url}`);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/alerts/channels', headers: { 'x-api-key': key }, payload: { type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: PW } })).statusCode, 403);
});

test('kata sandi: wajib untuk membuat, mengganti target, dan menghapus; salah = 403 tanpa efek; dikunci setelah 5 salah', { skip }, async () => {
  const o = await reg();
  assert.equal((await tg(o, 'x', { password: 'salah-salah-1' })).statusCode, 403);
  assert.equal((await q(o.tenantId, 'SELECT 1 FROM alert_channels WHERE tenant_id = $1', [o.tenantId])).length, 0, 'tidak ada kanal terbuat');
  const c = (await tg(o)).json().data;
  const noPw = await call(app, 'PATCH', `/alerts/channels/${c.id}`, o.tok, { token: TOKEN, chat_id: '555' });
  assert.equal(noPw.statusCode, 400, 'ganti target tanpa kata sandi ditolak');
  assert.equal((await call(app, 'PATCH', `/alerts/channels/${c.id}`, o.tok, { token: TOKEN, chat_id: '555', password: 'salah-salah-1' })).statusCode, 403);
  assert.equal((await call(app, 'PATCH', `/alerts/channels/${c.id}`, o.tok, { name: 'Nama baru' })).statusCode, 200, 'ganti nama tidak butuh kata sandi');
  assert.equal((await call(app, 'DELETE', `/alerts/channels/${c.id}`, o.tok, { password: 'salah-salah-1' })).statusCode, 403);
  assert.equal((await q(o.tenantId, 'SELECT 1 FROM alert_channels WHERE id = $1', [c.id])).length, 1, 'tidak terhapus');
  // penguncian: pembatas nyata
  const o2 = await reg(); let last = 0;
  for (let i = 0; i < 6; i++) last = (await call(strict, 'POST', '/alerts/channels', o2.tok, { type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: 'salah-salah-1' })).statusCode;
  assert.equal(last, 429, 'setelah 5 salah terkunci');
  const locked = await call(strict, 'POST', '/alerts/channels', o2.tok, { type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: PW });
  assert.equal(locked.statusCode, 429, 'kata sandi benar pun tertahan saat terkunci'); assert.ok(Number(locked.headers['retry-after']) > 0);
});

// ---------- rahasia ----------

test('rahasia: token/URL tidak pernah muncul di respons, daftar, audit, atau kolom DB (hanya terenkripsi)', { skip }, async () => {
  const o = await reg();
  const a = await tg(o); const b = await sl(o);
  assert.equal(a.statusCode, 201); assert.equal(b.statusCode, 201);
  const blob = JSON.stringify([a.json(), b.json(), (await call(app, 'GET', '/alerts/channels', o.tok)).json()]);
  for (const s of [TOKEN, 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9', 'XXXXSECRETXXXX', 'hooks.slack.com/services']) assert.ok(!blob.includes(s), `respons membocorkan ${s}`);
  assert.equal(a.json().data.target_hint, 'saw9'); assert.equal(b.json().data.target_hint, 'XXXX');
  const rows = await q(o.tenantId, 'SELECT target_ciphertext FROM alert_channels WHERE tenant_id = $1', [o.tenantId]);
  for (const r of rows) { const raw = Buffer.from(r.target_ciphertext).toString('latin1'); assert.ok(!raw.includes('AAHdqTcv') && !raw.includes('XXXXSECRET') && !raw.includes('hooks.slack')); }
  const audit = JSON.stringify(await q(o.tenantId, `SELECT details, target_id FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'alert_%'`, [o.tenantId]));
  assert.ok(audit.includes('alert_channel') === false || !audit.includes('AAHdq'), 'audit tanpa rahasia'); assert.ok(!audit.includes('XXXXSECRET') && !audit.includes(PW));
  const actions = (await q(o.tenantId, `SELECT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'alert_channel.%'`, [o.tenantId])).map((r: any) => r.action);
  assert.equal(actions.filter((x: string) => x === 'alert_channel.created').length, 2);
  // dekripsi dengan AAD tenant+id yang benar berhasil; AAD tenant lain gagal
  const row = (await plat('SELECT id, tenant_id, target_ciphertext FROM alert_channels WHERE id = $1', [a.json().data.id]))[0];
  const { alertTargetAad } = await import('../src/security/alert-target.js');
  assert.match(cr.decrypt(row.target_ciphertext, alertTargetAad(row.tenant_id, row.id)).toString(), /AAHdq/);
  assert.throws(() => cr.decrypt(row.target_ciphertext, alertTargetAad(crypto.randomUUID(), row.id)), /gagal/);
});

// ---------- validasi target (SSRF) ----------

test('validasi target: Slack hanya host yang diizinkan, https, tanpa kredensial/port aneh/IP internal/DNS rebinding; Telegram format ketat', { skip }, async () => {
  const o = await reg();
  const bad: [string, string][] = [
    ['http://hooks.slack.com/services/a/b/c', 'http'], ['https://localhost/x', 'localhost'], ['https://127.0.0.1/x', 'loopback'], ['https://169.254.169.254/latest/meta-data', 'metadata'],
    ['https://[::1]/x', 'ipv6'], ['https://2130706433/x', 'desimal'], ['https://hooks.slack.com.evil.com/x', 'subdomain palsu'], ['https://evil.com/hooks.slack.com', 'host lain'],
    ['https://user:pw@hooks.slack.com/x', 'kredensial'], ['https://hooks.slack.com:8443/x', 'port'], ['https://rebind.example/x', 'rebinding'], ['ftp://hooks.slack.com/x', 'skema'], ['bukan url', 'sintaks'],
  ];
  for (const [url, why] of bad) { const r = await call(app, 'POST', '/alerts/channels', o.tok, { type: 'SLACK', name: 'x', url, password: PW }); assert.ok([422, 400].includes(r.statusCode), `${why}: ${url} => ${r.statusCode}`); }
  assert.equal((await sl(o, 'discord', { url: 'https://discord.com/api/webhooks/1/abcdef/slack' })).statusCode, 201);
  for (const body of [{ token: 'bukan-token', chat_id: '1' }, { token: TOKEN, chat_id: 'abc def' }, { token: TOKEN, chat_id: '@ab' }, { token: TOKEN + '/../x', chat_id: '1' }])
    assert.ok([422, 400].includes((await tg(o, 'x', body)).statusCode), `Telegram ditolak ${JSON.stringify(body)}`);
  assert.equal((await tg(o, 'kanal publik', { chat_id: '@kanal_saya_x' })).statusCode, 201);
  const extra = await call(app, 'POST', '/alerts/channels', o.tok, { type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: PW, host: 'evil.test' });
  assert.equal(extra.statusCode, 400, 'field asing ditolak (strict)');
});

test('kuota kanal: maks ALERTS_MAX_CHANNELS per workspace', { skip }, async () => {
  const o = await reg();
  for (let i = 0; i < 5; i++) assert.equal((await tg(o, `k${i}`)).statusCode, 201);
  const r = await tg(o, 'k6'); assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'QUOTA_EXCEEDED');
});

// ---------- isolasi tenant ----------

test('isolasi tenant: tenant B tidak dapat melihat/mengubah/menghapus/menguji kanal tenant A, atau memakainya di aturan; RLS di DB', { skip }, async () => {
  const A = await reg(); const B = await reg();
  const chA = (await tg(A)).json().data.id;
  assert.deepEqual((await call(app, 'GET', '/alerts/channels', B.tok)).json().data, []);
  assert.equal((await call(app, 'PATCH', `/alerts/channels/${chA}`, B.tok, { name: 'bajak' })).statusCode, 404);
  assert.equal((await call(app, 'DELETE', `/alerts/channels/${chA}`, B.tok, { password: PW })).statusCode, 404);
  assert.equal((await call(app, 'POST', `/alerts/channels/${chA}/test`, B.tok)).statusCode, 404);
  assert.equal((await rule(B, 'session.logged_out', { enabled: true, channel_ids: [chA] })).statusCode, 400, 'kanal tenant lain tidak dapat dipilih');
  assert.equal((await call(app, 'PATCH', `/alerts/channels/${chA}`, B.tok, { token: TOKEN, chat_id: '1', password: PW })).statusCode, 404);
  assert.equal((await q(B.tenantId, 'SELECT * FROM alert_channels')).length, 0, 'RLS: B melihat 0 baris');
  assert.equal((await q(B.tenantId, 'SELECT * FROM alert_rules')).length, 0);
  assert.equal((await q(B.tenantId, 'SELECT * FROM alert_deliveries')).length, 0);
  await assert.rejects(q(B.tenantId, `INSERT INTO alert_channels (tenant_id, type, name, target_ciphertext, target_key_version, target_hint) VALUES ($1,'SLACK','x','\\x00',1,'x')`, [A.tenantId]), /row-level security/);
  assert.equal((await call(app, 'GET', '/alerts/channels', A.tok)).json().data.length, 1, 'A tetap utuh');
});

// ---------- aturan ----------

test('aturan: bawaan, validasi ambang dan jeda, wajib kanal, kanal dihapus dilepas dari aturan', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id;
  const list = (await call(app, 'GET', '/alerts/rules', o.tok)).json().data;
  assert.equal(list.length, RULES.length); assert.ok(list.every((r: any) => r.enabled === false && r.channel_ids.length === 0));
  assert.equal(list.find((r: any) => r.code === 'session.disconnected_long').threshold, 10);
  assert.equal((await rule(o, 'session.logged_out', { enabled: true, channel_ids: [] })).statusCode, 400, 'aktif tanpa kanal');
  assert.equal((await rule(o, 'session.logged_out', { enabled: true, threshold: 5, channel_ids: [ch] })).statusCode, 400, 'tanpa ambang');
  assert.equal((await rule(o, 'session.logged_out', { enabled: true, cooldown_minutes: 10, channel_ids: [ch] })).statusCode, 400, 'tanpa jeda ulang');
  assert.equal((await rule(o, 'session.disconnected_long', { enabled: true, threshold: 0, channel_ids: [ch] })).statusCode, 400);
  assert.equal((await rule(o, 'session.disconnected_long', { enabled: true, threshold: 1441, channel_ids: [ch] })).statusCode, 400);
  assert.equal((await rule(o, 'tidak.ada', { enabled: false, channel_ids: [] })).statusCode, 400);
  assert.equal((await rule(o, 'session.disconnected_long', { enabled: true, threshold: 3, cooldown_minutes: 5, channel_ids: [ch] })).statusCode, 200);
  assert.equal((await rule(o, 'session.disconnected_long', { enabled: true, threshold: 3, cooldown_minutes: 4, channel_ids: [ch] })).statusCode, 400);
  const got = (await call(app, 'GET', '/alerts/rules', o.tok)).json().data.find((r: any) => r.code === 'session.disconnected_long');
  assert.deepEqual([got.enabled, got.threshold, got.cooldown_minutes, got.channel_ids], [true, 3, 5, [ch]]);
  assert.equal((await call(app, 'DELETE', `/alerts/channels/${ch}`, o.tok, { password: PW })).statusCode, 200);
  assert.deepEqual((await call(app, 'GET', '/alerts/rules', o.tok)).json().data.find((r: any) => r.code === 'session.disconnected_long').channel_ids, [], 'kanal terhapus dilepas');
  assert.equal((await q(o.tenantId, `SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'alert_rule.updated'`, [o.tenantId])).length, 1, 'hanya perubahan yang berhasil diaudit');
});

// ---------- uji kirim ----------

test('uji kirim: sinkron, hasil apa adanya, dibatasi per jam; kegagalan tidak membocorkan rahasia', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id; posted = [];
  respond = () => ({ statusCode: 200 });
  let r = (await call(strict, 'POST', `/alerts/channels/${ch}/test`, o.tok)).json().data; assert.equal(r.ok, true);
  assert.equal(posted.length, 1); assert.ok(posted[0]!.url.startsWith('https://api.telegram.org/bot'), 'host Telegram dikunci');
  assert.equal(posted[0]!.body.chat_id, '-1001234567890'); assert.match(posted[0]!.body.text, /Pesan uji/);
  respond = () => ({ statusCode: 401 });
  r = (await call(strict, 'POST', `/alerts/channels/${ch}/test`, o.tok)).json().data; assert.deepEqual([r.ok, r.status_code], [false, 401]);
  assert.ok(!JSON.stringify(r).includes('AAHdq'));
  const lim = await call(strict, 'POST', `/alerts/channels/${ch}/test`, o.tok);
  assert.equal(lim.statusCode, 429); assert.ok(Number(lim.headers['retry-after']) > 0);
  respond = () => ({ statusCode: 200 });
});

// ---------- evaluator + pengirim ----------

test('LOGGED_OUT: satu kejadian = satu notifikasi per kanal walau evaluator dijalankan berulang; teks tanpa nomor telepon', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Toko Utama');
  const c1 = (await tg(o)).json().data.id, c2 = (await sl(o)).json().data.id; posted = [];
  await plat(`UPDATE wa_sessions SET phone_number = '6281234567890' WHERE id = $1`, [sid]);
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [c1, c2] });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, from_status, to_status, actor) VALUES ($1,$2,'status','CONNECTED','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  const a = await run(); assert.deepEqual([a.queued, a.sent], [2, 2]);
  const b = await run(); assert.deepEqual([b.queued, b.sent], [0, 0], 'idempoten');
  await Promise.all([evaluator.runOnce(), evaluator.runOnce()]); // dua instans bersamaan
  assert.equal((await deliveries(o.tenantId)).length, 2);
  assert.equal(posted.length, 2);
  const tgMsg = posted.find((p) => p.url.includes('telegram'))!, slMsg = posted.find((p) => p.url.includes('slack'))!;
  assert.match(tgMsg.body.text, /Sesi: Toko Utama/); assert.equal(slMsg.url, SLACK);
  for (const p of posted) assert.ok(!JSON.stringify(p.body).includes('6281234567890'), 'tidak memuat nomor telepon');
  assert.ok((await deliveries(o.tenantId)).every((d: any) => d.status === 'SENT'));
});

test('aturan nonaktif / tanpa kanal aktif tidak mengantre; tenant lain tidak ikut menerima', { skip }, async () => {
  const A = await reg(); const B = await reg(); const sa = await session(A, 'A1'); const sb = await session(B, 'B1');
  const ch = (await tg(A)).json().data.id;
  await rule(A, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE'), ($3,$4,'status','LOGGED_OUT','ENGINE')`, [A.tenantId, sa, B.tenantId, sb]);
  await run();
  assert.equal((await deliveries(A.tenantId)).length, 1); assert.equal((await deliveries(B.tenantId)).length, 0, 'B tidak mengatur aturan');
  await call(app, 'PATCH', `/alerts/channels/${ch}`, A.tok, { active: false });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [A.tenantId, sa]);
  await run(); assert.equal((await deliveries(A.tenantId)).length, 1, 'kanal nonaktif tidak menerima antrean baru');
});

test('terputus lama: hanya sesi yang seharusnya tersambung; diulang paling cepat tiap jeda (jendela)', { skip }, async () => {
  const o = await reg(); const s1 = await session(o, 'Putus'), s2 = await session(o, 'Sengaja'), s3 = await session(o, 'Sehat');
  const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'session.disconnected_long', { enabled: true, threshold: 10, cooldown_minutes: 60, channel_ids: [ch] });
  await plat(`UPDATE wa_sessions SET status='DISCONNECTED', desired_state='CONNECTED' WHERE id = $1`, [s1]);
  await plat(`UPDATE wa_sessions SET status='DISCONNECTED', desired_state='DISCONNECTED' WHERE id = $1`, [s2]);
  await plat(`UPDATE wa_sessions SET status='CONNECTED', desired_state='CONNECTED' WHERE id = $1`, [s3]);
  await plat(`ALTER TABLE wa_sessions DISABLE TRIGGER trg_wa_sessions_updated`);
  try { await plat(`UPDATE wa_sessions SET updated_at = now() - interval '30 minutes' WHERE id IN ($1,$2,$3)`, [s1, s2, s3]); } finally { await plat(`ALTER TABLE wa_sessions ENABLE TRIGGER trg_wa_sessions_updated`); }
  await run();
  assert.equal(posted.length, 1); assert.match(posted[0]!.body.text, /Sesi: Putus/); assert.match(posted[0]!.body.text, /sekitar 30 menit/);
  await run(); assert.equal(posted.length, 1, 'jendela yang sama tidak diulang');
  await plat(`UPDATE alert_deliveries SET window_key = 'lama' WHERE tenant_id = $1`, [o.tenantId]); // simulasi jendela berikutnya
  await run(); assert.equal(posted.length, 2, 'jendela baru = pengingat baru');
});

test('putus-sambung berulang: hanya bila jumlah perubahan dalam 10 menit mencapai ambang', { skip }, async () => {
  const o = await reg(); const s1 = await session(o, 'Goyang'), s2 = await session(o, 'Tenang');
  const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'session.reconnect_loop', { enabled: true, threshold: 4, channel_ids: [ch] });
  for (let i = 0; i < 4; i++) await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status',$3,'ENGINE')`, [o.tenantId, s1, i % 2 ? 'DISCONNECTED' : 'RECONNECTING']);
  for (let i = 0; i < 3; i++) await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','RECONNECTING','ENGINE')`, [o.tenantId, s2]);
  await run(); assert.equal(posted.length, 1); assert.match(posted[0]!.body.text, /Goyang/); assert.match(posted[0]!.body.text, /4 perubahan/);
});

test('gagal berkelompok dan pesan tidak pasti: ambang jumlah, tanpa isi/nomor', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Kirim');
  const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'message.failed_burst', { enabled: true, threshold: 3, channel_ids: [ch] });
  await rule(o, 'message.unknown', { enabled: true, channel_ids: [ch] });
  const ins = (status: string) => plat(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, actor, status) VALUES ($1,$2,'6281010101010','{"text":"RAHASIA-ISI"}','USER',$3)`, [o.tenantId, sid, status]);
  await ins('FAILED'); await ins('FAILED'); await run(); assert.equal(posted.length, 0, 'di bawah ambang');
  await ins('FAILED'); await ins('UNKNOWN'); await run();
  assert.equal(posted.length, 2);
  const all = JSON.stringify(posted); assert.ok(!all.includes('RAHASIA-ISI') && !all.includes('6281010101010'), 'tanpa isi pesan/nomor');
  assert.ok(posted.some((p) => /3 pesan keluar gagal/.test(p.body.text)) && posted.some((p) => /UNKNOWN/.test(p.body.text)));
});

test('webhook dinonaktifkan dan webhook DEAD berkelompok: hanya host, tanpa URL penuh', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'webhook.endpoint_disabled', { enabled: true, channel_ids: [ch] });
  await rule(o, 'webhook.dead_burst', { enabled: true, threshold: 2, channel_ids: [ch] });
  const ep = (await plat(`INSERT INTO webhook_endpoints (tenant_id, url, events, secret_ciphertext, secret_key_version, secret_hint, active, disabled_at, disabled_reason)
    VALUES ($1,'https://hook.klien.test/path?token=RAHASIA-URL',ARRAY['*'],'\\x00',1,'abcd',false,now(),'AUTO_CONSECUTIVE_FAILURES') RETURNING id`, [o.tenantId]))[0].id;
  for (let i = 0; i < 2; i++) await plat(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status, last_error_code) VALUES ($1,$2,gen_random_uuid(),'message.sent','{}','DEAD','HTTP_ERROR')`, [o.tenantId, ep]);
  await plat(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status, last_error_code) VALUES ($1,$2,gen_random_uuid(),'webhook.test','{}','DEAD','HTTP_ERROR')`, [o.tenantId, ep]);
  await run(); assert.equal(posted.length, 2);
  const all = JSON.stringify(posted); assert.ok(!all.includes('RAHASIA-URL') && all.includes('hook.klien.test'));
  assert.ok(posted.some((p) => /2 pengiriman webhook/.test(p.body.text)), 'webhook.test tidak dihitung');
});

test('ekspor selesai: hanya outcome completed, memuat jenis dan jumlah baris', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'export.completed', { enabled: true, channel_ids: [ch] });
  const ins = (outcome: string) => q(o.tenantId, `INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id, details) VALUES ($1,$2,'data.exported','export','contacts',$3::jsonb)`, [o.tenantId, o.userId, JSON.stringify({ type: 'contacts', outcome, rows: 42 })]);
  await ins('aborted'); await ins('failed'); await ins('completed');
  await run(); assert.equal(posted.length, 1); assert.match(posted[0]!.body.text, /contacts, baris: 42/);
});

// ---------- perilaku pengirim ----------

test('pengirim: 5xx diulang lalu berhasil; 401/403/404 langsung DEAD; kanal dinonaktifkan setelah N DEAD beruntun dan tercatat di audit', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Uji'); const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  const ev = () => plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  let calls = 0; respond = () => (++calls === 1 ? { statusCode: 503 } : { statusCode: 200 });
  await ev(); await evaluator.runOnce(); await sender.runOnce(); await new Promise((r) => setTimeout(r, 20)); await sender.runOnce();
  let d = await deliveries(o.tenantId); assert.deepEqual([d[0].status, d[0].attempts], ['SENT', 2], '5xx diulang lalu SENT');
  respond = () => ({ statusCode: 401 });
  await ev(); await evaluator.runOnce(); await sender.runOnce();
  d = await deliveries(o.tenantId); assert.deepEqual([d[1].status, d[1].attempts, d[1].last_error_code], ['DEAD', 1, 'HTTP_401'], '401 permanen tanpa ulang');
  assert.equal((await q(o.tenantId, 'SELECT consecutive_failures, active FROM alert_channels WHERE id = $1', [ch]))[0].consecutive_failures, 1);
  await ev(); await evaluator.runOnce(); await sender.runOnce();
  const c = (await q(o.tenantId, 'SELECT active, disabled_reason, disabled_at FROM alert_channels WHERE id = $1', [ch]))[0];
  assert.deepEqual([c.active, c.disabled_reason], [false, 'AUTO_CONSECUTIVE_FAILURES']); assert.ok(c.disabled_at);
  assert.equal((await q(o.tenantId, `SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'alert_channel.disabled'`, [o.tenantId])).length, 1);
  // diaktifkan lagi oleh pengguna: penghitung direset
  assert.equal((await call(app, 'PATCH', `/alerts/channels/${ch}`, o.tok, { active: true })).statusCode, 200);
  assert.equal((await q(o.tenantId, 'SELECT consecutive_failures, disabled_at FROM alert_channels WHERE id = $1', [ch]))[0].consecutive_failures, 0);
  respond = () => ({ statusCode: 200 });
});

test('pengirim: tiap percobaan gagal dicatat di log (kode galat, percobaan, hasil) tanpa target atau token', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Uji'); const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  const logs: any[] = [];
  const s2 = createAlertSender({ db, crypto: cr, log: { warn: (obj: any, msg?: string) => logs.push({ ...obj, msg }) }, opts: { post: fakePost, random: () => 0 } });
  let calls = 0; respond = () => (++calls === 1 ? { errorCode: 'CONNECTION_FAILED' } : { statusCode: 200 });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  await evaluator.runOnce(); await s2.runOnce(); await new Promise((r) => setTimeout(r, 20)); await s2.runOnce();
  assert.equal(logs.length, 1, 'hanya percobaan yang gagal dicatat; yang sukses tidak');
  assert.deepEqual([logs[0].msg, logs[0].attempt, logs[0].outcome, logs[0].errorCode, logs[0].rule], ['pengiriman alarm gagal', 1, 'RETRY', 'CONNECTION_FAILED', 'session.logged_out']);
  const text = JSON.stringify(logs); assert.ok(!/token|chat_id|bot\d|api\.telegram/i.test(text), 'log tidak boleh memuat target/token');
  respond = () => ({ statusCode: 200 });
});

test('pengirim: antrean tertunda untuk kanal yang nonaktif/dihapus menjadi DEAD semu tanpa mengirim dan tanpa menghitung ke breaker', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Hilang'); const ch = (await tg(o)).json().data.id; posted = [];
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  await evaluator.runOnce();
  await call(app, 'PATCH', `/alerts/channels/${ch}`, o.tok, { active: false });
  await sender.runOnce();
  assert.equal(posted.length, 0); const d = await deliveries(o.tenantId);
  assert.deepEqual([d[0].status, d[0].last_error_code], ['DEAD', 'CHANNEL_INACTIVE']);
  assert.equal((await q(o.tenantId, 'SELECT consecutive_failures FROM alert_channels WHERE id = $1', [ch]))[0].consecutive_failures, 0);
});

test('pengirim: batas kirim per kanal per jam melindungi chat dari banjir (RATE_CAPPED)', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id; posted = []; respond = () => ({ statusCode: 200 });
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  for (let i = 0; i < 5; i++) { const sid = (await plat(`INSERT INTO wa_sessions (tenant_id, session_name) VALUES ($1,$2) RETURNING id`, [o.tenantId, `Banjir${i}`]))[0].id; await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]); }
  await evaluator.runOnce(); for (let i = 0; i < 10; i++) { await sender.runOnce(); }
  assert.equal(posted.length, 3, 'maks 3 per jam (env uji)');
  const d = await deliveries(o.tenantId);
  assert.equal(d.filter((x: any) => x.status === 'SENT').length, 3); assert.equal(d.filter((x: any) => x.last_error_code === 'RATE_CAPPED').length, 2);
  assert.equal((await q(o.tenantId, 'SELECT consecutive_failures, active FROM alert_channels WHERE id = $1', [ch]))[0].consecutive_failures, 0, 'batas kirim bukan kegagalan kanal');
});

test('saklar ALERTS_ENABLED=false: API 503, evaluator tidak mengantre, konfigurasi tetap ada', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Saklar'); const ch = (await tg(o)).json().data.id;
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  const off = mk({ alerts: createAlertService(db, { crypto: cr, post: fakePost, enabled: false }) });
  try {
    assert.equal((await call(off, 'POST', '/alerts/channels', o.tok, { type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: PW })).statusCode, 503);
    assert.equal((await call(off, 'POST', `/alerts/channels/${ch}/test`, o.tok)).statusCode, 503);
    assert.equal((await call(off, 'PUT', '/alerts/rules/session.logged_out', o.tok, { enabled: false, channel_ids: [] })).statusCode, 503);
    assert.equal((await call(off, 'GET', '/alerts/catalog', o.tok)).json().data.enabled, false);
    assert.equal((await call(off, 'GET', '/alerts/channels', o.tok)).json().data.length, 1, 'konfigurasi tetap terbaca');
  } finally { await off.close(); }
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  assert.equal(await createAlertEvaluator({ db, enabled: () => false }).runOnce(), 0);
  assert.equal((await deliveries(o.tenantId)).length, 0);
});

// ---------- riwayat, rotasi kunci, retensi ----------

test('riwayat pengiriman: hanya milik tenant sendiri, tanpa rahasia, batas limit', { skip }, async () => {
  const A = await reg(); const B = await reg(); const sid = await session(A, 'Riwayat'); const ch = (await tg(A)).json().data.id; respond = () => ({ statusCode: 200 });
  await rule(A, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [A.tenantId, sid]);
  await run();
  const a = (await call(app, 'GET', '/alerts/deliveries', A.tok)).json().data;
  assert.equal(a.length, 1); assert.deepEqual([a[0].status, a[0].rule_code, a[0].channel_name], ['SENT', 'session.logged_out', 'Telegram tim']);
  assert.ok(!JSON.stringify(a).includes('AAHdq') && !('payload' in a[0]));
  assert.deepEqual((await call(app, 'GET', '/alerts/deliveries', B.tok)).json().data, []);
  assert.equal((await call(app, 'GET', '/alerts/deliveries?limit=0', A.tok)).statusCode, 400);
  assert.equal((await call(app, 'GET', '/alerts/deliveries?limit=101', A.tok)).statusCode, 400);
});

test('rotasi kunci: target kanal ikut dienkripsi ulang ke versi aktif dan tetap dapat dibaca', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id;
  const both = createCredentialCrypto(parseKeyring(`1:${k1},2:${k2}`, 2));
  const dry = await createKeyRotator(db, both).run({ dryRun: true }); assert.ok(dry.alertTargets.rotated >= 1);
  assert.equal((await q(o.tenantId, 'SELECT target_key_version v FROM alert_channels WHERE id = $1', [ch]))[0].v, 1, 'dry-run tidak mengubah');
  const rep = await createKeyRotator(db, both).run(); assert.equal(rep.alertTargets.failed, 0);
  assert.equal((await q(o.tenantId, 'SELECT target_key_version v FROM alert_channels WHERE id = $1', [ch]))[0].v, 2);
  const onlyV2 = createCredentialCrypto(parseKeyring(`2:${k2}`));
  const row = (await plat('SELECT id, tenant_id, target_ciphertext FROM alert_channels WHERE id = $1', [ch]))[0];
  const { alertTargetAad } = await import('../src/security/alert-target.js');
  assert.match(onlyV2.decrypt(row.target_ciphertext, alertTargetAad(row.tenant_id, row.id)).toString(), /AAHdq/, 'terbaca hanya dengan kunci baru');
  const again = await createKeyRotator(db, both).run(); assert.equal(again.alertTargets.rotated, 0, 'idempoten');
});

test('retensi: riwayat notifikasi lama (bukan PENDING) dibersihkan; yang baru dan PENDING tetap', { skip }, async () => {
  const o = await reg(); const ch = (await tg(o)).json().data.id;
  const ins = (key: string, status: string, age: string) => plat(`INSERT INTO alert_deliveries (tenant_id, channel_id, rule_code, object_key, window_key, payload, status, created_at) VALUES ($1,$2,'session.logged_out',$3,'w','{}',$4, now() - $5::interval)`, [o.tenantId, ch, key, status, age]);
  await ins('lama-sent', 'SENT', '60 days'); await ins('lama-dead', 'DEAD', '60 days'); await ins('lama-pending', 'PENDING', '60 days'); await ins('baru-sent', 'SENT', '1 day');
  await createRetention(db).runOnce();
  const keys = (await q(o.tenantId, 'SELECT object_key FROM alert_deliveries WHERE tenant_id = $1 ORDER BY object_key', [o.tenantId])).map((r: any) => r.object_key);
  assert.deepEqual(keys, ['baru-sent', 'lama-pending']);
});

test('menghapus workspace/kanal tidak meninggalkan antrean yatim (FK cascade)', { skip }, async () => {
  const o = await reg(); const sid = await session(o, 'Cascade'); const ch = (await tg(o)).json().data.id;
  await rule(o, 'session.logged_out', { enabled: true, channel_ids: [ch] });
  await plat(`INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'status','LOGGED_OUT','ENGINE')`, [o.tenantId, sid]);
  await evaluator.runOnce(); assert.equal((await deliveries(o.tenantId)).length, 1);
  assert.equal((await call(app, 'DELETE', `/alerts/channels/${ch}`, o.tok, { password: PW })).statusCode, 200);
  assert.equal((await plat('SELECT 1 FROM alert_deliveries WHERE tenant_id = $1', [o.tenantId])).length, 0);
});
