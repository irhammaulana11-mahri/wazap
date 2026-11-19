import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/env.js';
import { sessionRoutes } from './modules/sessions/sessions.routes.js';
import { createSessionService, type SessionService } from './modules/sessions/sessions.service.js';
import { messageRoutes } from './modules/messaging/messages.routes.js';
import { createMessageService, type MessageService } from './modules/messaging/messages.service.js';
import { webhookRoutes } from './modules/webhooks/webhooks.routes.js';
import { createWebhookService, type WebhookService } from './modules/webhooks/webhooks.service.js';
import { chatRoutes } from './modules/chats/chats.routes.js';
import { createChatService, type ChatService } from './modules/chats/chats.service.js';
import { teamRoutes } from './modules/team/team.routes.js';
import { createTeamService, type TeamService } from './modules/team/team.service.js';
import { usageRoutes } from './modules/usage/usage.routes.js';
import { createUsageService, type UsageService } from './modules/usage/usage.service.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { createAuditService, type AuditService } from './modules/audit/audit.service.js';
import { settingsRoutes } from './modules/tenant/settings.routes.js';
import { createSettingsService, type SettingsService } from './modules/tenant/settings.service.js';
import cookie from '@fastify/cookie';
import { randomUUID } from 'crypto';
import { createAuthenticate } from './modules/identity/guard.js';
import { createIdentityService, type IdentityService } from './modules/identity/identity.service.js';
import { identityRoutes } from './modules/identity/identity.routes.js';
import { RateLimiter } from './modules/identity/rate-limit.js';
import { tryGetCredentialCrypto } from './security/credential-crypto.js';
import { getGatewayDb } from './database/gateway.js';
import { AppError, installErrorHandling } from './http/errors.js';
import { healthRoutes } from './modules/health/health.routes.js';

export const APP_VERSION = '1.0.0';

const defaultCheckDb = async () => {
  try {
    return ((await getGatewayDb().pool.query('SELECT 1')).rowCount ?? 0) > 0;
  } catch {
    return false;
  }
};

export interface AppDeps {
  isShuttingDown?: () => boolean;
  checkDb?: () => Promise<boolean>;
  identity?: IdentityService;
  sessions?: SessionService;
  messages?: MessageService;
  webhooks?: WebhookService;
  chats?: ChatService;
  team?: TeamService;
  usage?: UsageService;
  audit?: AuditService;
  settings?: SettingsService;
  limiter?: RateLimiter;
  /** Pembatas laju API umum (IP + tenant). Default: instans baru dengan batas dari env. */
  apiLimiter?: RateLimiter;
  apiLimits?: { ipPerMinute: number; tenantPerMinute: number };
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    trustProxy: config.TRUST_PROXY === 'true',
    requestTimeout: config.REQUEST_TIMEOUT_MS, // tutup request yang mengalir terlalu lambat (slowloris)
    logger: {
      level: config.LOG_LEVEL,
      // Jangan pernah mencatat kredensial/secret.
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      transport:
        config.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
  });

  // CORS: dashboard memakai proxy same-origin, jadi default menolak origin lain.
  // Isi CORS_ORIGINS (pisah koma) bila frontend di-host di domain berbeda.
  app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  app.register(cookie);
  installErrorHandling(app);
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    // Header keamanan dasar untuk API JSON (tidak ada konten aktif/ramai-ramai embed).
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  // Batas laju per IP SEBELUM autentikasi (brute force / banjir permintaan); batas per tenant ada di authenticate.
  const apiLimiter = deps.apiLimiter ?? new RateLimiter();
  const limits = deps.apiLimits ?? { ipPerMinute: config.API_RATE_LIMIT_IP_PER_MINUTE, tenantPerMinute: config.API_RATE_LIMIT_TENANT_PER_MINUTE };
  app.addHook('onRequest', async (req) => {
    if (limits.ipPerMinute <= 0 || !req.url.startsWith('/api/v1/')) return;
    const r = apiLimiter.check(`api:ip:${req.ip}`, limits.ipPerMinute, 60_000);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 429, 'Terlalu banyak permintaan; coba lagi nanti', [], { 'Retry-After': String(r.retryAfterSec) });
  });

  // identity dibuat lazy agar tes health tidak memerlukan koneksi gateway DB
  const identity = deps.identity ?? createIdentityService(getGatewayDb());
  const authenticate = createAuthenticate(identity, { limiter: apiLimiter, perMinute: limits.tenantPerMinute });
  const messages = deps.messages ?? createMessageService(getGatewayDb());
  const webhooks = deps.webhooks ?? createWebhookService(getGatewayDb(), { crypto: tryGetCredentialCrypto(config) });
  const chats = deps.chats ?? createChatService(getGatewayDb());
  const team = deps.team ?? createTeamService(getGatewayDb());
  const usage = deps.usage ?? createUsageService(getGatewayDb());
  const audit = deps.audit ?? createAuditService(getGatewayDb());
  const settings = deps.settings ?? createSettingsService(getGatewayDb());
  const sessions = deps.sessions ?? createSessionService(getGatewayDb(), { crypto: tryGetCredentialCrypto(config) });

  // Health (publik, tanpa detail internal)
  app.register(healthRoutes, {
    checkDb: deps.checkDb ?? defaultCheckDb,
    isShuttingDown: deps.isShuttingDown ?? (() => false),
    version: APP_VERSION,
  });

  // Shortcut /qr dihapus: QR adalah kredensial login WhatsApp, tidak boleh publik.
  // Gunakan dashboard (terautentikasi) atau GET /api/v1/sessions/:id/qr dengan token.

  // Identity (register/login/refresh/logout/me + api-keys) -- kontrak baru
  app.register(
    async (scope) => {
      await scope.register(identityRoutes, { identity, authenticate, limiter: deps.limiter });
      await scope.register(sessionRoutes, { sessions, authenticate });
      await scope.register(messageRoutes, { messages, authenticate });
      await scope.register(webhookRoutes, { webhooks, authenticate });
      await scope.register(chatRoutes, { chats, authenticate });
      await scope.register(teamRoutes, { team, authenticate });
      await scope.register(usageRoutes, { usage, authenticate });
      await scope.register(auditRoutes, { audit, authenticate });
      await scope.register(settingsRoutes, { settings, authenticate });
    },
    { prefix: '/api/v1' }
  );

  return app;
}
