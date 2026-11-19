/**
 * Validasi indeks dengan data berukuran realistis (bukan bagian `npm test`; jalankan `npm run test:perf`).
 * Seed ~1,3 juta baris di schema sementara, ANALYZE, lalu EXPLAIN (dalam transaksi yang di-rollback) untuk kueri kritis.
 * Aturan: tidak boleh ada Seq Scan pada tabel besar untuk kueri jalur panas. Waktu eksekusi dicetak (tidak di-assert: tergantung mesin).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from '../helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../../src/modules/identity/identity.service.js');
const { createMessageService } = await import('../../src/modules/messaging/messages.service.js');
const { createOutboxRelay } = await import('../../src/modules/engine/outbox-relay.js');

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
after(async () => { await t?.drop(); });

const BIG = new Set(['message_queue', 'message_attempts', 'outbox_events', 'webhook_deliveries', 'wa_messages', 'wa_chats']);
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);
let tenants: { id: string }[] = []; let sessions: { id: string; tenant_id: string }[] = []; let chat: { id: string; tenant_id: string }; let heavy: string;
const timings: { name: string; ms: number; plan: string }[] = [];

test('seed data besar + ANALYZE', { skip }, async () => {
  const identity = createIdentityService(db);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((await identity.register({ email: `pf${i}@x.test`, password: 'correct-horse-battery', tenantName: `P${i}` })).tenant.id);
  tenants = ids.map((id) => ({ id }));
  heavy = ids[0]!;
  await q(`INSERT INTO wa_sessions (id, tenant_id, session_name, status, desired_state)
           SELECT gen_random_uuid(), t, 's' || g, 'CONNECTED', 'CONNECTED' FROM unnest($1::uuid[]) t, generate_series(1,3) g`, [ids]);
  sessions = await q('SELECT id, tenant_id FROM wa_sessions');
  assert.equal(sessions.length, 18);
  const t0 = Date.now();
  // Pemetaan baris->sesi/tenant lewat row_number (hash join): tabel tenants tidak terbaca oleh platform (RLS), sesi bisa.
  const SES = `(SELECT id, tenant_id, row_number() OVER (ORDER BY id) AS rn FROM wa_sessions)`;
  // message_queue: 300k, ~98% selesai tersebar 400 hari, 1% FAILED, 0,7% PENDING
  await q(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, status, priority, scheduled_at, completed_at, created_at, provider_message_id, actor)
    SELECT s.tenant_id, s.id, '62' || (800000000 + (random()*99999999)::int)::text, '{"text":"x"}'::jsonb,
           CASE WHEN r < 0.01 THEN 'FAILED' WHEN r < 0.017 THEN 'PENDING' ELSE (ARRAY['SENT','DELIVERED','READ'])[1 + (random()*2)::int] END,
           (random()*9)::int, now() - (d || ' days')::interval,
           CASE WHEN r >= 0.01 AND r < 0.017 THEN NULL ELSE now() - (d || ' days')::interval END,
           now() - (d || ' days')::interval, 'PM' || g || '-' || md5(random()::text), 'SYSTEM'
    FROM (SELECT random() AS r, (random()*400)::numeric(6,1) AS d, g FROM generate_series(1,300000) g) src
    JOIN ${SES} s ON s.rn = 1 + (src.g % 18)`);
  await q(`INSERT INTO message_attempts (tenant_id, job_id, attempt_number, started_at, finished_at, outcome)
           SELECT tenant_id, id, 1, created_at, created_at, 'SENT' FROM message_queue WHERE status IN ('SENT','DELIVERED','READ') LIMIT 150000`);
  await q(`INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, status, created_at, dispatched_at)
           SELECT s.tenant_id, 'message', gen_random_uuid(), 'message.sent', '{}',
                  CASE WHEN g % 400 = 0 THEN 'PENDING' ELSE 'DISPATCHED' END, now() - ((g % 60) || ' days')::interval,
                  CASE WHEN g % 400 = 0 THEN NULL ELSE now() - ((g % 60) || ' days')::interval END
           FROM generate_series(1,200000) g JOIN ${SES} s ON s.rn = 1 + (g % 18)`);
  await q(`INSERT INTO webhook_endpoints (tenant_id, url, secret_ciphertext, secret_key_version, secret_hint) SELECT t, 'https://example.com/h', '\\x00', 1, 'abcd' FROM unnest($1::uuid[]) t`, [ids]);
  await q(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status, created_at, next_attempt_at)
           SELECT e.tenant_id, e.id, gen_random_uuid(), 'message.sent', '{}', CASE WHEN g % 700 = 0 THEN 'PENDING' ELSE 'DELIVERED' END,
                  now() - ((g % 60) || ' days')::interval, now() - ((g % 60) || ' days')::interval
           FROM generate_series(1,150000) g
           JOIN (SELECT id, tenant_id, row_number() OVER (ORDER BY id) AS rn FROM webhook_endpoints) e ON e.rn = 1 + (g % 6)`);
  await q(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at)
           SELECT s.tenant_id, s.id, '62' || (700000000 + g)::text || '@s.whatsapp.net', '62' || (700000000 + g)::text, now() - ((g % 300) || ' days')::interval
           FROM generate_series(1,30000) g JOIN ${SES} s ON s.rn = 1 + (g % 18)`);
  await q(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at, created_at)
           SELECT c.tenant_id, c.session_id, c.id, 'OUT', 'W' || g || md5(random()::text), 'text', 'isi', 'SENT', now() - ((g % 400) || ' days')::interval, now() - ((g % 400) || ' days')::interval
           FROM generate_series(1,300000) g
           JOIN (SELECT id, tenant_id, session_id, row_number() OVER (ORDER BY id) AS rn FROM wa_chats) c ON c.rn = 1 + (g % 30000)`);
  for (const tb of ['message_queue', 'message_attempts', 'outbox_events', 'webhook_deliveries', 'wa_messages', 'wa_chats', 'webhook_endpoints', 'wa_sessions']) await db.pool.query(`ANALYZE ${tb}`);
  chat = (await q(`SELECT id, tenant_id FROM wa_chats WHERE tenant_id = $1 LIMIT 1`, [heavy]))[0];
  const counts = (await q(`SELECT (SELECT count(*) FROM message_queue)::int mq, (SELECT count(*) FROM wa_messages)::int wm, (SELECT count(*) FROM outbox_events)::int ox, (SELECT count(*) FROM webhook_deliveries)::int wd`))[0];
  console.log(`seed selesai ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(counts));
  assert.ok(counts.mq >= 300000 && counts.wm >= 300000);
});

type Node = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Node[] };
const walk = (n: Node, out: Node[] = []) => { out.push(n); for (const c of n.Plans ?? []) walk(c, out); return out; };
/** EXPLAIN dalam transaksi yang di-rollback (aman untuk DML), dengan konteks RLS yang sama seperti aplikasi. */
async function explain(name: string, ctx: { tenantId?: string; platform?: boolean }, sql: string, params: any[] = [], analyze = true) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    if (ctx.platform) await c.query("SELECT set_config('app.scope','platform',true)");
    if (ctx.tenantId) await c.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.tenantId]);
    const j = (await c.query(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    const nodes = walk(j.Plan);
    const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] && BIG.has(n['Relation Name']));
    const idx = nodes.filter((n) => n['Index Name']).map((n) => n['Index Name']);
    timings.push({ name, ms: analyze ? Math.round(j['Execution Time'] * 100) / 100 : -1, plan: idx.join(',') || nodes.map((n) => n['Node Type']).join('>') });
    assert.deepEqual(seq.map((n) => n['Relation Name']), [], `${name}: Seq Scan pada tabel besar. Plan: ${nodes.map((n) => n['Node Type'] + (n['Relation Name'] ? `(${n['Relation Name']})` : '')).join(' > ')}`);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const sid = () => sessions.find((s) => s.tenant_id === heavy)!.id;
