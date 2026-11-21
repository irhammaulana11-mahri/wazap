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
  app.get('/tenant/settings', { preHandler: [authenticate, requireAccess('usage:read', ['OWNER', 'MEMBER', 'VIEWER'])] }, async (req) => ok(await settings.get(req.auth!.tenantId)));
  // OWNER TIDAK lagi dapat mengubah kuota (ADR-054): diatur pemilik platform. Rute dipertahankan agar klien lama mendapat jawaban yang jelas, bukan 404.
  // MEMBER/VIEWER/API key tetap ditolak guard seperti biasa; OWNER mendapat 403 dengan kode khusus.
  app.patch('/tenant/settings', { preHandler: [authenticate, requireRole('OWNER')] }, async (req) => {
    if (req.auth!.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    PatchSchema.parse(req.body);
    throw new AppError('QUOTA_MANAGED_BY_PLATFORM', 403, 'Kuota workspace diatur oleh pemilik platform. Hubungi pemilik platform untuk menambah atau mengubah kuota.');
  });
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'PATCH /tenant/settings': { body: PatchSchema },
};
