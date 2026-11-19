import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import { requireRole } from '../identity/guard.js';
import type { RateLimiter } from '../identity/rate-limit.js';
import { RateLimiter as Limiter } from '../identity/rate-limit.js';
import type { TeamActor, TeamService } from './team.service.js';

const Role = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
const PageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
const PatchSchema = z.strictObject({ role: Role.optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, 'minimal satu field (role atau status)');
const InviteSchema = z.strictObject({ email: z.email().max(254), role: Role.default('MEMBER') });
const AcceptSchema = z.strictObject({ token: z.string().min(10).max(200) });
const InvList = PageSchema.extend({ status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']).optional() });
const UserParam = z.object({ userId: z.string().max(64) });
const IdParam = z.object({ invitationId: z.string().max(64) });

export interface TeamRoutesOpts {
  team: TeamService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter?: RateLimiter;
}

export async function teamRoutes(app: FastifyInstance, { team, authenticate, limiter }: TeamRoutesOpts) {
  const lim = limiter ?? new Limiter();
  // Hanya pengguna dashboard (API key tidak dapat mengelola tim), peran OWNER/ADMIN.
  const manage = [authenticate, requireRole('OWNER', 'ADMIN')];
  const anyUser = [authenticate, requireRole('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')];
  const actor = (req: FastifyRequest): TeamActor => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, role: a.role, ip: req.ip, requestId: req.id };
  };

  app.get('/team/members', { preHandler: manage }, async (req) => {
    const q = PageSchema.parse(req.query);
    const { rows, total } = await team.listMembers(actor(req), { page: q.page, pageSize: q.page_size });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
  app.patch('/team/members/:userId', { preHandler: manage }, async (req) =>
    ok(await team.updateMember(actor(req), UserParam.parse(req.params).userId, PatchSchema.parse(req.body))));
  app.delete('/team/members/:userId', { preHandler: anyUser }, async (req) => // semua peran boleh keluar sendiri; matriks izin menolak selebihnya
    ok(await team.removeMember(actor(req), UserParam.parse(req.params).userId)));

  app.post('/team/invitations', { preHandler: manage }, async (req, reply) => {
    const b = InviteSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store'); // respons memuat token sekali tampil
    return reply.code(201).send(ok(await team.invite(actor(req), b)));
  });
  app.get('/team/invitations', { preHandler: manage }, async (req) => {
    const q = InvList.parse(req.query);
    const { rows, total } = await team.listInvitations(actor(req), { page: q.page, pageSize: q.page_size, status: q.status });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
  app.delete('/team/invitations/:invitationId', { preHandler: manage }, async (req) =>
    ok(await team.revokeInvitation(actor(req), IdParam.parse(req.params).invitationId)));
  // Terbitkan ulang tautan (token baru tampil sekali; token lama hangus). Pengganti email: tautan hilang tidak perlu undangan baru.
  app.post('/team/invitations/:invitationId/reissue', { preHandler: manage }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return ok(await team.reissueInvitation(actor(req), IdParam.parse(req.params).invitationId));
  });

  // Siapa pun yang login dapat menerima undangan yang ditujukan ke emailnya (tenant aktifnya tidak relevan).
  app.post('/team/invitations/accept', { preHandler: anyUser }, async (req) => {
    const a = actor(req);
    const r = lim.check(`invite-accept:${a.userId}`, 10, 15 * 60_000);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan; coba lagi nanti', [], { 'Retry-After': String(r.retryAfterSec) });
    return ok(await team.acceptInvitation(a.userId, AcceptSchema.parse(req.body).token, { ip: req.ip, requestId: req.id }));
  });
}
