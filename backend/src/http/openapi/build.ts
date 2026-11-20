import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OPERATIONS, type Operation } from './operations.js';
import * as S from './schemas.js';
import type { GuardMeta, RouteContract } from './types.js';
import { APP_VERSION } from '../../version.js';
import { routeContracts as identityC } from '../../modules/identity/identity.routes.js';
import { routeContracts as sessionsC } from '../../modules/sessions/sessions.routes.js';
import { routeContracts as messagesC } from '../../modules/messaging/messages.routes.js';
import { routeContracts as chatsC } from '../../modules/chats/chats.routes.js';
import { routeContracts as webhooksC } from '../../modules/webhooks/webhooks.routes.js';
import { routeContracts as teamC } from '../../modules/team/team.routes.js';
import { routeContracts as joinC } from '../../modules/team/join.routes.js';
import { routeContracts as usageC } from '../../modules/usage/usage.routes.js';
import { routeContracts as auditC } from '../../modules/audit/audit.routes.js';
import { routeContracts as tenantC } from '../../modules/tenant/tenant.routes.js';
import { routeContracts as settingsC } from '../../modules/tenant/settings.routes.js';

export const CONTRACTS: Record<string, RouteContract> = {
  ...identityC, ...sessionsC, ...messagesC, ...chatsC, ...webhooksC, ...teamC, ...joinC, ...usageC, ...auditC, ...tenantC, ...settingsC,
};

export interface CollectedRoute { key: string; method: string; url: string; guards: GuardMeta[] }

/** Normalisasi kunci operasi: tanpa awalan /api/v1. */
export const opKey = (method: string, url: string) => `${method.toUpperCase()} ${url.replace(/^\/api\/v1(?=\/|$)/, '')}`;

/**
 * Pasang SEBELUM `app.ready()`: mengumpulkan route nyata beserta guard-nya (metadata yang ditempelkan guard.ts), bukan daftar tulisan tangan.
 * HEAD/OPTIONS otomatis (Fastify/CORS) diabaikan.
 */
export function collectRoutes(app: FastifyInstance): () => CollectedRoute[] {
  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (o) => {
    const pre = o.preHandler ? (Array.isArray(o.preHandler) ? o.preHandler : [o.preHandler]) : [];
    const guards = pre.map((f) => (f as unknown as { guard?: GuardMeta }).guard).filter((g): g is GuardMeta => !!g);
    for (const m of Array.isArray(o.method) ? o.method : [o.method]) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      routes.push({ key: opKey(m, o.url), method: m, url: o.url, guards });
    }
  });
  return () => routes;
}

// ---------- JSON Schema ----------
const strip = (c: { jsonSchema: Record<string, unknown> }) => {
  const f = c.jsonSchema.format;
  if (f === 'date-time' || f === 'uuid' || f === 'email') delete c.jsonSchema.pattern; // pola regex panjang tidak informatif bagi pembaca
};
type Json = Record<string, any>;
function toSchema(schema: z.ZodType, io: 'input' | 'output', defs: Json): Json {
  const js = z.toJSONSchema(schema as z.core.$ZodType, { target: 'draft-2020-12', io, unrepresentable: 'any', metadata: S.registry as never, override: strip as never }) as Json;
  delete js.$schema;
  const rewrite = (x: unknown): Json => JSON.parse(JSON.stringify(x).replaceAll('#/$defs/', '#/components/schemas/'));
  for (const [id, raw] of Object.entries((js.$defs ?? {}) as Json)) {
    const d = rewrite(raw); // komponen yang merujuk komponen lain (mis. AuthSession -> User) juga harus ditulis ulang
    const prev = defs[id];
    if (prev && JSON.stringify(prev) !== JSON.stringify(d)) throw new Error(`Komponen ${id} berbeda antara dua operasi`);
    defs[id] = d;
  }
  delete js.$defs;
  return rewrite(js);
}
function objectParams(schema: z.ZodType, where: 'query' | 'path', defs: Json): Json[] {
  const js = toSchema(schema, 'input', defs);
  const req = new Set<string>(js.required ?? []);
  return Object.entries((js.properties ?? {}) as Json).map(([name, s]) => ({ name, in: where, required: where === 'path' ? true : req.has(name), schema: s }));
}

const ERR_TEXT: Record<number, string> = {
  400: 'Permintaan tidak valid (VALIDATION_ERROR)', 401: 'Kredensial tidak ada/tidak valid (UNAUTHENTICATED)', 403: 'Tidak berwenang (FORBIDDEN)',
  404: 'Tidak ditemukan (NOT_FOUND)', 409: 'Konflik status/kuota/duplikat', 413: 'Body terlalu besar', 422: 'Tidak dapat diproses (mis. URL ditolak)',
  429: 'Terlalu banyak permintaan (RATE_LIMITED); lihat header Retry-After', 503: 'Database sementara tidak tersedia (SERVICE_UNAVAILABLE); ulangi dengan backoff',
};
const STATUS_TEXT: Record<number, string> = { 200: 'Berhasil', 201: 'Dibuat', 202: 'Diterima (diproses asinkron)', 204: 'Berhasil tanpa isi' };

