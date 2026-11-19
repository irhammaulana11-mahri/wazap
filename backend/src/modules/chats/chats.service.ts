import type { GatewayDb } from '../../database/gateway.js';
import { AppError } from '../../http/errors.js';
import { config } from '../../config/env.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError('NOT_FOUND', 404, 'Chat tidak ditemukan');

const chatView = (r: any) => ({ id: r.id, session_id: r.session_id, jid: r.remote_jid, phone: r.contact_phone, name: r.display_name, last_message_at: r.last_message_at, created_at: r.created_at });
const msgView = (r: any) => ({
  id: r.id, direction: r.direction, type: r.message_type, text: r.body, text_purged: r.body_purged_at !== null, status: r.status,
  provider_message_id: r.provider_message_id, job_id: r.queue_id, occurred_at: r.occurred_at,
});

/** Layanan baca chat/kontak (jalur tenant, RLS). Penulisan hanya oleh engine. */
export function createChatService(db: GatewayDb, opts: { countCap?: number } = {}) {
  return {
    async listChats(tenantId: string, q: { page: number; pageSize: number; sessionId?: string }) {
      return db.tx({ tenantId }, async (c) => {
        const where = `tenant_id = $1 AND ($2::uuid IS NULL OR session_id = $2)`;
        const args = [tenantId, q.sessionId ?? null];
        const cap = opts.countCap ?? config.LIST_COUNT_CAP;
        const n = (await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM wa_chats WHERE ${where} LIMIT $3) x`, [...args, cap + 1])).rows[0].n;
        const rows = (await c.query(
          `SELECT * FROM wa_chats WHERE ${where} ORDER BY last_message_at DESC NULLS LAST, id LIMIT $3 OFFSET $4`,
          [...args, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(chatView), total: Math.min(n, cap), capped: n > cap };
      });
    },

    async chatMessages(tenantId: string, chatId: string, q: { page: number; pageSize: number }) {
      if (!UUID_RE.test(chatId)) throw notFound();
      return db.tx({ tenantId }, async (c) => {
        const chat = (await c.query('SELECT * FROM wa_chats WHERE id = $1 AND tenant_id = $2', [chatId, tenantId])).rows[0];
        if (!chat) throw notFound();
        const total = (await c.query('SELECT count(*)::int n FROM wa_messages WHERE chat_id = $1 AND tenant_id = $2', [chatId, tenantId])).rows[0].n;
        const rows = (await c.query(
          `SELECT * FROM wa_messages WHERE chat_id = $1 AND tenant_id = $2 ORDER BY occurred_at DESC, id LIMIT $3 OFFSET $4`,
          [chatId, tenantId, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { chat: chatView(chat), rows: rows.map(msgView), total };
      });
    },

    /** Kontak = lawan bicara 1:1 yang nomornya diketahui, digabung lintas sesi. */
    async listContacts(tenantId: string, q: { page: number; pageSize: number }) {
      return db.tx({ tenantId }, async (c) => {
        const total = (await c.query('SELECT count(DISTINCT contact_phone)::int n FROM wa_chats WHERE tenant_id = $1 AND contact_phone IS NOT NULL', [tenantId])).rows[0].n;
        const rows = (await c.query(
          `SELECT contact_phone AS phone, (array_agg(display_name ORDER BY last_message_at DESC NULLS LAST) FILTER (WHERE display_name IS NOT NULL))[1] AS name,
                  max(last_message_at) AS last_message_at, count(*)::int AS chats
           FROM wa_chats WHERE tenant_id = $1 AND contact_phone IS NOT NULL
           GROUP BY contact_phone ORDER BY max(last_message_at) DESC NULLS LAST, contact_phone LIMIT $2 OFFSET $3`,
          [tenantId, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows, total };
      });
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
