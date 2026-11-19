import crypto from 'node:crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { assertPublicHost, BlockedTargetError, parseWebhookUrl, type Resolver, type UrlPolicy } from '../../security/ssrf.js';
import { newWebhookSecret, webhookSecretAad } from '../../security/webhook-signature.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WEBHOOK_EVENTS = [
  '*', 'session.status', 'message.sent', 'message.delivered', 'message.read', 'message.failed', 'message.unknown', 'message.cancelled', 'message.incoming',
] as const;

const COLS = 'id, url, description, events, secret_hint, active, consecutive_failures, disabled_at, disabled_reason, created_at, updated_at';
const view = (r: any) => ({ id: r.id, url: r.url, description: r.description, events: r.events, secret_hint: r.secret_hint, active: r.active, consecutive_failures: r.consecutive_failures, disabled_at: r.disabled_at, disabled_reason: r.disabled_reason, created_at: r.created_at, updated_at: r.updated_at });
const dview = (r: any) => ({
  id: r.id, endpoint_id: r.endpoint_id, event_id: r.event_id, event: r.event_type, status: r.status, attempts: r.attempts, max_attempts: r.max_attempts,
  next_attempt_at: r.status === 'PENDING' ? r.next_attempt_at : null, last_status_code: r.last_status_code, last_error_code: r.last_error_code,
  last_duration_ms: r.last_duration_ms, delivered_at: r.delivered_at, created_at: r.created_at,
});
const notFound = () => new AppError('NOT_FOUND', 404, 'Webhook tidak ditemukan');
const normEvents = (ev: string[]) => { const s = [...new Set(ev)]; return s.includes('*') ? ['*'] : s; };

export interface WebhookServiceOpts {
  crypto?: CredentialCrypto;
  policy?: UrlPolicy;
  resolve?: Resolver;
}

