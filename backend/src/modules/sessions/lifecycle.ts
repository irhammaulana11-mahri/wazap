import type pg from 'pg';
import { AppError } from '../../http/errors.js';

export const SESSION_STATES = [
  'CREATED', 'PENDING_ASSIGNMENT', 'INITIALIZING', 'QR_REQUIRED', 'CONNECTING', 'CONNECTED',
  'RECONNECTING', 'DISCONNECTING', 'DISCONNECTED', 'LOGGED_OUT', 'ERROR', 'DELETING', 'DELETED',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Sesi yang sedang dimiliki (atau akan dimiliki) engine dan menjalankan koneksi. */
export const OWNED_STATES: SessionState[] = ['INITIALIZING', 'QR_REQUIRED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'];

/** Aturan transisi terpusat (docs/02_BACKEND/SESSION_LIFECYCLE.md). */
export const TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['PENDING_ASSIGNMENT', 'DELETING'],
  PENDING_ASSIGNMENT: ['INITIALIZING', 'DISCONNECTED', 'DELETING'],
  INITIALIZING: ['QR_REQUIRED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'ERROR', 'LOGGED_OUT', 'PENDING_ASSIGNMENT', 'DISCONNECTING', 'DELETING'],
  QR_REQUIRED: ['CONNECTING', 'CONNECTED', 'ERROR', 'PENDING_ASSIGNMENT', 'DISCONNECTING', 'DELETING'],
  CONNECTING: ['CONNECTED', 'QR_REQUIRED', 'RECONNECTING', 'ERROR', 'LOGGED_OUT', 'PENDING_ASSIGNMENT', 'DISCONNECTING', 'DELETING'],
  CONNECTED: ['RECONNECTING', 'DISCONNECTING', 'LOGGED_OUT', 'ERROR', 'PENDING_ASSIGNMENT', 'DELETING'],
  RECONNECTING: ['CONNECTED', 'QR_REQUIRED', 'ERROR', 'LOGGED_OUT', 'PENDING_ASSIGNMENT', 'DISCONNECTING', 'DELETING'],
  DISCONNECTING: ['DISCONNECTED', 'ERROR', 'DELETING'],
  DISCONNECTED: ['PENDING_ASSIGNMENT', 'DELETING'],
  LOGGED_OUT: ['PENDING_ASSIGNMENT', 'DELETING'],
  ERROR: ['PENDING_ASSIGNMENT', 'DISCONNECTED', 'DELETING'],
  DELETING: ['DELETED'],
  DELETED: [],
};

export const canTransition = (from: SessionState, to: SessionState) => TRANSITIONS[from].includes(to);
export const allowedFrom = (to: SessionState): SessionState[] =>
  SESSION_STATES.filter((s) => TRANSITIONS[s].includes(to));

export type Actor = 'USER' | 'API_KEY' | 'SYSTEM' | 'ENGINE';

const SENSITIVE = /qr|cred|secret|token|password|passwd|auth|private|api[_-]?key|authorization|cookie|session[_-]?key/i;

/** Hapus kunci sensitif (QR, kredensial, token...) secara rekursif; batasi ukuran. Event tidak boleh membawa rahasia. */
export function sanitizePayload(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 4) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = sanitizePayload(v, depth + 1);
    else if (typeof v === 'string') out[k] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

export interface TransitionOpts {
  sessionId: string;
  to: SessionState;
  actor: Actor;
  /** Wajib untuk jalur tenant; null hanya untuk layanan platform. */
  tenantId: string | null;
  reason?: string;
  eventType?: string;
  payload?: unknown;
  set?: { desired_state?: 'CONNECTED' | 'DISCONNECTED'; phone_number?: string | null; auth_version?: number };
  /** Batasi dari status tertentu (mis. control-plane hanya dari PENDING_ASSIGNMENT). */
  onlyFrom?: SessionState[];
}

/**
 * Transisi atomik: validasi status asal dilakukan DI SQL (WHERE status = ANY(...)), sehingga aman dari race.
 * Event dicatat dalam transaksi yang sama. Mengembalikan baris sesi baru, atau null bila transisi tidak diizinkan.
 */
export async function transitionSession(c: pg.PoolClient, o: TransitionOpts) {
  const from = (o.onlyFrom ?? SESSION_STATES).filter((s) => canTransition(s, o.to));
  const prev = (await c.query('SELECT status FROM wa_sessions WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2) FOR UPDATE', [o.sessionId, o.tenantId])).rows[0];
  if (!prev || !from.includes(prev.status)) return null;
  const set = o.set ?? {};
  const row = (
    await c.query(
      `UPDATE wa_sessions SET status = $3::text, status_reason = $4,
         desired_state = COALESCE($5, desired_state),
         phone_number = CASE WHEN $6::boolean THEN $7 ELSE phone_number END,
         auth_version = COALESCE($8, auth_version),
         deleted_at = CASE WHEN $3::text = 'DELETED' THEN now() ELSE deleted_at END,
         engine_id = CASE WHEN $3::text IN ('PENDING_ASSIGNMENT','DISCONNECTED','LOGGED_OUT','ERROR','DELETING','DELETED','CREATED') THEN NULL ELSE engine_id END
       WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2) AND status = $9
       RETURNING id, tenant_id, session_name, phone_number, status, status_reason, desired_state, adapter, auth_version, created_at, updated_at`,
      [o.sessionId, o.tenantId, o.to, o.reason ?? null, set.desired_state ?? null,
       'phone_number' in set, set.phone_number ?? null, set.auth_version ?? null, prev.status]
    )
  ).rows[0];
  if (!row) return null;
  await c.query(
    `INSERT INTO wa_session_events (tenant_id, session_id, event_type, from_status, to_status, actor, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [row.tenant_id, row.id, o.eventType ?? 'session.status_changed', prev.status, o.to, o.actor,
     JSON.stringify(sanitizePayload({ reason: o.reason, ...(o.payload as object) }))]
  );
  return row as SessionRow;
}

export interface SessionRow {
  id: string; tenant_id: string; session_name: string; phone_number: string | null; status: SessionState;
  status_reason: string | null; desired_state: 'CONNECTED' | 'DISCONNECTED'; adapter: string;
  auth_version: number; created_at: Date; updated_at: Date;
}

export const invalidState = (status: string, action: string) =>
  new AppError('INVALID_STATE', 409, `Tidak dapat ${action} saat status sesi ${status}`);
