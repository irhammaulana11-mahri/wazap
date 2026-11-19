import crypto from 'crypto';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import type { Principal } from '../identity/principal.js';
import { actorOf } from '../sessions/sessions.service.js';
import { assertPublicHost, BlockedTargetError, parseWebhookUrl, type Resolver, type UrlPolicy } from '../../security/ssrf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sesi yang boleh menerima antrean: sedang/akan tersambung. Lainnya ditolak cepat (409) daripada kedaluwarsa diam-diam. */
const SENDABLE = ['PENDING_ASSIGNMENT', 'INITIALIZING', 'CONNECTING', 'CONNECTED', 'RECONNECTING'];
const COLS = `id, session_id, recipient, message_type, COALESCE(payload->>'text', payload->>'caption') AS text,
  payload->>'url' AS media_url, payload->>'filename' AS media_filename, payload->>'mimetype' AS media_mimetype, status, priority, attempts, max_attempts,
  provider_message_id, last_error_code, scheduled_at, completed_at, content_purged_at, created_at, updated_at`;
const notFound = () => new AppError('NOT_FOUND', 404, 'Pesan tidak ditemukan');

const view = (r: any) => ({
  id: r.id, session_id: r.session_id, to: r.recipient, type: r.message_type, message: r.content_purged_at ? null : r.text,
  media: r.media_url && !r.content_purged_at ? { url: r.media_url, filename: r.media_filename, mimetype: r.media_mimetype } : null, status: r.status,
  priority: r.priority, attempts: r.attempts, max_attempts: r.max_attempts, provider_message_id: r.provider_message_id,
  last_error_code: r.last_error_code, scheduled_at: r.scheduled_at, completed_at: r.completed_at, content_purged: r.content_purged_at != null,
  created_at: r.created_at, updated_at: r.updated_at,
});

export interface SendInput {
  sessionId: string;
  to: string;
  text: string;
  priority: number;
  scheduledAt?: Date;
  idempotencyKey?: string;
}

export interface SendMediaInput {
  sessionId: string;
  to: string;
  type: 'image' | 'video' | 'audio' | 'document';
  url: string;
  caption?: string;
  filename?: string;
  mimetype?: string;
  priority: number;
  scheduledAt?: Date;
  idempotencyKey?: string;
}
export interface BulkInput {
  sessionId: string;
  items: { to: string; text: string }[];
  priority: number;
  scheduledAt?: Date;
  idempotencyKey?: string;
}
export interface MessageServiceOpts {
  /** Kebijakan URL media (default dari env MEDIA_*). */
  mediaPolicy?: UrlPolicy;
  resolve?: Resolver;
  /** Batas hitungan total pada daftar (default env LIST_COUNT_CAP). */
  countCap?: number;
}

