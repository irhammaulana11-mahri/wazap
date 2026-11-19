import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import { requireAccess } from '../identity/guard.js';
import { resolveRange, validTimeZone, type UsageService } from './usage.service.js';

const Iso = z.iso.datetime({ offset: true });
const RangeQ = z.object({ from: Iso.optional(), to: Iso.optional() });
const SeriesQ = RangeQ.extend({
  group_by: z.enum(['hour', 'day']).default('day'),
  tz: z.string().max(64).default('UTC'),
  session_id: z.uuid().optional(),
});

export interface UsageRoutesOpts {
  usage: UsageService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function usageRoutes(app: FastifyInstance, { usage, authenticate }: UsageRoutesOpts) {
  const read = [authenticate, requireAccess('usage:read', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])];

  app.get('/usage/summary', { preHandler: read }, async (req) => ok(await usage.summary(req.auth!.tenantId, resolveRange(RangeQ.parse(req.query)))));

  app.get('/usage/messages', { preHandler: read }, async (req) => {
    const q = SeriesQ.parse(req.query);
    if (!validTimeZone(q.tz) || !(await usage.timezoneKnown(q.tz))) throw new AppError('VALIDATION_ERROR', 400, 'Zona waktu tidak dikenal (gunakan nama IANA, mis. Asia/Jakarta; bentuk offset seperti +07:00 tidak didukung)');
    const range = resolveRange(q);
    return ok(await usage.series(req.auth!.tenantId, range, { unit: q.group_by, tz: q.tz, sessionId: q.session_id }),
      { from: range.from.toISOString(), to: range.to.toISOString(), group_by: q.group_by, tz: q.tz });
  });

  app.get('/usage/sessions', { preHandler: read }, async (req) => ok(await usage.sessions(req.auth!.tenantId, resolveRange(RangeQ.parse(req.query)))));
}
