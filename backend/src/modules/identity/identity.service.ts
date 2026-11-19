import crypto from 'crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { AppError } from '../../http/errors.js';
import { config } from '../../config/env.js';
import { hashPassword, verifyPassword } from './password.js';
import { randomToken, sha256hex, signAccessToken, verifyAccessToken } from './tokens.js';
import type { Principal, Role } from './principal.js';

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

  const tokens = (userId: string, tenantId: string, refreshRaw: string): SessionTokens => ({
    accessToken: signAccessToken(userId, tenantId),
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refreshRaw,
    refreshExpiresIn: config.REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    async register(input: { email: string; password: string; tenantName: string }): Promise<AuthResult> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password); // CPU-bound, di luar transaksi
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const slug = slugify(input.tenantName);
      try {
        return await db.tx({ userId, tenantId }, async (c) => {
          await c.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [userId, email, passwordHash]);
          await c.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, input.tenantName.trim(), slug]);
          await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')`, [tenantId, userId]);
          await c.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId]);
          const rt = await issueRefresh(c, userId, tenantId);
          return {
            ...tokens(userId, tenantId, rt.raw),
            user: { id: userId, email },
            tenant: { id: tenantId, name: input.tenantName.trim(), slug },
            role: 'OWNER' as const,
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
        (await c.query('SELECT id, email, password_hash, status FROM users WHERE email = $1', [email])).rows[0] as
          | { id: string; email: string; password_hash: string; status: string }
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
        if (!m) throw new AppError('NO_ACTIVE_TENANT', 403, 'Tidak ada workspace aktif untuk akun ini');
        await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        const rt = await issueRefresh(c, user.id, m.id);
        return {
          ...tokens(user.id, m.id, rt.raw),
          user: { id: user.id, email: user.email },
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
            `SELECT u.id AS uid, u.email, t.id AS tid, t.name, t.slug, m.role
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
            ...tokens(ctxRow.uid, ctxRow.tid, next.raw),
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
              `SELECT m.role FROM users u
               JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = $2
               JOIN tenants t ON t.id = m.tenant_id
               WHERE u.id = $1 AND u.status = 'ACTIVE' AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
              [claims.sub, claims.tid]
            )
          ).rows[0]
        );
      return row ? { type: 'user', userId: claims.sub, tenantId: claims.tid, role: row.role } : null;
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
             JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 ORDER BY m.created_at`,
            [userId]
          )
        ).rows;
        return { user: u, active_tenant_id: tenantId, memberships };
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
            `SELECT id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
             FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
            [tenantId, pageSize, (page - 1) * pageSize]
          )
        ).rows;
        return { rows, total };
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
