import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import { requireRole } from '../identity/guard.js';
import { RateLimiter } from '../identity/rate-limit.js';
import type { JoinService } from './join.service.js';
import type { TeamActor } from './team.service.js';

const Role = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
const RequestSchema = z.strictObject({ join_code: z.string().min(10).max(40), email: z.email().max(254), password: z.string().min(10, 'minimal 10 karakter').max(128) });
const ApproveSchema = z.strictObject({ role: Role.default('MEMBER') });
const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(),
});
const IdParam = z.object({ requestId: z.string().max(64) });

export interface JoinRoutesOpts {
  join: JoinService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter?: RateLimiter;
}

export async function joinRoutes(app: FastifyInstance, { join, authenticate, limiter }: JoinRoutesOpts) {
  const lim = limiter ?? new RateLimiter();
  const manage = [authenticate, requireRole('OWNER', 'ADMIN')];
  const actor = (req: FastifyRequest): TeamActor => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, role: a.role, ip: req.ip, requestId: req.id };
  };

  // Publik: pemohon belum punya sesi. Batas laju per IP melindungi dari penebakan kode (100 bit entropi) dan pembuatan akun massal.
  app.post('/auth/join-requests', async (req, reply) => {
    const r = lim.check(`join:${req.ip}`, 10, 60 * 60_000);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan. Coba lagi nanti.', [], { 'Retry-After': String(r.retryAfterSec) });
    const b = RequestSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store'); // respons dapat memuat kode pemulihan sekali tampil (akun baru)
    return reply.code(201).send(ok(await join.request({ joinCode: b.join_code, email: b.email, password: b.password }, { ip: req.ip, requestId: req.id })));
  });

  // Kode workspace (tampil sekali saat dibuat/diputar).
  app.get('/team/join-code', { preHandler: manage }, async (req) => ok(await join.getCode(actor(req))));
  app.put('/team/join-code', { preHandler: manage }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return ok(await join.rotateCode(actor(req)));
  });
  app.delete('/team/join-code', { preHandler: manage }, async (req) => ok(await join.disableCode(actor(req))));

  app.get('/team/join-requests', { preHandler: manage }, async (req) => {
    const q = ListSchema.parse(req.query);
    const { rows, total } = await join.list(actor(req), { page: q.page, pageSize: q.page_size, status: q.status });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
  app.post('/team/join-requests/:requestId/approve', { preHandler: manage }, async (req) =>
    ok(await join.approve(actor(req), IdParam.parse(req.params).requestId, ApproveSchema.parse(req.body ?? {}).role)));
  app.post('/team/join-requests/:requestId/reject', { preHandler: manage }, async (req) =>
    ok(await join.reject(actor(req), IdParam.parse(req.params).requestId)));
}
