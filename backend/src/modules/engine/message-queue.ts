import type { GatewayDb } from '../../database/gateway.js';
import { config } from '../../config/env.js';
import { FencedError, type Lease, type LeaseService } from './lease.service.js';

export interface ClaimedJob {
  id: string;
  attemptNumber: number;
  maxAttempts: number;
  recipient: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  /** Teks (type=text) atau caption (media). */
  text: string;
  media?: { url: string; filename?: string; mimetype?: string };
}
export type ClaimResult = { kind: 'job'; job: ClaimedJob } | { kind: 'wait'; waitMs: number } | { kind: 'none' };

export type JobResult =
  | { kind: 'sent'; providerMessageId?: string }
  | { kind: 'retry'; errorCode: string; detail?: string } //   gagal SEBELUM pesan keluar: aman diulang
  | { kind: 'failed'; errorCode: string; detail?: string } //  permanen
  | { kind: 'unknown'; errorCode: string; detail?: string }; // hasil ambigu: JANGAN diulang otomatis

export interface QueueOptions {
  processingTimeoutSec?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
}

const clip = (s: string | undefined, n = 500) => (s ? s.slice(0, n) : null);

/**
 * Sisi engine/control-plane dari antrean (konteks platform). Hanya engine pemilik lease sesi yang meng-klaim
 * dan menyelesaikan job sesi itu (lewat withFence), sehingga lane per sesi bersifat serial dan engine lama tidak
 * dapat menulis hasil setelah kehilangan kepemilikan. Tidak ada koneksi DB yang ditahan selama pengiriman jaringan.
 */
