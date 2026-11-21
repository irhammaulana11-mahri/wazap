import crypto from 'node:crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import type { Role } from '../identity/principal.js';
import { sha256hex } from '../identity/tokens.js';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { readMembership, teamLock } from './team-lock.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ROLES: Role[] = ['OWNER', 'MEMBER', 'VIEWER'];
const RANK: Record<Role, number> = { OWNER: 2, MEMBER: 1, VIEWER: 0 };

/** Hanya OWNER yang mengelola anggota (ADR-053: peran ADMIN dihapus). Satu workspace boleh punya beberapa OWNER; perlindungan OWNER terakhir tetap berlaku. */
export const canManageRole = (actor: Role, _target: Role) => actor === 'OWNER';
/** Peran yang boleh DIBERIKAN aktor (sama dengan batas pengelolaan: tidak ada eskalasi ke peran yang tidak boleh dikelola). */
export const canAssignRole = canManageRole;

export interface TeamActor { userId: string; tenantId: string; role: Role; email?: string | null; /** asal permintaan untuk audit */ ip?: string; requestId?: string }

const forbidden = (msg = 'Tidak memiliki izin untuk operasi ini') => new AppError('FORBIDDEN', 403, msg);
const memberNotFound = () => new AppError('NOT_FOUND', 404, 'Anggota tidak ditemukan');
const invalidInvite = () => new AppError('INVALID_INVITATION', 404, 'Undangan tidak valid atau sudah tidak berlaku');

const memberView = (r: any, me: string) => ({ user_id: r.user_id, email: r.member_email, role: r.role, status: r.status, joined_at: r.created_at, is_me: r.user_id === me });
const INV_COLS = `id, email, role, invited_by, expires_at, created_at, accepted_at,
  CASE WHEN status = 'PENDING' AND expires_at <= now() THEN 'EXPIRED' ELSE status END AS status`;
/**
 * Tautan siap bagikan (bila DASHBOARD_BASE_URL diatur); selain itu null dan frontend membangun dari origin-nya sendiri.
 * Token ada di FRAGMEN (`#token=`), bukan query: fragmen tidak pernah dikirim browser ke server, sehingga tidak masuk access log Nginx maupun header Referer.
 */
const inviteUrl = (token: string) => (config.DASHBOARD_BASE_URL ? `${config.DASHBOARD_BASE_URL.replace(/\/$/, '')}/invite#token=${token}` : null);
const invView = (r: any) => ({ id: r.id, email: r.email, role: r.role, status: r.status, expires_at: r.expires_at, created_at: r.created_at, accepted_at: r.accepted_at });

/**
 * Layanan tim jalur tenant. Mutasi per tenant diserialkan dengan advisory lock agar aturan "pemilik terakhir" dan kuota
 * tidak dapat dilewati lewat balapan. Peran aktor datang dari principal terverifikasi, bukan dari klien.
 */
