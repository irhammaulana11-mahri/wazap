/**
 * Ekspor data pada data berukuran realistis (ADR-048; bukan bagian `npm test`: jalankan `node --import tsx --test --test-timeout=300000 test/perf/export.perf.ts`).
 * Membuktikan: (1) kueri keyset memakai indeks 0019 tanpa Sort/Seq Scan, (2) memori proses tidak tumbuh seiring jumlah baris (tidak memuat semua baris),
 * (3) klien yang lambat tidak menahan koneksi DB di antara batch (tidak ada `idle in transaction`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable } from '../helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../../src/modules/sessions/sessions.service.js');
const { createExportService } = await import('../../src/modules/export/export.service.js');
const { DEFS } = await import('../../src/modules/export/definitions.js');

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
after(async () => { await t?.drop(); });
const plat = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);

const PER_TENANT = 30_000, TENANTS = 4;
let target: { tenantId: string; userId: string; sessionId: string };

test('seed: 4 tenant x 30 ribu pesan (+ antrean) lalu ANALYZE', { skip, timeout: 240_000 }, async () => {
  const identity = createIdentityService(db); const sessions = createSessionService(db);
  for (let i = 0; i < TENANTS; i++) {
    const reg = await identity.register({ email: `xp${i}@x.test`, password: 'correct-horse-battery', tenantName: `XP ${i}` });
    const s = await sessions.create({ type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any, { name: `xps${i}`, autoConnect: false });
    const chat = (await plat(`INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at) VALUES ($1,$2,'6281000001@s.whatsapp.net','6281000001',now()) RETURNING id`, [reg.tenant.id, s.id]))[0].id;
    await plat(`INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at)
                SELECT $1,$2,$3, CASE WHEN g % 2 = 0 THEN 'IN' ELSE 'OUT' END, 'P'||g, 'text', 'pesan nomor '||g, CASE WHEN g % 2 = 0 THEN 'RECEIVED' ELSE 'SENT' END,
                       now() - interval '5 hours' + g * interval '500 milliseconds'
                  FROM generate_series(1, $4) g`, [reg.tenant.id, s.id, chat, PER_TENANT]);
    await plat(`INSERT INTO message_queue (tenant_id, session_id, recipient, payload, actor, status, created_at)
                SELECT $1,$2,'6281234567890','{"text":"x"}','USER','SENT', now() - interval '5 hours' + g * interval '500 milliseconds' FROM generate_series(1, $3) g`, [reg.tenant.id, s.id, PER_TENANT / 3]);
    if (i === 0) target = { tenantId: reg.tenant.id, userId: reg.user.id, sessionId: s.id };
  }
  await db.pool.query('ANALYZE wa_messages'); await db.pool.query('ANALYZE message_queue'); await db.pool.query('ANALYZE wa_chats');
  assert.equal((await plat('SELECT count(*)::int n FROM wa_messages'))[0].n, PER_TENANT * TENANTS);
});

test('EXPLAIN: kueri keyset memakai indeks 0019, tanpa Sort dan tanpa Seq Scan pada tabel besar', { skip, timeout: 120_000 }, async () => {
  const filters = { from: new Date(Date.now() - 6 * 3600_000), to: new Date(), startedAt: new Date() };
  const check = async (type: 'messages' | 'outbound', index: string, cursor: string[] | null) => {
    let plan = '';
    await db.tx({ tenantId: target.tenantId, userId: target.userId }, async (c: any) => {
      const spy = { query: async (sql: string, p: unknown[]) => { plan = JSON.stringify((await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, p)).rows[0]['QUERY PLAN']); return { rows: [] }; } };
      await DEFS[type].batch(spy as any, target.tenantId, filters, cursor, 1000);
    });
    assert.ok(plan.includes(index), `${type}${cursor ? ' (dengan kursor)' : ''}: harus memakai ${index}\n${plan.slice(0, 400)}`);
    assert.ok(!plan.includes('"Node Type":"Sort"'), `${type}: tidak boleh mengurutkan ulang (indeks sudah berurutan)`);
    assert.ok(!/"Node Type":"Seq Scan","[^}]*"Relation Name":"(wa_messages|message_queue)"/.test(plan), `${type}: tanpa Seq Scan`);
  };
  await check('messages', 'idx_wa_messages_tenant_time', null);
  await check('messages', 'idx_wa_messages_tenant_time', [new Date(Date.now() - 4 * 3600_000).toISOString(), '00000000-0000-0000-0000-000000000000']);
  await check('outbound', 'idx_message_queue_tenant_time', null);
});

test('streaming 30 ribu baris: memori tidak tumbuh dan koneksi DB tidak ditahan saat klien lambat', { skip, timeout: 240_000 }, async () => {
  const svc = createExportService(db, { limits: { maxRows: 200_000, batchRows: 1000 } });
  const actor = { userId: target.userId, tenantId: target.tenantId, role: 'OWNER' as const };
  const plan = await svc.prepare(actor, { type: 'messages', format: 'csv', from: new Date(Date.now() - 6 * 3600_000), to: new Date() });
  assert.equal(plan.rows, PER_TENANT);
  if (global.gc) global.gc();
  const rss0 = process.memoryUsage().rss; let maxRss = rss0, bytes = 0, chunks = 0, idleTx = 0, samples = 0;
  const t0 = Date.now();
  const stream = svc.open(actor, plan);
  for await (const chunk of stream) {
    bytes += (chunk as Buffer).length; chunks++;
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    if (chunks % 5 === 0) { // klien lambat: jeda, lalu periksa tidak ada transaksi menggantung
      await new Promise((r) => setTimeout(r, 40));
      idleTx += (await plat(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND state = 'idle in transaction'`))[0].n; samples++;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  const growthMb = (maxRss - rss0) / 1048576;
  console.log(`  [perf] ${PER_TENANT} baris, ${(bytes / 1048576).toFixed(1)} MB dalam ${secs.toFixed(1)} dtk (${Math.round(PER_TENANT / secs)} baris/dtk), puncak RSS +${growthMb.toFixed(0)} MB, sampel koneksi=${samples}, idle-in-tx=${idleTx}`);
  assert.equal(idleTx, 0, 'tidak boleh ada koneksi idle in transaction saat klien lambat (koneksi dilepas di antara batch)');
  assert.ok(chunks > 20, 'dikirim bertahap per batch (bukan satu potongan besar)');
  assert.ok(growthMb < 120, `memori tumbuh ${growthMb.toFixed(0)} MB; ekspor tidak boleh memuat semua baris`);
  const audit = await db.tx({ tenantId: target.tenantId }, async (c: any) => (await c.query(`SELECT details FROM audit_logs WHERE action = 'data.exported' ORDER BY id DESC LIMIT 1`)).rows[0]);
  assert.deepEqual([audit.details.outcome, audit.details.rows], ['completed', PER_TENANT]);
});
