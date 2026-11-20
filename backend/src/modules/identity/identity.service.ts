import crypto from 'crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { AppError } from '../../http/errors.js';
import { config } from '../../config/env.js';
import { hashPassword, verifyPassword } from './password.js';
import { randomToken, sha256hex, signAccessToken, verifyAccessToken } from './tokens.js';
import type { Principal, Role } from './principal.js';
import { newRecoverySet, normalizeCode, recoveryHash, storeRecoverySet } from './codes.js';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { readMembership } from '../team/team-lock.js';

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}
export interface AuthResult extends SessionTokens {
  user: { id: string; email: string };
  tenant: { id: string; name: string; slug: string };
  role: Role;
  /** Hanya pada pendaftaran akun baru: himpunan kode pemulihan sekali tampil. */
  recoveryCodes?: string[];
}

const API_KEY_RE = /^gwk_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAST_USED_THROTTLE_MS = 60_000;

const slugify = (name: string) => {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base.length >= 2 ? base : 'workspace'}-${crypto.randomBytes(4).toString('hex')}`;
};
const isUnique = (e: unknown, constraintPart: string) =>
  (e as { code?: string; constraint?: string })?.code === '23505' &&
  ((e as { constraint?: string }).constraint ?? '').includes(constraintPart);

export interface AccountActor { userId: string; tenantId: string; ip?: string; requestId?: string }

export function createIdentityService(db: GatewayDb) {
  async function issueRefresh(c: pg.PoolClient, userId: string, tenantId: string, familyId = crypto.randomUUID()) {
    const raw = randomToken(32);
    const id = crypto.randomUUID();
    await c.query(
      `INSERT INTO refresh_tokens (id, user_id, tenant_id, family_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
      [id, userId, tenantId, familyId, sha256hex(raw), config.REFRESH_TOKEN_TTL_SECONDS]
    );
    return { raw, id, familyId };
  }

  const tokens = (userId: string, tenantId: string, refreshRaw: string, version = 0): SessionTokens => ({
    accessToken: signAccessToken(userId, tenantId, undefined, version),
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refreshRaw,
    refreshExpiresIn: config.REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    async register(input: { email: string; password: string; tenantName: string }): Promise<AuthResult> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password); // CPU-bound, di luar transaksi
      const recovery = newRecoverySet();
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const slug = slugify(input.tenantName);
      try {
        return await db.tx({ userId, tenantId }, async (c) => {
          await c.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [userId, email, passwordHash]);
          await storeRecoverySet(c, userId, recovery.hashes, false);
          await c.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, input.tenantName.trim(), slug]);
          await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, member_email) VALUES ($1,$2,'OWNER',$3)`, [tenantId, userId, email]);
          await c.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId]);
          const rt = await issueRefresh(c, userId, tenantId);
          return {
            ...tokens(userId, tenantId, rt.raw),
            user: { id: userId, email },
            tenant: { id: tenantId, name: input.tenantName.trim(), slug },
            role: 'OWNER' as const,
            recoveryCodes: recovery.codes,
          };
        });
      } catch (e) {
        if (isUnique(e, 'users_email')) throw new AppError('EMAIL_TAKEN', 409, 'Email sudah terdaftar');
        throw e;
      }
    },

    async login(input: { email: string; password: string; tenantId?: string }): Promise<AuthResult> {
      const email = input.email.trim().toLowerCase();
      const user = await db.tx({ loginEmail: email }, async (c) =>
        (await c.query('SELECT id, email, password_hash, status, token_version FROM users WHERE email = $1', [email])).rows[0] as
          | { id: string; email: string; password_hash: string; status: string; token_version: number }
          | undefined
      );
      const passOk = await verifyPassword(input.password, user?.password_hash ?? null);
      if (!user || !passOk || user.status !== 'ACTIVE') {
        throw new AppError('INVALID_CREDENTIALS', 401, 'Email atau password salah');
      }
      return db.tx({ userId: user.id }, async (c) => {
        // input.tenantId hanya memilih di antara membership milik user (bukan otoritas).
        const m = (
          await c.query(
            `SELECT t.id, t.name, t.slug, m.role FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
             WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND t.status = 'ACTIVE' AND ($2::uuid IS NULL OR t.id = $2)
             ORDER BY m.created_at LIMIT 1`,
            [user.id, input.tenantId ?? null]
          )
        ).rows[0];
        if (!m) {
          // Kata sandi sudah benar (diperiksa di atas), jadi pesan ini tidak membuka enumerasi akun.
          const jr = (await c.query(`SELECT status, expires_at > now() AS live FROM tenant_join_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [user.id])).rows[0];
          if (jr?.status === 'PENDING' && jr.live) throw new AppError('JOIN_PENDING', 403, 'Permintaan bergabung Anda menunggu persetujuan admin workspace');
          if (jr && !(jr.status === 'PENDING' && jr.live) && jr.status !== 'APPROVED') throw new AppError('JOIN_REJECTED', 403, 'Permintaan bergabung Anda ditolak atau kedaluwarsa');
          throw new AppError('NO_ACTIVE_TENANT', 403, 'Tidak ada workspace aktif untuk akun ini');
        }
        await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        const rt = await issueRefresh(c, user.id, m.id);
        return {
          ...tokens(user.id, m.id, rt.raw, user.token_version),
          user: { id: user.id, email: user.email },
          tenant: { id: m.id, name: m.name, slug: m.slug },
          role: m.role as Role,
        };
      });
    },

    /**
     * Pindah workspace tanpa mengetik ulang kata sandi: pengguna terautentikasi memilih tenant dari MEMBERSHIP-nya sendiri.
     * Menerbitkan access token + refresh token (family baru) untuk tenant tujuan; family refresh lama dicabut bila diberikan.
     */
    async switchTenant(userId: string, tenantId: string, oldRefreshRaw?: string): Promise<AuthResult> {
      if (!UUID_RE.test(tenantId)) throw new AppError('NOT_FOUND', 404, 'Workspace tidak ditemukan');
      return db.tx({ userId }, async (c) => {
        const m = (
          await c.query(
            `SELECT u.email, u.token_version, t.id, t.name, t.slug, m.role
             FROM users u JOIN tenant_memberships m ON m.user_id = u.id JOIN tenants t ON t.id = m.tenant_id
             WHERE u.id = $1 AND t.id = $2 AND u.status = 'ACTIVE' AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
            [userId, tenantId]
          )
        ).rows[0];
        if (!m) throw new AppError('NOT_FOUND', 404, 'Workspace tidak ditemukan'); // bukan anggota = sama dengan tidak ada
        if (oldRefreshRaw) {
          const old = (await c.query('SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [sha256hex(oldRefreshRaw), userId])).rows[0];
          if (old) await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1', [old.family_id]);
        }
        const rt = await issueRefresh(c, userId, m.id);
        return {
          ...tokens(userId, m.id, rt.raw, m.token_version),
          user: { id: userId, email: m.email },
          tenant: { id: m.id, name: m.name, slug: m.slug },
          role: m.role as Role,
        };
      });
    },

    /** Rotasi refresh token. Reuse token lama => seluruh family dicabut. */
    async refresh(rawToken: string): Promise<AuthResult> {
      const invalid = () => new AppError('INVALID_REFRESH_TOKEN', 401, 'Refresh token tidak valid');
      const outcome = await db.tx({ refreshHash: sha256hex(rawToken) }, async (c) => {
        // Lookup by hash (kebijakan SELECT), set konteks user, lalu kunci baris (FOR UPDATE memerlukan kebijakan UPDATE).
        const found = (await c.query('SELECT user_id FROM refresh_tokens WHERE token_hash = $1', [sha256hex(rawToken)])).rows[0];
        if (!found) return { fail: true as const };
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [found.user_id]);
        const row = (
          await c.query(
            `SELECT id, user_id, tenant_id, family_id, revoked_at, (expires_at <= now()) AS expired
             FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
            [sha256hex(rawToken)]
          )
        ).rows[0];
        if (!row) return { fail: true as const };
        const revokeFamily = () =>
          c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1', [row.family_id]);
        if (row.revoked_at) {
          await revokeFamily(); // indikasi pencurian/reuse
          return { fail: true as const };
        }
        if (row.expired) return { fail: true as const };
        const ctxRow = (
          await c.query(
            `SELECT u.id AS uid, u.email, u.token_version, t.id AS tid, t.name, t.slug, m.role
             FROM users u JOIN tenant_memberships m ON m.user_id = u.id JOIN tenants t ON t.id = m.tenant_id
             WHERE u.id = $1 AND t.id = $2 AND u.status = 'ACTIVE' AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
            [row.user_id, row.tenant_id]
          )
        ).rows[0];
        if (!ctxRow) {
          await revokeFamily();
          return { fail: true as const };
        }
        const next = await issueRefresh(c, row.user_id, row.tenant_id, row.family_id);
        await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $2 WHERE id = $1', [row.id, next.id]);
        return {
          fail: false as const,
          result: {
            ...tokens(ctxRow.uid, ctxRow.tid, next.raw, ctxRow.token_version),
            user: { id: ctxRow.uid, email: ctxRow.email },
            tenant: { id: ctxRow.tid, name: ctxRow.name, slug: ctxRow.slug },
            role: ctxRow.role as Role,
          } satisfies AuthResult,
        };
      });
      if (outcome.fail) throw invalid(); // dilempar setelah commit agar pencabutan family tersimpan
      return outcome.result;
    },

    async logout(rawToken: string): Promise<void> {
      await db.tx({ refreshHash: sha256hex(rawToken) }, async (c) => {
        const row = (await c.query('SELECT user_id, family_id FROM refresh_tokens WHERE token_hash = $1', [sha256hex(rawToken)])).rows[0];
        if (!row) return;
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [row.user_id]);
        await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1', [row.family_id]);
      });
    },

    /** Verifikasi access token + membership aktif (role/status berubah berlaku segera). */
    async authenticateAccessToken(token: string): Promise<Principal | null> {
      const claims = verifyAccessToken(token);
      if (!claims) return null;
      if (!UUID_RE.test(claims.sub) || !UUID_RE.test(claims.tid)) return null;
      const row = await db.tx({ userId: claims.sub, tenantId: claims.tid }, async (c) =>
          (
            await c.query(
              `SELECT m.role, u.token_version FROM users u
               JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = $2
               JOIN tenants t ON t.id = m.tenant_id
               WHERE u.id = $1 AND u.status = 'ACTIVE' AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
              [claims.sub, claims.tid]
            )
          ).rows[0]
        );
      if (!row) return null;
      // Ganti kata sandi / reset / keluar dari semua perangkat menaikkan token_version dan mematikan access token yang diterbitkan sebelumnya.
      if (claims.tv !== row.token_version) return null;
      return { type: 'user', userId: claims.sub, tenantId: claims.tid, role: row.role };
    },

    async authenticateApiKey(raw: string): Promise<Principal | null> {
      if (!API_KEY_RE.test(raw)) return null;
      const hash = sha256hex(raw);
      return db.tx({ apiKeyHash: hash }, async (c) => {
        const k = (
          await c.query(
            `SELECT id, tenant_id, scopes, (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2)) AS stale
             FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
            [hash, LAST_USED_THROTTLE_MS / 1000]
          )
        ).rows[0];
        if (!k) return null;
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [k.tenant_id]);
        const t = (await c.query(`SELECT 1 FROM tenants WHERE id = $1 AND status = 'ACTIVE'`, [k.tenant_id])).rows[0];
        if (!t) return null;
        if (k.stale) await c.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND tenant_id = $2', [k.id, k.tenant_id]);
        return { type: 'apikey' as const, apiKeyId: k.id, tenantId: k.tenant_id, scopes: k.scopes as string[] };
      });
    },

    async me(userId: string, tenantId: string) {
      return db.tx({ userId, tenantId }, async (c) => {
        const u = (await c.query('SELECT id, email, created_at FROM users WHERE id = $1', [userId])).rows[0];
        const memberships = (
          await c.query(
            `SELECT t.id AS tenant_id, t.name, t.slug, m.role, m.status FROM tenant_memberships m
             JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.status = 'ACTIVE' ORDER BY m.created_at`,
            [userId]
          )
        ).rows;
        const rec = (await c.query('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId])).rows[0].n;
        const conf = (await c.query('SELECT recovery_confirmed_at FROM users WHERE id = $1', [userId])).rows[0]?.recovery_confirmed_at;
        // Status kode pemulihan untuk banner (tanpa nilai kode): sisa kode, dan apakah pengguna sudah mengonfirmasi menyimpannya.
        return { user: u, active_tenant_id: tenantId, memberships, recovery: { codes_remaining: rec, confirmed: !!conf } };
      });
    },

    // ================= manajemen akun (hanya pengguna dashboard; dipanggil route dengan principal terverifikasi) =================

    /** Audit akun dicatat di workspace aktif pengguna (satu-satunya konteks tenant yang ada). */
    async accountAudit(c: pg.PoolClient, a: AccountActor, action: AuditAction, details: Record<string, unknown> = {}) {
      const m = await readMembership(c, a.tenantId, a.userId);
      await recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email: m?.email ?? null, role: m?.role ?? null }, action, targetType: 'account', targetId: a.userId, targetEmail: m?.email ?? null, details, ip: a.ip, requestId: a.requestId });
    },

    /** Ganti kata sandi: butuh kata sandi lama; semua sesi lain dicabut (refresh token + access token lama); sesi ini dilanjutkan dengan token baru. */
    async changePassword(a: AccountActor, input: { current: string; next: string }): Promise<AuthResult> {
      const u = await db.tx({ userId: a.userId }, async (c) => (await c.query('SELECT email, password_hash, status FROM users WHERE id = $1', [a.userId])).rows[0] as { email: string; password_hash: string; status: string } | undefined);
      if (!u || u.status !== 'ACTIVE' || !(await verifyPassword(input.current, u.password_hash))) throw new AppError('INVALID_PASSWORD', 403, 'Kata sandi saat ini salah');
      if (input.current === input.next) throw new AppError('PASSWORD_UNCHANGED', 400, 'Kata sandi baru harus berbeda dari yang lama');
      const newHash = await hashPassword(input.next);
      return db.tx({ userId: a.userId, tenantId: a.tenantId }, async (c) => {
        // Compare-and-swap pada hash lama: dua penggantian serentak tidak saling menimpa tanpa sadar.
        const r = await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), token_version = token_version + 1 WHERE id = $1 AND password_hash = $3 RETURNING token_version', [a.userId, newHash, u.password_hash]);
        if (r.rowCount !== 1) throw new AppError('CONFLICT', 409, 'Kata sandi baru saja diubah dari perangkat lain; coba lagi');
        await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1', [a.userId]);
        const m = (await c.query(
          `SELECT t.id, t.name, t.slug, m.role FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
           WHERE m.user_id = $1 AND t.id = $2 AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'`, [a.userId, a.tenantId])).rows[0];
        if (!m) throw new AppError('FORBIDDEN', 403, 'Workspace tidak aktif');
        const rt = await issueRefresh(c, a.userId, a.tenantId);
        await this.accountAudit(c, a, 'account.password_changed', { revoked_other_sessions: true });
        return { ...tokens(a.userId, a.tenantId, rt.raw, r.rows[0].token_version), user: { id: a.userId, email: u.email }, tenant: { id: m.id, name: m.name, slug: m.slug }, role: m.role as Role };
      });
    },

    /** Terbitkan himpunan 8 kode pemulihan baru (tampil sekali; seluruh kode lama hangus). Butuh kata sandi saat ini. */
    async issueRecoveryCodes(a: AccountActor, password: string): Promise<{ recoveryCodes: string[] }> {
      const u = await db.tx({ userId: a.userId }, async (c) => (await c.query('SELECT password_hash, status FROM users WHERE id = $1', [a.userId])).rows[0] as { password_hash: string; status: string } | undefined);
      if (!u || u.status !== 'ACTIVE' || !(await verifyPassword(password, u.password_hash))) throw new AppError('INVALID_PASSWORD', 403, 'Kata sandi saat ini salah');
      const set = newRecoverySet();
      await db.tx({ userId: a.userId, tenantId: a.tenantId }, async (c) => {
        await storeRecoverySet(c, a.userId, set.hashes, true);
        await this.accountAudit(c, a, 'account.recovery_code_created');
      });
      return { recoveryCodes: set.codes };
    },

    /** Pengguna menyatakan sudah menyimpan kode (menghilangkan banner). */
    async confirmRecoveryCodes(a: AccountActor): Promise<void> {
      await db.tx({ userId: a.userId }, async (c) => { await c.query('UPDATE users SET recovery_confirmed_at = now() WHERE id = $1', [a.userId]); });
    },

    /**
     * Atur ulang kata sandi dengan salah satu kode pemulihan (tanpa email). Semua kegagalan dijawab sama. Tiap kode sekali pakai (CAS pada used_at); sisa kode
     * tetap berlaku. Berhasil => seluruh sesi dicabut dan peristiwa dicatat di audit SETIAP workspace tempat pengguna menjadi anggota (admin dapat melihat
     * pengambilalihan akun). Hashing dan satu transaksi dijalankan juga untuk email yang tidak dikenal agar waktu respons tidak membedakannya.
     */
    async resetPassword(input: { email: string; recoveryCode: string; next: string }, meta: { ip?: string; requestId?: string } = {}): Promise<{ remainingRecoveryCodes: number }> {
      const invalid = () => new AppError('INVALID_RECOVERY', 400, 'Email atau kode pemulihan tidak valid');
      const email = input.email.trim().toLowerCase();
      const newHash = await hashPassword(input.next);
      const core = normalizeCode('RC', input.recoveryCode);
      const user = await db.tx({ loginEmail: email }, async (c) => (await c.query('SELECT id, status FROM users WHERE email = $1', [email])).rows[0] as { id: string; status: string } | undefined);
      const uid = user?.id ?? crypto.randomUUID();
      return db.tx({ userId: uid, loginEmail: email }, async (c) => {
        const used = await c.query('UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [uid, recoveryHash(core ?? '0'.repeat(20))]);
        if (!core || !user || user.status !== 'ACTIVE' || used.rowCount !== 1) throw invalid(); // melempar membatalkan transaksi: kode tidak terpakai
        await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), token_version = token_version + 1 WHERE id = $1', [uid, newHash]);
        await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1', [uid]);
        for (const m of (await c.query('SELECT tenant_id, member_email, role FROM tenant_memberships WHERE user_id = $1', [uid])).rows) {
          await recordAudit(c, { tenantId: m.tenant_id, actor: { userId: uid, email: m.member_email, role: m.role }, action: 'account.password_reset', targetType: 'account', targetId: uid, targetEmail: m.member_email, details: { method: 'recovery_code' }, ip: meta.ip, requestId: meta.requestId });
        }
        const left = (await c.query('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [uid])).rows[0].n;
        return { remainingRecoveryCodes: left as number };
      });
    },

    /** Alat operator: terbitkan himpunan kode pemulihan baru untuk email (kode lama hangus). null bila akun tidak ada. */
    async adminIssueRecoveryCodes(emailRaw: string): Promise<string[] | null> {
      const email = emailRaw.trim().toLowerCase();
      const u = await db.tx({ loginEmail: email }, async (c) => (await c.query('SELECT id FROM users WHERE email = $1', [email])).rows[0] as { id: string } | undefined);
      if (!u) return null;
      const set = newRecoverySet();
      await db.tx({ userId: u.id }, (c) => storeRecoverySet(c, u.id, set.hashes, true));
      return set.codes;
    },

    /** Langkah pengaman untuk operasi sensitif (mis. ekspor data): kata sandi akun harus benar. Tanpa efek samping. */
    async confirmPassword(userId: string, password: string): Promise<void> {
      const u = await db.tx({ userId }, async (c) => (await c.query('SELECT password_hash, status FROM users WHERE id = $1', [userId])).rows[0] as { password_hash: string; status: string } | undefined);
      if (!u || u.status !== 'ACTIVE' || !(await verifyPassword(password, u.password_hash))) throw new AppError('INVALID_PASSWORD', 403, 'Kata sandi salah');
    },

    /** Ganti email akun (butuh kata sandi). Email tidak diverifikasi (keputusan tanpa email); salinan member_email di semua keanggotaan ikut diperbarui. */
    async changeEmail(a: AccountActor, input: { password: string; newEmail: string }) {
      const email = input.newEmail.trim().toLowerCase();
      const u = await db.tx({ userId: a.userId }, async (c) => (await c.query('SELECT email, password_hash, status FROM users WHERE id = $1', [a.userId])).rows[0] as { email: string; password_hash: string; status: string } | undefined);
      if (!u || u.status !== 'ACTIVE' || !(await verifyPassword(input.password, u.password_hash))) throw new AppError('INVALID_PASSWORD', 403, 'Kata sandi saat ini salah');
      if (email === u.email) throw new AppError('EMAIL_UNCHANGED', 400, 'Email baru sama dengan email saat ini');
      try {
        await db.tx({ userId: a.userId, tenantId: a.tenantId }, async (c) => {
          await c.query('UPDATE users SET email = $2 WHERE id = $1', [a.userId, email]);
          await c.query('UPDATE tenant_memberships SET member_email = $2 WHERE user_id = $1', [a.userId, email]);
          await this.accountAudit(c, a, 'account.email_changed', { from: u.email, to: email });
        });
      } catch (e) {
        if (isUnique(e, 'users_email')) throw new AppError('EMAIL_TAKEN', 409, 'Email sudah terdaftar');
        throw e;
      }
      return { id: a.userId, email };
    },

    /** Keluar dari semua perangkat: seluruh refresh token dicabut dan access token yang beredar ditolak (termasuk perangkat ini). */
    async logoutAll(a: AccountActor): Promise<void> {
      await db.tx({ userId: a.userId, tenantId: a.tenantId }, async (c) => {
        await c.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [a.userId]);
        await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1', [a.userId]);
        await this.accountAudit(c, a, 'account.sessions_revoked');
      });
    },

    async updateApiKey(a: AccountActor, keyId: string, patch: { name?: string; scopes?: string[] }) {
      if (!UUID_RE.test(keyId)) throw new AppError('NOT_FOUND', 404, 'API key tidak ditemukan');
      return db.tx({ tenantId: a.tenantId }, async (c) => {
        const k = (await c.query('SELECT id, name, scopes, revoked_at FROM api_keys WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [keyId, a.tenantId])).rows[0];
        if (!k) throw new AppError('NOT_FOUND', 404, 'API key tidak ditemukan');
        if (k.revoked_at) throw new AppError('INVALID_STATE', 409, 'API key yang sudah dicabut tidak dapat diubah');
        const row = (await c.query(
          `UPDATE api_keys SET name = COALESCE($3, name), scopes = COALESCE($4::jsonb, scopes) WHERE id = $1 AND tenant_id = $2
           RETURNING id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at`,
          [keyId, a.tenantId, patch.name?.trim() ?? null, patch.scopes ? JSON.stringify(patch.scopes) : null])).rows[0];
        const m = await readMembership(c, a.tenantId, a.userId);
        await recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email: m?.email ?? null, role: m?.role ?? null }, action: 'api_key.updated', targetType: 'api_key', targetId: keyId,
          details: { name: patch.name !== undefined ? { from: k.name, to: row.name } : undefined, scopes: patch.scopes ? { from: k.scopes, to: row.scopes } : undefined }, ip: a.ip, requestId: a.requestId });
        return row;
      });
    },

    async createApiKey(
      tenantId: string,
      createdBy: string | null,
      input: { name: string; scopes: string[]; expiresAt?: Date | null }
    ) {
      const raw = `gwk_${randomToken(32)}`; // 4 + 43 karakter
      const prefix = raw.slice(0, 12);
      return db.tx({ tenantId }, async (c) => {
        const lim = (await c.query('SELECT max_api_keys FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
        const used = (
          await c.query(`SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId])
        ).rows[0].n;
        if (lim && used >= lim.max_api_keys) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah API key tercapai');
        const row = (
          await c.query(
            `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by_user_id, expires_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
             RETURNING id, name, key_prefix, scopes, expires_at, created_at`,
            [tenantId, input.name.trim(), prefix, sha256hex(raw), JSON.stringify(input.scopes), createdBy, input.expiresAt ?? null]
          )
        ).rows[0];
        return { ...row, key: raw }; // raw hanya dikembalikan sekali
      });
    },

    async listApiKeys(tenantId: string, page: number, pageSize: number) {
      return db.tx({ tenantId }, async (c) => {
        const total = (await c.query('SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1', [tenantId])).rows[0].n;
        const rows = (
          await c.query(
            `SELECT k.id, k.name, k.key_prefix, k.scopes, k.last_used_at, k.expires_at, k.revoked_at, k.created_at,
                    k.created_by_user_id, m.member_email AS created_by_email
             FROM api_keys k LEFT JOIN tenant_memberships m ON m.tenant_id = k.tenant_id AND m.user_id = k.created_by_user_id
             WHERE k.tenant_id = $1 ORDER BY k.created_at DESC, k.id LIMIT $2 OFFSET $3`,
            [tenantId, pageSize, (page - 1) * pageSize]
          )
        ).rows;
        // Pembuat: id selalu ada bila dibuat pengguna dashboard; email hanya selama pembuatnya masih anggota (null bila sudah dihapus).
        return { rows: rows.map(({ created_by_user_id, created_by_email, ...k }: any) => ({ ...k, created_by: created_by_user_id ? { user_id: created_by_user_id, email: created_by_email ?? null } : null })), total };
      });
    },

    async revokeApiKey(tenantId: string, keyId: string) {
      if (!UUID_RE.test(keyId)) throw new AppError('NOT_FOUND', 404, 'API key tidak ditemukan');
      const row = await db.tx({ tenantId }, async (c) =>
        (
          await c.query(
            `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND tenant_id = $2
             RETURNING id, revoked_at`,
            [keyId, tenantId]
          )
        ).rows[0]
      );
      if (!row) throw new AppError('NOT_FOUND', 404, 'API key tidak ditemukan');
      return row;
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
