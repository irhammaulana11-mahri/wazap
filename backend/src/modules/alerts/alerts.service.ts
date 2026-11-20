import crypto from 'node:crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { alertTargetAad, hintOf, InvalidTargetError, validateSlackUrl, validateTelegram, type ChannelType, type TelegramTarget } from '../../security/alert-target.js';
import type { Resolver, UrlPolicy } from '../../security/ssrf.js';
import { recordAudit } from '../audit/audit.js';
import type { Role } from '../identity/principal.js';
import { DEFAULT_COOLDOWN_MINUTES, RULE_BY_CODE, RULES } from './rules.js';
import { sendToChannel, type Poster, type SendResult } from '../engine/alert-sender.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface AlertActor { userId: string; tenantId: string; role?: Role | null; email?: string | null; ip?: string; requestId?: string }
export type ChannelInput = { type: 'TELEGRAM'; name: string; token: string; chat_id: string } | { type: 'SLACK'; name: string; url: string };

const COLS = 'id, type, name, target_hint, active, consecutive_failures, disabled_at, disabled_reason, created_by, created_at, updated_at';
const cview = (r: any) => ({ id: r.id, type: r.type, name: r.name, target_hint: r.target_hint, active: r.active, consecutive_failures: r.consecutive_failures, disabled_at: r.disabled_at, disabled_reason: r.disabled_reason, created_at: r.created_at, updated_at: r.updated_at });
const notFound = () => new AppError('NOT_FOUND', 404, 'Kanal tidak ditemukan');

export interface AlertServiceOpts { crypto?: CredentialCrypto; policy?: UrlPolicy; resolve?: Resolver; post?: Poster; enabled?: boolean }

