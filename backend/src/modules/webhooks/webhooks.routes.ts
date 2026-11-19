import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok } from '../../http/errors.js';
import { requireAccess } from '../identity/guard.js';
import { WEBHOOK_EVENTS, type WebhookService } from './webhooks.service.js';

const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const CreateSchema = z.strictObject({
  url: z.string().max(2048),
  description: z.string().trim().max(200).optional(),
  events: Events.default(['*']),
});
const PatchSchema = z.strictObject({
  url: z.string().max(2048).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  events: Events.optional(),
  active: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, 'minimal satu field');
const PageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) });
const DeliveriesQuery = PageSchema.extend({ status: z.enum(['PENDING', 'DELIVERED', 'DEAD']).optional() });
const IdParam = z.object({ webhookId: z.string().max(64) });
const DeliveryParam = IdParam.extend({ deliveryId: z.string().max(64) });

export interface WebhookRoutesOpts {
  webhooks: WebhookService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function webhookRoutes(app: FastifyInstance, { webhooks, authenticate }: WebhookRoutesOpts) {
  // Konfigurasi webhook menyangkut secret & egress: hanya OWNER/ADMIN (atau API key ber-scope webhooks:manage).
  const manage = [authenticate, requireAccess('webhooks:manage', ['OWNER', 'ADMIN'])];
  const id = (req: FastifyRequest) => IdParam.parse(req.params).webhookId;

  app.post('/webhooks', { preHandler: manage }, async (req, reply) => {
    const b = CreateSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(ok(await webhooks.create(req.auth!.tenantId, b)));
  });
  app.get('/webhooks', { preHandler: manage }, async (req) => {
    const q = PageSchema.parse(req.query);
    const { rows, total } = await webhooks.list(req.auth!.tenantId, { page: q.page, pageSize: q.page_size });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
  app.patch('/webhooks/:webhookId', { preHandler: manage }, async (req) => ok(await webhooks.update(req.auth!.tenantId, id(req), PatchSchema.parse(req.body))));
  app.delete('/webhooks/:webhookId', { preHandler: manage }, async (req) => ok(await webhooks.remove(req.auth!.tenantId, id(req))));
  app.post('/webhooks/:webhookId/rotate-secret', { preHandler: manage }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return ok(await webhooks.rotateSecret(req.auth!.tenantId, id(req)));
  });
  app.post('/webhooks/:webhookId/test', { preHandler: manage }, async (req, reply) => reply.code(202).send(ok(await webhooks.test(req.auth!.tenantId, id(req)))));
  app.get('/webhooks/:webhookId/deliveries', { preHandler: manage }, async (req) => {
    const q = DeliveriesQuery.parse(req.query);
    const { rows, total } = await webhooks.deliveries(req.auth!.tenantId, id(req), { page: q.page, pageSize: q.page_size, status: q.status });
    return ok(rows, { page: q.page, page_size: q.page_size, total });
  });
  app.get('/webhooks/:webhookId/deliveries/:deliveryId', { preHandler: manage }, async (req) => {
    const p = DeliveryParam.parse(req.params);
    return ok(await webhooks.delivery(req.auth!.tenantId, p.webhookId, p.deliveryId));
  });
  app.post('/webhooks/:webhookId/deliveries/:deliveryId/replay', { preHandler: manage }, async (req, reply) => {
    const p = DeliveryParam.parse(req.params);
    return reply.code(202).send(ok(await webhooks.replay(req.auth!.tenantId, p.webhookId, p.deliveryId)));
  });
}