const TERMINAL = `('SENT','DELIVERED','READ','FAILED','CANCELLED','UNKNOWN','RECONCILIATION_REQUIRED')`;

test('jalur panas pesan: klaim, daftar tenant, hitung antrean, idempotensi, receipt, rate window, reap', { skip }, async () => {
  await explain('claim kandidat', { platform: true }, `SELECT id FROM message_queue WHERE session_id = $1 AND status = 'PENDING' AND scheduled_at <= now() ORDER BY priority DESC, scheduled_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [sid()], false);
  await explain('klaim: jadwal terdekat', { platform: true }, `SELECT extract(epoch FROM (min(scheduled_at) - now())) FROM message_queue WHERE session_id = $1 AND status = 'PENDING'`, [sid()]);
  await explain('daftar pesan tenant', { tenantId: heavy }, `SELECT id, status FROM message_queue WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 20 OFFSET 0`, [heavy]);
  await explain('daftar pesan tenant + filter status', { tenantId: heavy }, `SELECT id FROM message_queue WHERE tenant_id = $1 AND status = 'FAILED' ORDER BY created_at DESC, id LIMIT 20`, [heavy]);
  await explain('total pesan tenant (count)', { tenantId: heavy }, `SELECT count(*) FROM message_queue WHERE tenant_id = $1`, [heavy]);
  await explain('hitung PENDING tenant (batas antrean)', { tenantId: heavy }, `SELECT count(*) FROM message_queue WHERE tenant_id = $1 AND status = 'PENDING'`, [heavy]);
  await explain('idempotensi (tenant,key)', { tenantId: heavy }, `SELECT id, status FROM message_queue WHERE tenant_id = $1 AND idempotency_key = $2`, [heavy, 'k-tidak-ada']);
  await explain('receipt (sesi,provider id)', { platform: true }, `SELECT id FROM message_queue WHERE session_id = $1 AND provider_message_id = $2 AND status = 'SENT'`, [sid(), 'PM-x']);
  await explain('rate window tenant', { platform: true }, `SELECT count(*), min(started_at) FROM message_attempts WHERE tenant_id = $1 AND started_at > now() - interval '60 seconds'`, [heavy]);
  await explain('reap: PROCESSING kedaluwarsa', { platform: true }, `UPDATE message_queue SET status = 'RECONCILIATION_REQUIRED', processing_at = NULL, processing_expires_at = NULL, completed_at = now() WHERE status = 'PROCESSING' AND processing_expires_at < now() RETURNING id`, [], false);
  await explain('reap: PENDING melewati TTL', { platform: true }, `UPDATE message_queue SET status = 'FAILED', last_error_code = 'EXPIRED', completed_at = now() WHERE status = 'PENDING' AND scheduled_at < now() - make_interval(secs => 86400)`, [], false);
});

test('jalur panas integrasi & riwayat: outbox relay, klaim webhook, daftar delivery, chat', { skip }, async () => {
  await explain('outbox relay (PENDING)', { platform: true }, `SELECT id, tenant_id, event_type, payload, created_at FROM outbox_events WHERE status = 'PENDING' ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`, [], false);
  await explain('klaim delivery webhook', { platform: true }, `SELECT id FROM webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED`, [], false);
  const ep = (await q('SELECT id FROM webhook_endpoints WHERE tenant_id = $1', [heavy]))[0].id;
  await explain('daftar delivery endpoint', { tenantId: heavy }, `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 AND tenant_id = $2 ORDER BY created_at DESC, id LIMIT 20`, [ep, heavy]);
  await explain('daftar chat tenant', { tenantId: heavy }, `SELECT * FROM wa_chats WHERE tenant_id = $1 ORDER BY last_message_at DESC NULLS LAST, id LIMIT 20`, [heavy]);
  await explain('riwayat chat', { tenantId: chat.tenant_id }, `SELECT * FROM wa_messages WHERE chat_id = $1 AND tenant_id = $2 ORDER BY occurred_at DESC, id LIMIT 20`, [chat.id, chat.tenant_id]);
  await explain('kontak (agregasi per nomor)', { tenantId: heavy }, `SELECT contact_phone, max(last_message_at) FROM wa_chats WHERE tenant_id = $1 AND contact_phone IS NOT NULL GROUP BY contact_phone ORDER BY max(last_message_at) DESC NULLS LAST LIMIT 20`, [heavy]);
  await explain('inbound: upsert chat (sesi,jid)', { platform: true }, `SELECT id FROM wa_chats WHERE session_id = $1 AND remote_jid = $2`, [sid(), '62700000001@s.whatsapp.net']);
  await explain('inbound: cek duplikat (sesi,arah,provider id)', { platform: true }, `SELECT id FROM wa_messages WHERE session_id = $1 AND direction = 'IN' AND provider_message_id = $2`, [sid(), 'IN-x']);
});

test('penyapu retensi memakai indeks (tidak memindai seluruh tabel)', { skip }, async () => {
  await explain('retensi: purge isi antrean', { platform: true }, `WITH c AS (SELECT id FROM message_queue WHERE status IN ${TERMINAL} AND content_purged_at IS NULL AND completed_at < now() - make_interval(days => 30) ORDER BY completed_at LIMIT 500 FOR UPDATE SKIP LOCKED) UPDATE message_queue q SET content_purged_at = now() FROM c WHERE q.id = c.id`, [], false);
  await explain('retensi: hapus baris antrean', { platform: true }, `WITH c AS (SELECT id FROM message_queue WHERE status IN ${TERMINAL} AND completed_at < now() - make_interval(days => 180) ORDER BY completed_at LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM message_queue q USING c WHERE q.id = c.id`, [], false);
  await explain('retensi: purge isi riwayat', { platform: true }, `WITH c AS (SELECT id FROM wa_messages WHERE body IS NOT NULL AND created_at < now() - make_interval(days => 30) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED) UPDATE wa_messages m SET body = NULL FROM c WHERE m.id = c.id`, [], false);
  await explain('retensi: hapus riwayat', { platform: true }, `WITH c AS (SELECT id FROM wa_messages WHERE created_at < now() - make_interval(days => 180) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM wa_messages m USING c WHERE m.id = c.id`, [], false);
  await explain('retensi: hapus outbox', { platform: true }, `WITH c AS (SELECT id FROM outbox_events WHERE status = 'DISPATCHED' AND dispatched_at < now() - make_interval(days => 7) ORDER BY dispatched_at LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM outbox_events o USING c WHERE o.id = c.id`, [], false);
  await explain('retensi: hapus delivery selesai', { platform: true }, `WITH c AS (SELECT id FROM webhook_deliveries WHERE status <> 'PENDING' AND created_at < now() - make_interval(days => 30) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM webhook_deliveries w USING c WHERE w.id = c.id`, [], false);
});

test('throughput dasar (satu proses, satu koneksi): enqueue API dan relay outbox', { skip }, async () => {
  const msgs = createMessageService(db);
  const principal = { type: 'user', tenantId: heavy, userId: crypto.randomUUID(), role: 'OWNER' } as any;
  await q(`UPDATE wa_sessions SET status = 'CONNECTED' WHERE id = $1`, [sid()]);
  const N = 300; const t0 = Date.now();
  for (let i = 0; i < N; i++) await msgs.send(principal, { sessionId: sid(), to: `62811${String(1000000 + i)}`, text: 'beban', priority: 5 });
  const enq = Date.now() - t0;
  const relay = createOutboxRelay(db);
  const r0 = Date.now(); let moved = 0; for (;;) { const n = await relay.runOnce(100); moved += n; if (!n) break; }
  const rel = Date.now() - r0;
  console.log(`enqueue: ${N} pesan, ${(enq / N).toFixed(1)} ms/pesan (~${Math.round(N / (enq / 1000))}/dtk sekuensial, 1 koneksi)`);
  console.log(`relay outbox: ${moved} event, ${(rel / Math.max(1, moved)).toFixed(2)} ms/event (~${Math.round(moved / (rel / 1000))}/dtk)`);
  assert.ok(moved > 0);
});

test('ringkasan rencana & waktu eksekusi', { skip }, () => {
  const w = Math.max(...timings.map((x) => x.name.length));
  console.log('\n' + timings.map((x) => `${x.name.padEnd(w)}  ${x.ms >= 0 ? String(x.ms).padStart(8) + ' ms' : '   (plan)  '}  ${x.plan}`).join('\n'));
  assert.ok(timings.length >= 20);
});
