import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Error domain dengan kode stabil (lihat docs/02_BACKEND/API_CONTRACT.md "Error codes"). */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details: unknown[] = [],
    public readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

export const ok = <T>(data: T, meta?: Record<string, unknown>) => ({ success: true, data, ...(meta ? { meta } : {}) });

function envelope(code: string, message: string, requestId: string, details: unknown[] = []) {
  return { success: false, error: { code, message, details }, request_id: requestId };
}

/** Galat koneksi/ketersediaan database (bukan bug aplikasi): klien sebaiknya mencoba lagi. */
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006']);
const DB_DOWN_MSG = /connection terminated|connection timeout|timeout exceeded when trying to connect|client has encountered a connection error|cannot use a pool after calling end|the database system is (starting up|shutting down)/i;
export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errors?: unknown[] } | undefined;
  if (!e) return false;
  if (e.code && DB_DOWN_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length && e.errors.every(isDbUnavailable)) return true; // AggregateError (IPv4+IPv6)
  return typeof e.message === 'string' && DB_DOWN_MSG.test(e.message);
}

export function installErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.status).send(envelope(err.code, err.message, req.id, err.details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.code(400).send(envelope('VALIDATION_ERROR', 'Request validation failed', req.id, details));
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST';
      return reply.code(status).send(envelope(code, 'Bad request', req.id));
    }
    if (isDbUnavailable(err)) {
      req.log.error({ err: { code: (err as { code?: string }).code, message: (err as Error).message } }, 'database tidak tersedia');
      return reply.code(503).header('retry-after', '2').send(envelope('SERVICE_UNAVAILABLE', 'Layanan sementara tidak tersedia, coba lagi sebentar lagi', req.id));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(envelope('INTERNAL_ERROR', 'Internal server error', req.id));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(envelope('NOT_FOUND', 'Route not found', req.id))
  );
}
