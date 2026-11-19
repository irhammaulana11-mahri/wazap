import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';

const view = (r: any) => ({
  id: String(r.id), action: r.action,
  actor: { user_id: r.actor_user_id, email: r.actor_email, role: r.actor_role },
  target: { type: r.target_type, id: r.target_id, email: r.target_email },
  details: r.details, ip: r.ip, request_id: r.request_id, created_at: r.created_at,
});

/** Baca jejak audit tenant (jalur tenant, RLS). Penulisan hanya lewat recordAudit di dalam transaksi perubahan. */
export function createAuditService(db: GatewayDb) {
  return {
    async list(tenantId: string, q: { page: number; pageSize: number; action?: string; actorUserId?: string; targetId?: string; from?: Date; to?: Date }) {
      return db.tx({ tenantId }, async (c) => {
        const where = `tenant_id = $1 AND ($2::text IS NULL OR action = $2) AND ($3::uuid IS NULL OR actor_user_id = $3)
          AND ($4::text IS NULL OR target_id = $4) AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at < $6)`;
        const args = [tenantId, q.action ?? null, q.actorUserId ?? null, q.targetId ?? null, q.from ?? null, q.to ?? null];
        const cap = config.LIST_COUNT_CAP;
        const n = (await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM audit_logs WHERE ${where} LIMIT $7) x`, [...args, cap + 1])).rows[0].n;
        const rows = (await c.query(`SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $7 OFFSET $8`, [...args, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(view), total: Math.min(n, cap), capped: n > cap };
      });
    },
  };
}
export type AuditService = ReturnType<typeof createAuditService>;
