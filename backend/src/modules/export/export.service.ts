import { Readable } from 'node:stream';
import type { GatewayDb } from '../../database/gateway.js';
import { AppError } from '../../http/errors.js';
import { config } from '../../config/env.js';
import { recordAudit } from '../audit/audit.js';
import type { Role } from '../identity/principal.js';
import { BOM, csvRow, ndjsonLine } from './csv.js';
import { DEFS, EXPORT_TYPES, type ExportType, type Filters } from './definitions.js';

/**
 * Ekspor data workspace (ADR-048, docs/02_BACKEND/DATA_EXPORT_DESIGN.md). Tiga tahap terpisah agar urutan pengaman benar di route:
 *   prepare()  validasi + PRA-HITUNG (422 bila melebihi batas; belum ada byte terkirim, belum memakai jatah per jam)
 *   open()     ambil slot (1 ekspor per workspace, batas bersamaan per proses) lalu kembalikan aliran
 *   aliran     batch keyset, tiap batch transaksi pendek berkonteks RLS tenant; koneksi DB dilepas di antara batch
 * Setiap ekspor berakhir dengan satu baris audit data.exported (completed | aborted | failed) berisi jumlah baris dan byte, tanpa isi data.
 */
export interface ExportLimits { maxRows: number; maxSpanDays: number; batchRows: number; maxSeconds: number; maxConcurrent: number; maxBytes: number; statementTimeoutMs: number }
export const defaultLimits = (): ExportLimits => ({
  maxRows: config.EXPORT_MAX_ROWS, maxSpanDays: config.EXPORT_MAX_SPAN_DAYS, batchRows: config.EXPORT_BATCH_ROWS, maxSeconds: config.EXPORT_MAX_SECONDS,
  maxConcurrent: config.EXPORT_MAX_CONCURRENT, maxBytes: 100 * 1024 * 1024, statementTimeoutMs: 15_000,
});

export type ExportFormat = 'csv' | 'ndjson';
export interface ExportRequest { type: ExportType; format: ExportFormat; from?: Date; to?: Date; sessionId?: string; direction?: 'IN' | 'OUT'; status?: string }
export interface ExportActor { userId: string; tenantId: string; role?: Role; ip?: string; requestId?: string }
export interface ExportPlan {
  request: ExportRequest; filters: Filters; rows: number; filename: string; contentType: string;
  workspace: { name: string; slug: string }; actorEmail: string | null; rangeFrom?: Date; rangeTo?: Date;
}
type Outcome = 'completed' | 'aborted' | 'failed';
interface Logger { warn(o: unknown, msg?: string): void }

const DAY = 86_400_000;
const safeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');

