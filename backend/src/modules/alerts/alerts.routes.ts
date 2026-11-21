import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ok } from '../../http/errors.js';
import type { RouteContract } from '../../http/openapi/types.js';
import { config } from '../../config/env.js';
import { requireRole } from '../identity/guard.js';
import type { IdentityService } from '../identity/identity.service.js';
import { RateLimiter } from '../identity/rate-limit.js';
import type { AlertActor, AlertService } from './alerts.service.js';
import { RULE_CODES } from './rules.js';

const Pw = z.string().min(1).max(128);
const Name = z.string().trim().min(1).max(60);
const TelegramBody = z.strictObject({ type: z.literal('TELEGRAM'), name: Name, token: z.string().min(10).max(100), chat_id: z.string().min(1).max(40), password: Pw });
const SlackBody = z.strictObject({ type: z.literal('SLACK'), name: Name, url: z.string().min(10).max(2048), password: Pw });
const CreateChannelBody = z.discriminatedUnion('type', [TelegramBody, SlackBody]);
const PatchChannelBody = z.strictObject({
  name: Name.optional(), active: z.boolean().optional(), password: Pw.optional(),
  token: z.string().min(10).max(100).optional(), chat_id: z.string().min(1).max(40).optional(), url: z.string().min(10).max(2048).optional(),
}).refine((b) => b.name !== undefined || b.active !== undefined || b.token !== undefined || b.chat_id !== undefined || b.url !== undefined, { message: 'Tidak ada perubahan' });
const DeleteChannelBody = z.strictObject({ password: Pw });
const IdParams = z.strictObject({ channelId: z.string().min(1).max(64) });
const CodeParams = z.strictObject({ code: z.enum(RULE_CODES) });
const PutRuleBody = z.strictObject({ enabled: z.boolean(), threshold: z.number().int().optional(), cooldown_minutes: z.number().int().min(5).max(1440).optional(), channel_ids: z.array(z.uuid()).max(5) });
const DeliveriesQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export interface AlertRoutesOpts { alerts: AlertService; identity: IdentityService; authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>; limiter?: RateLimiter }