export function createMessageQueue(db: GatewayDb, leases: LeaseService, o: QueueOptions = {}) {
  const timeoutSec = () => o.processingTimeoutSec ?? config.MESSAGE_PROCESSING_TIMEOUT_SECONDS;
  const base = () => o.retryBaseMs ?? config.MESSAGE_RETRY_BASE_MS;
  const max = () => o.retryMaxMs ?? config.MESSAGE_RETRY_MAX_MS;
  const rnd = () => (o.random ?? Math.random)();

  return {
    /**
     * Klaim job berikutnya untuk sesi ini: prioritas tinggi dulu, lalu jadwal, lalu FIFO. Menghormati batas
     * pesan/menit tenant (jendela 60 dtk dari riwayat percobaan; diserialkan per tenant dengan advisory lock).
     * Job tetap PENDING bila batas tercapai ('wait').
     */
    claim(lease: Lease, tenantId: string): Promise<ClaimResult> {
      return leases.withFence(lease, async (c) => {
        const cand = (
          await c.query(
            `SELECT id FROM message_queue WHERE session_id = $1 AND status = 'PENDING' AND scheduled_at <= now()
             ORDER BY priority DESC, scheduled_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [lease.sessionId]
          )
        ).rows[0];
        if (!cand) {
          const next = (await c.query(`SELECT extract(epoch FROM (min(scheduled_at) - now())) * 1000 AS ms FROM message_queue WHERE session_id = $1 AND status = 'PENDING'`, [lease.sessionId])).rows[0];
          return next?.ms != null ? { kind: 'wait', waitMs: Math.max(50, Math.ceil(Number(next.ms))) } : { kind: 'none' };
        }
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wazap:msgrate:' + tenantId]);
        const limit = (await c.query('SELECT messages_per_minute AS n FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0]?.n ?? 0;
        const win = (
          await c.query(
            `SELECT count(*)::int AS n, extract(epoch FROM (min(started_at) + interval '60 seconds' - now())) * 1000 AS ms
             FROM message_attempts WHERE tenant_id = $1 AND started_at > now() - interval '60 seconds'`,
            [tenantId]
          )
        ).rows[0];
        if (win.n >= limit) return { kind: 'wait', waitMs: Math.max(100, Math.ceil(Number(win.ms ?? 60000))) };

        const job = (
          await c.query(
            `UPDATE message_queue SET status = 'PROCESSING', attempts = attempts + 1, processing_at = now(),
               processing_expires_at = now() + make_interval(secs => $2), processing_engine_id = $3
             WHERE id = $1 AND status = 'PENDING'
             RETURNING id, attempts, max_attempts, recipient, message_type AS type, COALESCE(payload->>'text', payload->>'caption') AS text,
               payload->>'url' AS url, payload->>'filename' AS filename, payload->>'mimetype' AS mimetype`,
            [cand.id, timeoutSec(), lease.engineId]
          )
        ).rows[0];
        await c.query('INSERT INTO message_attempts (tenant_id, job_id, attempt_number, engine_id) VALUES ($1,$2,$3,$4)', [tenantId, job.id, job.attempts, lease.engineId]);
        return { kind: 'job', job: { id: job.id, attemptNumber: job.attempts, maxAttempts: job.max_attempts, recipient: job.recipient, type: job.type, text: job.text,
          ...(job.url ? { media: { url: job.url, filename: job.filename ?? undefined, mimetype: job.mimetype ?? undefined } } : {}) } };
      });
    },

    /** Catat hasil percobaan (berfencing). Mengembalikan status akhir job, atau null bila job sudah tidak PROCESSING. */
    complete(lease: Lease, job: ClaimedJob, r: JobResult): Promise<string | null> {
      return leases.withFence(lease, async (c) => {
        let status: string, outcome: string, errorCode: string | null = null, detail: string | null = null, provider: string | null = null;
        let retryDelayMs: number | null = null;
        switch (r.kind) {
          case 'sent': status = 'SENT'; outcome = 'SENT'; provider = r.providerMessageId ?? null; break;
          case 'unknown': status = 'UNKNOWN'; outcome = 'UNKNOWN'; errorCode = r.errorCode; detail = clip(r.detail); break;
          case 'failed': status = 'FAILED'; outcome = 'FAILED'; errorCode = r.errorCode; detail = clip(r.detail); break;
          case 'retry':
            errorCode = r.errorCode; detail = clip(r.detail);
            if (job.attemptNumber >= job.maxAttempts) { status = 'FAILED'; outcome = 'FAILED'; errorCode = 'MAX_ATTEMPTS_REACHED'; detail = clip(`terakhir: ${r.errorCode}`); }
            else {
              status = 'PENDING'; outcome = 'RETRY';
              const cap = Math.min(max(), base() * 2 ** (job.attemptNumber - 1));
              retryDelayMs = Math.round(cap / 2 + rnd() * (cap / 2)); // jitter 50-100%
            }
        }
        await c.query(
          `UPDATE message_attempts SET finished_at = now(), outcome = $3, provider_message_id = $4, error_code = $5, error_detail = $6
           WHERE job_id = $1 AND attempt_number = $2 AND outcome IS NULL`,
          [job.id, job.attemptNumber, outcome, provider, errorCode, detail]
        );
        const done = status !== 'PENDING';
        const u = await c.query(
          `UPDATE message_queue SET status = $3, provider_message_id = COALESCE($4, provider_message_id), last_error_code = $5,
             completed_at = CASE WHEN $6::boolean THEN now() ELSE NULL END,
             scheduled_at = CASE WHEN $7::int IS NULL THEN scheduled_at ELSE now() + make_interval(secs => $7::int / 1000.0) END,
             processing_at = NULL, processing_expires_at = NULL, processing_engine_id = NULL
           WHERE id = $1 AND status = 'PROCESSING' AND processing_engine_id = $2`,
          [job.id, lease.engineId, status, provider, errorCode, done, retryDelayMs]
        );
        return u.rowCount === 1 ? status : null;
      });
    },

    /**
     * Receipt dari WhatsApp untuk pesan KELUAR: SENT -> DELIVERED -> READ, hanya maju (receipt terlambat/duplikat
     * tidak memundurkan status). Berfencing: hanya engine pemilik sesi yang mencatat. true bila status berubah.
     */
    receipt(lease: Lease, providerMessageId: string, status: 'DELIVERED' | 'READ'): Promise<boolean> {
      return leases.withFence(lease, async (c) => {
        const u = await c.query(
          `UPDATE message_queue SET status = $3 WHERE session_id = $1 AND provider_message_id = $2
             AND (status = 'SENT' OR (status = 'DELIVERED' AND $3 = 'READ'))`,
          [lease.sessionId, providerMessageId, status]
        );
        return (u.rowCount ?? 0) > 0;
      });
    },

    /**
     * Pemulihan (control-plane): (1) PROCESSING yang melewati batas waktu => RECONCILIATION_REQUIRED (engine mati
     * saat kirim; hasil tidak diketahui, TIDAK di-retry otomatis); (2) PENDING lebih tua dari TTL => FAILED EXPIRED.
     */
    async reap(ttlSec = config.MESSAGE_TTL_SECONDS): Promise<{ abandoned: number; expired: number }> {
      return db.tx({ platform: true }, async (c) => {
        const ab = await c.query(
          `UPDATE message_queue SET status = 'RECONCILIATION_REQUIRED', last_error_code = 'PROCESSING_TIMEOUT',
             processing_at = NULL, processing_expires_at = NULL, processing_engine_id = NULL, completed_at = now()
           WHERE status = 'PROCESSING' AND processing_expires_at < now() RETURNING id, attempts`
        );
        for (const j of ab.rows) {
          await c.query(
            `UPDATE message_attempts SET finished_at = now(), outcome = 'ABANDONED', error_code = 'PROCESSING_TIMEOUT'
             WHERE job_id = $1 AND attempt_number = $2 AND outcome IS NULL`, [j.id, j.attempts]);
        }
        const ex = await c.query(
          `UPDATE message_queue SET status = 'FAILED', last_error_code = 'EXPIRED', completed_at = now()
           WHERE status = 'PENDING' AND scheduled_at < now() - make_interval(secs => $1)`, [ttlSec]);
        return { abandoned: ab.rowCount ?? 0, expired: ex.rowCount ?? 0 };
      });
    },
  };
}
export type MessageQueue = ReturnType<typeof createMessageQueue>;
export { FencedError };
