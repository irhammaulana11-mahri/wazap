import crypto from 'node:crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { hashPassword, verifyPassword } from '../identity/password.js';
import type { Role } from '../identity/principal.js';
import { sha256hex } from '../identity/tokens.js';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { readMembership, teamLock } from './team-lock.js';
import { canAssignRole, canManageRole, type TeamActor } from './team.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Alfabet tanpa 0/O/1/I/L agar mudah diketik; 20 karakter = 100 bit entropi.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$/;

/** Kode tampil `WJ-XXXXX-XXXXX-XXXXX-XXXXX`; pada input, huruf kecil/tanda hubung/spasi diabaikan. Mengembalikan 20 karakter inti atau null. */
export function normalizeJoinCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length === 22 && s.startsWith('WJ')) s = s.slice(2); // awalan tampilan; kode inti 20 karakter boleh saja diawali "WJ"
  return CODE_RE.test(s) ? s : null;
}
const display = (core: string) => `WJ-${core.match(/.{5}/g)!.join('-')}`;
function newCode(): string {
  let out = '';
  // Penolakan (rejection sampling) menghindari bias modulo: 31 simbol, ambil byte < 248 (= 31 * 8).
  while (out.length < 20) for (const b of crypto.randomBytes(32)) if (b < 248 && out.length < 20) out += ALPHABET[b % 31];
  return out;
}
const codeHash = (core: string) => sha256hex('wj:' + core);

/** Tautan siap bagikan; kode ada di FRAGMEN (tidak masuk access log/Referer), seperti tautan undangan. null bila DASHBOARD_BASE_URL tidak diatur. */
const joinUrl = (core: string) => (config.DASHBOARD_BASE_URL ? `${config.DASHBOARD_BASE_URL.replace(/\/$/, '')}/join#code=${display(core)}` : null);

const forbidden = () => new AppError('FORBIDDEN', 403, 'Tidak memiliki izin untuk operasi ini');
const invalidCode = () => new AppError('INVALID_JOIN_CODE', 404, 'Kode workspace tidak valid atau sudah tidak berlaku');
const reqNotFound = () => new AppError('NOT_FOUND', 404, 'Permintaan tidak ditemukan');

const REQ_COLS = `id, email, user_id, expires_at, created_at, decided_at, decided_by, decided_role,
  CASE WHEN status = 'PENDING' AND expires_at <= now() THEN 'EXPIRED' ELSE status END AS status`;
const reqView = (r: any) => ({ id: r.id, email: r.email, user_id: r.user_id, status: r.status, role: r.decided_role, requested_at: r.created_at, expires_at: r.expires_at, decided_at: r.decided_at, decided_by: r.decided_by });

