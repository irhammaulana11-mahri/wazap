import type pg from 'pg';
import { AppError } from '../../http/errors.js';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { generateRecoveryCodes, generateTotpSecret, base32Encode, hashRecovery, looksLikeRecovery, otpauthUri, totpAad, verifyTotp } from '../../security/totp.js';
import { verifyPassword } from '../identity/password.js';
import { auditPlatform, type PlatformAuditEntry } from './platform.audit.js';
import { createWorkspaceOps } from './platform.workspaces.js';
import { signMfaToken, signPlatformToken, verifyMfaToken, verifyPlatformToken } from './platform-token.js';

/**
 * Platform admin (ADR-054): autentikasi (kata sandi -> TOTP -> token berumur pendek), pembuatan akun (hanya CLI), dan jejak audit platform.
 * Memakai konteks platform di DB; modul ini masuk daftar izin tes penjaga dan HANYA menjalankan kueri terkurasi (tanpa isi pesan, kontak, kredensial sesi, kunci API).
 */
export interface PlatformAdmin { userId: string; email: string }
export interface RequestMeta { ip?: string; requestId?: string }
export { auditPlatform, type PlatformAuditEntry };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidCreds = () => new AppError('INVALID_CREDENTIALS', 401, 'Email atau password salah');
const invalidMfa = () => new AppError('INVALID_MFA_TOKEN', 401, 'Sesi verifikasi tidak valid atau kedaluwarsa; masuk ulang');
const locked = (until: Date) => new AppError('ACCOUNT_LOCKED', 429, 'Terlalu banyak percobaan; akun dikunci sementara', [], { 'Retry-After': String(Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))) });