/** Layanan kanal dan aturan alarm jalur tenant (ADR-049). Target (token/URL) hanya terenkripsi; tidak pernah dikembalikan. */
export function createAlertService(db: GatewayDb, o: AlertServiceOpts = {}) {
  const enabled = () => o.enabled ?? config.ALERTS_ENABLED === 'true';
  const policy = (): UrlPolicy => o.policy ?? { allowHttp: false, allowPrivate: false };
  const needCrypto = () => { if (!o.crypto) throw new AppError('NOT_CONFIGURED', 503, 'Enkripsi kredensial belum dikonfigurasi'); return o.crypto; };
  const needEnabled = () => { if (!enabled()) throw new AppError('NOT_CONFIGURED', 503, 'Notifikasi alarm dinonaktifkan oleh operator'); };

  async function validate(i: ChannelInput): Promise<{ secret: string; hint: string }> {
    try {
      if (i.type === 'TELEGRAM') { const t = validateTelegram(i); return { secret: JSON.stringify(t), hint: hintOf(t.token) }; }
      const url = await validateSlackUrl(i.url, policy(), o.resolve);
      return { secret: url, hint: hintOf(url.replace(/\/+$/, '')) };
    } catch (e) { if (e instanceof InvalidTargetError) throw new AppError('INVALID_ALERT_TARGET', 422, e.message); throw e; }
  }
  const seal = (secret: string, tenantId: string, id: string) => needCrypto().encrypt(Buffer.from(secret), alertTargetAad(tenantId, id));
  async function load(c: pg.PoolClient, tenantId: string, id: string, lock = false) {
    if (!UUID_RE.test(id)) throw notFound();
    const r = (await c.query(`SELECT ${COLS} FROM alert_channels WHERE id = $1 AND tenant_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, tenantId])).rows[0];
    if (!r) throw notFound();
    return r;
  }
  const audit = (c: pg.PoolClient, a: AlertActor, action: 'alert_channel.created' | 'alert_channel.updated' | 'alert_channel.deleted' | 'alert_rule.updated', targetType: 'alert_channel' | 'alert_rule', targetId: string, details: Record<string, unknown>) =>
    recordAudit(c, { tenantId: a.tenantId, actor: { userId: a.userId, email: a.email ?? null, role: a.role ?? null }, action, targetType, targetId, details, ip: a.ip, requestId: a.requestId });

  async function rulesOf(c: pg.PoolClient, tenantId: string) {
    const stored = (await c.query('SELECT rule_code, enabled, threshold, cooldown_minutes, channel_ids, updated_at FROM alert_rules WHERE tenant_id = $1', [tenantId])).rows;
    const by = new Map(stored.map((r: any) => [r.rule_code, r]));
    return RULES.map((d) => {
      const s: any = by.get(d.code);
      return { code: d.code, enabled: s?.enabled ?? false, threshold: d.threshold ? (s?.threshold ?? d.threshold.default) : null, cooldown_minutes: s?.cooldown_minutes ?? DEFAULT_COOLDOWN_MINUTES, channel_ids: s?.channel_ids ?? [], updated_at: s?.updated_at ?? null };
    });
  }

  return {
    enabled,
    /** Info untuk UI: daftar aturan (tetap di kode), batas, dan status fitur. */
    catalog() {
      return {
        enabled: enabled(), max_channels: config.ALERTS_MAX_CHANNELS, channel_types: ['TELEGRAM', 'SLACK'], cooldown: { default: DEFAULT_COOLDOWN_MINUTES, min: 5, max: 1440 },
        rules: RULES.map((r) => ({ code: r.code, label: r.label, description: r.description, threshold: r.threshold, repeats: r.repeats })),
      };
    },

    async listChannels(tenantId: string) {
      return db.tx({ tenantId }, async (c) => (await c.query(`SELECT ${COLS} FROM alert_channels WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId])).rows.map(cview));
    },

    async createChannel(a: AlertActor, i: ChannelInput) {
      needEnabled(); needCrypto();
      const { secret, hint } = await validate(i);
      const id = crypto.randomUUID();
      const { blob, keyVersion } = seal(secret, a.tenantId, id);
      return db.tx({ tenantId: a.tenantId, userId: a.userId }, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:alerts:' + a.tenantId]);
        const n = (await c.query('SELECT count(*)::int n FROM alert_channels WHERE tenant_id = $1', [a.tenantId])).rows[0].n;
        if (n >= config.ALERTS_MAX_CHANNELS) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah kanal tercapai');
        const row = (await c.query(
          `INSERT INTO alert_channels (id, tenant_id, type, name, target_ciphertext, target_key_version, target_hint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
          [id, a.tenantId, i.type, i.name.trim(), blob, keyVersion, hint, a.userId])).rows[0];
        await audit(c, a, 'alert_channel.created', 'alert_channel', id, { type: i.type, name: i.name.trim() });
        return cview(row);
      });
    },

    async updateChannel(a: AlertActor, id: string, p: { name?: string; active?: boolean; target?: ChannelInput }) {
      needEnabled();
      let sealed: { blob: Buffer; keyVersion: number; hint: string } | undefined;
      if (p.target) {
        needCrypto();
        const cur = await db.tx({ tenantId: a.tenantId }, (c) => load(c, a.tenantId, id));
        if (p.target.type !== cur.type) throw new AppError('VALIDATION_ERROR', 400, 'Tipe kanal tidak dapat diubah; buat kanal baru');
        const { secret, hint } = await validate(p.target);
        sealed = { ...seal(secret, a.tenantId, id), hint };
      }
      return db.tx({ tenantId: a.tenantId, userId: a.userId }, async (c) => {
        await load(c, a.tenantId, id, true);
        const row = (await c.query(
          `UPDATE alert_channels SET name = COALESCE($3, name), active = COALESCE($4, active),
             target_ciphertext = COALESCE($5, target_ciphertext), target_key_version = COALESCE($6, target_key_version), target_hint = COALESCE($7, target_hint),
             consecutive_failures = CASE WHEN $4::boolean IS TRUE OR $5::bytea IS NOT NULL THEN 0 ELSE consecutive_failures END,
             disabled_at = CASE WHEN $4::boolean IS TRUE OR $5::bytea IS NOT NULL THEN NULL ELSE disabled_at END,
             disabled_reason = CASE WHEN $4::boolean IS TRUE OR $5::bytea IS NOT NULL THEN NULL ELSE disabled_reason END
           WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`,
          [id, a.tenantId, p.name?.trim() ?? null, p.active ?? null, sealed?.blob ?? null, sealed?.keyVersion ?? null, sealed?.hint ?? null])).rows[0];
        await audit(c, a, 'alert_channel.updated', 'alert_channel', id, { name: p.name !== undefined, active: p.active, target_changed: !!p.target });
        return cview(row);
      });
    },

    async deleteChannel(a: AlertActor, id: string) {
      return db.tx({ tenantId: a.tenantId, userId: a.userId }, async (c) => {
        await load(c, a.tenantId, id, true);
        await c.query('DELETE FROM alert_channels WHERE id = $1 AND tenant_id = $2', [id, a.tenantId]);
        // Bersihkan rujukan pada aturan agar tidak menggantung.
        await c.query('UPDATE alert_rules SET channel_ids = array_remove(channel_ids, $2::uuid) WHERE tenant_id = $1', [a.tenantId, id]);
        await audit(c, a, 'alert_channel.deleted', 'alert_channel', id, {});
        return { id, deleted: true };
      });
    },

    /** Kirim pesan uji SINKRON dan kembalikan hasilnya apa adanya (tanpa mengantre). */
    async testChannel(tenantId: string, id: string): Promise<SendResult & { ok: boolean }> {
      needEnabled(); const cr = needCrypto();
      const r = await db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id);
        return (await c.query('SELECT type, target_ciphertext FROM alert_channels WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
      });
      const res = await sendToChannel({ type: r.type as ChannelType, cipher: r.target_ciphertext, tenantId, channelId: id, ruleCode: 'channel.test', facts: {}, crypto: cr, post: o.post });
      return { ...res, ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300 };
    },

    async listRules(tenantId: string) { return db.tx({ tenantId }, (c) => rulesOf(c, tenantId)); },

    async putRule(a: AlertActor, code: string, p: { enabled: boolean; threshold?: number; cooldown_minutes?: number; channel_ids: string[] }) {
      needEnabled();
      const def = RULE_BY_CODE.get(code);
      if (!def) throw new AppError('NOT_FOUND', 404, 'Aturan tidak dikenal');
      if (p.threshold !== undefined) {
        if (!def.threshold) throw new AppError('VALIDATION_ERROR', 400, 'Aturan ini tidak memiliki ambang');
        if (p.threshold < def.threshold.min || p.threshold > def.threshold.max) throw new AppError('VALIDATION_ERROR', 400, `Ambang harus ${def.threshold.min}-${def.threshold.max} ${def.threshold.unit}`);
      }
      if (p.cooldown_minutes !== undefined && !def.repeats) throw new AppError('VALIDATION_ERROR', 400, 'Aturan ini tidak memakai jeda ulang');
      const ids = [...new Set(p.channel_ids)];
      if (p.enabled && ids.length === 0) throw new AppError('VALIDATION_ERROR', 400, 'Pilih minimal satu kanal untuk mengaktifkan aturan');
      return db.tx({ tenantId: a.tenantId, userId: a.userId }, async (c) => {
        if (ids.length) {
          const found = (await c.query('SELECT count(*)::int n FROM alert_channels WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [a.tenantId, ids])).rows[0].n;
          if (found !== ids.length) throw new AppError('VALIDATION_ERROR', 400, 'Ada kanal yang tidak ditemukan');
        }
        await c.query(
          `INSERT INTO alert_rules (tenant_id, rule_code, enabled, threshold, cooldown_minutes, channel_ids, updated_by) VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7)
           ON CONFLICT (tenant_id, rule_code) DO UPDATE SET enabled = EXCLUDED.enabled, threshold = EXCLUDED.threshold, cooldown_minutes = EXCLUDED.cooldown_minutes,
             channel_ids = EXCLUDED.channel_ids, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [a.tenantId, code, p.enabled, def.threshold ? (p.threshold ?? def.threshold.default) : null, p.cooldown_minutes ?? DEFAULT_COOLDOWN_MINUTES, ids, a.userId]);
        await audit(c, a, 'alert_rule.updated', 'alert_rule', code, { enabled: p.enabled, threshold: p.threshold ?? null, cooldown_minutes: p.cooldown_minutes ?? null, channels: ids.length });
        return (await rulesOf(c, a.tenantId)).find((r) => r.code === code)!;
      });
    },

    async deliveries(tenantId: string, limit: number) {
      return db.tx({ tenantId }, async (c) => (await c.query(
        `SELECT d.id, d.channel_id, ch.name AS channel_name, d.rule_code, d.status, d.attempts, d.last_status_code, d.last_error_code, d.sent_at, d.created_at
         FROM alert_deliveries d JOIN alert_channels ch ON ch.id = d.channel_id AND ch.tenant_id = d.tenant_id
         WHERE d.tenant_id = $1 ORDER BY d.created_at DESC, d.id LIMIT $2`, [tenantId, limit])).rows);
    },
  };
}
export type AlertService = ReturnType<typeof createAlertService>;
export type { TelegramTarget };
