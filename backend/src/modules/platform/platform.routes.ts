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

  app.get('/platform/me', { preHandler: [authenticate] }, async (req) => ok({ user_id: req.platformAdmin!.userId, email: req.platformAdmin!.email }));
}

export const routeContracts: Record<string, RouteContract> = {
  'POST /platform/auth/login': { body: LoginBody },
  'POST /platform/auth/verify': { body: VerifyBody },
};
