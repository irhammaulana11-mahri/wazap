import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.js';
import type { Role } from '../identity/principal.js';

export type LimitKey = 'max_sessions' | 'max_api_keys' | 'max_members' | 'messages_per_minute';
/** Rentang yang sah per kuota: [min, ceiling]. Ceiling dari env (operator): tenant TIDAK dapat melampauinya. */
const SPEC: Record<LimitKey, { min: number; ceil: () => number }> = {
  max_sessions: { min: 1, ceil: () => config.LIMIT_CEIL_SESSIONS },
  max_api_keys: { min: 0, ceil: () => config.LIMIT_CEIL_API_KEYS },
  max_members: { min: 1, ceil: () => config.LIMIT_CEIL_MEMBERS },
  messages_per_minute: { min: 1, ceil: () => config.LIMIT_CEIL_MESSAGES_PER_MINUTE },
};
export const LIMIT_KEYS = Object.keys(SPEC) as LimitKey[];

export interface SettingsActor { userId: string; tenantId: string; ip?: string; requestId?: string }

const forbidden = () => new AppError('FORBIDDEN', 403, 'Hanya OWNER yang dapat mengubah pengaturan tenant');

async function read(c: pg.PoolClient, tenantId: string) {
  const s = (await c.query('SELECT max_sessions, max_api_keys, max_members, messages_per_minute, updated_at FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!s) throw new AppError('NOT_FOUND', 404, 'Pengaturan tenant tidak ditemukan');
  // Definisi "terpakai" sama persis dengan yang dipakai saat menolak pembuatan (sesi, API key, anggota + undangan tertunda).
  const used = (await c.query(
    `SELECT (SELECT count(*) FROM wa_sessions WHERE tenant_id = $1 AND status NOT IN ('DELETING','DELETED'))::int AS sessions,
            (SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL)::int AS api_keys,
            (SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1)::int
              + (SELECT count(*) FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now())::int AS members`, [tenantId])).rows[0];
  return {
    limits: { max_sessions: s.max_sessions, max_api_keys: s.max_api_keys, max_members: s.max_members, messages_per_minute: s.messages_per_minute } as Record<LimitKey, number>,
    ceilings: Object.fromEntries(LIMIT_KEYS.map((k) => [k, SPEC[k].ceil()])) as Record<LimitKey, number>,
    minimums: Object.fromEntries(LIMIT_KEYS.map((k) => [k, SPEC[k].min])) as Record<LimitKey, number>,
    used: { sessions: used.sessions as number, api_keys: used.api_keys as number, members: used.members as number },
    updated_at: s.updated_at as Date,
  };
}

/**
 * Kuota tenant. Dibaca semua peran; diubah hanya OWNER, di dalam [minimum, ceiling global dari env] dan tidak di bawah pemakaian saat ini
 * (mencegah keadaan membingungkan). Perubahan berlaku seketika (kuota dibaca saat pembuatan/klaim) dan dicatat di audit log.
 * Operator mengontrol batas atas lewat env (LIMIT_CEIL_*): setel sama dengan nilai bawaan untuk membuat kuota efektif tidak dapat dinaikkan tenant.
 */
export function createSettingsService(db: GatewayDb) {
  return {
    get: (tenantId: string) => db.tx({ tenantId }, (c) => read(c, tenantId)),

    async update(actor: SettingsActor, patch: Partial<Record<LimitKey, number>>) {
      return db.tx({ tenantId: actor.tenantId }, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:team:' + actor.tenantId]); // serial dengan undangan/anggota
        const me = (await c.query('SELECT role, status, member_email FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [actor.tenantId, actor.userId])).rows[0];
        if (!me || me.status !== 'ACTIVE' || me.role !== 'OWNER') throw forbidden(); // peran dibaca ulang di dalam lock
        const cur = await read(c, actor.tenantId);
        const problems: { path: string; message: string }[] = [];
        const changes: Record<string, { from: number; to: number }> = {};
        for (const k of LIMIT_KEYS) {
          const v = patch[k];
          if (v === undefined) continue;
          const { min } = SPEC[k]; const ceil = SPEC[k].ceil();
          if (!Number.isInteger(v) || v < min || v > ceil) { problems.push({ path: k, message: `harus bilangan bulat ${min}..${ceil}` }); continue; }
          const usedKey = k === 'max_sessions' ? 'sessions' : k === 'max_api_keys' ? 'api_keys' : k === 'max_members' ? 'members' : null;
          if (usedKey && v < cur.used[usedKey]) throw new AppError('LIMIT_BELOW_USAGE', 409, `${k} tidak boleh di bawah pemakaian saat ini (${cur.used[usedKey]}); kurangi pemakaian dahulu`);
          if (v !== cur.limits[k]) changes[k] = { from: cur.limits[k], to: v };
        }
        if (problems.length) throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', problems);
        if (Object.keys(changes).length) {
          await c.query(
            `UPDATE tenant_settings SET max_sessions = COALESCE($2, max_sessions), max_api_keys = COALESCE($3, max_api_keys),
               max_members = COALESCE($4, max_members), messages_per_minute = COALESCE($5, messages_per_minute) WHERE tenant_id = $1`,
            [actor.tenantId, changes.max_sessions?.to ?? null, changes.max_api_keys?.to ?? null, changes.max_members?.to ?? null, changes.messages_per_minute?.to ?? null]);
          await recordAudit(c, { tenantId: actor.tenantId, actor: { userId: actor.userId, email: me.member_email, role: me.role as Role }, action: 'settings.updated', targetType: 'settings', targetId: actor.tenantId, details: { changes }, ip: actor.ip, requestId: actor.requestId });
        }
        return read(c, actor.tenantId);
      });
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
