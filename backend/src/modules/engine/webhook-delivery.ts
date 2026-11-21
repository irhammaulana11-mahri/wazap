import http from 'node:http';
import https from 'node:https';
import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { config } from '../../config/env.js';
import { BlockedTargetError, createSafeLookup, parseWebhookUrl, type Resolver, type UrlPolicy } from '../../security/ssrf.js';
import { signWebhook, webhookSecretAad } from '../../security/webhook-signature.js';

export interface PostResult {
  statusCode?: number;
  /** Kode galat tersanitasi (tanpa pesan mentah dari jaringan/peer). */
  errorCode?: string;
  durationMs: number;
}

/**
 * POST JSON dengan: timeout total, lookup anti-SSRF, TANPA mengikuti redirect (3xx dianggap gagal), dan body respons
 * dibuang (maks 64 KB dibaca lalu koneksi ditutup). Tidak pernah membuang exception: hasil selalu PostResult.
 */
export function postJson(rawUrl: string, headers: Record<string, string>, body: string, o: { timeoutMs: number; policy: UrlPolicy; resolve?: Resolver }): Promise<PostResult> {
  const t0 = Date.now();
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const done = (r: Omit<PostResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve({ ...r, durationMs: Date.now() - t0 });
    };
    let u: URL;
    try { u = parseWebhookUrl(rawUrl, o.policy); } catch (e) { done({ errorCode: e instanceof BlockedTargetError ? e.code : 'INVALID_URL' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'user-agent': 'WAZAP-Webhook/1.0' },
      lookup: createSafeLookup(o.policy, o.resolve) as any,
      agent: false,
      // Batas bawaan Node 250 ms per alamat membatalkan sambungan IPv4 yang sehat tetapi jauh (RTT > 250 ms), lalu beralih ke IPv6 yang
      // di banyak host tidak terjangkau: hasilnya CONNECTION_FAILED acak. Tenggat keseluruhan tetap dijaga oleh `deadline` di bawah.
      ...({ autoSelectFamilyAttemptTimeout: Math.max(1000, Math.min(o.timeoutMs, 5000)) } as object), // opsi net.connect; belum ada di tipe RequestOptions
    }, (res) => {
      let read = 0;
      res.on('data', (b: Buffer) => { read += b.length; if (read > 65_536) res.destroy(); });
      res.on('error', () => {});
      res.on('end', () => done({ statusCode: res.statusCode }));
      res.on('close', () => done({ statusCode: res.statusCode }));
    });
    deadline = setTimeout(() => { done({ errorCode: 'TIMEOUT' }); req.destroy(); }, o.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => {
      const cause = err as Error & { code?: string };
      if (err instanceof BlockedTargetError) return done({ errorCode: err.code });
      const code = cause.code ?? '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return done({ errorCode: 'DNS_FAILED' });
      if (/^(ERR_TLS|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|ERR_SSL|HOSTNAME_MISMATCH)/.test(code)) return done({ errorCode: 'TLS_ERROR' });
      done({ errorCode: 'CONNECTION_FAILED' });
    });
    req.end(body);
  });
}

export interface DelivererOptions {
  timeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
  policy?: UrlPolicy;
  resolve?: Resolver;
  /** Nonaktifkan endpoint setelah N delivery DEAD berturut-turut (default env; 0 = mati). */
  autoDisableAfter?: number;
  /** Lama klaim: delivery yang macet (proses mati) dicoba lagi setelah ini. */
  claimSeconds?: number;
}

interface Claimed { id: string; tenantId: string; endpointId: string; eventId: string; eventType: string; payload: unknown; attempts: number; maxAttempts: number }

/**
 * Pengirim webhook (konteks platform). Klaim batch (visibility timeout, aman multi-instans), kirim di luar transaksi DB,
 * lalu catat hasil. Retry eksponensial + jitter; setelah batas percobaan => DEAD (dapat di-replay manual).
 * Semantik at-least-once: penerima WAJIB dedup berdasarkan event_id.
 */
