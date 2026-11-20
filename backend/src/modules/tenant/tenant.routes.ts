import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError, ok } from '../../http/errors.js';
import { requireRole } from '../identity/guard.js';
import { RateLimiter } from '../identity/rate-limit.js';
import type { TenantActor, TenantService } from './tenant.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
const RenameSchema = z.strictObject({ name: z.string().trim().min(2).max(100) });
const DeleteSchema = z.strictObject({ password: z.string().min(1).max(128), confirm_name: z.string().min(1).max(255) });

const CredSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) });
const RestoreSchema = CredSchema.extend({ tenant_id: z.uuid() });

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

  // Publik (setelah hapus tidak ada workspace aktif untuk login): OWNER membuktikan diri dengan email + kata sandi. Dibatasi seperti login.
  const guardCred = (ip: string, email: string) => {
    for (const [key, max, win] of [[`restore-ip:${ip}`, 10, 60 * 60_000], [`restore-email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`, 8, 15 * 60_000]] as const) {
      const r = lim.check(key, max, win);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan. Coba lagi nanti.', [], { 'Retry-After': String(r.retryAfterSec) });
    }
  };
  app.post('/auth/deleted-workspaces', async (req) => {
    const b = CredSchema.parse(req.body); guardCred(req.ip, b.email);
    return ok(await tenant.listDeleted(b));
  });
  app.post('/auth/restore-workspace', async (req) => {
    const b = RestoreSchema.parse(req.body); guardCred(req.ip, b.email);
    return ok(await tenant.restore({ email: b.email, password: b.password }, b.tenant_id, { ip: req.ip, requestId: req.id }));
  });

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

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'POST /auth/deleted-workspaces': { body: CredSchema },
  'POST /auth/restore-workspace': { body: RestoreSchema },
  'PATCH /tenant': { body: RenameSchema },
  'DELETE /tenant': { body: DeleteSchema },
};
