import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { verifyPassword } from '../identity/password.js';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { transitionSession } from '../sessions/lifecycle.js';
import { readMembership, teamLock } from '../team/team-lock.js';

export interface TenantActor { userId: string; tenantId: string; ip?: string; requestId?: string }

const forbidden = () => new AppError('FORBIDDEN', 403, 'Hanya OWNER yang dapat melakukan operasi ini');

/**
 * Ganti nama dan hapus workspace (hanya OWNER, peran dibaca ulang di dalam lock). Hapus = status DELETED (lunak): akses langsung berhenti
 * (login/refresh/API key/socket menolak tenant yang tidak ACTIVE), sesi WhatsApp diturunkan lewat jalur penghapusan biasa (control-plane menuntaskan
 * dan menghapus kredensial), integrasi dimatikan, dan retensi menghapus seluruh data setelah RETENTION_TENANT_DAYS.
 */
export function createTenantService(db: GatewayDb) {
  async function owner(c: pg.PoolClient, a: TenantActor) {
    const m = await readMembership(c, a.tenantId, a.userId);
    if (!m || m.status !== 'ACTIVE' || m.role !== 'OWNER') throw forbidden();
    return m;
  }
  const audit = (c: pg.PoolClient, a: TenantActor, email: string | null, action: AuditAction, details: Record<string, unknown>) =>
    recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email, role: 'OWNER' }, action, targetType: 'tenant', targetId: a.tenantId, details, ip: a.ip, requestId: a.requestId });

  /** Verifikasi email + kata sandi tanpa token (seperti login). Semua kegagalan: 401 INVALID_CREDENTIALS. */
  async function authenticateUser(cred: { email: string; password: string }): Promise<string> {
    const email = cred.email.trim().toLowerCase();
    const u = await db.tx({ loginEmail: email }, async (c) => (await c.query('SELECT id, password_hash, status FROM users WHERE email = $1', [email])).rows[0] as { id: string; password_hash: string; status: string } | undefined);
    const okPw = await verifyPassword(cred.password, u?.password_hash ?? null);
    if (!u || !okPw || u.status !== 'ACTIVE') throw new AppError('INVALID_CREDENTIALS', 401, 'Email atau password salah');
    return u.id;
  }

  return {
    async rename(a: TenantActor, name: string) {
      return db.tx({ tenantId: a.tenantId }, async (c) => {
        await teamLock(c, a.tenantId);
        const m = await owner(c, a);
        const cur = (await c.query('SELECT name FROM tenants WHERE id = $1 FOR UPDATE', [a.tenantId])).rows[0];
        if (!cur) throw forbidden();
        const row = (await c.query('UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id, name, slug', [a.tenantId, name.trim()])).rows[0];
        await c.query('UPDATE tenant_join_codes SET tenant_name = $2 WHERE tenant_id = $1', [a.tenantId, row.name]); // salinan yang dilihat calon anggota
        if (cur.name !== row.name) await audit(c, a, m.email, 'tenant.renamed', { from: cur.name, to: row.name });
        return row as { id: string; name: string; slug: string };
      });
    },

    /** Hapus workspace. Butuh kata sandi OWNER dan konfirmasi nama workspace persis. */
    async remove(a: TenantActor, input: { password: string; confirmName: string }) {
      const u = await db.tx({ userId: a.userId }, async (c) => (await c.query('SELECT password_hash, status FROM users WHERE id = $1', [a.userId])).rows[0] as { password_hash: string; status: string } | undefined);
      if (!u || u.status !== 'ACTIVE' || !(await verifyPassword(input.password, u.password_hash))) throw new AppError('INVALID_PASSWORD', 403, 'Kata sandi salah');
      return db.tx({ tenantId: a.tenantId }, async (c) => {
        await teamLock(c, a.tenantId);
        const m = await owner(c, a);
        const t = (await c.query(`SELECT name FROM tenants WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`, [a.tenantId])).rows[0];
        if (!t) throw forbidden();
        if (input.confirmName.trim() !== t.name) throw new AppError('CONFIRMATION_MISMATCH', 400, 'Nama workspace yang diketik tidak sama');
        // Sesi WhatsApp: jalur penghapusan biasa (lease dicabut, status DELETING; control-plane menuntaskan dan menghapus kredensial).
        const sessions = (await c.query(`SELECT id FROM wa_sessions WHERE tenant_id = $1 AND status NOT IN ('DELETING','DELETED') FOR UPDATE`, [a.tenantId])).rows;
        for (const s of sessions) await transitionSession(c, { sessionId: s.id, tenantId: a.tenantId, to: 'DELETING', actor: 'USER', reason: 'tenant_deleted', set: { desired_state: 'DISCONNECTED' } });
        const hooks = (await c.query('DELETE FROM webhook_endpoints WHERE tenant_id = $1', [a.tenantId])).rowCount ?? 0; // berhenti mengirim data ke luar
        const keys = (await c.query('UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [a.tenantId])).rowCount ?? 0;
        await c.query(`UPDATE tenant_invitations SET status = 'REVOKED' WHERE tenant_id = $1 AND status = 'PENDING'`, [a.tenantId]);
        await c.query('DELETE FROM tenant_join_codes WHERE tenant_id = $1', [a.tenantId]);
        await c.query(`UPDATE tenant_join_requests SET status = 'REJECTED', decided_at = now(), decided_by = $2 WHERE tenant_id = $1 AND status = 'PENDING'`, [a.tenantId, a.userId]);
        await audit(c, a, m.email, 'tenant.deleted', { sessions: sessions.length, webhooks: hooks, api_keys_revoked: keys });
        await c.query(`UPDATE tenants SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [a.tenantId]);
        return { deleted: true as const, sessions_scheduled: sessions.length, purge_after_days: config.RETENTION_TENANT_DAYS };
      });
    },

    /**
     * Pemulihan workspace terhapus (dalam masa tunggu RETENTION_TENANT_DAYS), tanpa token: OWNER membuktikan diri dengan email + kata sandi (setelah
     * dihapus tidak ada workspace aktif untuk login). Yang kembali: workspace, anggota, riwayat pesan/chat, pengaturan, audit. Yang TIDAK kembali:
     * koneksi WhatsApp (kredensial sudah dihapus), webhook, API key, dan undangan; semuanya harus dibuat ulang.
     */
    async listDeleted(cred: { email: string; password: string }) {
      const userId = await authenticateUser(cred);
      return db.tx({ userId }, async (c) =>
        (await c.query(
          `SELECT t.id AS tenant_id, t.name, t.slug, t.deleted_at, t.deleted_at + make_interval(days => $2) AS restorable_until
           FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
           WHERE m.user_id = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE' AND t.status = 'DELETED' AND t.deleted_at > now() - make_interval(days => $2)
           ORDER BY t.deleted_at DESC`, [userId, config.RETENTION_TENANT_DAYS])).rows);
    },

    async restore(cred: { email: string; password: string }, tenantId: string, meta: { ip?: string; requestId?: string } = {}) {
      const notFound = () => new AppError('NOT_FOUND', 404, 'Workspace tidak ditemukan atau sudah tidak dapat dipulihkan');
      const userId = await authenticateUser(cred);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw notFound();
      return db.tx({ userId, tenantId }, async (c) => {
        await teamLock(c, tenantId);
        const m = await readMembership(c, tenantId, userId);
        if (!m || m.status !== 'ACTIVE' || m.role !== 'OWNER') throw notFound(); // bukan OWNER = sama dengan tidak ada
        const row = (await c.query(
          `UPDATE tenants SET status = 'ACTIVE', deleted_at = NULL WHERE id = $1 AND status = 'DELETED' AND deleted_at > now() - make_interval(days => $2) RETURNING id, name, slug`,
          [tenantId, config.RETENTION_TENANT_DAYS])).rows[0];
        if (!row) throw notFound();
        await recordAudit(c, { tenantId, actor: { userId, email: m.email, role: 'OWNER' }, action: 'tenant.restored', targetType: 'tenant', targetId: tenantId, details: {}, ip: meta.ip, requestId: meta.requestId });
        return { restored: true as const, tenant: row as { id: string; name: string; slug: string }, must_recreate: ['whatsapp_sessions', 'webhooks', 'api_keys', 'invitations'] };
      });
    },
  };
}
export type TenantService = ReturnType<typeof createTenantService>;