/** Layanan pesan jalur tenant. tenantId selalu dari principal; semua query memakai konteks RLS tenant. */
export function createMessageService(db: GatewayDb, svcOpts: MessageServiceOpts = {}) {
  const mediaPolicy = (): UrlPolicy => svcOpts.mediaPolicy ?? { allowHttp: config.MEDIA_ALLOW_HTTP === 'true', allowPrivate: config.MEDIA_ALLOW_PRIVATE_TARGETS === 'true' };
  interface EnqueueArgs { sessionId: string; to: string; type: string; payload: Record<string, string>; priority: number; scheduledAt?: Date; idempotencyKey?: string }
  async function enqueueOne(p: Principal, i: EnqueueArgs, hash: string): Promise<{ job_id: string; status: string; replay: boolean }> {
    const tenantId = p.tenantId;
    return db.tx({ tenantId }, async (c) => {
      const replayOf = async () => {
        const ex = (await c.query('SELECT id, status, request_hash FROM message_queue WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, i.idempotencyKey])).rows[0];
        if (!ex) return null;
        if (ex.request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 422, 'Idempotency-Key sudah dipakai dengan permintaan yang berbeda');
        return { job_id: ex.id as string, status: ex.status as string, replay: true };
      };
      if (i.idempotencyKey) { const r = await replayOf(); if (r) return r; }
      await assertSendable(c, tenantId, i.sessionId);
      await assertQueueRoom(c, tenantId, 1);
      const ins = (
        await c.query(
          `INSERT INTO message_queue (tenant_id, session_id, idempotency_key, request_hash, recipient, message_type, payload, priority, max_attempts, scheduled_at, actor)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, COALESCE($10::timestamptz, now()), $11)
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id, status`,
          [tenantId, i.sessionId, i.idempotencyKey ?? null, i.idempotencyKey ? hash : null, i.to, i.type, JSON.stringify(i.payload),
           i.priority, config.MESSAGE_MAX_ATTEMPTS, i.scheduledAt ?? null, actorOf(p)]
        )
      ).rows[0];
      if (ins) return { job_id: ins.id as string, status: ins.status as string, replay: false };
      const r = await replayOf(); // kalah balapan dengan permintaan yang sama
      if (r) return r;
      throw new AppError('INTERNAL_ERROR', 500, 'Gagal mengantre pesan');
    });
  }

  const bulkHash = (i: BulkInput) => crypto.createHash('sha256').update(JSON.stringify([i.sessionId, i.items.map((x) => [x.to, x.text]), i.priority, i.scheduledAt?.toISOString() ?? null])).digest('hex');

  /** Sesi harus milik tenant dan dalam status yang boleh menerima antrean. */
  async function assertSendable(c: pg.PoolClient, tenantId: string, sessionId: string) {
    if (!UUID_RE.test(sessionId)) throw new AppError('NOT_FOUND', 404, 'Session tidak ditemukan');
    const s = (await c.query(`SELECT status, desired_state FROM wa_sessions WHERE id = $1 AND tenant_id = $2 AND status <> 'DELETED'`, [sessionId, tenantId])).rows[0];
    if (!s) throw new AppError('NOT_FOUND', 404, 'Session tidak ditemukan');
    if (!SENDABLE.includes(s.status) || s.desired_state !== 'CONNECTED') throw new AppError('SESSION_UNAVAILABLE', 409, `Session tidak dapat menerima pesan pada status ${s.status}`);
  }
  async function assertQueueRoom(c: pg.PoolClient, tenantId: string, adding: number) {
    const pending = (await c.query(`SELECT count(*)::int n FROM message_queue WHERE tenant_id = $1 AND status = 'PENDING'`, [tenantId])).rows[0].n;
    if (pending + adding > config.MAX_PENDING_PER_TENANT) throw new AppError('QUEUE_FULL', 429, 'Antrean pesan penuh; coba lagi nanti');
  }

  async function loadOne(c: pg.PoolClient, tenantId: string, id: string, lock = false) {
    if (!UUID_RE.test(id)) throw notFound();
    const r = (await c.query(`SELECT ${COLS} FROM message_queue WHERE id = $1 AND tenant_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, tenantId])).rows[0];
    if (!r) throw notFound();
    return r;
  }

  return {
    /**
     * Antre pesan teks. Idempotensi: kunci sama + payload sama => job yang sama (replay); payload beda => 422.
     * Tidak ada pengiriman di sini: engine pemilik sesi yang mengirim (lane serial per sesi).
     */
    async send(p: Principal, i: SendInput): Promise<{ job_id: string; status: string; replay: boolean }> {
      const hash = crypto.createHash('sha256').update(JSON.stringify([i.sessionId, i.to, 'text', i.text, i.priority, i.scheduledAt?.toISOString() ?? null])).digest('hex');
      return enqueueOne(p, { sessionId: i.sessionId, to: i.to, type: 'text', payload: { text: i.text }, priority: i.priority, scheduledAt: i.scheduledAt, idempotencyKey: i.idempotencyKey }, hash);
    },

    /**
     * Antre pesan media. URL divalidasi (skema, bukan jaringan internal) saat antre; unduhan dilakukan engine saat kirim
     * dengan perlindungan SSRF, batas ukuran, dan validasi tipe. Kegagalan unduh terjadi sebelum kirim (aman).
     */
    async sendMedia(p: Principal, i: SendMediaInput): Promise<{ job_id: string; status: string; replay: boolean }> {
      let url: string;
      try {
        const u = parseWebhookUrl(i.url, mediaPolicy());
        await assertPublicHost(u.hostname, mediaPolicy(), svcOpts.resolve);
        url = u.toString();
      } catch (e) {
        if (e instanceof BlockedTargetError) throw new AppError('INVALID_MEDIA_URL', 422, e.message);
        throw e;
      }
      const payload: Record<string, string> = { url };
      if (i.caption) payload.caption = i.caption;
      if (i.filename) payload.filename = i.filename;
      if (i.mimetype) payload.mimetype = i.mimetype;
      const hash = crypto.createHash('sha256').update(JSON.stringify([i.sessionId, i.to, i.type, url, i.caption ?? null, i.filename ?? null, i.mimetype ?? null, i.priority, i.scheduledAt?.toISOString() ?? null])).digest('hex');
      return enqueueOne(p, { sessionId: i.sessionId, to: i.to, type: i.type, payload, priority: i.priority, scheduledAt: i.scheduledAt, idempotencyKey: i.idempotencyKey }, hash);
    },

    /**
     * Antre banyak pesan teks SEKALIGUS: atomik (semua masuk atau tidak sama sekali). Idempotensi per batch: kunci yang
     * sama + isi sama => daftar job yang sama; isi beda => 422. Pengiriman tetap lewat lane serial & batas pesan/menit tenant.
     */
    async bulk(p: Principal, i: BulkInput): Promise<{ replay: boolean; jobs: { index: number; to: string; job_id: string; status: string }[] }> {
      const tenantId = p.tenantId;
      const hash = bulkHash(i);
      const key = i.idempotencyKey;
      if (key && key.length > 200) throw new AppError('VALIDATION_ERROR', 400, 'Idempotency-Key untuk bulk maksimal 200 karakter');
      const seen = new Set<string>();
      for (const it of i.items) {
        const k = it.to + '\u0000' + it.text;
        if (seen.has(k)) throw new AppError('DUPLICATE_ITEM', 422, `Batch memuat pesan ganda ke ${it.to}`);
        seen.add(k);
      }
      return db.tx({ tenantId }, async (c) => {
        const replayOf = async () => {
          if (!key) return null;
          const rows = (await c.query(
            `SELECT id, status, recipient, request_hash, substring(idempotency_key from '#([0-9]+)$')::int AS idx
             FROM message_queue WHERE tenant_id = $1 AND starts_with(idempotency_key, $2) AND idempotency_key ~ '#[0-9]+$' ORDER BY idx`, [tenantId, key + '#'])).rows;
          if (!rows.length) return null;
          if (rows.some((r: any) => r.request_hash !== hash)) throw new AppError('IDEMPOTENCY_CONFLICT', 422, 'Idempotency-Key sudah dipakai dengan permintaan yang berbeda');
          return { replay: true, jobs: rows.map((r: any) => ({ index: r.idx, to: r.recipient, job_id: r.id, status: r.status })) };
        };
        const rp = await replayOf(); if (rp) return rp;
        await assertSendable(c, tenantId, i.sessionId);
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:enqueue:' + tenantId]); // serialkan agar batas antrean akurat
        await assertQueueRoom(c, tenantId, i.items.length);
        const jobs: { index: number; to: string; job_id: string; status: string }[] = [];
        for (const [idx, it] of i.items.entries()) {
          const r = (await c.query(
            `INSERT INTO message_queue (tenant_id, session_id, idempotency_key, request_hash, recipient, payload, priority, max_attempts, scheduled_at, actor)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, COALESCE($9::timestamptz, clock_timestamp()) + make_interval(secs => $11::int / 1000000.0), $10)
             ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id, status`,
            // jadwal naik 1 mikrodetik per item: urutan batch = urutan kirim (lane serial mengurutkan menurut scheduled_at)
            [tenantId, i.sessionId, key ? `${key}#${idx}` : null, key ? hash : null, it.to, JSON.stringify({ text: it.text }), i.priority,
             config.MESSAGE_MAX_ATTEMPTS, i.scheduledAt ?? null, actorOf(p), idx])).rows[0];
          if (!r) { const again = await replayOf(); if (again) return again; throw new AppError('INTERNAL_ERROR', 500, 'Gagal mengantre pesan'); }
          jobs.push({ index: idx, to: it.to, job_id: r.id, status: r.status });
        }
        return { replay: false, jobs };
      });
    },

    async list(tenantId: string, q: { page: number; pageSize: number; status?: string; sessionId?: string; from?: Date; to?: Date }) {
      return db.tx({ tenantId }, async (c) => {
        const where = `tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR session_id = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)`;
        const args = [tenantId, q.status ?? null, q.sessionId ?? null, q.from ?? null, q.to ?? null];
        // Hitungan berbatas: count eksak membaca semua baris tenant (O(n)); cukup tahu "ada lebih dari batas".
        const cap = svcOpts.countCap ?? config.LIST_COUNT_CAP;
        const n = (await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM message_queue WHERE ${where} LIMIT $6) x`, [...args, cap + 1])).rows[0].n;
        const rows = (await c.query(`SELECT ${COLS} FROM message_queue WHERE ${where} ORDER BY created_at DESC, id LIMIT $6 OFFSET $7`, [...args, q.pageSize, (q.page - 1) * q.pageSize])).rows;
        return { rows: rows.map(view), total: Math.min(n, cap), capped: n > cap };
      });
    },

    async get(tenantId: string, id: string) {
      return db.tx({ tenantId }, async (c) => {
        const job = view(await loadOne(c, tenantId, id));
        const attempts = (
          await c.query(
            `SELECT attempt_number, started_at, finished_at, outcome, provider_message_id, error_code
             FROM message_attempts WHERE job_id = $1 AND tenant_id = $2 ORDER BY attempt_number`, [id, tenantId])
        ).rows;
        return { ...job, attempt_history: attempts };
      });
    },

    async status(tenantId: string, id: string) {
      return db.tx({ tenantId }, async (c) => {
        const r = await loadOne(c, tenantId, id);
        return { id: r.id, status: r.status, attempts: r.attempts, last_error_code: r.last_error_code, provider_message_id: r.provider_message_id, updated_at: r.updated_at };
      });
    },

    /** Batalkan hanya bila masih PENDING (atomik). Yang sudah diproses tidak bisa ditarik kembali. */
    async cancel(p: Principal, id: string) {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const cur = await loadOne(c, p.tenantId, id);
        const u = await c.query(
          `UPDATE message_queue SET status = 'CANCELLED', last_error_code = 'CANCELLED_BY_CLIENT', completed_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'`, [id, p.tenantId]);
        if (u.rowCount !== 1) {
          if (cur.status === 'CANCELLED') return view(cur);
          throw new AppError('INVALID_STATE', 409, `Pesan tidak dapat dibatalkan pada status ${cur.status}`);
        }
        return view(await loadOne(c, p.tenantId, id));
      });
    },

    /**
     * Kirim ulang manual. UNKNOWN / RECONCILIATION_REQUIRED berarti pesan MUNGKIN sudah terkirim: wajib
     * `confirm_duplicate_risk=true` (klien menerima kemungkinan duplikat). FAILED boleh diulang tanpa konfirmasi.
     */
    async retry(p: Principal, id: string, confirmDuplicateRisk: boolean) {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const cur = await loadOne(c, p.tenantId, id, true);
        if (cur.content_purged_at) throw new AppError('CONTENT_PURGED', 409, 'Isi pesan sudah dihapus sesuai kebijakan retensi; buat pesan baru');
        if (!['FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(cur.status)) throw new AppError('INVALID_STATE', 409, `Pesan tidak dapat dikirim ulang pada status ${cur.status}`);
        if (cur.status !== 'FAILED' && !confirmDuplicateRisk) {
          throw new AppError('CONFIRMATION_REQUIRED', 409, 'Hasil pengiriman sebelumnya tidak pasti; set confirm_duplicate_risk=true untuk menerima kemungkinan pesan ganda');
        }
        const sess = (await c.query(`SELECT status, desired_state FROM wa_sessions WHERE id = $1 AND tenant_id = $2`, [cur.session_id, p.tenantId])).rows[0];
        if (!sess || !SENDABLE.includes(sess.status) || sess.desired_state !== 'CONNECTED') throw new AppError('SESSION_UNAVAILABLE', 409, 'Session tidak dapat menerima pesan');
        await c.query(
          `UPDATE message_queue SET status = 'PENDING', max_attempts = attempts + $3, scheduled_at = now(), completed_at = NULL, last_error_code = NULL
           WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId, config.MESSAGE_MAX_ATTEMPTS]);
        return view(await loadOne(c, p.tenantId, id));
      });
    },
  };
}
export type MessageService = ReturnType<typeof createMessageService>;
