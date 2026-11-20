import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { config } from '../../config/env.js';
import { alertTargetAad, TELEGRAM_HOST, type ChannelType, type TelegramTarget } from '../../security/alert-target.js';
import type { UrlPolicy } from '../../security/ssrf.js';
import { postJson, type PostResult } from './webhook-delivery.js';
import { buildAlertText } from '../alerts/rules.js';

export type SendResult = PostResult;
/** Pengirim HTTP yang dapat diganti (tes). Bawaan: postJson dengan anti-SSRF, tanpa redirect, timeout. */
export type Poster = (url: string, body: string, o: { timeoutMs: number; policy: UrlPolicy }) => Promise<PostResult>;
const defaultPost: Poster = (url, body, o) => postJson(url, {}, body, o);
const STRICT: UrlPolicy = { allowHttp: false, allowPrivate: false };

/** Kirim satu pesan ke satu kanal. Rahasia didekripsi hanya di sini dan tidak pernah dicatat. Tidak pernah melempar. */
export async function sendToChannel(i: { type: ChannelType; cipher: Buffer; tenantId: string; channelId: string; ruleCode: string; facts: Record<string, unknown>; crypto: CredentialCrypto; post?: Poster }): Promise<SendResult> {
  let secret: string;
  try { secret = i.crypto.decrypt(i.cipher, alertTargetAad(i.tenantId, i.channelId)).toString('utf8'); }
  catch { return { errorCode: 'SECRET_UNAVAILABLE', durationMs: 0 }; }
  const text = buildAlertText(i.ruleCode, i.facts, config.DASHBOARD_BASE_URL);
  const post = i.post ?? defaultPost;
  const o = { timeoutMs: config.ALERTS_TIMEOUT_MS, policy: STRICT };
  if (i.type === 'TELEGRAM') {
    let t: TelegramTarget;
    try { t = JSON.parse(secret); } catch { return { errorCode: 'SECRET_UNAVAILABLE', durationMs: 0 }; }
    return post(`https://${TELEGRAM_HOST}/bot${t.token}/sendMessage`, JSON.stringify({ chat_id: t.chat_id, text, disable_web_page_preview: true }), o);
  }
  return post(secret, JSON.stringify({ text }), o);
}

export interface SenderOptions { post?: Poster; random?: () => number; claimSeconds?: number }
interface Claimed { id: string; tenantId: string; channelId: string; ruleCode: string; payload: Record<string, unknown>; attempts: number }

/**
 * Pengirim antrean alarm (konteks platform). Klaim batch (FOR UPDATE SKIP LOCKED, aman multi-instans), kirim di luar transaksi,
 * catat hasil. Retry eksponensial terbatas; 400/401/403/404 (token dicabut / chat hilang) permanen. Batas kirim per kanal per jam melindungi
 * chat pelanggan dari banjir. Setelah N DEAD beruntun kanal dinonaktifkan otomatis dan tercatat di audit.
 */