export function createPlatformService(db: GatewayDb, deps: { crypto?: CredentialCrypto; /** Jam (detik epoch) yang dapat disuntikkan untuk uji langkah TOTP; bawaan Date.now. */ now?: () => number }) {
  const cryptoOf = () => { if (!deps.crypto) throw new AppError('NOT_CONFIGURED', 503, 'Kunci enkripsi kredensial belum dikonfigurasi'); return deps.crypto; };

  interface AdminRow { user_id: string; status: string; totp_cipher: Buffer; totp_last_step: string; recovery_hashes: string[]; failed_attempts: number; locked_until: Date | null; email: string; ustatus: string; token_version: number }
  /** Baca admin + akunnya dengan penguncian baris. Konteks platform + pengguna: tabel users hanya terbaca untuk pemilik barisnya. */
  const loadAdmin = async (c: pg.PoolClient, userId: string): Promise<AdminRow | undefined> => (await c.query(
    `SELECT a.user_id, a.status, a.totp_cipher, a.totp_last_step, a.recovery_hashes, a.failed_attempts, a.locked_until, u.email, u.status AS ustatus, u.token_version
       FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 FOR UPDATE OF a`, [userId])).rows[0];

  /**
   * Memeriksa kode TOTP (atau, bila `allowRecovery`, kode pemulihan) untuk admin dan MENCATAT hasilnya, termasuk kegagalan, dalam transaksinya sendiri (commit walau gagal;
   * galat dilempar SETELAH commit). Kesalahan beruntun mengunci akun admin itu. Satu kode TOTP hanya sekali (langkah waktu terakhir disimpan).
   */
  async function consumeOtp(userId: string, code: string, o: { allowRecovery: boolean; action: string }, meta: RequestMeta): Promise<{ email: string; method: 'totp' | 'recovery'; recoveryRemaining: number; tokenVersion: number }> {
    const res = await db.tx({ platform: true, userId }, async (c) => {
      const a = await loadAdmin(c, userId);
      if (!a || a.status !== 'ACTIVE' || a.ustatus !== 'ACTIVE') return { kind: 'denied' as const };
      if (a.locked_until && a.locked_until.getTime() > Date.now()) return { kind: 'locked' as const, until: a.locked_until };
      let method: 'totp' | 'recovery' | null = null, step: number | null = null, remaining = a.recovery_hashes.length;
      if (o.allowRecovery && looksLikeRecovery(code)) {
        const h = hashRecovery(code);
        if (a.recovery_hashes.includes(h)) { method = 'recovery'; remaining = a.recovery_hashes.length - 1; await c.query(`UPDATE platform_admins SET recovery_hashes = array_remove(recovery_hashes, $2) WHERE user_id = $1`, [userId, h]); }
      } else {
        let secret: Buffer | undefined;
        try { secret = cryptoOf().decrypt(a.totp_cipher, totpAad(userId)); } catch (e) { if (e instanceof AppError) throw e; return { kind: 'denied' as const }; }
        step = verifyTotp(secret, code, { lastStep: Number(a.totp_last_step), now: deps.now?.() });
        if (step !== null) method = 'totp';
      }
      if (!method) {
        const failed = a.failed_attempts + 1, lock = failed >= config.PLATFORM_MAX_FAILED_OTP;
        await c.query(`UPDATE platform_admins SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE user_id = $1`,
          [userId, lock ? 0 : failed, lock, config.PLATFORM_LOCK_MINUTES]);
        await auditPlatform(c, { adminUserId: userId, adminEmail: a.email, action: lock ? 'platform_admin.locked' : 'platform_admin.otp_failed', details: { purpose: o.action, consecutive: failed }, ...meta });
        return { kind: 'bad' as const };
      }
      await c.query(`UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL${step !== null ? ', totp_last_step = $2' : ''} WHERE user_id = $1`, step !== null ? [userId, step] : [userId]);
      return { kind: 'ok' as const, email: a.email, method, recoveryRemaining: remaining, tokenVersion: a.token_version };
    });
    if (res.kind === 'denied') throw invalidMfa();
    if (res.kind === 'locked') throw locked(res.until);
    if (res.kind === 'bad') throw new AppError('INVALID_OTP', 401, 'Kode verifikasi salah atau sudah dipakai');
    return { email: res.email, method: res.method, recoveryRemaining: res.recoveryRemaining, tokenVersion: res.tokenVersion };
  }

  const enrol = (email: string) => {
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    return { secret, codes, uri: otpauthUri(email, secret), base32: base32Encode(secret) };
  };

  const api = {
    // ---------- autentikasi ----------
    /** Langkah 1: email + kata sandi. Semua kegagalan (bukan pengguna, kata sandi salah, bukan admin, admin nonaktif) menjawab sama: 401 INVALID_CREDENTIALS. */
    async login(input: { email: string; password: string }, meta: RequestMeta = {}) {
      const email = input.email.trim().toLowerCase();
      const u = await db.tx({ loginEmail: email }, async (c) => (await c.query('SELECT id, password_hash, status, token_version FROM users WHERE email = $1', [email])).rows[0] as { id: string; password_hash: string; status: string; token_version: number } | undefined);
      const okPw = await verifyPassword(input.password, u?.password_hash ?? null);   // waktu konstan: tetap memverifikasi hash tiruan bila pengguna tidak ada
      if (!u || !okPw || u.status !== 'ACTIVE') throw invalidCreds();
      const st = await db.tx({ platform: true }, async (c) => {
        const a = (await c.query('SELECT status, locked_until FROM platform_admins WHERE user_id = $1', [u.id])).rows[0] as { status: string; locked_until: Date | null } | undefined;
        if (a && a.status === 'ACTIVE') await auditPlatform(c, { adminUserId: u.id, adminEmail: email, action: 'platform_admin.password_ok', ...meta });
        return a;
      });
      if (!st || st.status !== 'ACTIVE') throw invalidCreds();
      if (st.locked_until && st.locked_until.getTime() > Date.now()) throw locked(st.locked_until);
      return { mfa_token: signMfaToken(u.id, u.token_version), expires_in: config.PLATFORM_MFA_TOKEN_TTL_SECONDS };
    },

    /** Langkah 2: kode TOTP (atau kode pemulihan sekali pakai) -> token platform berumur pendek. */
    async verifyMfa(input: { mfaToken: string; code: string }, meta: RequestMeta = {}) {
      const claims = verifyMfaToken(input.mfaToken);
      if (!claims || !UUID_RE.test(claims.sub)) throw invalidMfa();
      const r = await consumeOtp(claims.sub, input.code.trim(), { allowRecovery: true, action: 'login' }, meta);
      if (claims.tv !== r.tokenVersion) throw invalidMfa();   // kata sandi diganti sejak langkah 1
      await db.tx({ platform: true, userId: claims.sub }, async (c) => {
        await c.query('UPDATE platform_admins SET last_login_at = now() WHERE user_id = $1', [claims.sub]);
        await auditPlatform(c, { adminUserId: claims.sub, adminEmail: r.email, action: 'platform_admin.login', details: { method: r.method, recovery_remaining: r.recoveryRemaining }, ...meta });
      });
      return { access_token: signPlatformToken(claims.sub, r.tokenVersion), expires_in: config.PLATFORM_TOKEN_TTL_SECONDS, admin: { user_id: claims.sub, email: r.email }, recovery_remaining: r.recoveryRemaining };
    },

    /** Memvalidasi token platform pada tiap permintaan: admin dan akun harus ACTIVE dan versi token cocok (ganti kata sandi mematikan token lama). */
    async authenticate(token: string): Promise<PlatformAdmin | null> {
      const claims = verifyPlatformToken(token);
      if (!claims || !UUID_RE.test(claims.sub)) return null;
      const row = await db.tx({ platform: true, userId: claims.sub }, async (c) => (await c.query(
        `SELECT u.email, u.token_version FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND a.status = 'ACTIVE' AND u.status = 'ACTIVE'`, [claims.sub])).rows[0] as { email: string; token_version: number } | undefined);
      if (!row || row.token_version !== claims.tv) return null;
      return { userId: claims.sub, email: row.email };
    },

    /** Kode TOTP SEGAR untuk perubahan (kuota, tangguhkan, default). Tidak menerima kode pemulihan. Kegagalan dihitung dan dapat mengunci akun. */
    async requireOtp(admin: PlatformAdmin, otp: string, action: string, meta: RequestMeta = {}): Promise<void> {
      await consumeOtp(admin.userId, otp.trim(), { allowRecovery: false, action }, meta);
    },

    // ---------- pengelolaan akun (CLI di server; tidak ada rute HTTP) ----------
    /** Daftarkan pengguna yang SUDAH ADA sebagai platform admin. Mengembalikan rahasia dan kode pemulihan SEKALI (untuk dicetak CLI); tidak disimpan dalam bentuk terbaca. */
    async createAdmin(email: string) {
      const em = email.trim().toLowerCase();
      const u = await db.tx({ platform: true, loginEmail: em }, async (c) => (await c.query('SELECT id, status FROM users WHERE email = $1', [em])).rows[0] as { id: string; status: string } | undefined);
      if (!u) throw new AppError('NOT_FOUND', 404, 'Pengguna dengan email itu belum terdaftar (daftar dulu lewat dashboard)');
      if (u.status !== 'ACTIVE') throw new AppError('INVALID_STATE', 409, 'Akun pengguna tidak aktif');
      const e = enrol(em); const { blob, keyVersion } = cryptoOf().encrypt(e.secret, totpAad(u.id));
      await db.tx({ platform: true }, async (c) => {
        const dup = await c.query('SELECT 1 FROM platform_admins WHERE user_id = $1', [u.id]);
        if (dup.rowCount) throw new AppError('ALREADY_EXISTS', 409, 'Sudah menjadi platform admin (gunakan reset-mfa untuk mendaftarkan ulang perangkat)');
        await c.query('INSERT INTO platform_admins (user_id, totp_cipher, totp_key_version, recovery_hashes) VALUES ($1,$2,$3,$4)', [u.id, blob, keyVersion, e.codes.hashes]);
        await auditPlatform(c, { adminUserId: u.id, adminEmail: em, action: 'platform_admin.created', details: { via: 'cli' } });
      });
      return { userId: u.id, otpauthUri: e.uri, secretBase32: e.base32, recoveryCodes: e.codes.codes };
    },

    /** Daftarkan ulang perangkat MFA: rahasia dan kode pemulihan baru; hitungan gagal dan kunci direset; kode lama tidak berlaku lagi. */
    async resetMfa(email: string) {
      const em = email.trim().toLowerCase();
      const u = await db.tx({ platform: true, loginEmail: em }, async (c) => (await c.query('SELECT id FROM users WHERE email = $1', [em])).rows[0] as { id: string } | undefined);
      if (!u) throw new AppError('NOT_FOUND', 404, 'Pengguna tidak ditemukan');
      const e = enrol(em); const { blob, keyVersion } = cryptoOf().encrypt(e.secret, totpAad(u.id));
      await db.tx({ platform: true }, async (c) => {
        const r = await c.query(`UPDATE platform_admins SET totp_cipher = $2, totp_key_version = $3, totp_last_step = 0, recovery_hashes = $4, failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [u.id, blob, keyVersion, e.codes.hashes]);
        if (!r.rowCount) throw new AppError('NOT_FOUND', 404, 'Bukan platform admin');
        await auditPlatform(c, { adminUserId: u.id, adminEmail: em, action: 'platform_admin.mfa_reset', details: { via: 'cli' } });
      });
      return { userId: u.id, otpauthUri: e.uri, secretBase32: e.base32, recoveryCodes: e.codes.codes };
    },

    /** Cabut hak platform admin (baris dihapus; jejak audit tetap). */
    async revokeAdmin(email: string) {
      const em = email.trim().toLowerCase();
      const u = await db.tx({ platform: true, loginEmail: em }, async (c) => (await c.query('SELECT id FROM users WHERE email = $1', [em])).rows[0] as { id: string } | undefined);
      if (!u) throw new AppError('NOT_FOUND', 404, 'Pengguna tidak ditemukan');
      await db.tx({ platform: true }, async (c) => {
        const r = await c.query('DELETE FROM platform_admins WHERE user_id = $1', [u.id]);
        if (!r.rowCount) throw new AppError('NOT_FOUND', 404, 'Bukan platform admin');
        await auditPlatform(c, { adminUserId: u.id, adminEmail: em, action: 'platform_admin.revoked', details: { via: 'cli' } });
      });
    },

    async listAdmins() {
      const rows = await db.tx({ platform: true }, async (c) => (await c.query(
        `SELECT user_id, status, last_login_at, locked_until, failed_attempts, cardinality(recovery_hashes)::int AS recovery_remaining, created_at FROM platform_admins ORDER BY created_at`)).rows);
      const out = [];
      for (const r of rows) {
        const e = await db.tx({ platform: true, userId: r.user_id }, async (c) => (await c.query('SELECT email FROM users WHERE id = $1', [r.user_id])).rows[0]?.email as string | undefined);
        out.push({ ...r, email: e ?? null });
      }
      return out as { user_id: string; email: string | null; status: string; last_login_at: Date | null; locked_until: Date | null; failed_attempts: number; recovery_remaining: number; created_at: Date }[];
    },
  };
  return { ...api, ...createWorkspaceOps(db, { requireOtp: api.requireOtp }) };
}

export type PlatformService = ReturnType<typeof createPlatformService>;
