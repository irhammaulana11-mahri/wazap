import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { ok } from '../../http/errors.js';
import { requireAccess } from '../identity/guard.js';
import { SESSION_STATES } from './lifecycle.js';
import type { SessionService } from './sessions.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
const Name = z.string().trim().min(2).max(50).regex(/^[\p{L}\p{N} _.\-]+$/u, 'hanya huruf, angka, spasi, titik, garis bawah, strip');
const CreateSchema = z.strictObject({ session_name: Name, auto_connect: z.boolean().default(true) });
const RenameSchema = z.strictObject({ session_name: Name });
const PageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
const ListSchema = PageSchema.extend({ status: z.enum(SESSION_STATES).optional() });
const IdParam = z.object({ sessionId: z.string().max(64) });

export interface SessionRoutesOpts {
  sessions: SessionService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function sessionRoutes(app: FastifyInstance, { sessions, authenticate }: SessionRoutesOpts) {
  const read = [authenticate, requireAccess('sessions:read', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])];
  const write = [authenticate, requireAccess('sessions:write', ['OWNER', 'ADMIN', 'MEMBER'])];
  const id = (req: FastifyRequest) => IdParam.parse(req.params).sessionId;

  app.post('/sessions', { preHandler: write }, async (req, reply) => {
    const b = CreateSchema.parse(req.body);
    const s = await sessions.create(req.auth!, { name: b.session_name, autoConnect: b.auto_connect });
    return reply.code(201).send(ok(s));
  });

  app.get('/sessions', { preHandler: read }, async (req) => {
    const q = ListSchema.parse(req.query);
    const { rows, total } = await sessions.list(req.auth!.tenantId, { page: q.page, pageSize: q.page_size, status: q.status });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });

  app.patch('/sessions/:sessionId', { preHandler: write }, async (req) => ok(await sessions.rename(req.auth!, id(req), RenameSchema.parse(req.body).session_name)));

  app.get('/sessions/:sessionId', { preHandler: read }, async (req) => ok(await sessions.get(req.auth!.tenantId, id(req))));

  app.get('/sessions/:sessionId/status', { preHandler: read }, async (req) => {
    const s = await sessions.get(req.auth!.tenantId, id(req));
    return ok({ id: s.id, status: s.status, status_reason: s.status_reason, desired_state: s.desired_state, updated_at: s.updated_at });
  });

  app.get('/sessions/:sessionId/events', { preHandler: read }, async (req) => {
    const q = PageSchema.parse(req.query);
    const { rows, total } = await sessions.events(req.auth!.tenantId, id(req), q.page, q.page_size);
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });

  // QR pairing (rahasia, berumur pendek): hanya untuk yang boleh mengelola sesi; tidak boleh di-cache.
  app.get('/sessions/:sessionId/qr', { preHandler: write }, async (req, reply) => {
    const q = await sessions.getQr(req.auth!.tenantId, id(req));
    reply.header('Cache-Control', 'no-store');
    return ok({ qr: q.qr, qr_data_url: await QRCode.toDataURL(q.qr), expires_at: q.expires_at });
  });

  app.post('/sessions/:sessionId/connect', { preHandler: write }, async (req, reply) =>
    reply.code(202).send(ok(await sessions.connect(req.auth!, id(req)))));
  app.post('/sessions/:sessionId/disconnect', { preHandler: write }, async (req, reply) =>
    reply.code(202).send(ok(await sessions.disconnect(req.auth!, id(req)))));
  app.post('/sessions/:sessionId/reconnect', { preHandler: write }, async (req, reply) =>
    reply.code(202).send(ok(await sessions.reconnect(req.auth!, id(req)))));
  app.delete('/sessions/:sessionId', { preHandler: write }, async (req, reply) =>
    reply.code(202).send(ok(await sessions.remove(req.auth!, id(req)))));
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'POST /sessions': { body: CreateSchema },
  'GET /sessions': { query: ListSchema },
  'PATCH /sessions/:sessionId': { params: IdParam, body: RenameSchema },
  'GET /sessions/:sessionId': { params: IdParam },
  'GET /sessions/:sessionId/status': { params: IdParam },
  'GET /sessions/:sessionId/events': { params: IdParam, query: PageSchema },
  'GET /sessions/:sessionId/qr': { params: IdParam },
  'POST /sessions/:sessionId/connect': { params: IdParam },
  'POST /sessions/:sessionId/disconnect': { params: IdParam },
  'POST /sessions/:sessionId/reconnect': { params: IdParam },
  'DELETE /sessions/:sessionId': { params: IdParam },
};
