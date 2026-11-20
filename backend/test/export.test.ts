import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { buildApp } = await import('../src/app.js');
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createTeamService } = await import('../src/modules/team/team.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createExportService } = await import('../src/modules/export/export.service.js');
const { DEFS } = await import('../src/modules/export/definitions.js');
const { csvCell, csvRow, BOM } = await import('../src/modules/export/csv.js');
const { RateLimiter } = await import('../src/modules/identity/rate-limit.js');

const t = skip ? null : await createTestDb(20);
const db = t?.db as any;
const identity = skip ? (null as any) : createIdentityService(db);
const exportsSvc = skip ? (null as any) : createExportService(db, { limits: { batchRows: 10, maxRows: 500 } });
const deps = () => ({ identity, team: createTeamService(db), sessions: createSessionService(db), exports: exportsSvc, checkDb: async () => true, apiLimits: { ipPerMinute: 0, tenantPerMinute: 0 } });
const app = skip ? (null as any) : buildApp({ ...deps(), limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
const strict = skip ? (null as any) : buildApp(deps()); // pembatas laju NYATA (kata sandi dan jatah per jam)
after(async () => { await app?.close(); await strict?.close(); await t?.drop(); });

let n = 0;
const PW = 'kata-sandi-panjang-1';
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const q = (tenantId: string, sql: string, args: any[] = []) => db.tx({ tenantId }, async (c: any) => (await c.query(sql, args)).rows);
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);

interface U { tok: string; userId: string; email: string; tenantId: string }
const call = async (a: any, method: string, url: string, tok?: string, payload?: any, headers: any = {}) => {
  const r = await a.inject({ method, url: `/api/v1${url}`, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, payload });
  return r as any;
};
async function reg(): Promise<U> {
  const email = `ex${++n}@x.test`;
  const r = await call(app, 'POST', '/auth/register', undefined, { email, password: PW, tenant_name: `Ekspor ${n}` });
  assert.equal(r.statusCode, 201);
  const b = r.json().data;
  return { tok: b.access_token, userId: b.user.id, email, tenantId: b.tenant.id };
}
async function join(owner: U, role: string): Promise<U> {
  const u = await reg();
  const inv = await call(app, 'POST', '/team/invitations', owner.tok, { email: u.email, role });
  await call(app, 'POST', '/team/invitations/accept', u.tok, { token: inv.json().data.token });
  const lg = await call(app, 'POST', '/auth/login', undefined, { email: u.email, password: PW, tenant_id: owner.tenantId });
  return { ...u, tenantId: owner.tenantId, tok: lg.json().data.access_token };
}
/** Sesi + chat + pesan untuk satu tenant. Mengembalikan id sesi dan chat. */
async function seed(o: U, opts: { phone: string; name?: string; msgs: { dir: 'IN' | 'OUT'; body: string | null; at: number; purged?: boolean }[] }) {
  const s = await createSessionService(db).create({ type: 'user', tenantId: o.tenantId, userId: o.userId, role: 'OWNER' } as any, { name: `sesi${++n}`, autoConnect: false });
  const chat = (await plat(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, display_name, last_message_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
    [o.tenantId, s.id, `${opts.phone}@s.whatsapp.net`, opts.phone, opts.name ?? null]))[0].id as string;
  let i = 0;
  for (const m of opts.msgs) {
    await plat(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at, body_purged_at)
                VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
      [o.tenantId, s.id, chat, m.dir, `PM-${n}-${++i}`, m.body, m.dir === 'IN' ? 'RECEIVED' : 'SENT', iso(m.at), m.purged ? new Date() : null]);
  }
  return { sessionId: s.id as string, chatId: chat };
}
/** Parser CSV minimal (kutipan ganda, CRLF dalam kutipan). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* CRLF */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const exp = (a: any, type: string, tok: string, body: any = {}) => call(a, 'POST', `/exports/${type}`, tok, { password: PW, ...body });
const now = () => Date.now();
const range = (extra: any = {}) => ({ from: iso(now() - 6 * HOUR), to: iso(now() + HOUR), ...extra });
const auditRows = (tenantId: string) => q(tenantId, `SELECT actor_email, details FROM audit_logs WHERE tenant_id = $1 AND action = 'data.exported' ORDER BY id`, [tenantId]);
const waitAudit = async (tenantId: string, count: number) => { for (let i = 0; i < 100; i++) { const r = await auditRows(tenantId); if (r.length >= count) return r; await new Promise((r2) => setTimeout(r2, 25)); } throw new Error('audit ekspor tidak muncul'); };

// ---------- penulis CSV ----------

test('CSV: kutipan, koma, baris baru, Unicode, BOM, CRLF; angka dan boolean tidak dikutip', () => {
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('baris1\nbaris2'), '"baris1\nbaris2"');
  assert.equal(csvCell('halo 😀 ñ'), 'halo 😀 ñ'); assert.equal(csvCell(null), ''); assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(42), '42'); assert.equal(csvCell(true), 'true'); assert.equal(csvCell(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02T03:04:05.678Z');
  assert.equal(csvRow(['a', 'b,c']), 'a,"b,c"\r\n'); assert.equal(BOM, '﻿');
});

test('CSV: injeksi formula dinetralkan (=, +, -, @, tab, CR) tetapi nomor telepon dan angka tidak berubah', () => {
  for (const v of ['=1+1', '=HYPERLINK("http://x","klik")', '+cmd|calc', '-2+3', '@SUM(A1:A9)', '\t=1', '\r=1']) {
    const out = csvCell(v);
    assert.ok(out.startsWith("'") || out.startsWith('"\''), `harus dinetralkan: ${JSON.stringify(v)} => ${JSON.stringify(out)}`);
    assert.ok(!/^"?[=+\-@\t\r]/.test(out), `tidak boleh diawali karakter formula: ${JSON.stringify(out)}`);
  }
  assert.equal(csvCell('6281234567890'), '6281234567890'); assert.equal(csvCell(-5), '-5', 'angka bertipe number tidak dinetralkan');
});

// ---------- ekspor pesan ----------

test('messages CSV: berkas benar (BOM, kolom, urutan, filter, purged, injeksi dinetralkan, header unduhan)', { skip }, async () => {
  const o = await reg(); const base = now() - 3 * HOUR;
  await seed(o, { phone: '6281111111111', name: 'Budi', msgs: [
    { dir: 'IN', body: 'halo', at: base }, { dir: 'OUT', body: '=HYPERLINK("http://jahat.test","klik")', at: base + 1000 },
    { dir: 'IN', body: null, purged: true, at: base + 2000 }, { dir: 'IN', body: 'koma, dan "kutip"\nbaris baru', at: base + 3000 },
  ] });
  const r = await exp(app, 'messages', o.tok, range());
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /^text\/csv; charset=utf-8/);
  assert.match(String(r.headers['content-disposition']), /^attachment; filename="wazap-[a-z0-9-]+-messages-\d{8}\.csv"$/);
  assert.equal(r.headers['x-export-rows'], '4'); assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(r.body.startsWith(BOM), 'BOM untuk Excel');
  const rows = parseCsv(r.body);
  assert.deepEqual(rows[0], DEFS.messages.columns);
  assert.equal(rows.length, 5, 'header + 4 baris');
  const col = (name: string) => DEFS.messages.columns.indexOf(name);
  assert.deepEqual(rows.slice(1).map((x) => x[col('direction')]), ['IN', 'OUT', 'IN', 'IN'], 'urut menurut waktu');
  assert.equal(rows[2]![col('text')], `'=HYPERLINK("http://jahat.test","klik")`, 'injeksi formula dinetralkan');
  assert.equal(rows[3]![col('text')], ''); assert.equal(rows[3]![col('text_purged')], 'true');
  assert.equal(rows[4]![col('text')], 'koma, dan "kutip"\nbaris baru', 'kutipan dan baris baru utuh');
  assert.equal(rows[1]![col('contact_phone')], '6281111111111'); assert.equal(rows[1]![col('contact_name')], 'Budi'); assert.equal(rows[1]![col('text_purged')], 'false');
  const only = await exp(app, 'messages', o.tok, range({ direction: 'OUT' }));
  assert.equal(parseCsv(only.body).length, 2, 'filter direction=OUT');
});

test('messages NDJSON: satu objek per baris dan baris TERAKHIR adalah manifest dengan jumlah baris benar', { skip }, async () => {
  const o = await reg(); const base = now() - 3 * HOUR;
  await seed(o, { phone: '6282222222222', msgs: [{ dir: 'IN', body: 'satu', at: base }, { dir: 'OUT', body: 'dua', at: base + 1 }, { dir: 'IN', body: 'tiga', at: base + 2 }] });
  const r = await exp(app, 'messages', o.tok, range({ format: 'ndjson' }));
  assert.equal(r.statusCode, 200); assert.match(String(r.headers['content-type']), /^application\/x-ndjson/);
  const lines = r.body.trim().split('\n').map((l: string) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(Object.keys(lines[0]), DEFS.messages.columns);
  const m = lines[3]._manifest;
  assert.deepEqual([m.type, m.rows, m.schema_version], ['messages', 3, 1]);
  assert.ok(m.notes[0].includes('dibersihkan') && m.to_effective && m.exported_at);
});

test('ISOLASI TENANT: A tidak pernah menerima baris B (termasuk dengan session_id milik B)', { skip }, async () => {
  const a = await reg(); const b = await reg(); const base = now() - 2 * HOUR;
  await seed(a, { phone: '6283333333333', msgs: [{ dir: 'IN', body: 'rahasia-A', at: base }] });
  const sb = await seed(b, { phone: '6284444444444', name: 'Pelanggan B', msgs: [{ dir: 'IN', body: 'rahasia-B', at: base }, { dir: 'OUT', body: 'balasan-B', at: base + 1 }] });
  const ra = await exp(app, 'messages', a.tok, range());
  assert.ok(ra.body.includes('rahasia-A') && !ra.body.includes('rahasia-B') && !ra.body.includes('6284444444444') && !ra.body.includes('Pelanggan B'));
  const cross = await exp(app, 'messages', a.tok, range({ session_id: sb.sessionId }));
  assert.equal(cross.statusCode, 200); assert.equal(cross.headers['x-export-rows'], '0'); assert.equal(parseCsv(cross.body).length, 1, 'hanya header');
  for (const type of ['chats', 'contacts', 'members']) { const r = await exp(app, type, a.tok); assert.ok(!r.body.includes('6284444444444'), `${type} tidak boleh memuat data B`); }
});

// ---------- hak akses dan pengaman ----------

test('hak akses: hanya OWNER/ADMIN pengguna dashboard; MEMBER, VIEWER, API key, dan tanpa kredensial ditolak', { skip }, async () => {
  const o = await reg(); const admin = await join(o, 'ADMIN'); const member = await join(o, 'MEMBER'); const viewer = await join(o, 'VIEWER');
  assert.equal((await exp(app, 'chats', o.tok)).statusCode, 200);
  assert.equal((await exp(app, 'chats', admin.tok)).statusCode, 200, 'ADMIN boleh');
  for (const [name, u] of [['MEMBER', member], ['VIEWER', viewer]] as const) assert.equal((await exp(app, 'chats', u.tok)).statusCode, 403, `${name} ditolak`);
  const key = (await call(app, 'POST', '/api-keys', o.tok, { name: 'kunci-uji', scopes: ['messages:read', 'sessions:read'] })).json().data.key;
  const viaKey = await call(app, 'POST', '/exports/chats', undefined, { password: PW }, { 'x-api-key': key });
  assert.equal(viaKey.statusCode, 403, 'API key ditolak (hanya pengguna dashboard)');
  assert.equal((await call(app, 'POST', '/exports/chats', undefined, { password: PW })).statusCode, 401);
  assert.equal((await call(app, 'GET', '/exports/policy', viewer.tok)).statusCode, 200, 'kebijakan boleh dibaca semua pengguna dashboard');
  assert.equal((await call(app, 'GET', '/exports/policy', undefined, undefined, { 'x-api-key': key })).statusCode, 403);
});

test('kata sandi salah => 403 INVALID_PASSWORD tanpa data; setelah 5 percobaan => 429 dengan Retry-After (pembatas nyata)', { skip }, async () => {
  const o = await reg();
  const bad = await exp(app, 'chats', o.tok, { password: 'salah-salah-1' });
  assert.equal(bad.statusCode, 403); assert.equal(bad.json().error.code, 'INVALID_PASSWORD'); assert.ok(!String(bad.headers['content-disposition'] ?? ''));
  const u = await reg(); let last: any;
  for (let i = 0; i < 6; i++) last = await exp(strict, 'chats', u.tok, { password: 'salah-salah-1' });
  assert.equal(last.statusCode, 429); assert.equal(last.json().error.code, 'RATE_LIMITED'); assert.ok(Number(last.headers['retry-after']) >= 1);
  const right = await exp(strict, 'chats', u.tok);
  assert.equal(right.statusCode, 429, 'bahkan kata sandi benar tertahan selama jendela percobaan');
});

test('jatah per jam: 5 ekspor lalu 429; ekspor yang ditolak 422 TIDAK menghabiskan jatah', { skip }, async () => {
  const o = await reg(); const base = now() - 2 * HOUR;
  await seed(o, { phone: '6285555555555', msgs: [{ dir: 'IN', body: 'x', at: base }] });
  // Validasi 400 dan kata sandi benar tidak menagih jatah maupun percobaan kata sandi.
  for (let i = 0; i < 3; i++) assert.equal((await exp(strict, 'messages', o.tok, { from: iso(base), to: iso(base - 1) })).statusCode, 400);
  for (let i = 0; i < 5; i++) { const r = await exp(strict, 'chats', o.tok); assert.equal(r.statusCode, 200, `ekspor ke-${i + 1}`); }
  const over = await exp(strict, 'chats', o.tok);
  assert.equal(over.statusCode, 429); assert.equal(over.json().error.code, 'RATE_LIMITED'); assert.ok(Number(over.headers['retry-after']) > 0);
});

// ---------- batas dan validasi ----------

test('terlalu besar: 422 EXPORT_TOO_LARGE SEBELUM ada byte data, tidak menghabiskan jatah, tidak diaudit sebagai ekspor', { skip }, async () => {
  const small = createExportService(db, { limits: { maxRows: 3, batchRows: 10 } });
  const a = buildApp({ ...deps(), exports: small, limiter: new RateLimiter() });
  try {
    const o = await reg(); const base = now() - 2 * HOUR;
    await seed(o, { phone: '6286666666666', msgs: Array.from({ length: 5 }, (_, i) => ({ dir: 'IN' as const, body: `m${i}`, at: base + i })) });
    const r = await exp(a, 'messages', o.tok, range());
    assert.equal(r.statusCode, 422); assert.equal(r.json().error.code, 'EXPORT_TOO_LARGE');
    assert.deepEqual([r.json().error.details[0].max_rows, r.json().error.details[0].capped], [3, true]);
    assert.match(String(r.headers['content-type']), /json/); assert.ok(!r.headers['content-disposition'], 'tidak ada unduhan');
    assert.ok(!r.body.includes('m0'), 'tidak ada isi data pada penolakan');
    const narrow = await exp(a, 'messages', o.tok, { from: iso(base + 3), to: iso(base + 100) });
    assert.equal(narrow.statusCode, 200, 'rentang lebih sempit berhasil (jatah tidak terpakai oleh 422)');
    assert.equal(parseCsv(narrow.body).length, 3, 'header + 2 baris');
    assert.equal((await auditRows(o.tenantId)).length, 1, 'hanya ekspor yang benar-benar dibuka yang diaudit');
  } finally { await a.close(); }
});

test('validasi: from/to wajib untuk jenis berentang, from<to, rentang maksimal, field asing ditolak, id sesi harus UUID', { skip }, async () => {
  const o = await reg(); const t0 = now();
  const code = async (type: string, body: any) => { const r = await exp(app, type, o.tok, body); return [r.statusCode, r.json?.().error?.code] as const; };
  assert.deepEqual(await code('messages', {}), [400, 'VALIDATION_ERROR']);
  assert.deepEqual(await code('audit-logs', { from: iso(t0) }), [400, 'VALIDATION_ERROR']);
  assert.deepEqual(await code('messages', { from: iso(t0), to: iso(t0 - 1000) }), [400, 'VALIDATION_ERROR']);
  assert.deepEqual(await code('messages', { from: iso(t0 - 100 * 86_400_000), to: iso(t0) }), [400, 'VALIDATION_ERROR'], 'lebih dari 92 hari');
  assert.deepEqual(await code('chats', { rahasia: 'x' }), [400, 'VALIDATION_ERROR'], 'strictObject');
  assert.deepEqual(await code('messages', range({ session_id: 'bukan-uuid' })), [400, 'VALIDATION_ERROR']);
  assert.deepEqual(await code('messages', range({ format: 'xlsx' })), [400, 'VALIDATION_ERROR']);
  assert.equal((await exp(app, 'chats', o.tok, { format: undefined })).statusCode, 200, 'format bawaan csv');
});

test('batas atas terkunci pada waktu mulai: pesan bertanggal masa depan tidak ikut walau to di masa depan', { skip }, async () => {
  const o = await reg(); const base = now() - HOUR;
  await seed(o, { phone: '6287777777777', msgs: [{ dir: 'IN', body: 'lampau', at: base }, { dir: 'IN', body: 'depan', at: now() + 30 * 60_000 }] });
  const r = await exp(app, 'messages', o.tok, range({ to: iso(now() + 2 * HOUR) }));
  assert.ok(r.body.includes('lampau') && !r.body.includes('depan'));
  assert.equal(r.headers['x-export-rows'], '1');
});

// ---------- audit, pembatalan, konkurensi ----------

test('audit: setiap ekspor tercatat data.exported (completed) dengan jumlah baris dan byte, tanpa isi data atau kata sandi', { skip }, async () => {
  const o = await reg(); const base = now() - 2 * HOUR;
  await seed(o, { phone: '6288888888888', msgs: [{ dir: 'IN', body: 'ISI-RAHASIA-PESAN', at: base }, { dir: 'OUT', body: 'balas', at: base + 1 }] });
  const r = await exp(app, 'messages', o.tok, range());
  const [row] = await waitAudit(o.tenantId, 1);
  assert.equal(row.actor_email, o.email);
  const d = row.details;
  assert.deepEqual([d.type, d.format, d.outcome, d.rows], ['messages', 'csv', 'completed', 2]);
  assert.ok(d.bytes >= Buffer.byteLength(r.body) - 4 && d.duration_ms >= 0);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes('ISI-RAHASIA-PESAN') && !dump.includes(PW) && !/password/i.test(dump), 'audit tanpa isi data dan tanpa kata sandi');
});

test('dibatalkan klien di tengah aliran: loop berhenti, audit outcome=aborted dengan baris < total, slot dilepas', { skip }, async () => {
  const o = await reg(); const base = now() - 3 * HOUR;
  await seed(o, { phone: '6289999999999', msgs: Array.from({ length: 120 }, (_, i) => ({ dir: 'IN' as const, body: `pesan ${i}`, at: base + i * 10 })) });
  const actor = { userId: o.userId, tenantId: o.tenantId, role: 'OWNER' as const };
  const plan = await exportsSvc.prepare(actor, { type: 'messages', format: 'csv', from: new Date(now() - 6 * HOUR), to: new Date(now() + HOUR) });
  assert.equal(plan.rows, 120);
  const stream = exportsSvc.open(actor, plan);
  const it = stream[Symbol.asyncIterator]();
  await it.next(); await it.next(); // BOM+header, lalu batch pertama (10 baris)
  stream.destroy();
  const [row] = await waitAudit(o.tenantId, 1);
  assert.equal(row.details.outcome, 'aborted'); assert.ok(row.details.rows >= 10 && row.details.rows < 120, `baris terkirim ${row.details.rows}`);
  const again = exportsSvc.open(actor, await exportsSvc.prepare(actor, { type: 'chats', format: 'csv' }));
  again.destroy(); // slot sudah dilepas: open tidak melempar 409
});

test('konkurensi: satu ekspor per workspace (409 EXPORT_IN_PROGRESS) dan batas bersamaan per proses (429)', { skip }, async () => {
  const svc = createExportService(db, { limits: { maxConcurrent: 2, batchRows: 10 } });
  const [a, b, c] = [await reg(), await reg(), await reg()];
  const act = (u: U) => ({ userId: u.userId, tenantId: u.tenantId, role: 'OWNER' as const });
  const plan = (u: U) => svc.prepare(act(u), { type: 'chats', format: 'csv' });
  const s1 = svc.open(act(a), await plan(a));
  await assert.rejects(async () => svc.open(act(a), await plan(a)), (e: any) => e.code === 'EXPORT_IN_PROGRESS' && e.status === 409);
  const s2 = svc.open(act(b), await plan(b));
  await assert.rejects(async () => svc.open(act(c), await plan(c)), (e: any) => e.code === 'RATE_LIMITED' && e.status === 429 && !!e.headers['Retry-After']);
  s1.destroy(); s2.destroy();
  await new Promise((r) => setTimeout(r, 100));
  const s3 = svc.open(act(c), await plan(c)); s3.destroy(); // setelah dilepas, tenant lain dapat membuka
});

// ---------- jenis lain ----------

test('jenis lain: outbound, chats, contacts (digabung per nomor), audit-logs, members; kolom persis sesuai kontrak', { skip }, async () => {
  const o = await reg(); const base = now() - 2 * HOUR;
  const s1 = await seed(o, { phone: '6281010101010', name: 'Dewi', msgs: [{ dir: 'IN', body: 'a', at: base }] });
  await seed(o, { phone: '6281010101010', name: 'Dewi', msgs: [] }); // nomor sama di sesi lain: satu kontak, dua chat
  await seed(o, { phone: '6282020202020', msgs: [] });
  await plat(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, actor, status, created_at) VALUES ($1,$2,'6281010101010','{"text":"RAHASIA-ANTRIAN"}','USER','SENT',$3), ($1,$2,'6282020202020','{"text":"x"}','USER','FAILED',$3)`, [o.tenantId, s1.sessionId, iso(base)]);
  await q(o.tenantId, `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_email, actor_role, action, target_type, details) VALUES ($1,$2,$3,'OWNER','settings.updated','settings','{"changes":{"max_sessions":{"from":3,"to":5}}}')`, [o.tenantId, o.userId, o.email]);
  const get = async (type: string, body: any = {}) => { const r = await exp(app, type, o.tok, body); assert.equal(r.statusCode, 200, `${type}: ${r.body}`); return r; };

  const out = await get('outbound', range());
  const orows = parseCsv(out.body); assert.deepEqual(orows[0], DEFS.outbound.columns); assert.equal(orows.length, 3); assert.equal(out.headers['x-export-rows'], '2');
  assert.ok(!out.body.includes('RAHASIA-ANTRIAN'), 'outbound tidak memuat isi pesan');
  assert.equal((await get('outbound', range({ status: 'FAILED' }))).headers['x-export-rows'], '1');

  const ch = await get('chats'); assert.deepEqual(parseCsv(ch.body)[0], DEFS.chats.columns); assert.equal(parseCsv(ch.body).length, 4);
  const co = await get('contacts'); const crow = parseCsv(co.body); assert.deepEqual(crow[0], DEFS.contacts.columns);
  assert.equal(crow.length, 3, 'dua kontak');
  assert.deepEqual([crow[1]![0], crow[1]![1], crow[1]![2]], ['6281010101010', 'Dewi', '2'], 'satu kontak dari dua chat');

  const au = await get('audit-logs', range()); const arows = parseCsv(au.body); assert.deepEqual(arows[0], DEFS['audit-logs'].columns);
  const A = DEFS['audit-logs'].columns; const actions = arows.slice(1).map((x) => x[A.indexOf('action')]);
  assert.ok(actions.includes('settings.updated'), 'baris audit yang disemai ada');
  assert.ok(actions.filter((x) => x === 'data.exported').length >= 4, 'ekspor sebelumnya ikut tercatat di audit dan dapat diekspor');
  const seeded = arows.find((x) => x[A.indexOf('action')] === 'settings.updated')!;
  assert.deepEqual(JSON.parse(seeded[A.indexOf('details_json')]).changes.max_sessions, { from: 3, to: 5 });

  const mem = await get('members'); const mrows = parseCsv(mem.body); assert.deepEqual(mrows[0], DEFS.members.columns);
  assert.deepEqual([mrows[1]![0], mrows[1]![1], mrows[1]![2], mrows[1]![3]], [o.userId, o.email, 'OWNER', 'ACTIVE']);
  for (const r of [out, ch, co, au, mem]) assert.ok(!/password|hash|secret|token|\$argon2/i.test(r.body.replace(/token_/g, '')), 'tidak ada kolom/nilai rahasia');
});

test('saklar mati: EXPORT_ENABLED=false => semua ekspor 503 NOT_CONFIGURED tanpa memeriksa/mengambil data; kebijakan melaporkan enabled=false', { skip }, async () => {
  const off = buildApp({ ...deps(), exports: createExportService(db, { enabled: false }), limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
  try {
    const o = await reg();
    const r = await exp(off, 'chats', o.tok);
    assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'NOT_CONFIGURED'); assert.ok(!r.headers['content-disposition']);
    assert.equal((await call(off, 'GET', '/exports/policy', o.tok)).json().data.enabled, false);
    assert.equal((await auditRows(o.tenantId)).length, 0, 'tidak ada ekspor yang dibuka');
  } finally { await off.close(); }
});

test('kebijakan: GET /exports/policy memuat batas dan retensi untuk UI', { skip }, async () => {
  const o = await reg();
  const r = await call(app, 'GET', '/exports/policy', o.tok);
  assert.equal(r.statusCode, 200);
  const d = r.json().data;
  assert.equal(d.enabled, true);
  assert.deepEqual(d.types, ['messages', 'outbound', 'chats', 'contacts', 'audit-logs', 'members']);
  assert.ok(d.max_rows > 0 && d.max_span_days === 92 && d.per_hour === 5 && d.retention.content_days === 30 && d.retention.row_days === 180 && d.retention.audit_days === 365);
});

test('HTTP sungguhan: klien memutus unduhan di tengah jalan => loop server berhenti, audit aborted, slot dilepas', { skip, timeout: 60_000 }, async () => {
  const big = createExportService(db, { limits: { maxRows: 50_000, batchRows: 100 } });
  const a = buildApp({ ...deps(), exports: big, limiter: new (class extends RateLimiter { check() { return { allowed: true, retryAfterSec: 0 }; } })() });
  try {
    const o = await reg();
    const s = await createSessionService(db).create({ type: 'user', tenantId: o.tenantId, userId: o.userId, role: 'OWNER' } as any, { name: `big${++n}`, autoConnect: false });
    const chat = (await plat(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at) VALUES ($1,$2,'6281234500000@s.whatsapp.net','6281234500000',now()) RETURNING id`, [o.tenantId, s.id]))[0].id;
    const TOTAL = 8000; // ~8 MB: melebihi buffer soket sehingga server benar-benar tertahan oleh backpressure saat klien berhenti membaca
    await plat(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at)
                SELECT $1,$2,$3,'IN','B'||g,'text',repeat('x', 1000)||g,'RECEIVED', now() - interval '2 hours' + g * interval '10 milliseconds' FROM generate_series(1, $4) g`, [o.tenantId, s.id, chat, TOTAL]);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.server.address() as AddressInfo).port;
    const payload = JSON.stringify({ password: PW, ...range() });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/exports/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${o.tok}` } }, (res) => {
        try { assert.equal(res.statusCode, 200); assert.equal(res.headers['x-export-rows'], String(TOTAL)); } catch (e) { reject(e); return; }
        res.once('data', () => { res.destroy(); resolve(); }); // baca satu potongan lalu putus
      });
      req.on('error', () => { /* putus disengaja */ });
      req.end(payload);
    });
    const [row] = await waitAudit(o.tenantId, 1);
    assert.equal(row.details.outcome, 'aborted'); assert.ok(row.details.rows < TOTAL, `baris terkirim ${row.details.rows} dari ${TOTAL}`);
    const again = await call(a, 'POST', '/exports/chats', o.tok, { password: PW });
    assert.equal(again.statusCode, 200, 'slot workspace sudah dilepas');
  } finally { await a.close(); }
});
