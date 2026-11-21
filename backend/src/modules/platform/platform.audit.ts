import type pg from 'pg';
import { isSecretKey } from '../audit/audit.js';

export interface PlatformAuditEntry { adminUserId: string | null; adminEmail: string; action: string; tenantId?: string | null; details?: Record<string, unknown>; reason?: string | null; ip?: string; requestId?: string }

/** Jejak audit platform di DALAM transaksi perubahan (atomik). Kunci yang tampak rahasia dibuang (pertahanan berlapis). */
export async function auditPlatform(c: pg.PoolClient, e: PlatformAuditEntry): Promise<void> {
  const details = Object.fromEntries(Object.entries(e.details ?? {}).filter(([k]) => !isSecretKey(k)));
  await c.query(
    `INSERT INTO platform_audit_logs (admin_user_id, admin_email, action, tenant_id, details, reason, ip, request_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [e.adminUserId, e.adminEmail.slice(0, 254), e.action, e.tenantId ?? null, JSON.stringify(details), e.reason?.slice(0, 500) ?? null, e.ip?.slice(0, 45) ?? null, e.requestId?.slice(0, 64) ?? null]);
}
