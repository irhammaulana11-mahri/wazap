import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok } from '../../http/errors.js';
import { requireRole } from '../identity/guard.js';
import type { AuditService } from './audit.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
const Iso = z.iso.datetime({ offset: true });
const ListQ = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(48).optional(),
  actor_user_id: z.uuid().optional(),
  target_id: z.string().max(64).optional(),
  from: Iso.optional(),
  to: Iso.optional(),
}).refine((v) => !v.from || !v.to || new Date(v.from).getTime() < new Date(v.to).getTime(), { message: '`from` harus lebih awal dari `to`', path: ['from'] });

export interface AuditRoutesOpts {
  audit: AuditService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function auditRoutes(app: FastifyInstance, { audit, authenticate }: AuditRoutesOpts) {
  // Jejak perubahan hanya untuk pengurus (OWNER/ADMIN) pengguna dashboard; API key tidak dapat membacanya.
  const manage = [authenticate, requireRole('OWNER', 'ADMIN')];
  app.get('/audit-logs', { preHandler: manage }, async (req) => {
    const q = ListQ.parse(req.query);
    const { rows, total, capped } = await audit.list(req.auth!.tenantId, {
      page: q.page, pageSize: q.page_size, action: q.action, actorUserId: q.actor_user_id, targetId: q.target_id,
      from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined,
    });
    return ok(rows, { page: q.page, page_size: q.page_size, total, ...(capped ? { total_capped: true } : {}) });
  });
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'GET /audit-logs': { query: ListQ },
};
