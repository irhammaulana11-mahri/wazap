import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import { requireRole } from '../identity/guard.js';
import { RateLimiter } from '../identity/rate-limit.js';
import type { TenantActor, TenantService } from './tenant.service.js';

const RenameSchema = z.strictObject({ name: z.string().trim().min(2).max(100) });
const DeleteSchema = z.strictObject({ password: z.string().min(1).max(128), confirm_name: z.string().min(1).max(255) });

export interface TenantRoutesOpts {
  tenant: TenantService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter?: RateLimiter;
}

export async function tenantRoutes(app: FastifyInstance, { tenant, authenticate, limiter }: TenantRoutesOpts) {
  const lim = limiter ?? new RateLimiter();
  const owner = [authenticate, requireRole('OWNER')];
  const actor = (req: FastifyRequest): TenantActor => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, ip: req.ip, requestId: req.id };
  };

  app.patch('/tenant', { preHandler: owner }, async (req) => ok(await tenant.rename(actor(req), RenameSchema.parse(req.body).name)));

  // Kata sandi salah dijawab 403 INVALID_PASSWORD (bukan 401) agar klien tidak masuk lingkaran refresh.
  app.delete('/tenant', { preHandler: owner }, async (req) => {
    const a = actor(req);
    const r = lim.check(`tenant-del:${a.userId}`, 3, 60 * 60_000);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan; coba lagi nanti', [], { 'Retry-After': String(r.retryAfterSec) });
    const b = DeleteSchema.parse(req.body);
    return ok(await tenant.remove(a, { password: b.password, confirmName: b.confirm_name }));
  });
}