export function createTeamService(db: GatewayDb) {
  const lock = teamLock;

  /** Peran aktor dibaca ulang DI DALAM lock: peran di token bisa saja baru diturunkan oleh permintaan lain yang bersamaan. */
  async function freshActor(c: pg.PoolClient, a: TeamActor): Promise<TeamActor> {
    const m = await readMembership(c, a.tenantId, a.userId);
    if (!m || m.status !== 'ACTIVE') throw forbidden();
    return { ...a, role: m.role, email: m.email };
  }

  /** Jejak audit dalam transaksi yang sama dengan perubahan. */
  const audit = (c: pg.PoolClient, a: TeamActor, action: AuditAction, targetType: 'member' | 'invitation', targetId: string, targetEmail: string | null, details: Record<string, unknown> = {}) =>
    recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email: a.email, role: a.role }, action, targetType, targetId, targetEmail, details, ip: a.ip, requestId: a.requestId });

  async function target(c: pg.PoolClient, tenantId: string, userId: string) {
    if (!UUID_RE.test(userId)) throw memberNotFound();
    const t = (await c.query('SELECT user_id, role, status, member_email, created_at FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [tenantId, userId])).rows[0];
    if (!t) throw memberNotFound();
    return t as { user_id: string; role: Role; status: string; member_email: string | null; created_at: Date };
  }
  /**
   * Undangan tertunda milik seorang anggota dicabut bila ia dihapus, ditangguhkan, atau diturunkan perannya: undangan tidak boleh hidup
   * lebih lama daripada wewenang pembuatnya (penerima nanti masuk dengan peran yang diberikan di bawah wewenang yang sudah dicabut).
   * Pemeriksaan wewenang saat penerimaan tidak mungkin (penerima belum anggota dan RLS menutup pembacaan keanggotaan tenant), jadi dicabut di sini.
   */
  async function revokeInvitationsBy(c: pg.PoolClient, actor: TeamActor, inviterId: string, reason: string): Promise<number> {
    const rows = (await c.query(`UPDATE tenant_invitations SET status = 'REVOKED' WHERE tenant_id = $1 AND invited_by = $2 AND status = 'PENDING' RETURNING id, email, role`, [actor.tenantId, inviterId])).rows;
    for (const r of rows) await audit(c, actor, 'invitation.revoked', 'invitation', r.id, r.email, { role: r.role, reason });
    return rows.length;
  }

  /** Tolak bila operasi menyisakan tenant tanpa OWNER aktif. */
  async function assertNotLastOwner(c: pg.PoolClient, tenantId: string, t: { user_id: string; role: Role; status: string }) {
    if (t.role !== 'OWNER' || t.status !== 'ACTIVE') return;
    const others = (await c.query(`SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id = $1 AND role = 'OWNER' AND status = 'ACTIVE' AND user_id <> $2`, [tenantId, t.user_id])).rows[0].n;
    if (others === 0) throw new AppError('LAST_OWNER', 409, 'Tenant harus memiliki minimal satu OWNER aktif');
  }

  return {
    async listMembers(actor: TeamActor, q: { page: number; pageSize: number }) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        const total = (await c.query('SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id = $1', [actor.tenantId])).rows[0].n;
        const rows = (await c.query(
          `SELECT user_id, member_email, role, status, created_at FROM tenant_memberships WHERE tenant_id = $1
           ORDER BY array_position(ARRAY['OWNER','MEMBER','VIEWER'], role::text), created_at, user_id LIMIT $2 OFFSET $3`,
          [actor.tenantId, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map((r: any) => memberView(r, actor.userId)), total };
      });
    },

    async updateMember(actor: TeamActor, userId: string, patch: { role?: Role; status?: 'ACTIVE' | 'SUSPENDED' }) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await lock(c, actor.tenantId);
        actor = await freshActor(c, actor);
        const t = await target(c, actor.tenantId, userId);
        if (t.user_id === actor.userId) throw new AppError('CANNOT_MODIFY_SELF', 403, 'Tidak dapat mengubah peran/status akun sendiri');
        if (!canManageRole(actor.role, t.role)) throw forbidden();
        if (patch.role && !canAssignRole(actor.role, patch.role)) throw forbidden();
        if ((patch.role && patch.role !== 'OWNER') || patch.status === 'SUSPENDED') await assertNotLastOwner(c, actor.tenantId, t);
        const row = (await c.query(
          `UPDATE tenant_memberships SET role = COALESCE($3, role), status = COALESCE($4, status) WHERE tenant_id = $1 AND user_id = $2
           RETURNING user_id, member_email, role, status, created_at`, [actor.tenantId, userId, patch.role ?? null, patch.status ?? null])).rows[0];
        if (patch.role && patch.role !== t.role) await audit(c, actor, 'member.role_changed', 'member', userId, t.member_email, { from: t.role, to: patch.role });
        if (patch.status && patch.status !== t.status) await audit(c, actor, 'member.status_changed', 'member', userId, t.member_email, { from: t.status, to: patch.status });
        const demoted = patch.role !== undefined && RANK[patch.role] < RANK[t.role];
        const suspended = patch.status === 'SUSPENDED' && t.status !== 'SUSPENDED';
        if (demoted || suspended) await revokeInvitationsBy(c, actor, userId, demoted ? 'inviter_demoted' : 'inviter_suspended');
        return memberView(row, actor.userId);
      });
    },

    /** Hapus anggota; menghapus diri sendiri = keluar dari workspace (tidak boleh bila OWNER terakhir). */
    async removeMember(actor: TeamActor, userId: string) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await lock(c, actor.tenantId);
        actor = await freshActor(c, actor);
        const t = await target(c, actor.tenantId, userId);
        if (t.user_id !== actor.userId && !canManageRole(actor.role, t.role)) throw forbidden();
        await assertNotLastOwner(c, actor.tenantId, t);
        // Offboarding: kredensial yang dibuat anggota ini ikut dicabut (API key adalah kredensial tenant-wide yang bertahan setelah sesi dashboard mati).
        // WAJIB SEBELUM keanggotaan dihapus: FK (tenant_id, created_by_user_id) -> tenant_memberships berstatus ON DELETE SET NULL, sehingga sesudah DELETE
        // pembuat key sudah NULL dan tidak ada lagi yang dapat dicocokkan. Ditangguhkan (bukan dihapus) TIDAK mencabut key: daftar API key menampilkan
        // pembuatnya agar dapat dicabut manual.
        const keys = (await c.query(`UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND created_by_user_id = $2 AND revoked_at IS NULL RETURNING id`, [actor.tenantId, userId])).rows.map((r: any) => r.id as string);
        await c.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [actor.tenantId, userId]);
        const self = t.user_id === actor.userId;
        const invs = await revokeInvitationsBy(c, actor, userId, self ? 'inviter_left' : 'inviter_removed');
        await audit(c, actor, self ? 'member.left' : 'member.removed', 'member', userId, t.member_email, { role: t.role, status: t.status, revoked_api_keys: keys, revoked_invitations: invs });
        return { user_id: userId, removed: true };
      });
    },

    async invite(actor: TeamActor, i: { email: string; role: Role }) {
      if (!ROLES.includes(i.role)) throw new AppError('VALIDATION_ERROR', 400, 'Peran tidak valid');
      if (!canAssignRole(actor.role, i.role)) throw forbidden();
      const email = i.email.trim().toLowerCase();
      const raw = 'inv_' + crypto.randomBytes(32).toString('base64url');
      try {
        return await db.tx({ tenantId: actor.tenantId }, async (c) => {
          await lock(c, actor.tenantId);
          const fresh = await freshActor(c, actor);
          if (!canAssignRole(fresh.role, i.role)) throw forbidden();
          const member = (await c.query('SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND member_email = $2', [actor.tenantId, email])).rows[0];
          if (member) throw new AppError('ALREADY_MEMBER', 409, 'Email tersebut sudah menjadi anggota');
          await c.query(`UPDATE tenant_invitations SET status = 'REVOKED' WHERE tenant_id = $1 AND email = $2 AND status = 'PENDING' AND expires_at <= now()`, [actor.tenantId, email]);
          const used = (await c.query(
            `SELECT (SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1)::int
                  + (SELECT count(*) FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now())::int AS n,
                    (SELECT max_members FROM tenant_settings WHERE tenant_id = $1) AS max`, [actor.tenantId])).rows[0];
          if (used.max == null || used.n >= used.max) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah anggota (termasuk undangan tertunda) tercapai');
          const row = (await c.query(
            `INSERT INTO tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))
             RETURNING ${INV_COLS}`, [actor.tenantId, email, i.role, sha256hex(raw), actor.userId, config.TEAM_INVITATION_TTL_HOURS])).rows[0];
          await audit(c, fresh, 'invitation.created', 'invitation', row.id, email, { role: i.role, expires_at: row.expires_at });
          return { ...invView(row), token: raw, invite_url: inviteUrl(raw) };
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError('INVITATION_EXISTS', 409, 'Masih ada undangan tertunda untuk email tersebut; cabut dahulu bila ingin membuat ulang');
        throw e;
      }
    },

    async listInvitations(actor: TeamActor, q: { page: number; pageSize: number; status?: string }) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        const sub = `SELECT ${INV_COLS} FROM tenant_invitations WHERE tenant_id = $1`;
        const where = `($2::text IS NULL OR status = $2)`;
        const total = (await c.query(`SELECT count(*)::int n FROM (${sub}) x WHERE ${where}`, [actor.tenantId, q.status ?? null])).rows[0].n;
        const rows = (await c.query(`SELECT * FROM (${sub}) x WHERE ${where} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [actor.tenantId, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(invView), total };
      });
    },

    async revokeInvitation(actor: TeamActor, id: string) {
      if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Undangan tidak ditemukan');
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await lock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        const inv = (await c.query('SELECT id, email, role, status FROM tenant_invitations WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, actor.tenantId])).rows[0];
        if (!inv) throw new AppError('NOT_FOUND', 404, 'Undangan tidak ditemukan');
        if (!canManageRole(fresh.role, inv.role)) throw forbidden();
        if (inv.status === 'ACCEPTED') throw new AppError('INVALID_STATE', 409, 'Undangan sudah diterima');
        if (inv.status === 'PENDING') {
          await c.query(`UPDATE tenant_invitations SET status = 'REVOKED' WHERE id = $1`, [id]);
          await audit(c, fresh, 'invitation.revoked', 'invitation', id, inv.email, { role: inv.role });
        }
        const row = (await c.query(`SELECT ${INV_COLS} FROM tenant_invitations WHERE id = $1`, [id])).rows[0];
        return invView(row);
      });
    },

    /**
     * Terbitkan ulang tautan untuk undangan yang masih PENDING (termasuk yang kedaluwarsa): token LAMA langsung tidak berlaku,
     * token baru tampil sekali, masa berlaku dihitung ulang. Untuk kasus tautan hilang/terlanjur tidak dibagikan (tanpa email).
     */
    async reissueInvitation(actor: TeamActor, id: string) {
      if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Undangan tidak ditemukan');
      const raw = 'inv_' + crypto.randomBytes(32).toString('base64url');
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await lock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        const inv = (await c.query('SELECT id, email, role, status, (expires_at <= now()) AS expired FROM tenant_invitations WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, actor.tenantId])).rows[0];
        if (!inv) throw new AppError('NOT_FOUND', 404, 'Undangan tidak ditemukan');
        if (!canManageRole(fresh.role, inv.role)) throw forbidden();
        if (inv.status !== 'PENDING') throw new AppError('INVALID_STATE', 409, 'Hanya undangan tertunda yang dapat diterbitkan ulang');
        if (inv.expired) {
          // Undangan kedaluwarsa tidak dihitung dalam kuota; menghidupkannya kembali menambah satu slot: periksa seperti saat membuat undangan baru.
          const used = (await c.query(
            `SELECT (SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1)::int
                  + (SELECT count(*) FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now())::int AS n,
                    (SELECT max_members FROM tenant_settings WHERE tenant_id = $1) AS max`, [actor.tenantId])).rows[0];
          if (used.max == null || used.n >= used.max) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah anggota (termasuk undangan tertunda) tercapai; undangan kedaluwarsa tidak dapat dihidupkan kembali');
        }
        const row = (await c.query(
          `UPDATE tenant_invitations SET token_hash = $2, expires_at = now() + make_interval(hours => $3) WHERE id = $1 RETURNING ${INV_COLS}`,
          [id, sha256hex(raw), config.TEAM_INVITATION_TTL_HOURS])).rows[0];
        await audit(c, fresh, 'invitation.reissued', 'invitation', id, inv.email, { role: inv.role, expires_at: row.expires_at });
        return { ...invView(row), token: raw, invite_url: inviteUrl(raw) };
      });
    },

    /**
     * Terima undangan sebagai pengguna terautentikasi. Semua kegagalan token (tidak ada/kedaluwarsa/dicabut/email berbeda)
     * dijawab sama (`INVALID_INVITATION`) agar token valid milik orang lain tidak dapat dikenali.
     */
    async acceptInvitation(userId: string, rawToken: string, meta: { ip?: string; requestId?: string } = {}) {
      if (!TOKEN_RE.test(rawToken)) throw invalidInvite();
      const hash = sha256hex(rawToken);
      return db.tx({ userId, inviteHash: hash }, async (c) => {
        const inv = (await c.query(`SELECT id, tenant_id, email, role FROM tenant_invitations WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > now() FOR UPDATE`, [hash])).rows[0];
        if (!inv) throw invalidInvite();
        const me = (await c.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
        if (!me || me.email !== inv.email) throw invalidInvite();
        try {
          await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,$3,$4)`, [inv.tenant_id, userId, inv.role, inv.email]);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('ALREADY_MEMBER', 409, 'Anda sudah menjadi anggota workspace ini');
          throw e;
        }
        const u = await c.query(`UPDATE tenant_invitations SET status = 'ACCEPTED', accepted_at = now(), accepted_by = $2 WHERE id = $1 AND status = 'PENDING'`, [inv.id, userId]);
        if (u.rowCount !== 1) throw invalidInvite();
        await recordAudit(c, { tenantId: inv.tenant_id, actor: { userId, email: inv.email, role: inv.role as Role }, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, targetEmail: inv.email, details: { role: inv.role }, ip: meta.ip, requestId: meta.requestId });
        const t = (await c.query('SELECT id, name, slug, status FROM tenants WHERE id = $1', [inv.tenant_id])).rows[0];
        if (!t || t.status !== 'ACTIVE') throw invalidInvite();
        return { tenant: { id: t.id, name: t.name, slug: t.slug }, role: inv.role as Role };
      });
    },
  };
}
export type TeamService = ReturnType<typeof createTeamService>;