/** Notifikasi alarm per workspace (ADR-049). OWNER pengguna dashboard (API key ditolak). Membuat kanal, mengganti target, dan menghapus meminta kata sandi. */
export async function alertRoutes(app: FastifyInstance, { alerts, identity, authenticate, limiter }: AlertRoutesOpts) {
  const lim = limiter ?? new RateLimiter();
  const manage = [authenticate, requireRole('OWNER')];
  const anyUser = [authenticate, requireRole('OWNER', 'MEMBER', 'VIEWER')];
  const actor = (req: FastifyRequest): AlertActor => {
    const a = req.auth!;
    if (a.type !== 'user') throw new AppError('FORBIDDEN', 403, 'Endpoint ini hanya untuk pengguna dashboard');
    return { userId: a.userId, tenantId: a.tenantId, role: a.role, ip: req.ip, requestId: req.id };
  };
  const tooMany = (retryAfterSec: number, message: string) => new AppError('RATE_LIMITED', 429, message, [], { 'Retry-After': String(retryAfterSec) });
  /** Konfirmasi kata sandi: hanya percobaan SALAH dihitung (5 per 15 menit); penguncian dicek SEBELUM verifikasi. */
  async function stepUp(a: AlertActor, password: string) {
    const key = `alert-pw:${a.userId}`;
    const gate = lim.blocked(key, 5);
    if (gate.blocked) throw tooMany(gate.retryAfterSec, 'Terlalu banyak percobaan; coba lagi nanti');
    try { await identity.confirmPassword(a.userId, password); }
    catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_PASSWORD') { const r = lim.check(key, 5, 15 * 60_000); if (!r.allowed) throw tooMany(r.retryAfterSec, 'Terlalu banyak percobaan; coba lagi nanti'); }
      throw err;
    }
  }

  app.get('/alerts/catalog', { preHandler: anyUser }, async () => ok(alerts.catalog()));
  app.get('/alerts/channels', { preHandler: manage }, async (req) => ok(await alerts.listChannels(actor(req).tenantId)));
  app.post('/alerts/channels', { preHandler: manage }, async (req, reply) => {
    const a = actor(req); const b = CreateChannelBody.parse(req.body);
    await stepUp(a, b.password);
    const created = await alerts.createChannel(a, b.type === 'TELEGRAM' ? { type: 'TELEGRAM', name: b.name, token: b.token, chat_id: b.chat_id } : { type: 'SLACK', name: b.name, url: b.url });
    return reply.code(201).send(ok(created));
  });
  app.patch('/alerts/channels/:channelId', { preHandler: manage }, async (req) => {
    const a = actor(req); const { channelId } = IdParams.parse(req.params); const b = PatchChannelBody.parse(req.body);
    const targetGiven = b.token !== undefined || b.chat_id !== undefined || b.url !== undefined;
    if (targetGiven) {
      if (!b.password) throw new AppError('VALIDATION_ERROR', 400, 'Mengganti target kanal memerlukan kata sandi');
      await stepUp(a, b.password);
    }
    let target: Parameters<AlertService['updateChannel']>[2]['target'];
    if (targetGiven) {
      const cur = (await alerts.listChannels(a.tenantId)).find((c: any) => c.id === channelId);
      if (!cur) throw new AppError('NOT_FOUND', 404, 'Kanal tidak ditemukan');
      if (cur.type === 'TELEGRAM') {
        if (b.token === undefined || b.chat_id === undefined) throw new AppError('VALIDATION_ERROR', 400, 'Telegram: token dan chat_id wajib dikirim bersama');
        target = { type: 'TELEGRAM', name: cur.name, token: b.token, chat_id: b.chat_id };
      } else {
        if (b.url === undefined) throw new AppError('VALIDATION_ERROR', 400, 'Slack: url wajib');
        target = { type: 'SLACK', name: cur.name, url: b.url };
      }
    }
    return ok(await alerts.updateChannel(a, channelId, { name: b.name, active: b.active, target }));
  });
  app.delete('/alerts/channels/:channelId', { preHandler: manage }, async (req) => {
    const a = actor(req); const { channelId } = IdParams.parse(req.params); const b = DeleteChannelBody.parse(req.body);
    await stepUp(a, b.password);
    return ok(await alerts.deleteChannel(a, channelId));
  });
  app.post('/alerts/channels/:channelId/test', { preHandler: manage }, async (req) => {
    const a = actor(req); const { channelId } = IdParams.parse(req.params);
    const r = lim.check(`alert-test:${a.tenantId}`, config.ALERTS_TEST_PER_HOUR, 60 * 60_000);
    if (!r.allowed) throw tooMany(r.retryAfterSec, `Batas ${config.ALERTS_TEST_PER_HOUR} uji per jam tercapai; coba lagi nanti`);
    const res = await alerts.testChannel(a.tenantId, channelId);
    return ok({ ok: res.ok, status_code: res.statusCode ?? null, error_code: res.errorCode ?? null, duration_ms: res.durationMs });
  });
  app.get('/alerts/rules', { preHandler: manage }, async (req) => ok(await alerts.listRules(actor(req).tenantId)));
  app.put('/alerts/rules/:code', { preHandler: manage }, async (req) => {
    const a = actor(req); const { code } = CodeParams.parse(req.params); const b = PutRuleBody.parse(req.body);
    return ok(await alerts.putRule(a, code, b));
  });
  app.get('/alerts/deliveries', { preHandler: manage }, async (req) => { const a = actor(req); return ok(await alerts.deliveries(a.tenantId, DeliveriesQuery.parse(req.query).limit)); });
}

export const routeContracts: Record<string, RouteContract> = {
  'POST /alerts/channels': { body: CreateChannelBody },
  'PATCH /alerts/channels/:channelId': { params: IdParams, body: PatchChannelBody },
  'DELETE /alerts/channels/:channelId': { params: IdParams, body: DeleteChannelBody },
  'POST /alerts/channels/:channelId/test': { params: IdParams },
  'PUT /alerts/rules/:code': { params: CodeParams, body: PutRuleBody },
  'GET /alerts/deliveries': { query: DeliveriesQuery },
};
