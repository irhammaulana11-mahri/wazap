import fs from 'node:fs/promises';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { LIMIT_KEYS, LIMIT_SPEC, readLimits, type LimitKey } from '../tenant/settings.service.js';
import { transitionSession } from '../sessions/lifecycle.js';
import { auditPlatform } from './platform.audit.js';
import type { PlatformAdmin, RequestMeta } from './platform.service.js';

/**
 * Operasi workspace untuk konsol platform (ADR-054). BATAS KUASA: hanya metadata dan agregat. Setiap kueri di sini memilih kolom satu per satu dan TIDAK PERNAH menyentuh
 * isi pesan, kontak, chat, kredensial/auth state sesi, target alarm, rahasia webhook, atau kunci/hash API key (dijaga tes pemindai sumber `platform-privacy.test.ts` dan
 * tes isi respons). Perubahan membutuhkan kode TOTP segar dan alasan, lalu tercatat di audit platform DAN (tanpa alasan, tanpa identitas operator) di audit workspace.
 */
export type TenantStatusFilter = 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'ALL';
type Patch = Partial<Record<LimitKey, number>>;

const notFound = () => new AppError('NOT_FOUND', 404, 'Workspace tidak ditemukan');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const like = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

/** Daftar kolom ringkasan workspace: nama, slug, status, kuota, pemakaian agregat, dan surel OWNER aktif (salinan keanggotaan). Tanpa data pelanggan workspace. */
const SUMMARY_SQL = `
  SELECT t.id, t.name, t.slug, t.status, t.created_at, t.suspended_at,
         s.max_sessions, s.max_api_keys, s.max_members, s.messages_per_minute,
         (SELECT count(*) FROM wa_sessions w WHERE w.tenant_id = t.id AND w.status NOT IN ('DELETING','DELETED'))::int AS sessions,
         (SELECT count(*) FROM wa_sessions w WHERE w.tenant_id = t.id AND w.status = 'CONNECTED')::int AS sessions_connected,
         (SELECT count(*) FROM api_keys k WHERE k.tenant_id = t.id AND k.revoked_at IS NULL)::int AS api_keys,
         (SELECT count(*) FROM tenant_memberships m WHERE m.tenant_id = t.id)::int AS members,
         (SELECT COALESCE(array_agg(m.member_email ORDER BY m.created_at) FILTER (WHERE m.member_email IS NOT NULL), '{}')
            FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.role = 'OWNER' AND m.status = 'ACTIVE') AS owners
    FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id`;

const shape = (r: any) => ({
  id: r.id as string, name: r.name as string, slug: r.slug as string, status: r.status as string,
  created_at: r.created_at as Date, suspended_at: (r.suspended_at ?? null) as Date | null,
  limits: { max_sessions: r.max_sessions, max_api_keys: r.max_api_keys, max_members: r.max_members, messages_per_minute: r.messages_per_minute } as Record<LimitKey, number | null>,
  used: { sessions: r.sessions as number, sessions_connected: r.sessions_connected as number, api_keys: r.api_keys as number, members: r.members as number },
  owners: r.owners as string[],
});

const BackupStatus = z.object({
  updated_at: z.string().max(40),
  last_success_at: z.string().max(40).nullable(),
  last_failure_at: z.string().max(40).nullable().optional(),
  last_failure_reason: z.string().max(300).nullable().optional(),
  last_file: z.string().max(200).nullable().optional(),
  last_size_bytes: z.number().int().nonnegative().nullable().optional(),
  location: z.enum(['offsite', 'separate_disk', 'same_disk']),
  offsite_ok_at: z.string().max(40).nullable().optional(),
});

