import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok } from '../../http/errors.js';
import { requireAccess } from '../identity/guard.js';
import type { ChatService } from './chats.service.js';

import type { RouteContract } from '../../http/openapi/types.js';
const PageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
const ChatsQuery = PageSchema.extend({ session_id: z.uuid().optional() });
const IdParam = z.object({ chatId: z.string().max(64) });

export interface ChatRoutesOpts {
  chats: ChatService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function chatRoutes(app: FastifyInstance, { chats, authenticate }: ChatRoutesOpts) {
  const ALL = ['OWNER', 'MEMBER', 'VIEWER'] as const;
  const readMsgs = [authenticate, requireAccess('messages:read', [...ALL])];
  const readContacts = [authenticate, requireAccess('contacts:read', [...ALL])];

  app.get('/chats', { preHandler: readMsgs }, async (req) => {
    const q = ChatsQuery.parse(req.query);
    const { rows, total, capped } = await chats.listChats(req.auth!.tenantId, { page: q.page, pageSize: q.page_size, sessionId: q.session_id });
    return ok(rows, { page: q.page, page_size: q.page_size, total, ...(capped ? { total_capped: true } : {}) });
  });
  app.get('/chats/:chatId/messages', { preHandler: readMsgs }, async (req) => {
    const q = PageSchema.parse(req.query);
    const { chat, rows, total } = await chats.chatMessages(req.auth!.tenantId, IdParam.parse(req.params).chatId, { page: q.page, pageSize: q.page_size });
    return ok(rows, { page: q.page, page_size: q.page_size, total, chat });
  });
  app.get('/contacts', { preHandler: readContacts }, async (req) => {
    const q = PageSchema.parse(req.query);
    const { rows, total } = await chats.listContacts(req.auth!.tenantId, { page: q.page, pageSize: q.page_size });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
}

/** Skema request tiap route (sumber OpenAPI; skema yang sama dipakai handler di atas). */
export const routeContracts: Record<string, RouteContract> = {
  'GET /chats': { query: ChatsQuery },
  'GET /chats/:chatId/messages': { params: IdParam, query: PageSchema },
  'GET /contacts': { query: PageSchema },
};
