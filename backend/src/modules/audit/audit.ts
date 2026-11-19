import type pg from 'pg';
import type { Role } from '../identity/principal.js';

export type AuditAction =
  | 'member.role_changed' | 'member.status_changed' | 'member.removed' | 'member.left'
  | 'invitation.created' | 'invitation.revoked' | 'invitation.reissued' | 'invitation.accepted'
  | 'settings.updated';

export interface AuditEntry {
  tenantId: string;
  actor: { userId: string; email?: string | null; role?: Role | null };
  action: AuditAction;
  targetType: 'member' | 'invitation' | 'settings';
  targetId?: string | null;
  targetEmail?: string | null;
  /** Detail perubahan (mis. peran sebelum/sesudah). JANGAN memasukkan token/rahasia. */
  details?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
}

/** Asal permintaan untuk jejak audit (diisi route, bukan dari klien). */
export interface RequestMeta { ip?: string; requestId?: string }

/**
 * Catat audit DI DALAM transaksi perubahan: perubahan dan jejaknya atomik (rollback membatalkan keduanya).
 * Kunci yang tampak sebagai rahasia dibuang sebagai pertahanan berlapis.
 */
const SECRET_KEY = /token|secret|password|hash|authorization|api[_-]?key|cookie/i;
const clean = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) return depth > 3 ? [] : v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 3) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
  }
  return typeof v === 'string' ? v.slice(0, 300) : v;
};

export async function recordAudit(c: pg.PoolClient, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_email, actor_role, action, target_type, target_id, target_email, details, ip, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [e.tenantId, e.actor.userId, e.actor.email ?? null, e.actor.role ?? null, e.action, e.targetType, e.targetId ?? null, e.targetEmail ?? null,
     JSON.stringify(clean(e.details ?? {})), e.ip?.slice(0, 45) ?? null, e.requestId?.slice(0, 64) ?? null]
  );
}
