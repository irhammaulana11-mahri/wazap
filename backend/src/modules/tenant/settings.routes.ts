import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import { requireAccess, requireRole } from '../identity/guard.js';
import type { SettingsService } from './settings.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
const PatchSchema = z.strictObject({
  max_sessions: z.number().int().optional(),
  max_api_keys: z.number().int().optional(),
  max_members: z.number().int().optional(),
  messages_per_minute: z.number().int().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), 'minimal satu field');

export interface SettingsRoutesOpts {
  settings: SettingsService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function settingsRoutes(app: FastifyInstance, { settings, authenticate }: SettingsRoutesOpts) {
  // Baca: semua peran dashboard (atau API key ber-scope usage:read, sama dengan /usage/summary). Ubah: hanya OWNER dashboard.
  app.get('/tenant/settings', { preHandler: [authenticate, requireAccess('usage:read', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])] }, async (req) => ok(await settings.get(req.auth!.tenantId)));
  app.patch('/tenant/settings', { preHandler: [authenticate, requireRole('OWNER')] }, async (req) => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return ok(await settings.update({ userId: a.userId, tenantId: a.tenantId, ip: req.ip, requestId: req.id }, PatchSchema.parse(req.body)));
  });
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'PATCH /tenant/settings': { body: PatchSchema },
};
