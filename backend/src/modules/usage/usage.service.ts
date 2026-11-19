import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

export interface UsageRange { from: Date; to: Date }
export const MAX_RANGE_DAYS = 92;
export const MAX_HOURLY_DAYS = 7;
const DAY_MS = 86_400_000;

/** Rentang waktu [from, to): default 24 jam terakhir; maks 92 hari. Semua waktu dibandingkan terhadap `created_at` pesan. */
export function resolveRange(q: { from?: string; to?: string }, now = new Date()): UsageRange {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - DAY_MS);
  if (!(from.getTime() < to.getTime())) throw new AppError('INVALID_RANGE', 400, '`from` harus lebih awal dari `to`');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new AppError('INVALID_RANGE', 400, `Rentang maksimal ${MAX_RANGE_DAYS} hari`);
  return { from, to };
}

/**
 * Nama zona waktu IANA (mis. Asia/Jakarta, Etc/GMT-7) atau UTC. Bentuk OFFSET ('+07:00', 'UTC+7') DITOLAK: Intl menerimanya sebagai UTC+7 tetapi
 * PostgreSQL `AT TIME ZONE '+07:00'` membacanya sebagai POSIX (UTC-7, tanda terbalik) sehingga data bergeser 14 jam tanpa galat.
 */
const TZ_NAME = /^(UTC|[A-Za-z]+(?:[_-][A-Za-z]+)*\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/;
export function validTimeZone(tz: string): boolean {
  if (!TZ_NAME.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const sum = (m: Record<string, number>, ...keys: string[]) => keys.reduce((a, k) => a + (m[k] ?? 0), 0);

/**
 * Metrik penggunaan jalur tenant (RLS). Semantik: pesan KELUAR dihitung menurut `created_at` (saat diantrekan) dan status
 * SAAT INI; pesan MASUK menurut `created_at` (saat diterima gateway). Data lebih tua dari masa retensi (180 hari) sudah dihapus.
 */
export function createUsageService(db: GatewayDb) {
  // Nama zona yang sudah dipastikan dikenal PostgreSQL (pg_timezone_names lambat, jadi di-cache per proses).
  const knownTz = new Set<string>(['UTC']);
  return {
    /** Dikenal PostgreSQL? (pemeriksaan kedua setelah validTimeZone, agar nama yang hanya dikenal Intl tidak lolos). */
    async timezoneKnown(tz: string): Promise<boolean> {
      if (knownTz.has(tz)) return true;
      const ok = (await db.pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz])).rowCount === 1;
      if (ok) knownTz.add(tz);
      return ok;
    },

    async summary(tenantId: string, r: UsageRange) {
      return db.tx({ tenantId }, async (c) => {
        const out = (await c.query(
          `SELECT status, count(*)::int n FROM message_queue WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY status`,
          [tenantId, r.from, r.to])).rows;
        const incoming = (await c.query(
          `SELECT count(*)::int n FROM wa_messages WHERE tenant_id = $1 AND direction = 'IN' AND created_at >= $2 AND created_at < $3`,
          [tenantId, r.from, r.to])).rows[0].n;
        const sess = (await c.query(`SELECT status, count(*)::int n FROM wa_sessions WHERE tenant_id = $1 AND status <> 'DELETED' GROUP BY status`, [tenantId])).rows;
        const queue = (await c.query(`SELECT status, count(*)::int n FROM message_queue WHERE tenant_id = $1 AND status IN ('PENDING','PROCESSING') GROUP BY status`, [tenantId])).rows;
        const q = (await c.query(
          `SELECT s.max_sessions, s.max_api_keys, s.max_members, s.messages_per_minute,
             (SELECT count(*) FROM wa_sessions WHERE tenant_id = $1 AND status NOT IN ('DELETING','DELETED'))::int AS sessions_used,
             (SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL)::int AS keys_used,
             (SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1)::int
               + (SELECT count(*) FROM tenant_invitations WHERE tenant_id = $1 AND status = 'PENDING' AND expires_at > now())::int AS members_used,
             (SELECT count(*) FROM webhook_endpoints WHERE tenant_id = $1)::int AS webhooks_used
           FROM tenant_settings s WHERE s.tenant_id = $1`, [tenantId])).rows[0];
        const byStatus = Object.fromEntries(out.map((x: any) => [x.status, x.n])) as Record<string, number>;
        const sessBy = Object.fromEntries(sess.map((x: any) => [x.status, x.n])) as Record<string, number>;
        const qBy = Object.fromEntries(queue.map((x: any) => [x.status, x.n])) as Record<string, number>;
        return {
          period: { from: r.from.toISOString(), to: r.to.toISOString() },
          sessions: { total: sum(sessBy, ...Object.keys(sessBy)), connected: sessBy.CONNECTED ?? 0, by_status: sessBy },
          messages: {
            total: sum(byStatus, ...Object.keys(byStatus)), by_status: byStatus,
            sent: sum(byStatus, 'SENT', 'DELIVERED', 'READ'), delivered: sum(byStatus, 'DELIVERED', 'READ'), read: byStatus.READ ?? 0,
            failed: byStatus.FAILED ?? 0, unknown: sum(byStatus, 'UNKNOWN', 'RECONCILIATION_REQUIRED'), cancelled: byStatus.CANCELLED ?? 0,
          },
          incoming: { total: incoming },
          queue: { pending: qBy.PENDING ?? 0, processing: qBy.PROCESSING ?? 0 },
          quotas: q ? {
            sessions: { used: q.sessions_used, max: q.max_sessions }, api_keys: { used: q.keys_used, max: q.max_api_keys },
            members: { used: q.members_used, max: q.max_members }, webhooks: { used: q.webhooks_used, max: config.WEBHOOK_MAX_ENDPOINTS },
            messages_per_minute: q.messages_per_minute,
          } : null,
        };
      });
    },

    /** Deret waktu per jam/hari pada zona waktu `tz`; bucket kosong diisi nol agar siap digambar. */
    async series(tenantId: string, r: UsageRange, o: { unit: 'hour' | 'day'; tz: string; sessionId?: string }) {
      const span = r.to.getTime() - r.from.getTime();
      if (o.unit === 'hour' && span > MAX_HOURLY_DAYS * DAY_MS) throw new AppError('INVALID_RANGE', 400, `group_by=hour maksimal ${MAX_HOURLY_DAYS} hari`);
      const unit = o.unit === 'hour' ? 'hour' : 'day'; // daftar putih (disisipkan ke SQL)
      try {
        return await db.tx({ tenantId }, async (c) => {
          const rows = (await c.query(
            `WITH buckets AS (
               SELECT generate_series(date_trunc('${unit}', $2::timestamptz AT TIME ZONE $4::text),
                                      date_trunc('${unit}', ($3::timestamptz - interval '1 microsecond') AT TIME ZONE $4::text),
                                      interval '1 ${unit}') AS b),
             o AS (
               SELECT date_trunc('${unit}', created_at AT TIME ZONE $4::text) AS b, count(*)::int AS total,
                      count(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,
                      count(*) FILTER (WHERE status IN ('DELIVERED','READ'))::int AS delivered,
                      count(*) FILTER (WHERE status = 'READ')::int AS read,
                      count(*) FILTER (WHERE status = 'FAILED')::int AS failed
               FROM message_queue WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 AND ($5::uuid IS NULL OR session_id = $5)
               GROUP BY 1),
             i AS (
               SELECT date_trunc('${unit}', created_at AT TIME ZONE $4::text) AS b, count(*)::int AS n
               FROM wa_messages WHERE tenant_id = $1 AND direction = 'IN' AND created_at >= $2 AND created_at < $3 AND ($5::uuid IS NULL OR session_id = $5)
               GROUP BY 1)
             SELECT (buckets.b AT TIME ZONE $4::text) AS bucket, COALESCE(o.total,0) AS total, COALESCE(o.sent,0) AS sent,
                    COALESCE(o.delivered,0) AS delivered, COALESCE(o.read,0) AS read, COALESCE(o.failed,0) AS failed, COALESCE(i.n,0) AS incoming
             FROM buckets LEFT JOIN o ON o.b = buckets.b LEFT JOIN i ON i.b = buckets.b ORDER BY buckets.b`,
            [tenantId, r.from, r.to, o.tz, o.sessionId ?? null])).rows;
          return rows.map((x: any) => ({ bucket: new Date(x.bucket).toISOString(), total: x.total, sent: x.sent, delivered: x.delivered, read: x.read, failed: x.failed, incoming: x.incoming }));
        });
      } catch (e) {
        if ((e as { code?: string }).code === '22023') throw new AppError('VALIDATION_ERROR', 400, 'Zona waktu tidak dikenal');
        throw e;
      }
    },

    async sessions(tenantId: string, r: UsageRange) {
      return db.tx({ tenantId }, async (c) => {
        const rows = (await c.query(
          `WITH o AS (SELECT session_id, count(*)::int AS outgoing, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
                      FROM message_queue WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY session_id),
                i AS (SELECT session_id, count(*)::int AS incoming
                      FROM wa_messages WHERE tenant_id = $1 AND direction = 'IN' AND created_at >= $2 AND created_at < $3 GROUP BY session_id)
           SELECT s.id, s.session_name, s.status, COALESCE(o.outgoing,0) AS outgoing, COALESCE(o.failed,0) AS failed, COALESCE(i.incoming,0) AS incoming
           FROM wa_sessions s LEFT JOIN o ON o.session_id = s.id LEFT JOIN i ON i.session_id = s.id
           WHERE s.tenant_id = $1 AND s.status <> 'DELETED' ORDER BY s.created_at, s.id`, [tenantId, r.from, r.to])).rows;
        return rows.map((x: any) => ({ session_id: x.id, session_name: x.session_name, status: x.status, outgoing: x.outgoing, failed: x.failed, incoming: x.incoming }));
      });
    },
  };
}
export type UsageService = ReturnType<typeof createUsageService>;
