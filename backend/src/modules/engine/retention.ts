import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';

export interface RetentionPolicy {
  /** Hari setelah status akhir: isi pesan dihapus & nomor penerima dimasker. */
  contentDays: number;
  /** Hari setelah status akhir: baris dihapus. Wajib >= contentDays. */
  rowDays: number;
  /** Hari setelah DISPATCHED: event outbox dihapus (memuat teks pesan masuk). */
  outboxDays: number;
  /** Hari setelah dibuat: delivery webhook selesai (DELIVERED/DEAD) dihapus (payload memuat nomor/teks). */
  deliveryDays: number;
  /** Hari setelah dibuat: jejak audit dihapus (lebih panjang daripada data pesan). */
  auditDays: number;
  /** Hari setelah diputuskan/kedaluwarsa: permintaan bergabung dihapus (memuat email pemohon). Opsional agar pemanggil lama tetap valid. */
  joinRequestDays?: number;
  /** Hari setelah workspace dihapus (status DELETED): barisnya dan seluruh datanya dihapus permanen (cascade). Opsional agar pemanggil lama tetap valid. */
  tenantDays?: number;
  batch: number;
}
export interface RetentionReport {
  contentPurged: number;
  rowsDeleted: number;
  historyPurged: number;
  historyDeleted: number;
  chatsDeleted: number;
  outboxDeleted: number;
  deliveriesDeleted: number;
  auditDeleted: number;
  joinRequestsDeleted: number;
  tenantsPurged: number;
}

export const defaultPolicy = (): RetentionPolicy => ({
  contentDays: config.RETENTION_CONTENT_DAYS, rowDays: config.RETENTION_ROW_DAYS, outboxDays: config.RETENTION_OUTBOX_DAYS,
  deliveryDays: config.RETENTION_WEBHOOK_DELIVERY_DAYS, auditDays: config.RETENTION_AUDIT_DAYS, joinRequestDays: config.RETENTION_JOIN_REQUEST_DAYS, tenantDays: config.RETENTION_TENANT_DAYS, batch: config.RETENTION_BATCH,
});

const TERMINAL = `('SENT','DELIVERED','READ','FAILED','CANCELLED','UNKNOWN','RECONCILIATION_REQUIRED')`;
const MAX_ROUNDS = 40; // batas per penyapuan agar satu putaran tidak berjalan tanpa akhir; sisanya di putaran berikutnya

/**
 * Penyapu retensi (konteks platform). Idempoten dan aman berjalan di banyak instans: tiap langkah memakai batch
 * `FOR UPDATE SKIP LOCKED` dan transaksi pendek. Hanya baris berstatus akhir yang disentuh (PENDING/PROCESSING tidak).
 */
