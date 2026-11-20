import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';

/**
 * Evaluator alarm (konteks platform). Satu jalur seragam: tiap aturan membaca sumbernya dalam jendela waktu terakhir (ALERTS_LOOKBACK_MINUTES atau jendela aturan),
 * lalu menulis antrean `alert_deliveries` untuk tiap kanal AKTIF yang dipilih aturan. Idempotensi dijamin UNIQUE (tenant, kanal, aturan, objek, jendela) +
 * ON CONFLICT DO NOTHING, sehingga poller ganda/restart tidak menggandakan notifikasi. Aturan berulang memakai jendela = floor(epoch / cooldown), jadi
 * kondisi yang berlanjut diingatkan lagi paling cepat tiap cooldown. Kejadian yang terjadi saat worker mati lebih lama dari jendela lookback tidak dikirim (diterima).
 * `payload` hanya berisi FAKTA tersanitasi (nama sesi, angka, host), bukan nomor telepon atau isi pesan.
 */
const INSERT = (rule: string, candidates: string) => `
  WITH rl AS (SELECT tenant_id, threshold, cooldown_minutes, channel_ids FROM alert_rules WHERE rule_code = '${rule}' AND enabled AND cardinality(channel_ids) > 0),
  cand AS (${candidates})
  INSERT INTO alert_deliveries (tenant_id, channel_id, rule_code, object_key, window_key, payload)
  SELECT cand.tenant_id, ch.id, '${rule}', cand.object_key, cand.window_key, cand.facts
  FROM cand JOIN rl ON rl.tenant_id = cand.tenant_id
  CROSS JOIN LATERAL unnest(rl.channel_ids) cid
  JOIN alert_channels ch ON ch.id = cid AND ch.tenant_id = cand.tenant_id AND ch.active
  ON CONFLICT DO NOTHING`;
const BUCKET = `floor(extract(epoch FROM now()) / (rl.cooldown_minutes * 60))::text`;

