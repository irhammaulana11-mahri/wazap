import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../http/errors.js';
import type { GuardMeta } from '../../http/openapi/types.js';
import type { PlatformAdmin, PlatformService } from './platform.service.js';

declare module 'fastify' {
  interface FastifyRequest { platformAdmin?: PlatformAdmin }
}

const tag = <F extends object>(fn: F, guard: GuardMeta): F => Object.assign(fn, { guard });

/**
 * Guard rute platform: HANYA token platform (Authorization: Bearer). API key (X-API-Key) dan token workspace tidak pernah diterima di sini (kunci dan `typ` berbeda),
 * dan token platform tidak diterima di guard workspace. Tiap permintaan memvalidasi ulang admin dan akunnya di DB.
 */
export function createAuthenticatePlatform(platform: PlatformService) {
  return tag(async function authenticatePlatform(req: FastifyRequest, _reply: FastifyReply) {
    const h = req.headers['authorization'];
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 401, 'Kredensial tidak ada');
    const admin = await platform.authenticate(h.slice(7).trim());
    if (!admin) throw new AppError('UNAUTHENTICATED', 401, 'Kredensial tidak valid atau kedaluwarsa');
    req.platformAdmin = admin;
  }, { kind: 'platform' });
}
