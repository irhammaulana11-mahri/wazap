import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { notifyEvents } from '../realtime/event-channel.js';

export interface RelayedEvent {
  id: string;
  tenantId: string;
  event: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Relay outbox (konteks platform). Mengambil event PENDING (FOR UPDATE SKIP LOCKED, aman dijalankan banyak instans),
 * membuat satu webhook_delivery per endpoint aktif yang berlangganan, lalu menandai DISPATCHED — semuanya dalam
 * SATU transaksi: event tidak hilang bila proses mati di tengah, dan tidak terkirim ganda ke endpoint yang sama
 * (UNIQUE endpoint_id+event_id). Pengiriman HTTP dilakukan terpisah oleh WebhookDeliverer.
 */
export function createOutboxRelay(db: GatewayDb, o: { maxAttempts?: number } = {}) {
  return {
    async runOnce(batch = 100): Promise<number> {
      return db.tx({ platform: true }, async (c) => {
        const rows = (
          await c.query(
            `SELECT id, tenant_id, event_type, payload, created_at FROM outbox_events
             WHERE status = 'PENDING' ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]
          )
        ).rows;
        const events: RelayedEvent[] = [];
        for (const r of rows) {
          const ev: RelayedEvent = { id: r.id, tenantId: r.tenant_id, event: r.event_type, occurredAt: new Date(r.created_at).toISOString(), data: r.payload };
          const envelope = { event_id: ev.id, event: ev.event, occurred_at: ev.occurredAt, data: ev.data };
          await c.query(
            `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, max_attempts)
             SELECT tenant_id, id, $2::uuid, $3::varchar, $4::jsonb, $5::int FROM webhook_endpoints
             WHERE tenant_id = $1 AND active AND ('*' = ANY(events) OR $3::text = ANY(events))
             ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
            [ev.tenantId, ev.id, ev.event, JSON.stringify(envelope), o.maxAttempts ?? config.WEBHOOK_MAX_ATTEMPTS]
          );
          events.push(ev);
        }
        if (rows.length) {
          await c.query(`UPDATE outbox_events SET status = 'DISPATCHED', dispatched_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
          // NOTIFY ikut commit: instans API (Socket.IO) menerima event hanya bila dispatch benar-benar tersimpan.
          await notifyEvents(c, events.map((e) => ({ tenantId: e.tenantId, id: e.id, event: e.event, occurredAt: e.occurredAt, data: e.data })));
        }
        return rows.length;
      });
    },
  };
}
export type OutboxRelay = ReturnType<typeof createOutboxRelay>;