export function createRetention(db: GatewayDb, policy: () => RetentionPolicy = defaultPolicy) {
  async function sweep(sql: string, params: unknown[], batch: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const n = await db.tx({ platform: true }, async (c) => (await c.query(sql, [...params, batch])).rowCount ?? 0);
      total += n;
      if (n < batch) break;
    }
    return total;
  }

  return {
    async runOnce(): Promise<RetentionReport> {
      const p = policy();
      if (p.rowDays < p.contentDays) throw new Error('RETENTION_ROW_DAYS harus >= RETENTION_CONTENT_DAYS');
      const d = (days: number) => days; // parameter hari (integer)

      // 1) Antrean: hapus isi & masker nomor. Payload dipertahankan bentuknya (CHECK) tetapi tanpa isi.
      const contentPurged = await sweep(
        `WITH c AS (SELECT id FROM message_queue WHERE status IN ${TERMINAL} AND content_purged_at IS NULL
                      AND completed_at < now() - make_interval(days => $1) ORDER BY completed_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE message_queue q SET content_purged_at = now(),
           payload = CASE WHEN q.message_type = 'text' THEN '{"text":""}'::jsonb ELSE jsonb_build_object('url', '[purged]') END,
           recipient = CASE WHEN q.recipient ~ '^[0-9]{8,15}$' THEN repeat('*', length(q.recipient) - 4) || right(q.recipient, 4) ELSE q.recipient END
         FROM c WHERE q.id = c.id`, [d(p.contentDays)], p.batch);

      // 2) Antrean: hapus baris (percobaan ikut terhapus lewat cascade).
      const rowsDeleted = await sweep(
        `WITH c AS (SELECT id FROM message_queue WHERE status IN ${TERMINAL} AND completed_at < now() - make_interval(days => $1)
                      ORDER BY completed_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         DELETE FROM message_queue q USING c WHERE q.id = c.id`, [d(p.rowDays)], p.batch);

      // 3) Riwayat chat: hapus isi teks, lalu hapus baris, lalu chat yang sudah kosong.
      const historyPurged = await sweep(
        `WITH c AS (SELECT id FROM wa_messages WHERE body IS NOT NULL AND created_at < now() - make_interval(days => $1)
                      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE wa_messages m SET body = NULL, body_purged_at = now() FROM c WHERE m.id = c.id`, [d(p.contentDays)], p.batch);
      const historyDeleted = await sweep(
        `WITH c AS (SELECT id FROM wa_messages WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         DELETE FROM wa_messages m USING c WHERE m.id = c.id`, [d(p.rowDays)], p.batch);
      const chatsDeleted = await sweep(
        `WITH c AS (SELECT id FROM wa_chats ch WHERE COALESCE(ch.last_message_at, ch.created_at) < now() - make_interval(days => $1)
                      AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.chat_id = ch.id) LIMIT $2 FOR UPDATE SKIP LOCKED)
         DELETE FROM wa_chats ch USING c WHERE ch.id = c.id`, [d(p.rowDays)], p.batch);

      // 4) Integrasi: outbox yang sudah diteruskan, dan delivery webhook yang sudah selesai.
      const outboxDeleted = await sweep(
        `WITH c AS (SELECT id FROM outbox_events WHERE status = 'DISPATCHED' AND dispatched_at < now() - make_interval(days => $1)
                      ORDER BY dispatched_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         DELETE FROM outbox_events o USING c WHERE o.id = c.id`, [d(p.outboxDays)], p.batch);
      const deliveriesDeleted = await sweep(
        `WITH c AS (SELECT id FROM webhook_deliveries WHERE status <> 'PENDING' AND created_at < now() - make_interval(days => $1)
                      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         DELETE FROM webhook_deliveries w USING c WHERE w.id = c.id`, [d(p.deliveryDays)], p.batch);

      // 5) Audit log: satu-satunya penghapusan yang diizinkan trigger append-only (hanya konteks platform). Tanpa FOR UPDATE:
      //    tabel ini sengaja tidak punya kebijakan UPDATE sehingga baris tidak dapat dikunci; dua penyapu bersamaan aman (DELETE idempoten).
      const auditDeleted = await sweep(
        `DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2)`,
        [d(p.auditDays)], p.batch);

      // 6) Permintaan bergabung: yang sudah diputuskan, atau tertunda tetapi kedaluwarsa, lebih lama dari batas. Platform hanya punya SELECT/DELETE di tabel ini.
      const joinRequestsDeleted = await sweep(
        `DELETE FROM tenant_join_requests WHERE id IN (
           SELECT id FROM tenant_join_requests
           WHERE (status <> 'PENDING' AND decided_at < now() - make_interval(days => $1))
              OR (status = 'PENDING' AND expires_at < now() - make_interval(days => $1))
           ORDER BY created_at LIMIT $2)`, [d(p.joinRequestDays ?? config.RETENTION_JOIN_REQUEST_DAYS)], p.batch);

      // 7) Workspace yang dihapus: hapus baris tenant (FK cascade menghapus sesi, pesan, webhook, audit, dll.). Kebijakan platform hanya mengizinkan DELETE bila status DELETED.
      //    Menunggu RETENTION_TENANT_DAYS cukup panjang agar control-plane sudah menuntaskan penghapusan sesi dan kredensialnya.
      const tenantsPurged = await sweep(
        `DELETE FROM tenants WHERE id IN (SELECT id FROM tenants WHERE status = 'DELETED' AND deleted_at < now() - make_interval(days => $1) ORDER BY deleted_at LIMIT $2)`,
        [d(p.tenantDays ?? config.RETENTION_TENANT_DAYS)], Math.min(p.batch, 20));

      return { contentPurged, rowsDeleted, historyPurged, historyDeleted, chatsDeleted, outboxDeleted, deliveriesDeleted, auditDeleted, joinRequestsDeleted, tenantsPurged };
    },
  };
}
export type Retention = ReturnType<typeof createRetention>;