export function createJoinService(db: GatewayDb) {
  async function freshActor(c: pg.PoolClient, a: TeamActor): Promise<TeamActor> {
    const m = await readMembership(c, a.tenantId, a.userId);
    if (!m || m.status !== 'ACTIVE') throw forbidden();
    return { ...a, role: m.role, email: m.email };
  }
  const audit = (c: pg.PoolClient, a: TeamActor, action: AuditAction, type: 'join_request' | 'join_code', id: string | null, email: string | null, details: Record<string, unknown> = {}) =>
    recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email: a.email, role: a.role }, action, targetType: type, targetId: id, targetEmail: email, details, ip: a.ip, requestId: a.requestId });

  return {
    // ================= jalur publik (pemohon belum punya akun/anggota) =================

    /**
     * Ajukan permohonan bergabung. Kata sandi dibuat pemohon SAAT mengajukan (bukan sesudah disetujui): persetujuan hanya mengaktifkan
     * keanggotaan, sehingga akun tidak dapat dibajak oleh orang lain yang kebetulan login lebih dulu. Email yang sudah terdaftar
     * harus membuktikan kepemilikan dengan kata sandi akunnya (tanpa membuat akun kedua). Kegagalan kode dijawab seragam.
     */
    async request(input: { joinCode: string; email: string; password: string }) {
      const core = normalizeJoinCode(input.joinCode);
      if (!core) throw invalidCode();
      const hash = codeHash(core);
      const email = input.email.trim().toLowerCase();
      const existing = await db.tx({ loginEmail: email }, async (c) =>
        (await c.query('SELECT id, password_hash, status FROM users WHERE email = $1', [email])).rows[0] as { id: string; password_hash: string; status: string } | undefined);
      let userId: string; let passwordHash: string | null = null;
      if (existing) {
        if (!(await verifyPassword(input.password, existing.password_hash)) || existing.status !== 'ACTIVE') throw new AppError('INVALID_CREDENTIALS', 401, 'Email atau password salah');
        userId = existing.id;
      } else {
        userId = crypto.randomUUID();
        passwordHash = await hashPassword(input.password); // CPU-bound, di luar transaksi
      }
      try {
        return await db.tx({ userId, joinHash: hash }, async (c) => {
          const code = (await c.query('SELECT tenant_id, tenant_name FROM tenant_join_codes WHERE code_hash = $1', [hash])).rows[0];
          if (!code) throw invalidCode();
          // Serialkan pengajuan per tenant agar batas antrean eksak (kunci yang sama dengan mutasi tim; tidak butuh akses tabel).
          await teamLock(c, code.tenant_id);
          if (!passwordHash) { // akun sudah ada: pengajuan ganda dijawab spesifik sebelum antrean penuh
            const mine = (await c.query(`SELECT 1 FROM tenant_join_requests WHERE tenant_id = $1 AND user_id = $2 AND status = 'PENDING' AND expires_at > now()`, [code.tenant_id, userId])).rows[0];
            if (mine) throw new AppError('JOIN_REQUEST_EXISTS', 409, 'Permintaan Anda untuk workspace ini masih menunggu persetujuan');
          }
          // Hitung antrean (kebijakan join_requests_queue_count membuka hanya baris PENDING yang berlaku milik tenant ini).
          const queued = (await c.query(`SELECT count(*)::int n FROM tenant_join_requests WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now()`, [code.tenant_id])).rows[0].n;
          if (queued >= config.JOIN_MAX_PENDING) throw new AppError('JOIN_QUEUE_FULL', 409, 'Antrean permintaan workspace ini sedang penuh; hubungi admin workspace');
          if (passwordHash) await c.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [userId, email, passwordHash]);
          const member = (await c.query('SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [code.tenant_id, userId])).rows[0];
          if (member) throw new AppError('ALREADY_MEMBER', 409, 'Anda sudah menjadi anggota workspace ini');
          // Permintaan lama yang kedaluwarsa dibersihkan agar tidak menghalangi pengajuan baru (indeks unik hanya untuk PENDING).
          await c.query(`UPDATE tenant_join_requests SET status = 'REJECTED', decided_at = now() WHERE tenant_id = $1 AND user_id = $2 AND status = 'PENDING' AND expires_at <= now()`, [code.tenant_id, userId]);
          const r = (await c.query(
            `INSERT INTO tenant_join_requests (tenant_id, user_id, email, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))
             RETURNING id, expires_at`, [code.tenant_id, userId, email, config.JOIN_REQUEST_TTL_DAYS])).rows[0];
          return { request_id: r.id as string, status: 'PENDING' as const, tenant_name: code.tenant_name as string, expires_at: r.expires_at as Date, existing_account: !!existing };
        });
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        if (err.code === '23505' && (err.constraint ?? '').includes('users_email')) throw new AppError('EMAIL_TAKEN', 409, 'Email sudah terdaftar; coba lagi');
        if (err.code === '23505') throw new AppError('JOIN_REQUEST_EXISTS', 409, 'Permintaan Anda untuk workspace ini masih menunggu persetujuan');
        throw e;
      }
    },

    // ================= jalur tenant (OWNER/ADMIN) =================

    async getCode(actor: TeamActor) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        const r = (await c.query('SELECT created_at, created_by FROM tenant_join_codes WHERE tenant_id = $1', [actor.tenantId])).rows[0];
        return { enabled: !!r, created_at: r?.created_at ?? null, created_by: r?.created_by ?? null };
      });
    },

    /** Buat/putar kode: kode lama langsung hangus; kode baru tampil sekali. Permintaan yang sudah masuk tetap berlaku. */
    async rotateCode(actor: TeamActor) {
      const core = newCode();
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await teamLock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        if (!canManageRole(fresh.role, 'MEMBER')) throw forbidden();
        const t = (await c.query('SELECT name FROM tenants WHERE id = $1', [actor.tenantId])).rows[0];
        if (!t) throw forbidden();
        const row = (await c.query(
          `INSERT INTO tenant_join_codes (tenant_id, code_hash, tenant_name, created_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, tenant_name = EXCLUDED.tenant_name, created_by = EXCLUDED.created_by, created_at = now()
           RETURNING created_at`, [actor.tenantId, codeHash(core), t.name, actor.userId])).rows[0];
        await audit(c, fresh, 'join_code.rotated', 'join_code', null, null, {});
        return { enabled: true, created_at: row.created_at as Date, join_code: display(core), join_url: joinUrl(core) };
      });
    },

    async disableCode(actor: TeamActor) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await teamLock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        if (!canManageRole(fresh.role, 'MEMBER')) throw forbidden();
        const d = await c.query('DELETE FROM tenant_join_codes WHERE tenant_id = $1', [actor.tenantId]);
        if (d.rowCount) await audit(c, fresh, 'join_code.disabled', 'join_code', null, null, {});
        return { enabled: false };
      });
    },

    async list(actor: TeamActor, q: { page: number; pageSize: number; status?: string }) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        const sub = `SELECT ${REQ_COLS} FROM tenant_join_requests WHERE tenant_id = $1`;
        const where = `($2::text IS NULL OR status = $2)`;
        const total = (await c.query(`SELECT count(*)::int n FROM (${sub}) x WHERE ${where}`, [actor.tenantId, q.status ?? null])).rows[0].n;
        const rows = (await c.query(`SELECT * FROM (${sub}) x WHERE ${where} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [actor.tenantId, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(reqView), total };
      });
    },

    /** Setujui: buat keanggotaan dengan peran yang dipilih penyetuju (dibatasi wewenangnya), cek kuota anggota, serta tandai APPROVED. */
    async approve(actor: TeamActor, id: string, role: Role) {
      if (!UUID_RE.test(id)) throw reqNotFound();
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await teamLock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        if (!canAssignRole(fresh.role, role)) throw forbidden();
        const r = (await c.query(`SELECT id, user_id, email, status, (expires_at <= now()) AS expired FROM tenant_join_requests WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, actor.tenantId])).rows[0];
        if (!r) throw reqNotFound();
        if (r.status !== 'PENDING') throw new AppError('INVALID_STATE', 409, 'Permintaan sudah diputuskan');
        if (r.expired) throw new AppError('REQUEST_EXPIRED', 409, 'Permintaan sudah kedaluwarsa; minta pemohon mengajukan ulang');
        const used = (await c.query(
          `SELECT (SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1)::int
                + (SELECT count(*) FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now())::int AS n,
                  (SELECT max_members FROM tenant_settings WHERE tenant_id = $1) AS max`, [actor.tenantId])).rows[0];
        if (used.max == null || used.n >= used.max) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah anggota (termasuk undangan tertunda) tercapai');
        try {
          await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,$3,$4)`, [actor.tenantId, r.user_id, role, r.email]);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('ALREADY_MEMBER', 409, 'Pengguna sudah menjadi anggota workspace ini');
          throw e;
        }
        await c.query(`UPDATE tenant_join_requests SET status = 'APPROVED', decided_at = now(), decided_by = $2, decided_role = $3 WHERE id = $1`, [id, actor.userId, role]);
        await audit(c, fresh, 'join_request.approved', 'join_request', id, r.email, { role });
        return reqView((await c.query(`SELECT ${REQ_COLS} FROM tenant_join_requests WHERE id = $1`, [id])).rows[0]);
      });
    },

    async reject(actor: TeamActor, id: string) {
      if (!UUID_RE.test(id)) throw reqNotFound();
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await teamLock(c, actor.tenantId);
        const fresh = await freshActor(c, actor);
        const r = (await c.query(`SELECT id, email, status FROM tenant_join_requests WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, actor.tenantId])).rows[0];
        if (!r) throw reqNotFound();
        if (r.status !== 'PENDING') throw new AppError('INVALID_STATE', 409, 'Permintaan sudah diputuskan');
        await c.query(`UPDATE tenant_join_requests SET status = 'REJECTED', decided_at = now(), decided_by = $2 WHERE id = $1`, [id, actor.userId]);
        await audit(c, fresh, 'join_request.rejected', 'join_request', id, r.email, {});
        return reqView((await c.query(`SELECT ${REQ_COLS} FROM tenant_join_requests WHERE id = $1`, [id])).rows[0]);
      });
    },
  };
}
export type JoinService = ReturnType<typeof createJoinService>;