const QUERIES: Record<string, string> = {
  'session.logged_out': INSERT('session.logged_out', `
    SELECT e.tenant_id, e.id::text AS object_key, 'e' AS window_key, jsonb_build_object('session_name', s.session_name) AS facts
    FROM wa_session_events e JOIN wa_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id JOIN rl ON rl.tenant_id = e.tenant_id
    WHERE e.to_status = 'LOGGED_OUT' AND e.created_at > now() - make_interval(mins => $1::int)`),
  'session.disconnected_long': INSERT('session.disconnected_long', `
    SELECT s.tenant_id, s.id::text AS object_key, ${BUCKET} AS window_key,
           jsonb_build_object('session_name', s.session_name, 'status', s.status, 'minutes', floor(extract(epoch FROM now() - s.updated_at) / 60)::int) AS facts
    FROM wa_sessions s JOIN rl ON rl.tenant_id = s.tenant_id
    WHERE s.desired_state = 'CONNECTED' AND s.status NOT IN ('CONNECTED','DELETING','DELETED','CREATED','PENDING_ASSIGNMENT')
      AND s.updated_at < now() - make_interval(mins => rl.threshold)`),
  'session.reconnect_loop': INSERT('session.reconnect_loop', `
    SELECT e.tenant_id, e.session_id::text AS object_key, ${BUCKET} AS window_key,
           jsonb_build_object('session_name', max(s.session_name), 'count', count(*)::int) AS facts
    FROM wa_session_events e JOIN wa_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id JOIN rl ON rl.tenant_id = e.tenant_id
    WHERE e.to_status IN ('RECONNECTING','DISCONNECTED') AND e.created_at > now() - interval '10 minutes'
    GROUP BY e.tenant_id, e.session_id, rl.threshold, rl.cooldown_minutes HAVING count(*) >= rl.threshold`),
  'webhook.endpoint_disabled': INSERT('webhook.endpoint_disabled', `
    SELECT w.tenant_id, w.id::text AS object_key, floor(extract(epoch FROM w.disabled_at))::text AS window_key,
           jsonb_build_object('endpoint_host', substring(w.url from '^https?://([^/:?#]+)'), 'reason', w.disabled_reason) AS facts
    FROM webhook_endpoints w JOIN rl ON rl.tenant_id = w.tenant_id
    WHERE w.disabled_at IS NOT NULL AND w.disabled_at > now() - make_interval(mins => $1::int)`),
  'webhook.dead_burst': INSERT('webhook.dead_burst', `
    SELECT d.tenant_id, 'tenant' AS object_key, ${BUCKET} AS window_key, jsonb_build_object('count', count(*)::int) AS facts
    FROM webhook_deliveries d JOIN rl ON rl.tenant_id = d.tenant_id
    WHERE d.status = 'DEAD' AND d.updated_at > now() - interval '1 hour' AND d.event_type <> 'webhook.test'
      AND coalesce(d.last_error_code, '') NOT IN ('ENDPOINT_GONE','ENDPOINT_INACTIVE')
    GROUP BY d.tenant_id, rl.threshold, rl.cooldown_minutes HAVING count(*) >= rl.threshold`),
  'message.failed_burst': INSERT('message.failed_burst', `
    SELECT q.tenant_id, 'tenant' AS object_key, ${BUCKET} AS window_key, jsonb_build_object('count', count(*)::int) AS facts
    FROM message_queue q JOIN rl ON rl.tenant_id = q.tenant_id
    WHERE q.status = 'FAILED' AND q.updated_at > now() - interval '10 minutes'
    GROUP BY q.tenant_id, rl.threshold, rl.cooldown_minutes HAVING count(*) >= rl.threshold`),
  'message.unknown': INSERT('message.unknown', `
    SELECT q.tenant_id, q.id::text AS object_key, lower(q.status) AS window_key, jsonb_build_object('status', q.status) AS facts
    FROM message_queue q JOIN rl ON rl.tenant_id = q.tenant_id
    WHERE q.status IN ('UNKNOWN','RECONCILIATION_REQUIRED') AND q.updated_at > now() - make_interval(mins => $1::int)`),
  'export.completed': INSERT('export.completed', `
    SELECT a.tenant_id, a.id::text AS object_key, 'e' AS window_key, jsonb_build_object('type', a.details->>'type', 'rows', coalesce((a.details->>'rows')::bigint, 0)) AS facts
    FROM audit_logs a JOIN rl ON rl.tenant_id = a.tenant_id
    WHERE a.action = 'data.exported' AND a.details->>'outcome' = 'completed' AND a.created_at > now() - make_interval(mins => $1::int)`),
};

export function createAlertEvaluator(deps: { db: GatewayDb; log?: { warn: (o: any, m?: string) => void }; enabled?: () => boolean; lookbackMinutes?: number }) {
  const { db } = deps;
  return {
    /** Satu penyapuan semua aturan. Mengembalikan jumlah antrean baru. Galat satu aturan tidak menghentikan aturan lain. */
    async runOnce(): Promise<number> {
      if (!(deps.enabled ? deps.enabled() : config.ALERTS_ENABLED === 'true')) return 0;
      const lookback = deps.lookbackMinutes ?? config.ALERTS_LOOKBACK_MINUTES;
      let total = 0;
      for (const [rule, sql] of Object.entries(QUERIES)) {
        try {
          // Parameter $1 (lookback) hanya dipakai kueri yang memuatnya; pg menolak parameter yang tak dipakai, jadi disesuaikan per kueri.
          const uses = sql.includes('$1');
          total += await db.tx({ platform: true }, async (c) => (await c.query(sql, uses ? [lookback] : [])).rowCount ?? 0);
        } catch (err) { deps.log?.warn({ rule, err: String((err as Error).message) }, 'evaluator alarm: aturan gagal'); }
      }
      return total;
    },
  };
}
export type AlertEvaluator = ReturnType<typeof createAlertEvaluator>;