function securityOf(op: Operation, guards: GuardMeta[]) {
  const auth = guards.some((g) => g.kind === 'authenticate');
  if (!auth) return { security: [] as Json[], extra: { 'x-auth': 'publik' } as Json };
  const access = guards.find((g) => g.kind === 'access') as Extract<GuardMeta, { kind: 'access' }> | undefined;
  const role = guards.find((g) => g.kind === 'role') as Extract<GuardMeta, { kind: 'role' }> | undefined;
  const scope = guards.find((g) => g.kind === 'scope') as Extract<GuardMeta, { kind: 'scope' }> | undefined;
  if (access) return { security: [{ bearerAuth: [] }, { apiKeyAuth: [access.scope] }], extra: { 'x-roles': access.roles, 'x-required-scope': access.scope } };
  if (scope) return { security: [{ bearerAuth: [] }, { apiKeyAuth: [scope.scope] }], extra: { 'x-required-scope': scope.scope } };
  if (role) return { security: [{ bearerAuth: [] }], extra: { 'x-roles': role.roles, 'x-user-only': true } };
  return op.userOnly ? { security: [{ bearerAuth: [] }], extra: { 'x-user-only': true } } : { security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], extra: {} };
}

export function generateOpenApi(routes: CollectedRoute[]): Json {
  const byKey = new Map(routes.map((r) => [r.key, r]));
  const defs: Json = {};
  const paths: Json = {};
  const tags: string[] = [];
  for (const [key, op] of Object.entries(OPERATIONS)) {
    const [method, path] = key.split(' ') as [string, string];
    const route = byKey.get(key);
    if (!route) throw new Error(`Operasi terdokumentasi tanpa route: ${key}`);
    const c = CONTRACTS[key] ?? {};
    const { security, extra } = securityOf(op, route.guards);
    const full = (path.startsWith('/health') ? path : `/api/v1${path}`).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    if (!tags.includes(op.tag)) tags.push(op.tag);

    const parameters: Json[] = [];
    if (c.params) parameters.push(...objectParams(c.params, 'path', defs));
    if (c.query) parameters.push(...objectParams(c.query, 'query', defs));
    if (op.idempotency) parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Kunci idempotensi (ASCII tercetak, maks 255). Pengulangan dengan kunci yang sama tidak mengirim ganda.', schema: { type: 'string', maxLength: 255 } });
    if (op.cookie === 'reads-refresh') parameters.push({ name: 'wzp_rt', in: 'cookie', required: true, description: 'Refresh token (cookie HttpOnly yang dipasang saat login/register).', schema: { type: 'string' } });

    const responses: Json = {};
    for (const [status, schema] of Object.entries(op.responses)) {
      const code = Number(status);
      const r: Json = { description: STATUS_TEXT[code] ?? 'Berhasil' };
      if (schema) r.content = { 'application/json': { schema: toSchema(schema, 'output', defs) } };
      if (op.cookie === 'sets-refresh' && code < 300) r.headers = { 'Set-Cookie': { description: 'Refresh token (wzp_rt) sebagai cookie HttpOnly, Secure di production, SameSite=Strict, Path=/api/v1/auth.', schema: { type: 'string' } } };
      responses[status] = r;
    }
    const isHealth = path.startsWith('/health');
    const errs = new Set<number>(op.errors ?? []);
    if (c.params || c.query || c.body) errs.add(400);
    if (c.body) errs.add(413);
    if (c.params) errs.add(404);
    if (security.length) { errs.add(401); errs.add(403); }
    if (!isHealth) { errs.add(429); errs.add(503); }
    for (const e of [...errs].sort((a, b) => a - b)) if (!(e in responses)) responses[e] = { $ref: `#/components/responses/Error${e}` };

    const operation: Json = {
      operationId: `${method.toLowerCase()}_${path.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/_$/, '')}`,
      tags: [op.tag], summary: op.summary, ...(op.description ? { description: op.description } : {}),
      ...(parameters.length ? { parameters } : {}), security, ...extra,
    };
    if (c.body) operation.requestBody = { required: !c.bodyOptional, content: { 'application/json': { schema: toSchema(c.body, 'input', defs) } } };
    operation.responses = responses;
    (paths[full] ??= {})[method.toLowerCase()] = operation;
  }

  const errorResponses: Json = {};
  for (const [code, text] of Object.entries(ERR_TEXT)) errorResponses[`Error${code}`] = { description: text, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const errSchema = toSchema(S.ErrorBody, 'output', defs);
  if (!defs.Error) defs.Error = errSchema;
  return {
    openapi: '3.1.0',
    info: {
      title: 'WAZAP WhatsApp Gateway API', version: APP_VERSION,
      description: 'Dihasilkan otomatis dari kode (npm run openapi); jangan diedit tangan. Semua respons sukses berbentuk {success:true,data,meta?}; galat {success:false,error:{code,message,details},request_id}. Konsumen sebaiknya mengabaikan field baru yang tidak dikenal.',
    },
    servers: [{ url: '/' }],
    tags: tags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Access token (login/register) pengguna dashboard.' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'API key (gwk_...). Scope yang dibutuhkan tercantum per operasi; juga diterima sebagai Authorization: Bearer gwk_...' },
      },
      schemas: Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b))),
      responses: errorResponses,
    },
  };
}
