import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

export type LimitKey = 'max_sessions' | 'max_api_keys' | 'max_members' | 'messages_per_minute';
/** Rentang yang sah per kuota: [min, ceiling]. Ceiling dari env (operator): tenant TIDAK dapat melampauinya. */
export const LIMIT_SPEC: Record<LimitKey, { min: number; ceil: () => number }> = {
  max_sessions: { min: 1, ceil: () => config.LIMIT_CEIL_SESSIONS },
  max_api_keys: { min: 0, ceil: () => config.LIMIT_CEIL_API_KEYS },
  max_members: { min: 1, ceil: () => config.LIMIT_CEIL_MEMBERS },
  messages_per_minute: { min: 1, ceil: () => config.LIMIT_CEIL_MESSAGES_PER_MINUTE },
};
export const LIMIT_KEYS = Object.keys(LIMIT_SPEC) as LimitKey[];
const SPEC = LIMIT_SPEC;

/** Kuota + pemakaian. Dipakai juga konsol platform (ADR-054) agar definisi "terpakai" satu-satunya. Tidak bergantung pada konteks (memakai klien yang diberikan). */
export async function readLimits(c: pg.PoolClient, tenantId: string) {
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
    /** OWNER tidak dapat mengubah kuota (ADR-054): diatur pemilik platform. UI menampilkan hanya-baca. */
    editable: false as const,
    managed_by: 'platform' as const,
  };
}

/**
 * Kuota tenant: DIBACA semua peran; diatur HANYA oleh pemilik platform (ADR-054, `modules/platform`). OWNER workspace tidak lagi dapat mengubahnya.
 * `LIMIT_CEIL_*` kini menjadi batas mutlak yang tidak dapat dilampaui platform admin pun (pagar salah ketik).
 */
export function createSettingsService(db: GatewayDb) {
  return {
    get: (tenantId: string) => db.tx({ tenantId }, (c) => readLimits(c, tenantId)),
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
