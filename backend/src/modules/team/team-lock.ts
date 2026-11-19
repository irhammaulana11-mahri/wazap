import type pg from 'pg';
import type { Role } from '../identity/principal.js';

/**
 * SATU-SATUNYA definisi kunci serialisasi untuk mutasi tim dan kuota per tenant (anggota, undangan, pengaturan).
 * Semua jalur yang memeriksa "OWNER terakhir" atau kuota anggota WAJIB memakai ini; menulis ulang string kuncinya di tempat
 * lain membuat dua jalur berhenti saling menunggu tanpa galat (tes memindai sumber agar kunci ini tidak diduplikasi).
 */
export const teamLock = (c: pg.PoolClient, tenantId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:team:' + tenantId]);

export interface MembershipNow { role: Role; status: string; email: string | null }

/** Keanggotaan saat ini dibaca dari basis data (bukan dari token): peran di token bisa saja baru diturunkan. null bila bukan anggota. */
export async function readMembership(c: pg.PoolClient, tenantId: string, userId: string): Promise<MembershipNow | null> {
  const m = (await c.query('SELECT role, status, member_email FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])).rows[0];
  return m ? { role: m.role as Role, status: m.status as string, email: (m.member_email as string | null) ?? null } : null;
}
