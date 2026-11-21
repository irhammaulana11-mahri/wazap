import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import type { RouteContract } from '../../http/openapi/types.js';
import { config } from '../../config/env.js';
import { RateLimiter } from '../identity/rate-limit.js';
import { createAuthenticatePlatform } from './platform.guard.js';
import type { PlatformService } from './platform.service.js';

const LoginBody = z.strictObject({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(128) });
const VerifyBody = z.strictObject({ mfa_token: z.string().min(10).max(2048), code: z.string().trim().min(6).max(32) });

const Reason = z.string().trim().min(3).max(500);
const Otp = z.string().trim().min(6).max(10);
const QuotaFields = { max_sessions: z.number().int().optional(), max_api_keys: z.number().int().optional(), max_members: z.number().int().optional(), messages_per_minute: z.number().int().optional() };
const hasQuota = (b: Record<string, unknown>) => ['max_sessions', 'max_api_keys', 'max_members', 'messages_per_minute'].some((k) => b[k] !== undefined);
const PatchQuotasBody = z.strictObject({ ...QuotaFields, reason: Reason, otp: Otp }).refine(hasQuota, { message: 'minimal satu kuota' });
const PatchDefaultsBody = z.strictObject({ ...QuotaFields, reason: Reason, otp: Otp }).refine(hasQuota, { message: 'minimal satu kuota' });
const ReasonOtpBody = z.strictObject({ reason: Reason, otp: Otp });
const IdParams = z.strictObject({ id: z.string().min(1).max(64) });
const Paging = { page: z.coerce.number().int().min(1).max(100000).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) };
const WorkspacesQuery = z.strictObject({ q: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED', 'ALL']).optional(), ...Paging });
const AuditQuery = z.strictObject({ tenant_id: z.string().min(1).max(64).optional(), action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(48).optional(), ...Paging });

export interface PlatformRoutesOpts { platform: PlatformService; limiter?: RateLimiter }

/**
 * Konsol platform (ADR-054). Seluruhnya di bawah /platform/*; PLATFORM_ENABLED=false membuatnya 404 (saklar mati operator). Respons tidak pernah di-cache.
 * Pembatasan laju tegas pada login; kunci per-admin di DB (PLATFORM_MAX_FAILED_OTP) melengkapi pembatas per-IP.
 */
export async function platformRoutes(app: FastifyInstance, { platform, limiter }: PlatformRoutesOpts) {
  const lim = limiter ?? new RateLimiter();
  const authenticate = createAuthenticatePlatform(platform);
  const limit = (key: string, max: number, windowMs: number) => {
    const r = lim.check(key, max, windowMs);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan; coba lagi nanti', [], { 'Retry-After': String(r.retryAfterSec) });
  };
  const meta = (req: FastifyRequest) => ({ ip: req.ip, requestId: req.id });

  app.addHook('onRequest', async () => { if (config.PLATFORM_ENABLED !== 'true') throw new AppError('NOT_FOUND', 404, 'Route not found'); });
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });

  app.post('/platform/auth/login', async (req) => {
    limit(`platform-login-ip:${req.ip}`, 10, 5 * 60_000);
    const b = LoginBody.parse(req.body);
    limit(`platform-login-email:${createHash('sha256').update(b.email.trim().toLowerCase()).digest('hex')}`, 5, 15 * 60_000);
    return ok(await platform.login({ email: b.email, password: b.password }, meta(req)));
  });

  app.post('/platform/auth/verify', async (req) => {
    limit(`platform-verify-ip:${req.ip}`, 20, 5 * 60_000);
    const b = VerifyBody.parse(req.body);
    return ok(await platform.verifyMfa({ mfaToken: b.mfa_token, code: b.code }, meta(req)));
  });

  /** Perubahan: satu admin paling banyak 30 perubahan per menit (sebelum kode TOTP dikonsumsi). */
  const mutateLimit = (req: FastifyRequest) => limit(`platform-mutate:${req.platformAdmin!.userId}`, 30, 60_000);
  const quotaOf = (b: { max_sessions?: number; max_api_keys?: number; max_members?: number; messages_per_minute?: number }) => ({ max_sessions: b.max_sessions, max_api_keys: b.max_api_keys, max_members: b.max_members, messages_per_minute: b.messages_per_minute });
  const pageMeta = (q: { page: number; page_size: number }, total: number) => ({ page: q.page, page_size: q.page_size, total });

  app.get('/platform/workspaces', { preHandler: [authenticate] }, async (req) => {
    const q = WorkspacesQuery.parse(req.query);
    const r = await platform.listWorkspaces({ q: q.q, status: q.status, page: q.page, pageSize: q.page_size });
    return ok(r.items, pageMeta(q, r.total));
  });
  app.get('/platform/workspaces/:id', { preHandler: [authenticate] }, async (req) => ok(await platform.getWorkspace(IdParams.parse(req.params).id)));
  app.patch('/platform/workspaces/:id/quotas', { preHandler: [authenticate] }, async (req) => {
    const { id } = IdParams.parse(req.params); const b = PatchQuotasBody.parse(req.body);
    mutateLimit(req);
    return ok(await platform.updateQuotas(req.platformAdmin!, id, quotaOf(b), b.reason, b.otp, meta(req)));
  });
  app.post('/platform/workspaces/:id/suspend', { preHandler: [authenticate] }, async (req) => {
    const { id } = IdParams.parse(req.params); const b = ReasonOtpBody.parse(req.body);
    mutateLimit(req);
    return ok(await platform.suspendWorkspace(req.platformAdmin!, id, b.reason, b.otp, meta(req)));
  });
  app.post('/platform/workspaces/:id/activate', { preHandler: [authenticate] }, async (req) => {
    const { id } = IdParams.parse(req.params); const b = ReasonOtpBody.parse(req.body);
    mutateLimit(req);
    return ok(await platform.activateWorkspace(req.platformAdmin!, id, b.reason, b.otp, meta(req)));
  });
  app.get('/platform/defaults', { preHandler: [authenticate] }, async () => ok(await platform.getDefaults()));
  app.patch('/platform/defaults', { preHandler: [authenticate] }, async (req) => {
    const b = PatchDefaultsBody.parse(req.body);
    mutateLimit(req);
    return ok(await platform.updateDefaults(req.platformAdmin!, quotaOf(b), b.reason, b.otp, meta(req)));
  });
  app.get('/platform/audit', { preHandler: [authenticate] }, async (req) => {
    const q = AuditQuery.parse(req.query);
    const r = await platform.listAudit({ page: q.page, pageSize: q.page_size, tenantId: q.tenant_id, action: q.action });
    return ok(r.items, pageMeta(q, r.total));
  });
  app.get('/platform/backup-status', { preHandler: [authenticate] }, async () => ok(await platform.backupStatus()));

  app.get('/platform/me', { preHandler: [authenticate] }, async (req) => ok({ user_id: req.platformAdmin!.userId, email: req.platformAdmin!.email }));
}

export const routeContracts: Record<string, RouteContract> = {
  'POST /platform/auth/login': { body: LoginBody },
  'POST /platform/auth/verify': { body: VerifyBody },
  'GET /platform/workspaces': { query: WorkspacesQuery },
  'GET /platform/workspaces/:id': { params: IdParams },
  'PATCH /platform/workspaces/:id/quotas': { params: IdParams, body: PatchQuotasBody },
  'POST /platform/workspaces/:id/suspend': { params: IdParams, body: ReasonOtpBody },
  'POST /platform/workspaces/:id/activate': { params: IdParams, body: ReasonOtpBody },
  'PATCH /platform/defaults': { body: PatchDefaultsBody },
  'GET /platform/audit': { query: AuditQuery },
};