export function createAlertSender(deps: { db: GatewayDb; crypto: CredentialCrypto; log?: { warn: (o: any, m?: string) => void }; opts?: SenderOptions }) {
  const { db, crypto } = deps; const o = deps.opts ?? {};
  const rnd = () => (o.random ?? Math.random)();

  async function claim(limit: number): Promise<Claimed[]> {
    return db.tx({ platform: true }, async (c) => (await c.query(
      `WITH c AS (SELECT id FROM alert_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE alert_deliveries d SET locked_until = now() + make_interval(secs => $2) FROM c WHERE d.id = c.id
       RETURNING d.id, d.tenant_id, d.channel_id, d.rule_code, d.payload, d.attempts`, [limit, o.claimSeconds ?? Math.ceil(config.ALERTS_TIMEOUT_MS / 1000) + 30]))
      .rows.map((x: any) => ({ id: x.id, tenantId: x.tenant_id, channelId: x.channel_id, ruleCode: x.rule_code, payload: x.payload, attempts: x.attempts })));
  }

  async function record(d: Claimed, r: PostResult | { dead: string }) {
    const attemptNo = d.attempts + 1;
    const res: PostResult = 'dead' in r ? { durationMs: 0, errorCode: r.dead } : r;
    const synthetic = 'dead' in r; // DEAD semu (kanal hilang/nonaktif/dibatasi): tidak dihitung ke breaker
    const ok = !synthetic && res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
    const sc = res.statusCode;
    const permanent = synthetic || res.errorCode === 'BLOCKED_TARGET' || res.errorCode === 'INVALID_URL' || res.errorCode === 'SECRET_UNAVAILABLE' || (sc !== undefined && [400, 401, 403, 404].includes(sc));
    const outcome = ok ? 'SENT' : permanent || attemptNo >= config.ALERTS_MAX_ATTEMPTS ? 'DEAD' : 'RETRY';
    const errorCode = ok ? null : res.errorCode ?? (sc ? `HTTP_${sc}` : 'ERROR');
    const exp = config.ALERTS_RETRY_BASE_MS * 2 ** (attemptNo - 1);
    const delayMs = Math.round(exp / 2 + rnd() * (exp / 2));
    await db.tx({ platform: true }, async (c) => {
      const u = await c.query(
        `UPDATE alert_deliveries SET attempts = $2::int, status = $3::varchar, locked_until = NULL,
           next_attempt_at = CASE WHEN $3::varchar = 'PENDING' THEN now() + make_interval(secs => $4::int / 1000.0) ELSE next_attempt_at END,
           last_status_code = $5::int, last_error_code = $6::varchar, sent_at = CASE WHEN $3::varchar = 'SENT' THEN now() ELSE sent_at END
         WHERE id = $1::uuid AND status = 'PENDING' AND attempts = $7::int`,
        [d.id, attemptNo, outcome === 'RETRY' ? 'PENDING' : outcome, delayMs, sc ?? null, errorCode, d.attempts]);
      if (u.rowCount !== 1) return;
      if (outcome === 'SENT') { await c.query('UPDATE alert_channels SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [d.channelId]); return; }
      if (outcome === 'DEAD' && !synthetic) {
        const th = config.ALERTS_AUTO_DISABLE_AFTER;
        const dis = await c.query(
          `UPDATE alert_channels SET consecutive_failures = consecutive_failures + 1,
             active = (active AND NOT ($2::int > 0 AND consecutive_failures + 1 >= $2::int)),
             disabled_at = CASE WHEN active AND $2::int > 0 AND consecutive_failures + 1 >= $2::int THEN now() ELSE disabled_at END,
             disabled_reason = CASE WHEN active AND $2::int > 0 AND consecutive_failures + 1 >= $2::int THEN 'AUTO_CONSECUTIVE_FAILURES' ELSE disabled_reason END
           WHERE id = $1 AND tenant_id = $3 RETURNING active, disabled_at > now() - interval '5 seconds' AS just_disabled`, [d.channelId, th, d.tenantId]);
        if (dis.rows[0] && dis.rows[0].active === false && dis.rows[0].just_disabled) {
          deps.log?.warn({ channelId: d.channelId, tenantId: d.tenantId, after: th }, 'kanal alarm dinonaktifkan otomatis: gagal berturut-turut');
          await db.tx({ tenantId: d.tenantId }, (cc) => cc.query(
            `INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id, details) VALUES ($1, NULL, 'alert_channel.disabled', 'alert_channel', $2, $3::jsonb)`,
            [d.tenantId, d.channelId, JSON.stringify({ reason: 'AUTO_CONSECUTIVE_FAILURES', after: th })])).catch(() => {});
        }
      }
    });
  }

  async function deliverOne(d: Claimed, ch: { type: ChannelType; target_ciphertext: Buffer; active: boolean } | undefined) {
    if (!ch) return record(d, { dead: 'CHANNEL_GONE' });
    if (!ch.active) return record(d, { dead: 'CHANNEL_INACTIVE' });
    const sent = (await db.tx({ platform: true }, (c) => c.query(
      `SELECT count(*)::int n FROM alert_deliveries WHERE channel_id = $1 AND status = 'SENT' AND sent_at > now() - interval '1 hour'`, [d.channelId]))).rows[0].n;
    if (sent >= config.ALERTS_MAX_PER_CHANNEL_PER_HOUR) return record(d, { dead: 'RATE_CAPPED' });
    const r = await sendToChannel({ type: ch.type, cipher: ch.target_ciphertext, tenantId: d.tenantId, channelId: d.channelId, ruleCode: d.ruleCode, facts: d.payload, crypto, post: o.post });
    return record(d, r);
  }

  return {
    async runOnce(limit = 20): Promise<number> {
      const batch = await claim(limit);
      if (!batch.length) return 0;
      const chs = await db.tx({ platform: true }, async (c) => (await c.query('SELECT id, type, target_ciphertext, active FROM alert_channels WHERE id = ANY($1::uuid[])', [[...new Set(batch.map((b) => b.channelId))]])).rows);
      const by = new Map(chs.map((x: any) => [x.id, x]));
      // Per kanal BERURUTAN (batas kirim per jam harus melihat pengiriman sebelumnya di batch yang sama); antar kanal paralel.
      const groups = new Map<string, Claimed[]>();
      for (const d of batch) groups.set(d.channelId, [...(groups.get(d.channelId) ?? []), d]);
      await Promise.all([...groups.values()].map(async (g) => {
        for (const d of g) await deliverOne(d, by.get(d.channelId) as any).catch((err) => deps.log?.warn({ err: String(err?.message ?? err), deliveryId: d.id }, 'gagal mencatat hasil alarm'));
      }));
      return batch.length;
    },
  };
}
export type AlertSender = ReturnType<typeof createAlertSender>;