export function createWorkspaceOps(db: GatewayDb, deps: { requireOtp: (admin: PlatformAdmin, otp: string, action: string, meta: RequestMeta) => Promise<void> }) {
  /**
   * Rencana perubahan kuota satu workspace: HANYA field yang berbeda dari nilai sekarang yang diperiksa (bilangan bulat dalam [minimum, batas mutlak env] dan tidak di bawah
   * pemakaian); nilai yang sama dilewati agar formulir yang mengirim semua kolom tidak ditolak bila env diturunkan. Dipakai DUA kali: sebagai pra-periksa SEBELUM kode TOTP
   * dikonsumsi (input salah tidak menghabiskan kode admin) dan sebagai pemeriksaan otoritatif di dalam kunci tulis.
   */
  async function planTenant(c: pg.PoolClient, tenantId: string, patch: Patch) {
    const t = (await c.query(`SELECT id, status FROM tenants WHERE id = $1`, [tenantId])).rows[0] as { id: string; status: string } | undefined;
    if (!t || t.status === 'DELETED') throw notFound();
    const cur = await readLimits(c, tenantId);
    const problems: { path: string; message: string }[] = [];
    const changes: Record<string, { from: number; to: number }> = {};
    for (const k of LIMIT_KEYS) {
      const v = patch[k]; if (v === undefined || v === cur.limits[k]) continue;
      const { min } = LIMIT_SPEC[k]; const ceil = LIMIT_SPEC[k].ceil();
      if (!Number.isInteger(v) || v < min || v > ceil) { problems.push({ path: k, message: `harus bilangan bulat ${min}..${ceil}` }); continue; }
      const usedKey = k === 'max_sessions' ? 'sessions' : k === 'max_api_keys' ? 'api_keys' : k === 'max_members' ? 'members' : null;
      if (usedKey && v < cur.used[usedKey]) throw new AppError('LIMIT_BELOW_USAGE', 409, `${k} tidak boleh di bawah pemakaian saat ini (${cur.used[usedKey]}); tangguhkan workspace atau minta pemilik mengurangi pemakaian`);
      changes[k] = { from: cur.limits[k], to: v };
    }
    if (problems.length) throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', problems);
    if (!Object.keys(changes).length) throw new AppError('NO_CHANGE', 409, 'Tidak ada perubahan: nilai yang diminta sama dengan kuota saat ini');
    return changes;
  }

  async function planDefaults(c: pg.PoolClient, patch: Patch, lock: boolean) {
    const cur = (await c.query(`SELECT max_sessions, max_api_keys, max_members, messages_per_minute FROM platform_defaults${lock ? ' FOR UPDATE' : ''}`)).rows[0] as Record<LimitKey, number>;
    const problems: { path: string; message: string }[] = [];
    const changes: Record<string, { from: number; to: number }> = {};
    for (const k of LIMIT_KEYS) {
      const v = patch[k]; if (v === undefined || v === cur[k]) continue;
      const { min } = LIMIT_SPEC[k]; const ceil = LIMIT_SPEC[k].ceil();
      if (!Number.isInteger(v) || v < min || v > ceil) { problems.push({ path: k, message: `harus bilangan bulat ${min}..${ceil}` }); continue; }
      changes[k] = { from: cur[k], to: v };
    }
    if (problems.length) throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', problems);
    if (!Object.keys(changes).length) throw new AppError('NO_CHANGE', 409, 'Tidak ada perubahan: nilai yang diminta sama dengan kuota bawaan saat ini');
    return changes;
  }

  async function getDefaults() {
    return db.tx({ platform: true }, async (c) => {
      const d = (await c.query(`SELECT max_sessions, max_api_keys, max_members, messages_per_minute, updated_at FROM platform_defaults`)).rows[0];
      return {
        limits: { max_sessions: d.max_sessions, max_api_keys: d.max_api_keys, max_members: d.max_members, messages_per_minute: d.messages_per_minute } as Record<LimitKey, number>,
        minimums: Object.fromEntries(LIMIT_KEYS.map((k) => [k, LIMIT_SPEC[k].min])) as Record<LimitKey, number>,
        ceilings: Object.fromEntries(LIMIT_KEYS.map((k) => [k, LIMIT_SPEC[k].ceil()])) as Record<LimitKey, number>,
        updated_at: d.updated_at as Date,
      };
    });
  }

  return {
    async listWorkspaces(o: { q?: string; status?: TenantStatusFilter; page: number; pageSize: number }) {
      const statuses = o.status === 'ALL' ? ['ACTIVE', 'SUSPENDED', 'DELETED'] : o.status ? [o.status] : ['ACTIVE', 'SUSPENDED'];
      const pat = o.q ? like(o.q.trim()) : null;
      const where = `WHERE t.status = ANY($1::text[]) AND ($2::text IS NULL OR t.name ILIKE $2 OR t.slug ILIKE $2
          OR EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.role = 'OWNER' AND m.member_email ILIKE $2))`;
      return db.tx({ platform: true }, async (c) => {
        const total = (await c.query(`SELECT count(*)::int n FROM tenants t ${where}`, [statuses, pat])).rows[0].n as number;
        const rows = (await c.query(`${SUMMARY_SQL} ${where} ORDER BY t.created_at DESC, t.id LIMIT $3 OFFSET $4`, [statuses, pat, o.pageSize, (o.page - 1) * o.pageSize])).rows;
        return { items: rows.map(shape), total };
      });
    },

    async getWorkspace(id: string) {
      if (!UUID_RE.test(id)) throw notFound();
      return db.tx({ platform: true }, async (c) => {
        const row = (await c.query(`${SUMMARY_SQL} WHERE t.id = $1`, [id])).rows[0];
        if (!row) throw notFound();
        const roles = (await c.query(`SELECT role, count(*)::int n FROM tenant_memberships WHERE tenant_id = $1 GROUP BY role`, [id])).rows as { role: string; n: number }[];
        const owners = (await c.query(
          `SELECT user_id, member_email AS email, status FROM tenant_memberships WHERE tenant_id = $1 AND role = 'OWNER' ORDER BY created_at, user_id`, [id])).rows as { user_id: string; email: string | null; status: string }[];
        const pendingInvites = (await c.query(`SELECT count(*)::int n FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now()`, [id])).rows[0].n as number;
        const lim = await readLimits(c, id);
        const history = (await c.query(
          `SELECT id, admin_email, action, details, reason, created_at FROM platform_audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`, [id])).rows;
        return {
          ...shape(row),
          members_by_role: Object.fromEntries(roles.map((r) => [r.role, r.n])) as Record<string, number>,
          pending_invitations: pendingInvites,
          owner_accounts: owners,
          quota_used: lim.used,        // definisi "terpakai" yang sama dengan penolakan pembuatan (anggota termasuk undangan tertunda)
          minimums: lim.minimums, ceilings: lim.ceilings,
          history,
        };
      });
    },

    /** Mengatur kuota satu workspace. Kode TOTP segar dan alasan wajib. Urutan: pra-periksa (tanpa mengonsumsi kode) -> konsumsi kode -> tulis dengan pemeriksaan ulang di dalam kunci. */
    async updateQuotas(admin: PlatformAdmin, tenantId: string, patch: Patch, reason: string, otp: string, meta: RequestMeta = {}) {
      if (!UUID_RE.test(tenantId)) throw notFound();
      await db.tx({ platform: true }, (c) => planTenant(c, tenantId, patch));
      await deps.requireOtp(admin, otp, 'quota_change', meta);
      return db.tx({ platform: true }, async (c) => {
        await c.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
        const changes = await planTenant(c, tenantId, patch);
        await c.query(
          `UPDATE tenant_settings SET max_sessions = COALESCE($2, max_sessions), max_api_keys = COALESCE($3, max_api_keys),
             max_members = COALESCE($4, max_members), messages_per_minute = COALESCE($5, messages_per_minute) WHERE tenant_id = $1`,
          [tenantId, changes.max_sessions?.to ?? null, changes.max_api_keys?.to ?? null, changes.max_members?.to ?? null, changes.messages_per_minute?.to ?? null]);
        await auditPlatform(c, { adminUserId: admin.userId, adminEmail: admin.email, action: 'tenant.quota_changed', tenantId, details: { changes }, reason, ...meta });
        // Transparansi: OWNER melihat kuotanya berubah dan bahwa itu dari platform (tanpa alasan internal dan tanpa identitas operator pribadi).
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_email, actor_role, action, target_type, target_id, details, ip, request_id)
           VALUES ($1::uuid, NULL, 'platform', NULL, 'tenant.quota_changed', 'tenant', $1::text, $2::jsonb, NULL, $3)`, [tenantId, JSON.stringify({ changes, source: 'platform' }), meta.requestId?.slice(0, 64) ?? null]);
        return readLimits(c, tenantId);
      });
    },

    /**
     * Tangguhkan workspace (ADR-054), DAPAT DIPULIHKAN dan tidak merusak: sesi WhatsApp diputus dengan jalur putus biasa (kredensial utuh; yang berniat tersambung ditandai
     * `resume_connect`), akses HTTP/realtime/API key/refresh langsung berhenti (semua jalur autentikasi mensyaratkan tenant ACTIVE), pengiriman webhook dan alarm ditahan.
     * Semua data tetap. Kode TOTP segar dan alasan wajib; pra-periksa sebelum kode dikonsumsi.
     */
    async suspendWorkspace(admin: PlatformAdmin, tenantId: string, reason: string, otp: string, meta: RequestMeta = {}) {
      if (!UUID_RE.test(tenantId)) throw notFound();
      const check = async (c: pg.PoolClient, lock: boolean) => {
        const t = (await c.query(`SELECT status FROM tenants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [tenantId])).rows[0] as { status: string } | undefined;
        if (!t || t.status === 'DELETED') throw notFound();
        if (t.status !== 'ACTIVE') throw new AppError('INVALID_STATE', 409, 'Workspace sudah ditangguhkan');
      };
      await db.tx({ platform: true }, (c) => check(c, false));
      await deps.requireOtp(admin, otp, 'suspend', meta);
      return db.tx({ platform: true }, async (c) => {
        await check(c, true);
        const row = (await c.query(`UPDATE tenants SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1 RETURNING id, status, suspended_at`, [tenantId])).rows[0];
        const sessions = (await c.query(`SELECT id, status, desired_state FROM wa_sessions WHERE tenant_id = $1 AND status NOT IN ('DELETING','DELETED') ORDER BY id FOR UPDATE`, [tenantId])).rows as { id: string; status: string; desired_state: string }[];
        let stopped = 0, marked = 0;
        for (const s of sessions) {
          if (s.desired_state === 'CONNECTED' && !['CREATED', 'LOGGED_OUT'].includes(s.status)) { await c.query(`UPDATE wa_sessions SET resume_connect = true WHERE id = $1`, [s.id]); marked++; }
          if (['CREATED', 'DISCONNECTED', 'DISCONNECTING', 'LOGGED_OUT', 'ERROR'].includes(s.status)) {
            await c.query(`UPDATE wa_sessions SET desired_state = 'DISCONNECTED' WHERE id = $1`, [s.id]);
          } else {
            const t = await transitionSession(c, { sessionId: s.id, tenantId, to: s.status === 'PENDING_ASSIGNMENT' ? 'DISCONNECTED' : 'DISCONNECTING', actor: 'SYSTEM', reason: 'tenant_suspended', set: { desired_state: 'DISCONNECTED' } });
            if (t) stopped++;
          }
        }
        await auditPlatform(c, { adminUserId: admin.userId, adminEmail: admin.email, action: 'tenant.suspended', tenantId, details: { sessions_stopped: stopped, sessions_marked_resume: marked }, reason, ...meta });
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_email, actor_role, action, target_type, target_id, details, ip, request_id)
           VALUES ($1::uuid, NULL, 'platform', NULL, 'tenant.suspended', 'tenant', $1::text, $2::jsonb, NULL, $3)`, [tenantId, JSON.stringify({ source: 'platform' }), meta.requestId?.slice(0, 64) ?? null]);
        return { id: row.id as string, status: row.status as string, suspended_at: row.suspended_at as Date | null, sessions_affected: stopped };
      });
    },

    /** Aktifkan kembali workspace ditangguhkan: akses pulih seketika; sesi yang berniat tersambung disambungkan lagi (yang sengaja diputus pengguna tidak ikut). */
    async activateWorkspace(admin: PlatformAdmin, tenantId: string, reason: string, otp: string, meta: RequestMeta = {}) {
      if (!UUID_RE.test(tenantId)) throw notFound();
      const check = async (c: pg.PoolClient, lock: boolean) => {
        const t = (await c.query(`SELECT status FROM tenants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [tenantId])).rows[0] as { status: string } | undefined;
        if (!t || t.status === 'DELETED') throw notFound();
        if (t.status !== 'SUSPENDED') throw new AppError('INVALID_STATE', 409, 'Workspace tidak sedang ditangguhkan');
      };
      await db.tx({ platform: true }, (c) => check(c, false));
      await deps.requireOtp(admin, otp, 'activate', meta);
      return db.tx({ platform: true }, async (c) => {
        await check(c, true);
        const row = (await c.query(`UPDATE tenants SET status = 'ACTIVE', suspended_at = NULL WHERE id = $1 RETURNING id, status, suspended_at`, [tenantId])).rows[0];
        const sessions = (await c.query(`SELECT id, status FROM wa_sessions WHERE tenant_id = $1 AND resume_connect ORDER BY id FOR UPDATE`, [tenantId])).rows as { id: string; status: string }[];
        let resumed = 0;
        for (const s of sessions) {
          if (['DISCONNECTED', 'ERROR'].includes(s.status)) {
            const t = await transitionSession(c, { sessionId: s.id, tenantId, to: 'PENDING_ASSIGNMENT', actor: 'SYSTEM', reason: 'tenant_reactivated', set: { desired_state: 'CONNECTED' }, onlyFrom: ['DISCONNECTED', 'ERROR'] });
            if (t) resumed++;
          } else if (s.status === 'DISCONNECTING') {
            // Masih melepas koneksi: niat disambung kembali dicatat; control-plane menempatkan ulang setelah lease dilepas (finalize).
            await c.query(`UPDATE wa_sessions SET desired_state = 'CONNECTED' WHERE id = $1`, [s.id]); resumed++;
          }
        }
        await c.query(`UPDATE wa_sessions SET resume_connect = false WHERE tenant_id = $1 AND resume_connect`, [tenantId]);
        await auditPlatform(c, { adminUserId: admin.userId, adminEmail: admin.email, action: 'tenant.reactivated', tenantId, details: { sessions_resumed: resumed }, reason, ...meta });
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_email, actor_role, action, target_type, target_id, details, ip, request_id)
           VALUES ($1::uuid, NULL, 'platform', NULL, 'tenant.reactivated', 'tenant', $1::text, $2::jsonb, NULL, $3)`, [tenantId, JSON.stringify({ source: 'platform' }), meta.requestId?.slice(0, 64) ?? null]);
        return { id: row.id as string, status: row.status as string, suspended_at: row.suspended_at as Date | null, sessions_affected: resumed };
      });
    },

    getDefaults,

    /** Kuota bawaan untuk workspace BARU (tidak mengubah workspace yang sudah ada). Urutan sama: pra-periksa, konsumsi kode, tulis. */
    async updateDefaults(admin: PlatformAdmin, patch: Patch, reason: string, otp: string, meta: RequestMeta = {}) {
      await db.tx({ platform: true }, (c) => planDefaults(c, patch, false));
      await deps.requireOtp(admin, otp, 'defaults_change', meta);
      await db.tx({ platform: true }, async (c) => {
        const changes = await planDefaults(c, patch, true);
        await c.query(
          `UPDATE platform_defaults SET max_sessions = COALESCE($1, max_sessions), max_api_keys = COALESCE($2, max_api_keys), max_members = COALESCE($3, max_members),
             messages_per_minute = COALESCE($4, messages_per_minute), updated_by = $5, updated_at = now()`,
          [changes.max_sessions?.to ?? null, changes.max_api_keys?.to ?? null, changes.max_members?.to ?? null, changes.messages_per_minute?.to ?? null, admin.userId]);
        await auditPlatform(c, { adminUserId: admin.userId, adminEmail: admin.email, action: 'platform.defaults_changed', details: { changes }, reason, ...meta });
      });
      return getDefaults();
    },

    async listAudit(o: { page: number; pageSize: number; tenantId?: string; action?: string }) {
      return db.tx({ platform: true }, async (c) => {
        const where = `WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR action = $2)`;
        const total = (await c.query(`SELECT count(*)::int n FROM platform_audit_logs ${where}`, [o.tenantId ?? null, o.action ?? null])).rows[0].n as number;
        const items = (await c.query(
          `SELECT id, admin_email, action, tenant_id, details, reason, ip, request_id, created_at FROM platform_audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
          [o.tenantId ?? null, o.action ?? null, o.pageSize, (o.page - 1) * o.pageSize])).rows;
        return { items, total };
      });
    },

    /** Status cadangan HANYA-BACA dari berkas yang ditulis backup-run.sh (tidak ada kredensial, tidak ada tombol jalankan/pulihkan: lihat ADR-052/054). */
    async backupStatus() {
      const file = config.PLATFORM_BACKUP_STATUS_FILE;
      const maxAge = config.PLATFORM_BACKUP_MAX_AGE_HOURS;
      if (!file) return { configured: false, available: false, status: null, age_hours: null, stale: null, max_age_hours: maxAge, reason: 'PLATFORM_BACKUP_STATUS_FILE belum diisi' };
      try {
        const st = await fs.stat(file);
        if (!st.isFile() || st.size > 65_536) return { configured: true, available: false, status: null, age_hours: null, stale: null, max_age_hours: maxAge, reason: 'berkas status tidak valid' };
        const parsed = BackupStatus.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
        if (!parsed.success) return { configured: true, available: false, status: null, age_hours: null, stale: null, max_age_hours: maxAge, reason: 'isi berkas status tidak sesuai format' };
        const s = parsed.data;
        const ageH = s.last_success_at ? Math.max(0, (Date.now() - Date.parse(s.last_success_at)) / 3_600_000) : null;
        return { configured: true, available: true, status: s, age_hours: ageH === null || Number.isNaN(ageH) ? null : Math.round(ageH * 10) / 10, stale: ageH === null || Number.isNaN(ageH) || ageH > maxAge, max_age_hours: maxAge, reason: null };
      } catch (e) {
        return { configured: true, available: false, status: null, age_hours: null, stale: null, max_age_hours: maxAge, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'berkas status belum ada (cadangan belum pernah berjalan?)' : 'berkas status tidak dapat dibaca' };
      }
    },
  };
}
