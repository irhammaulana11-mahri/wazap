import type { IncomingMessage } from '../whatsapp/adapter.js';
import type { Lease, LeaseService } from './lease.service.js';

// eslint-disable-next-line no-control-regex
const clean = (s: string | undefined, n: number) => (s ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null : null);

/**
 * Penyimpanan pesan masuk (sisi engine). Idempoten: WhatsApp dapat mengirim ulang pesan yang sama saat reconnect,
 * unik per (sesi, arah, provider id). Ditulis dengan fencing; event message.incoming dibuat TRIGGER di transaksi yang sama.
 */
export function createInbox(leases: LeaseService) {
  return {
    /** true bila pesan baru tersimpan, false bila duplikat. */
    record(lease: Lease, tenantId: string, m: IncomingMessage): Promise<boolean> {
      return leases.withFence(lease, async (c) => {
        // Satu aturan identitas chat untuk jalur masuk dan keluar: SQL resolve_chat (JID nomor vs LID => chat yang sama; 0018).
        const chatId = (
          await c.query('SELECT resolve_chat($1,$2,$3,$4,$5,$6) AS id', [tenantId, lease.sessionId, m.jid.slice(0, 96), m.phone ?? null, clean(m.pushName, 100), m.timestamp])
        ).rows[0].id as string;
        const ins = await c.query(
          `INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, occurred_at)
           VALUES ($1,$2,$3,'IN',$4,$5,$6,'RECEIVED',$7)
           ON CONFLICT (session_id, direction, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [tenantId, lease.sessionId, chatId, m.providerMessageId.slice(0, 128), m.type, m.text ?? null, m.timestamp]
        );
        return ins.rowCount === 1;
      });
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;