export function createExportService(db: GatewayDb, o: { limits?: Partial<ExportLimits>; log?: Logger; enabled?: boolean } = {}) {
  const enabled = o.enabled ?? config.EXPORT_ENABLED === 'true';
  const limits: ExportLimits = { ...defaultLimits(), ...o.limits };
  const activeTenants = new Set<string>();
  let activeCount = 0;

  const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);

  return {
    limits,
    enabled: () => enabled,

    /** Kebijakan untuk UI (batas dan retensi). */
    policy() {
      return {
        enabled, max_rows: limits.maxRows, max_span_days: limits.maxSpanDays, per_hour: config.EXPORT_PER_USER_PER_HOUR, types: [...EXPORT_TYPES],
        retention: { content_days: config.RETENTION_CONTENT_DAYS, row_days: config.RETENTION_ROW_DAYS, audit_days: config.RETENTION_AUDIT_DAYS },
      };
    },

    async prepare(actor: ExportActor, req: ExportRequest): Promise<ExportPlan> {
      const def = DEFS[req.type];
      const startedAt = new Date();
      let to = req.to ?? startedAt;
      if (def.needsRange) {
        if (!req.from || !req.to) throw bad('from dan to wajib untuk jenis ekspor ini');
        if (req.from >= req.to) throw bad('from harus lebih awal dari to');
        if (req.to.getTime() - req.from.getTime() > limits.maxSpanDays * DAY) throw bad(`Rentang maksimal ${limits.maxSpanDays} hari; ekspor per rentang yang lebih pendek`);
      }
      if (to > startedAt) to = startedAt; // batas atas terkunci pada waktu mulai: baris yang masuk sesudahnya tidak ikut (hasil deterministik)
      const filters: Filters = { from: req.from, to, startedAt, sessionId: req.sessionId, direction: req.direction, status: req.status };

      const info = await db.tx({ tenantId: actor.tenantId, userId: actor.userId }, async (c) => {
        const t = (await c.query('SELECT name, slug FROM tenants WHERE id = $1', [actor.tenantId])).rows[0] as { name: string; slug: string } | undefined;
        const m = (await c.query('SELECT member_email FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [actor.tenantId, actor.userId])).rows[0] as { member_email: string | null } | undefined;
        await c.query(`SET LOCAL statement_timeout = ${limits.statementTimeoutMs}`);
        const rows = await def.count(c, actor.tenantId, filters, limits.maxRows);
        return { t, email: m?.member_email ?? null, rows };
      });
      if (!info.t) throw new AppError('NOT_FOUND', 404, 'Workspace tidak ditemukan');
      if (info.rows > limits.maxRows) {
        throw new AppError('EXPORT_TOO_LARGE', 422, `Ekspor melebihi ${limits.maxRows} baris; persempit rentang waktu atau filter`, [{ max_rows: limits.maxRows, estimated_rows: info.rows, capped: true }]);
      }
      const ext = req.format === 'csv' ? 'csv' : 'ndjson';
      return {
        request: req, filters, rows: info.rows, rangeFrom: req.from, rangeTo: to,
        filename: `wazap-${safeSlug(info.t.slug)}-${req.type}-${ymd(startedAt)}.${ext}`,
        contentType: req.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        workspace: info.t, actorEmail: info.email,
      };
    },

    /** Mengambil slot dan mengembalikan aliran. Dilepas dan diaudit tepat sekali: saat selesai, gagal, dibatalkan klien, atau aliran ditutup tanpa dibaca. */
    open(actor: ExportActor, plan: ExportPlan): Readable {
      if (activeTenants.has(actor.tenantId)) throw new AppError('EXPORT_IN_PROGRESS', 409, 'Ekspor lain untuk workspace ini masih berjalan');
      if (activeCount >= limits.maxConcurrent) throw new AppError('RATE_LIMITED', 429, 'Server sedang memproses ekspor lain; coba lagi sebentar', [], { 'Retry-After': '15' });
      activeTenants.add(actor.tenantId); activeCount++;

      const def = DEFS[plan.request.type];
      const startedMs = Date.now();
      const st = { rows: 0, bytes: 0, outcome: 'aborted' as Outcome };
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        activeTenants.delete(actor.tenantId); activeCount--;
        try {
          await db.tx({ tenantId: actor.tenantId, userId: actor.userId }, (c) => recordAudit(c, {
            tenantId: actor.tenantId, actor: { userId: actor.userId, email: plan.actorEmail, role: actor.role ?? null },
            action: 'data.exported', targetType: 'export', targetId: plan.request.type,
            details: {
              type: plan.request.type, format: plan.request.format, outcome: st.outcome, from: plan.rangeFrom?.toISOString(), to: plan.rangeTo?.toISOString(),
              session_id: plan.request.sessionId, direction: plan.request.direction, status: plan.request.status, rows: st.rows, bytes: st.bytes, duration_ms: Date.now() - startedMs,
            },
            ip: actor.ip, requestId: actor.requestId,
          }));
        } catch (err) { o.log?.warn({ err: (err as Error).message }, 'audit ekspor gagal ditulis'); }
      };

      const manifest = () => ndjsonLine({ _manifest: {
        type: plan.request.type, format: 'ndjson', workspace: plan.workspace.slug, from: plan.rangeFrom?.toISOString() ?? null, to_effective: plan.rangeTo?.toISOString() ?? null,
        rows: st.rows, exported_at: new Date().toISOString(), schema_version: 1,
        notes: [`isi pesan lebih tua dari ${config.RETENTION_CONTENT_DAYS} hari sudah dibersihkan (text kosong, text_purged=true)`],
      } });

      async function* generate(): AsyncGenerator<string> {
        try {
          if (plan.request.format === 'csv') { const h = BOM + csvRow(def.columns); st.bytes += Buffer.byteLength(h); yield h; }
          let cursor: string[] | null = null;
          for (;;) {
            if (Date.now() - startedMs > limits.maxSeconds * 1000) throw new Error(`ekspor melebihi batas waktu ${limits.maxSeconds} dtk`);
            const batch = await db.tx({ tenantId: actor.tenantId, userId: actor.userId }, async (c) => {
              await c.query(`SET LOCAL statement_timeout = ${limits.statementTimeoutMs}`);
              return def.batch(c, actor.tenantId, plan.filters, cursor, limits.batchRows);
            });
            if (batch.rows.length > 0) {
              st.rows += batch.rows.length;
              if (st.rows > limits.maxRows) throw new Error(`ekspor melebihi ${limits.maxRows} baris saat berjalan`);
              const chunk = plan.request.format === 'csv'
                ? batch.rows.map((r) => csvRow(def.columns.map((k) => r[k]))).join('')
                : batch.rows.map((r) => ndjsonLine(Object.fromEntries(def.columns.map((k) => [k, r[k]])))).join('');
              st.bytes += Buffer.byteLength(chunk);
              if (st.bytes > limits.maxBytes) throw new Error('ekspor melebihi batas ukuran');
              yield chunk;
            }
            if (batch.rows.length < limits.batchRows) break;
            cursor = batch.cursor;
          }
          if (plan.request.format === 'ndjson') { const m = manifest(); st.bytes += Buffer.byteLength(m); yield m; }
          st.outcome = 'completed';
        } catch (err) {
          st.outcome = 'failed';
          throw err;
        } finally {
          await finish();
        }
      }
      const stream = Readable.from(generate(), { objectMode: false });
      stream.once('close', () => { void finish(); }); // aliran ditutup tanpa pernah dibaca: generator tidak berjalan, jadi lepaskan di sini
      return stream;
    },
  };
}
export type ExportService = ReturnType<typeof createExportService>;
