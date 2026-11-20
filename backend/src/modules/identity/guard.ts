import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../http/errors.js';
import type { IdentityService } from './identity.service.js';
import type { Principal, Role } from './principal.js';
import type { RateLimiter } from './rate-limit.js';
import type { GuardMeta } from '../../http/openapi/types.js';

/** Menempelkan metadata guard (dibaca generator OpenAPI); tidak mengubah perilaku fungsi. */
const tag = <F extends object>(fn: F, guard: GuardMeta): F => Object.assign(fn, { guard });

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Principal;
  }
}

function extractCredential(req: FastifyRequest): string | undefined {
  const k = req.headers['x-api-key'];
  if (typeof k === 'string' && k) return k.trim();
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

/** Menetapkan request.auth dari kredensial: API key (gwk_) atau access token. */
export function createAuthenticate(identity: IdentityService, tenantLimit?: { limiter: RateLimiter; perMinute: number }) {
  return tag(async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const cred = extractCredential(req);
    if (!cred) throw new AppError('UNAUTHENTICATED', 401, 'Kredensial tidak ada');
    const principal: Principal | null = cred.startsWith('gwk_')
      ? await identity.authenticateApiKey(cred)
      : await identity.authenticateAccessToken(cred);
    if (!principal) throw new AppError('UNAUTHENTICATED', 401, 'Kredensial tidak valid atau kedaluwarsa');
    req.auth = principal;
    // Batas laju per tenant (semua pengguna & API key tenant berbagi anggaran): satu tenant tidak dapat membanjiri API.
    if (tenantLimit && tenantLimit.perMinute > 0) {
      const r = tenantLimit.limiter.check(`api:tenant:${principal.tenantId}`, tenantLimit.perMinute, 60_000);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak permintaan; coba lagi nanti', [], { 'Retry-After': String(r.retryAfterSec) });
    }
  }, { kind: 'authenticate' });
}

/** Hanya pengguna dashboard (bukan API key) dengan salah satu role. */
export const requireRole =
  (...roles: Role[]) =>
  tag(async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    if (!roles.includes(a.role)) throw new AppError('FORBIDDEN', 403, 'Role tidak memiliki izin');
  }, { kind: 'role', roles });

/** API key harus memiliki scope; pengguna dashboard dinilai lewat role (lihat route). */
export const requireScope =
  (scope: string) =>
  tag(async (req: FastifyRequest) => {
    const a = req.auth;
    if (a?.type === 'apikey' && (a.scopes.includes('*') || a.scopes.includes(scope))) return;
    if (a?.type === 'user') return;
    throw new AppError('FORBIDDEN', 403, `Scope ${scope} diperlukan`);
  }, { kind: 'scope', scope });

/**
 * Otorisasi per-route: pengguna dashboard dinilai lewat role; API key lewat scope.
 */
export const requireAccess =
  (scope: string, roles: Role[]) =>
  tag(async (req: FastifyRequest) => {
    const a = req.auth;
    if (a?.type === 'user' && roles.includes(a.role)) return;
    if (a?.type === 'apikey' && (a.scopes.includes('*') || a.scopes.includes(scope))) return;
    throw new AppError('FORBIDDEN', 403, 'Tidak memiliki izin untuk operasi ini');
  }, { kind: 'access', scope, roles });