/** Layanan webhook jalur tenant. Secret hanya muncul SEKALI (create/rotate) dan disimpan terenkripsi (AAD terikat tenant+endpoint). */
export function createWebhookService(db: GatewayDb, opts: WebhookServiceOpts = {}) {
  const policy = (): UrlPolicy => opts.policy ?? { allowHttp: config.WEBHOOK_ALLOW_HTTP === 'true', allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true' };
  const needCrypto = () => {
    if (!opts.crypto) throw new AppError('NOT_CONFIGURED', 503, 'Enkripsi kredensial belum dikonfigurasi');
    return opts.crypto;
  };
  async function checkUrl(url: string) {
    try {
      const u = parseWebhookUrl(url, policy());
      await assertPublicHost(u.hostname, policy(), opts.resolve);
      return u.toString();
    } catch (e) {
      if (e instanceof BlockedTargetError) throw new AppError('INVALID_WEBHOOK_URL', 422, e.message);
      throw e;
    }
  }
  async function load(c: pg.PoolClient, tenantId: string, id: string, lock = false) {
    if (!UUID_RE.test(id)) throw notFound();
    const r = (await c.query(`SELECT ${COLS} FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, tenantId])).rows[0];
    if (!r) throw notFound();
    return r;
  }
  const seal = (secret: string, tenantId: string, id: string) => needCrypto().encrypt(Buffer.from(secret), webhookSecretAad(tenantId, id));

  return {
    async create(tenantId: string, i: { url: string; description?: string; events: string[] }) {
      needCrypto();
      const url = await checkUrl(i.url);
      const id = crypto.randomUUID();
      const secret = newWebhookSecret();
      const { blob, keyVersion } = seal(secret, tenantId, id);
      return db.tx({ tenantId }, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:webhooks:' + tenantId]);
        const n = (await c.query('SELECT count(*)::int n FROM webhook_endpoints WHERE tenant_id = $1', [tenantId])).rows[0].n;
        if (n >= config.WEBHOOK_MAX_ENDPOINTS) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah webhook tercapai');
        const row = (
          await c.query(
            `INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_ciphertext, secret_key_version, secret_hint)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
            [id, tenantId, url, i.description ?? null, normEvents(i.events), blob, keyVersion, secret.slice(-4)]
          )
        ).rows[0];
        return { ...view(row), secret };
      });
    },

    async list(tenantId: string, q: { page: number; pageSize: number }) {
      return db.tx({ tenantId }, async (c) => {
        const total = (await c.query('SELECT count(*)::int n FROM webhook_endpoints WHERE tenant_id = $1', [tenantId])).rows[0].n;
        const rows = (await c.query(`SELECT ${COLS} FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [tenantId, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(view), total };
      });
    },

    async update(tenantId: string, id: string, p: { url?: string; description?: string | null; events?: string[]; active?: boolean }) {
      const url = p.url === undefined ? undefined : await checkUrl(p.url);
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id, true);
        const row = (
          await c.query(
            `UPDATE webhook_endpoints SET url = COALESCE($3, url),
               description = CASE WHEN $4::boolean THEN $5 ELSE description END,
               events = COALESCE($6::text[], events), active = COALESCE($7, active),
               consecutive_failures = CASE WHEN $7::boolean IS TRUE THEN 0 ELSE consecutive_failures END,
               disabled_at = CASE WHEN $7::boolean IS TRUE THEN NULL ELSE disabled_at END,
               disabled_reason = CASE WHEN $7::boolean IS TRUE THEN NULL ELSE disabled_reason END
             WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`,
            [id, tenantId, url ?? null, p.description !== undefined, p.description ?? null, p.events ? normEvents(p.events) : null, p.active ?? null]
          )
        ).rows[0];
        return view(row);
      });
    },

    async remove(tenantId: string, id: string) {
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id, true);
        await c.query('DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        return { id, deleted: true };
      });
    },

    /** Rotasi: secret lama LANGSUNG tidak berlaku; yang baru ditampilkan sekali. */
    async rotateSecret(tenantId: string, id: string) {
      needCrypto();
      const secret = newWebhookSecret();
      const { blob, keyVersion } = seal(secret, tenantId, id);
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id, true);
        const row = (
          await c.query(
            `UPDATE webhook_endpoints SET secret_ciphertext = $3, secret_key_version = $4, secret_hint = $5 WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`,
            [id, tenantId, blob, keyVersion, secret.slice(-4)]
          )
        ).rows[0];
        return { ...view(row), secret };
      });
    },

    /** Kirim event uji `webhook.test` (melewati filter langganan) untuk memverifikasi URL dan tanda tangan. */
    async test(tenantId: string, id: string) {
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id, true);
        const eventId = crypto.randomUUID();
        const envelope = { event_id: eventId, event: 'webhook.test', occurred_at: new Date().toISOString(), data: { message: 'Uji koneksi webhook WAZAP' } };
        const d = (
          await c.query(
            `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, max_attempts)
             VALUES ($1,$2,$3,'webhook.test',$4::jsonb,1) RETURNING *`, [tenantId, id, eventId, JSON.stringify(envelope)])
        ).rows[0];
        return dview(d);
      });
    },

    async deliveries(tenantId: string, id: string, q: { page: number; pageSize: number; status?: string }) {
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id);
        const where = `endpoint_id = $1 AND tenant_id = $2 AND ($3::text IS NULL OR status = $3)`;
        const args = [id, tenantId, q.status ?? null];
        const total = (await c.query(`SELECT count(*)::int n FROM webhook_deliveries WHERE ${where}`, args)).rows[0].n;
        const rows = (await c.query(`SELECT * FROM webhook_deliveries WHERE ${where} ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`, [...args, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(dview), total };
      });
    },

    async delivery(tenantId: string, id: string, deliveryId: string) {
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id);
        if (!UUID_RE.test(deliveryId)) throw notFound();
        const d = (await c.query('SELECT * FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2 AND tenant_id = $3', [deliveryId, id, tenantId])).rows[0];
        if (!d) throw notFound();
        const attempts = (
          await c.query(
            `SELECT attempt_number, started_at, duration_ms, status_code, error_code, outcome FROM webhook_delivery_attempts
             WHERE delivery_id = $1 AND tenant_id = $2 ORDER BY attempt_number`, [deliveryId, tenantId])
        ).rows;
        return { ...dview(d), attempt_history: attempts };
      });
    },

    /** Replay manual: hanya delivery DEAD (atau DELIVERED bila klien ingin menerima ulang). Anggaran percobaan baru. */
    async replay(tenantId: string, id: string, deliveryId: string) {
      return db.tx({ tenantId }, async (c) => {
        const ep = await load(c, tenantId, id);
        if (!UUID_RE.test(deliveryId)) throw notFound();
        const d = (await c.query('SELECT status FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2 AND tenant_id = $3 FOR UPDATE', [deliveryId, id, tenantId])).rows[0];
        if (!d) throw notFound();
        if (d.status === 'PENDING') throw new AppError('INVALID_STATE', 409, 'Delivery masih dalam antrean');
        if (!ep.active) throw new AppError('INVALID_STATE', 409, 'Webhook tidak aktif');
        const row = (
          await c.query(
            `UPDATE webhook_deliveries SET status = 'PENDING', max_attempts = attempts + $3, next_attempt_at = now(), locked_until = NULL, delivered_at = NULL
             WHERE id = $1 AND tenant_id = $2 RETURNING *`, [deliveryId, tenantId, config.WEBHOOK_MAX_ATTEMPTS])
        ).rows[0];
        return dview(row);
      });
    },
  };
}
export type WebhookService = ReturnType<typeof createWebhookService>;
