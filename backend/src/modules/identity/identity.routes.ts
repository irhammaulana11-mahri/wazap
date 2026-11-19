import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'crypto';
import { config } from '../../config/env.js';
import { AppError, ok } from '../../http/errors.js';
import type { IdentityService, AuthResult } from './identity.service.js';
import { requireRole } from './guard.js';
import { RateLimiter } from './rate-limit.js';
import { API_KEY_SCOPES } from './principal.js';

export const REFRESH_COOKIE = 'wzp_rt';
const COOKIE_PATH = '/api/v1/auth';

const password = z.string().min(10, 'minimal 10 karakter').max(128);
const RegisterSchema = z.strictObject({
  email: z.email().max(254),
  password,
  tenant_name: z.string().trim().min(2).max(100),
});
const LoginSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128), tenant_id: z.uuid().optional() });
const ChangePasswordSchema = z.strictObject({ current_password: z.string().min(1).max(128), new_password: password });
const RecoveryCodeSchema = z.strictObject({ password: z.string().min(1).max(128) });
const ResetPasswordSchema = z.strictObject({ email: z.email().max(254), recovery_code: z.string().min(10).max(40), new_password: password });
const ChangeEmailSchema = z.strictObject({ password: z.string().min(1).max(128), new_email: z.email().max(254) });
const PatchKeySchema = z.strictObject({
  name: z.string().trim().min(2).max(100).optional(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
}).refine((v) => v.name !== undefined || v.scopes !== undefined, 'minimal satu field (name atau scopes)');
const SwitchSchema = z.strictObject({ tenant_id: z.uuid() });
const CreateKeySchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  expires_at: z.iso.datetime().optional(),
});
const PageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});
const IdParam = z.object({ keyId: z.string().max(64) });

export interface IdentityRoutesOpts {
  identity: IdentityService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiter?: RateLimiter;
}