export function createWebhookDeliverer(deps: { db: GatewayDb; crypto: CredentialCrypto; log?: { warn: (o: any, m?: string) => void }; opts?: DelivererOptions }) {
  const { db, crypto } = deps;
  const o = deps.opts ?? {};
  const timeoutMs = () => o.timeoutMs ?? config.WEBHOOK_TIMEOUT_MS;
  const base = () => o.retryBaseMs ?? config.WEBHOOK_RETRY_BASE_MS;
  const cap = () => o.retryMaxMs ?? config.WEBHOOK_RETRY_MAX_MS;
  const rnd = () => (o.random ?? Math.random)();
  const policy = (): UrlPolicy => o.policy ?? { allowHttp: config.WEBHOOK_ALLOW_HTTP === 'true', allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true' };

  const breakerAt = () => o.autoDisableAfter ?? config.WEBHOOK_AUTO_DISABLE_AFTER;

  async function claim(limit: number): Promise<Claimed[]> {
    return db.tx({ platform: true }, async (c) => {
      const r = await c.query(
        `WITH c AS (
           SELECT id FROM webhook_deliveries
           WHERE status = 'PENDING' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
             AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = webhook_deliveries.tenant_id AND t.status = 'ACTIVE')   -- workspace ditangguhkan: pengiriman ditahan (tidak dibuang), lanjut saat diaktifkan (ADR-054)
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         UPDATE webhook_deliveries d SET locked_until = now() + make_interval(secs => $2) FROM c WHERE d.id = c.id
         RETURNING d.id, d.tenant_id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts, d.max_attempts`,
        [limit, o.claimSeconds ?? Math.ceil(timeoutMs() / 1000) + 30]
      );
      return r.rows.map((x) => ({ id: x.id, tenantId: x.tenant_id, endpointId: x.endpoint_id, eventId: x.event_id, eventType: x.event_type, payload: x.payload, attempts: x.attempts, maxAttempts: x.max_attempts }));
    });
  }

  async function record(d: Claimed, r: PostResult | { dead: string }) {
    const attemptNo = d.attempts + 1;
    const res = 'dead' in r ? { durationMs: 0, errorCode: r.dead } as PostResult : r;
    const ok = !('dead' in r) && res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
    const permanent = 'dead' in r || res.errorCode === 'BLOCKED_TARGET' || res.errorCode === 'INVALID_URL';
    const exhausted = attemptNo >= d.maxAttempts;
    const outcome = ok ? 'DELIVERED' : permanent || exhausted ? 'DEAD' : 'RETRY';
    const errorCode = ok ? null : res.errorCode ?? 'HTTP_ERROR';
    const exp = Math.min(cap(), base() * 2 ** (attemptNo - 1));
    const delayMs = Math.round(exp / 2 + rnd() * (exp / 2));
    await db.tx({ platform: true }, async (c) => {
      const u = await c.query(
        `UPDATE webhook_deliveries SET attempts = $2::int, status = $3::varchar, locked_until = NULL,
           next_attempt_at = CASE WHEN $3::varchar = 'PENDING' THEN now() + make_interval(secs => $4::int / 1000.0) ELSE next_attempt_at END,
           last_status_code = $5::int, last_error_code = $6::varchar, last_duration_ms = $7::int,
           delivered_at = CASE WHEN $3::varchar = 'DELIVERED' THEN now() ELSE delivered_at END
         WHERE id = $1::uuid AND status = 'PENDING' AND attempts = $8::int`,
        [d.id, attemptNo, outcome === 'RETRY' ? 'PENDING' : outcome, delayMs, res.statusCode ?? null, errorCode, res.durationMs, d.attempts]
      );
      if (u.rowCount !== 1) return; // diubah pihak lain (mis. replay/hapus endpoint): jangan menimpa
      await c.query(
        `INSERT INTO webhook_delivery_attempts (tenant_id, delivery_id, attempt_number, duration_ms, status_code, error_code, outcome)
         VALUES ($1::uuid,$2::uuid,$3::int,$4::int,$5::int,$6::varchar,$7::varchar)`,
        [d.tenantId, d.id, attemptNo, res.durationMs, res.statusCode ?? null, errorCode, outcome]
      );
      // Circuit breaker: hitung hanya delivery yang benar-benar gagal total (DEAD dari percobaan nyata). Percobaan
      // RETRY, DEAD semu (endpoint nonaktif/terhapus) dan uji manual (webhook.test) tidak dihitung.
      if (outcome === 'DELIVERED') {
        await c.query('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [d.endpointId]);
      } else if (outcome === 'DEAD' && !('dead' in r) && d.eventType !== 'webhook.test') {
        const th = breakerAt();
        const u = await c.query(
          `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
             active = (active AND NOT ($2::int > 0 AND consecutive_failures + 1 >= $2::int)),
             disabled_at = CASE WHEN active AND $2::int > 0 AND consecutive_failures + 1 >= $2::int THEN now() ELSE disabled_at END,
             disabled_reason = CASE WHEN active AND $2::int > 0 AND consecutive_failures + 1 >= $2::int THEN 'AUTO_CONSECUTIVE_FAILURES' ELSE disabled_reason END
           WHERE id = $1 AND tenant_id = $3 RETURNING active`, [d.endpointId, th, d.tenantId]);
        if (u.rows[0] && u.rows[0].active === false && th > 0) deps.log?.warn({ endpointId: d.endpointId, tenantId: d.tenantId, after: th }, 'webhook dinonaktifkan otomatis: gagal berturut-turut');
      }
    });
  }

  async function deliverOne(d: Claimed, ep: { url: string; secret_ciphertext: Buffer; active: boolean } | undefined) {
    if (!ep) return record(d, { dead: 'ENDPOINT_GONE' });
    if (!ep.active) return record(d, { dead: 'ENDPOINT_INACTIVE' });
    let secret: string;
    try { secret = crypto.decrypt(ep.secret_ciphertext, webhookSecretAad(d.tenantId, d.endpointId)).toString('utf8'); }
    catch { return record(d, { dead: 'SECRET_UNAVAILABLE' }); }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    const result = await postJson(ep.url, {
      'x-wazap-event-id': d.eventId, 'x-wazap-event': d.eventType, 'x-wazap-delivery-id': d.id,
      'x-wazap-timestamp': String(ts), 'x-wazap-signature': signWebhook(secret, ts, body),
    }, body, { timeoutMs: timeoutMs(), policy: policy(), resolve: o.resolve });
    return record(d, result);
  }

  return {
    /** Satu putaran: klaim lalu kirim paralel. Mengembalikan jumlah delivery yang diproses. */
    async runOnce(limit = config.WEBHOOK_BATCH): Promise<number> {
      const batch = await claim(limit);
      if (!batch.length) return 0;
      const eps = await db.tx({ platform: true }, async (c) =>
        (await c.query('SELECT id, url, secret_ciphertext, active FROM webhook_endpoints WHERE id = ANY($1::uuid[])', [[...new Set(batch.map((b) => b.endpointId))]])).rows
      );
      const byId = new Map(eps.map((e: any) => [e.id, e]));
      await Promise.all(batch.map((d) => deliverOne(d, byId.get(d.endpointId)).catch((err) => deps.log?.warn({ err, deliveryId: d.id }, 'gagal mencatat hasil webhook'))));
      return batch.length;
    },
  };
}
export type WebhookDeliverer = ReturnType<typeof createWebhookDeliverer>;
