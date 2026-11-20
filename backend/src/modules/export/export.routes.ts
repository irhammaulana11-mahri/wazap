import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import type { RouteContract } from '../../http/openapi/types.js';
import { config } from '../../config/env.js';
import { requireRole } from '../identity/guard.js';
import type { IdentityService } from '../identity/identity.service.js';
import { RateLimiter } from '../identity/rate-limit.js';
import type { ExportActor, ExportService } from './export.service.js';
import type { ExportType } from './definitions.js';

const Pw = z.string().min(1).max(128);
const Fmt = z.enum(['csv', 'ndjson']).default('csv');
const Iso = z.iso.datetime({ offset: true });
const Sess = z.uuid().optional();
const QUEUE_STATUS = ['PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'] as const;

const MessagesBody = z.strictObject({ password: Pw, format: Fmt, from: Iso, to: Iso, session_id: Sess, direction: z.enum(['IN', 'OUT']).optional() });
const OutboundBody = z.strictObject({ password: Pw, format: Fmt, from: Iso, to: Iso, session_id: Sess, status: z.enum(QUEUE_STATUS).optional() });
const ChatsBody = z.strictObject({ password: Pw, format: Fmt, session_id: Sess });
const RangeBody = z.strictObject({ password: Pw, format: Fmt, from: Iso, to: Iso });
const PlainBody = z.strictObject({ password: Pw, format: Fmt });

export interface ExportRoutesOpts {
  exports: ExportService;
  identity: IdentityService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter?: RateLimiter;
  /** Jatah ekspor per pengguna per jam (bawaan: EXPORT_PER_USER_PER_HOUR). */
  perHour?: number;
}

/** Ekspor data workspace (ADR-048). Hanya OWNER/ADMIN pengguna dashboard (API key ditolak), dengan konfirmasi kata sandi. */
export async function exportRoutes(app: FastifyInstance, { exports: svc, identity, authenticate, limiter, perHour }: ExportRoutesOpts) {
  const lim = limiter ?? new RateLimiter();
  const quota = perHour ?? config.EXPORT_PER_USER_PER_HOUR;
  const manage = [authenticate, requireRole('OWNER', 'ADMIN')];
  const anyUser = [authenticate, requireRole('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')];
  const actor = (req: FastifyRequest): ExportActor => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, role: a.role, ip: req.ip, requestId: req.id };
  };
  const tooMany = (retryAfterSec: number, message: string) => new AppError('RATE_LIMITED', 429, message, [], { 'Retry-After': String(retryAfterSec) });

  const handle = (type: ExportType, schema: z.ZodType<Record<string, unknown>>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!svc.enabled()) throw new AppError('NOT_CONFIGURED', 503, 'Ekspor data dinonaktifkan oleh operator');
    const a = actor(req);
    const b = schema.parse(req.body) as { password: string; format: 'csv' | 'ndjson'; from?: string; to?: string; session_id?: string; direction?: 'IN' | 'OUT'; status?: string };
    // Hanya percobaan kata sandi yang SALAH dihitung (5 per 15 menit); ekspor yang sah berturut-turut tidak terkunci. Penguncian dicek SEBELUM verifikasi,
    // sehingga setelah terkunci bahkan kata sandi yang benar tertahan (tidak dapat dipakai menebak).
    const pwKey = `export-pw:${a.userId}`;
    const gate = lim.blocked(pwKey, 5);
    if (gate.blocked) throw tooMany(gate.retryAfterSec, 'Terlalu banyak percobaan; coba lagi nanti');
    try {
      await identity.confirmPassword(a.userId, b.password);
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_PASSWORD') {
        const r = lim.check(pwKey, 5, 15 * 60_000);
        if (!r.allowed) throw tooMany(r.retryAfterSec, 'Terlalu banyak percobaan; coba lagi nanti');
      }
      throw err;
    }
    const plan = await svc.prepare(a, {
      type, format: b.format, from: b.from ? new Date(b.from) : undefined, to: b.to ? new Date(b.to) : undefined,
      sessionId: b.session_id, direction: b.direction, status: b.status,
    });
    // Jatah per jam ditagih SETELAH pra-hitung lolos: ekspor yang ditolak 422 (terlalu besar) tidak menghabiskan jatah.
    const q = lim.check(`export:${a.userId}`, quota, 60 * 60_000);
    if (!q.allowed) throw tooMany(q.retryAfterSec, `Batas ${quota} ekspor per jam tercapai; coba lagi nanti`);
    const stream = svc.open(a, plan);
    return reply
      .header('Content-Type', plan.contentType)
      .header('Content-Disposition', `attachment; filename="${plan.filename}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Export-Rows', String(plan.rows))
      .send(stream);
  };

  app.post('/exports/messages', { preHandler: manage }, handle('messages', MessagesBody));
  app.post('/exports/outbound', { preHandler: manage }, handle('outbound', OutboundBody));
  app.post('/exports/chats', { preHandler: manage }, handle('chats', ChatsBody));
  app.post('/exports/contacts', { preHandler: manage }, handle('contacts', PlainBody));
  app.post('/exports/audit-logs', { preHandler: manage }, handle('audit-logs', RangeBody));
  app.post('/exports/members', { preHandler: manage }, handle('members', PlainBody));
  app.get('/exports/policy', { preHandler: anyUser }, async () => ok(svc.policy()));
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'POST /exports/messages': { body: MessagesBody },
  'POST /exports/outbound': { body: OutboundBody },
  'POST /exports/chats': { body: ChatsBody },
  'POST /exports/contacts': { body: PlainBody },
  'POST /exports/audit-logs': { body: RangeBody },
  'POST /exports/members': { body: PlainBody },
};