export async function identityRoutes(app: FastifyInstance, opts: IdentityRoutesOpts) {
  const { identity, authenticate } = opts;
  const limiter = opts.limiter ?? new RateLimiter();
  const secureCookie = (config.COOKIE_SECURE ?? String(config.NODE_ENV === 'production')) === 'true';

  const limit = (key: string, max: number, windowMs: number) => {
    const r = limiter.check(key, max, windowMs);
    if (!r.allowed) {
      throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak percobaan. Coba lagi nanti.', [], {
        'Retry-After': String(r.retryAfterSec),
      });
    }
  };

  const setRefreshCookie = (reply: FastifyReply, r: AuthResult) =>
    reply.setCookie(REFRESH_COOKIE, r.refreshToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: r.refreshExpiresIn,
    });
  const clearRefreshCookie = (reply: FastifyReply) => reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });

  // refresh token tidak pernah ada di body; hanya cookie HttpOnly.
  const authBody = (r: AuthResult) => ({
    access_token: r.accessToken,
    token_type: 'Bearer',
    expires_in: r.expiresIn,
    user: r.user,
    tenant: r.tenant,
    role: r.role,
    ...(r.recoveryCodes ? { recovery_codes: r.recoveryCodes } : {}), // hanya saat mendaftar; sekali tampil
  });

  app.post('/auth/register', async (req, reply) => {
    limit(`reg:${req.ip}`, 5, 60 * 60_000);
    const b = RegisterSchema.parse(req.body);
    const r = await identity.register({ email: b.email, password: b.password, tenantName: b.tenant_name });
    setRefreshCookie(reply, r);
    reply.header('Cache-Control', 'no-store'); // respons memuat kode pemulihan sekali tampil
    return reply.code(201).send(ok(authBody(r)));
  });

  app.post('/auth/login', async (req, reply) => {
    limit(`login-ip:${req.ip}`, 20, 5 * 60_000);
    const b = LoginSchema.parse(req.body);
    const emailKey = createHash('sha256').update(b.email.trim().toLowerCase()).digest('hex');
    limit(`login-email:${emailKey}`, 8, 15 * 60_000);
    const r = await identity.login({ email: b.email, password: b.password, tenantId: b.tenant_id });
    setRefreshCookie(reply, r);
    return ok(authBody(r));
  });

  app.post('/auth/refresh', async (req, reply) => {
    limit(`refresh:${req.ip}`, 60, 5 * 60_000);
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Refresh token tidak ada');
    try {
      const r = await identity.refresh(token);
      setRefreshCookie(reply, r);
      return ok(authBody(r));
    } catch (e) {
      if (e instanceof AppError) clearRefreshCookie(reply);
      throw e;
    }
  });

  // Pindah workspace (hanya pengguna dashboard; API key terikat satu tenant). Rotasi cookie refresh ke tenant tujuan.
  app.post('/auth/switch-tenant', { preHandler: [authenticate, requireRole('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')] }, async (req, reply) => {
    limit(`switch:${req.ip}`, 30, 5 * 60_000);
    const b = SwitchSchema.parse(req.body);
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    const r = await identity.switchTenant(a.userId, b.tenant_id, req.cookies[REFRESH_COOKIE]);
    setRefreshCookie(reply, r);
    return ok(authBody(r));
  });

  // ---- akun (hanya pengguna dashboard) ----
  const account = [authenticate, requireRole('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')];
  const self = (req: FastifyRequest) => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, ip: req.ip, requestId: req.id };
  };
  // Kata sandi salah dijawab 403 INVALID_PASSWORD (bukan 401) agar klien tidak mengira access token kedaluwarsa dan masuk lingkaran refresh.
  app.post('/auth/change-password', { preHandler: account }, async (req, reply) => {
    const a = self(req);
    limit(`chpw:${a.userId}`, 5, 15 * 60_000);
    const b = ChangePasswordSchema.parse(req.body);
    const r = await identity.changePassword(a, { current: b.current_password, next: b.new_password });
    setRefreshCookie(reply, r); // sesi ini dilanjutkan; semua sesi lain dicabut
    return ok(authBody(r));
  });
  app.post('/auth/recovery-codes', { preHandler: account }, async (req, reply) => {
    const a = self(req);
    limit(`rcode:${a.userId}`, 5, 15 * 60_000);
    const b = RecoveryCodeSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store');
    return ok({ recovery_codes: (await identity.issueRecoveryCodes(a, b.password)).recoveryCodes });
  });
  app.post('/auth/recovery-codes/confirm', { preHandler: account }, async (req) => {
    await identity.confirmRecoveryCodes(self(req));
    return ok({ confirmed: true });
  });
  // Publik. Semua kegagalan dijawab sama (400 INVALID_RECOVERY); berhasil => semua sesi dicabut, sisa kode tetap berlaku.
  app.post('/auth/reset-password', async (req, reply) => {
    limit(`reset-ip:${req.ip}`, 10, 60 * 60_000);
    const b = ResetPasswordSchema.parse(req.body);
    limit(`reset-email:${createHash('sha256').update(b.email.trim().toLowerCase()).digest('hex')}`, 8, 15 * 60_000);
    const r = await identity.resetPassword({ email: b.email, recoveryCode: b.recovery_code, next: b.new_password }, { ip: req.ip, requestId: req.id });
    clearRefreshCookie(reply);
    return ok({ remaining_recovery_codes: r.remainingRecoveryCodes });
  });
  app.post('/auth/change-email', { preHandler: account }, async (req) => {
    const a = self(req);
    limit(`chemail:${a.userId}`, 5, 15 * 60_000);
    const b = ChangeEmailSchema.parse(req.body);
    return ok({ user: await identity.changeEmail(a, { password: b.password, newEmail: b.new_email }) });
  });
  app.post('/auth/logout-all', { preHandler: account }, async (req, reply) => {
    await identity.logoutAll(self(req));
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await identity.logout(token);
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: authenticate }, async (req) => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return ok({ ...(await identity.me(a.userId, a.tenantId)), role: a.role });
  });

  // ---- API keys (kelola: OWNER/ADMIN pengguna dashboard) ----
  const manage = [authenticate, requireRole('OWNER', 'ADMIN')];

  app.get('/api-keys', { preHandler: [authenticate, requireRole('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')] }, async (req) => {
    const { page, page_size } = PageSchema.parse(req.query);
    const { rows, total } = await identity.listApiKeys(req.auth!.tenantId, page, page_size);
    return ok(rows, { page, page_size, total });
  });

  app.post('/api-keys', { preHandler: manage }, async (req, reply) => {
    const a = req.auth!;
    const b = CreateKeySchema.parse(req.body);
    const exp = b.expires_at ? new Date(b.expires_at) : null;
    if (exp && exp.getTime() <= Date.now()) throw new AppError('VALIDATION_ERROR', 400, 'expires_at harus di masa depan');
    const created = await identity.createApiKey(a.tenantId, a.type === 'user' ? a.userId : null, {
      name: b.name,
      scopes: b.scopes,
      expiresAt: exp,
    });
    return reply.code(201).send(ok(created));
  });

  app.patch('/api-keys/:keyId', { preHandler: [authenticate, requireRole('OWNER', 'ADMIN')] }, async (req) => {
    const { keyId } = IdParam.parse(req.params);
    return ok(await identity.updateApiKey(self(req), keyId, PatchKeySchema.parse(req.body)));
  });

  app.delete('/api-keys/:keyId', { preHandler: manage }, async (req) => {
    const { keyId } = IdParam.parse(req.params);
    return ok(await identity.revokeApiKey(req.auth!.tenantId, keyId));
  });
}
