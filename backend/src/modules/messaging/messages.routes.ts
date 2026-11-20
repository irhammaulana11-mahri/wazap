import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { ok } from '../../http/errors.js';
import { requireAccess } from '../identity/guard.js';
import type { MessageService } from './messages.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
/** Format internasional tanpa kode negara implisit: 8-15 digit; spasi, tanda hubung, titik, kurung, dan '+' awal diabaikan. */
const To = z.string().max(32).transform((v) => v.trim().replace(/^\+/, '').replace(/[\s\-().]/g, '')).pipe(
  z.string().regex(/^[1-9][0-9]{7,14}$/, 'nomor harus format internasional (8-15 digit, tanpa 0 di depan), mis. 6281234567890'));
const Idem = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, 'hanya karakter ASCII tercetak tanpa spasi');
const SendSchema = z.strictObject({
  session_id: z.string().max(64),
  to: To,
  type: z.literal('text'),
  message: z.string().min(1).max(config.MESSAGE_MAX_LENGTH),
  priority: z.number().int().min(0).max(9).default(5),
  scheduled_at: z.iso.datetime({ offset: true }).optional(),
});
const Sched = z.iso.datetime({ offset: true });
const MediaSchema = z.strictObject({
  session_id: z.string().max(64),
  to: To,
  type: z.enum(['image', 'video', 'audio', 'document']),
  url: z.string().max(2048),
  caption: z.string().max(1024).optional(),
  filename: z.string().trim().min(1).max(200).transform((v) => v.replace(/[\\/\u0000-\u001f\u007f]/g, '_')).optional(),
  mimetype: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/, 'mimetype tidak valid').optional(),
  priority: z.number().int().min(0).max(9).default(5),
  scheduled_at: Sched.optional(),
}).refine((v) => !(v.type === 'audio' && v.caption), { message: 'audio tidak mendukung caption', path: ['caption'] })
  .refine((v) => v.type === 'document' || !v.filename, { message: 'filename hanya untuk document', path: ['filename'] });
const BulkSchema = z.strictObject({
  session_id: z.string().max(64),
  messages: z.array(z.strictObject({ to: To, message: z.string().min(1).max(config.MESSAGE_MAX_LENGTH) })).min(1).max(config.BULK_MAX_MESSAGES),
  priority: z.number().int().min(0).max(9).default(5),
  scheduled_at: Sched.optional(),
});
const PageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
const ListSchema = PageSchema.extend({
  status: z.enum(['PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'UNKNOWN', 'RECONCILIATION_REQUIRED']).optional(),
  session_id: z.uuid().optional(),
  // Rentang waktu pembuatan (diantrekan): from inklusif, to eksklusif. ISO-8601 dengan offset, mis. 2026-11-19T00:00:00+07:00.
  from: Sched.optional(),
  to: Sched.optional(),
}).refine((v) => !v.from || !v.to || new Date(v.from).getTime() < new Date(v.to).getTime(), { message: '`from` harus lebih awal dari `to`', path: ['from'] });
const IdParam = z.object({ messageId: z.string().max(64) });
const RetrySchema = z.strictObject({ confirm_duplicate_risk: z.boolean().default(false) });

export interface MessageRoutesOpts {
  messages: MessageService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/** scheduled_at: maksimal 7 hari ke depan; waktu lampau = kirim segera. */
function parseSchedule(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  const ms = d.getTime() - Date.now();
  if (ms > 7 * 86_400_000) throw new z.ZodError([{ code: 'custom', path: ['scheduled_at'], message: 'maksimal 7 hari ke depan', input: v }]);
  return ms < 0 ? undefined : d;
}
const idemKey = (req: FastifyRequest) => {
  const raw = req.headers['idempotency-key'];
  return raw === undefined ? undefined : Idem.parse(Array.isArray(raw) ? raw[0] : raw);
};

export async function messageRoutes(app: FastifyInstance, { messages, authenticate }: MessageRoutesOpts) {
  const read = [authenticate, requireAccess('messages:read', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])];
  const write = [authenticate, requireAccess('messages:send', ['OWNER', 'ADMIN', 'MEMBER'])];
  const id = (req: FastifyRequest) => IdParam.parse(req.params).messageId;

  app.post('/messages/send', { preHandler: write }, async (req, reply) => {
    const b = SendSchema.parse(req.body);
    const r = await messages.send(req.auth!, { sessionId: b.session_id, to: b.to, text: b.message, priority: b.priority, scheduledAt: parseSchedule(b.scheduled_at), idempotencyKey: idemKey(req) });
    if (r.replay) reply.header('Idempotent-Replayed', 'true');
    return reply.code(202).send(ok({ job_id: r.job_id, status: r.status }));
  });

  app.post('/messages/send-media', { preHandler: write }, async (req, reply) => {
    const b = MediaSchema.parse(req.body);
    const r = await messages.sendMedia(req.auth!, {
      sessionId: b.session_id, to: b.to, type: b.type, url: b.url, caption: b.caption, filename: b.filename, mimetype: b.mimetype,
      priority: b.priority, scheduledAt: parseSchedule(b.scheduled_at), idempotencyKey: idemKey(req),
    });
    if (r.replay) reply.header('Idempotent-Replayed', 'true');
    return reply.code(202).send(ok({ job_id: r.job_id, status: r.status }));
  });

  app.post('/messages/bulk', { preHandler: write }, async (req, reply) => {
    const b = BulkSchema.parse(req.body);
    const r = await messages.bulk(req.auth!, {
      sessionId: b.session_id, items: b.messages.map((m) => ({ to: m.to, text: m.message })), priority: b.priority,
      scheduledAt: parseSchedule(b.scheduled_at), idempotencyKey: idemKey(req),
    });
    if (r.replay) reply.header('Idempotent-Replayed', 'true');
    return reply.code(202).send(ok({ count: r.jobs.length, jobs: r.jobs }));
  });

  app.get('/messages', { preHandler: read }, async (req) => {
    const q = ListSchema.parse(req.query);
    const { rows, total, capped } = await messages.list(req.auth!.tenantId, { page: q.page, pageSize: q.page_size, status: q.status, sessionId: q.session_id, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
    return ok(rows, { page: q.page, page_size: q.page_size, total, ...(capped ? { total_capped: true } : {}) });
  });
  app.get('/messages/:messageId', { preHandler: read }, async (req) => ok(await messages.get(req.auth!.tenantId, id(req))));
  app.get('/messages/:messageId/status', { preHandler: read }, async (req) => ok(await messages.status(req.auth!.tenantId, id(req))));
  app.post('/messages/:messageId/cancel', { preHandler: write }, async (req) => ok(await messages.cancel(req.auth!, id(req))));
  app.post('/messages/:messageId/retry', { preHandler: write }, async (req, reply) => {
    const b = RetrySchema.parse(req.body ?? {});
    return reply.code(202).send(ok(await messages.retry(req.auth!, id(req), b.confirm_duplicate_risk)));
  });
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'POST /messages/send': { body: SendSchema },
  'POST /messages/send-media': { body: MediaSchema },
  'POST /messages/bulk': { body: BulkSchema },
  'GET /messages': { query: ListSchema },
  'GET /messages/:messageId': { params: IdParam },
  'GET /messages/:messageId/status': { params: IdParam },
  'POST /messages/:messageId/cancel': { params: IdParam },
  'POST /messages/:messageId/retry': { params: IdParam, body: RetrySchema, bodyOptional: true },
};
