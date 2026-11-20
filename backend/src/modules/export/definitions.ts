import type pg from 'pg';

/**
 * Definisi tiap jenis ekspor (ADR-048): daftar kolom (DAFTAR PUTIH eksplisit, bukan SELECT *), kueri hitung terbatas, dan kueri batch keyset.
 * Semua kueri berjalan dengan konteks RLS tenant; filter tenant_id di sini hanya pagar kedua (sabuk dan bretel), RLS tetap sumber isolasi.
 * Kursor keyset membawa nilai waktu sebagai TEKS berpresisi mikrodetik (Date JS hanya milidetik dan akan menggandakan/melewatkan baris).
 */
export const EXPORT_TYPES = ['messages', 'outbound', 'chats', 'contacts', 'audit-logs', 'members'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export interface Filters {
  /** Batas bawah (inklusif) jenis berentang waktu. */
  from?: Date;
  /** Batas atas EFEKTIF (eksklusif) = min(permintaan, waktu mulai): hasil deterministik walau data terus masuk. */
  to: Date;
  /** Waktu mulai ekspor: batas created_at untuk jenis tanpa rentang (chats, members). */
  startedAt: Date;
  sessionId?: string;
  direction?: 'IN' | 'OUT';
  status?: string;
}
export type Row = Record<string, unknown>;
export interface Batch { rows: Row[]; cursor: string[] | null }
export interface ExportDef {
  columns: string[];
  needsRange: boolean;
  /** Jumlah baris, dihentikan di cap+1 (cukup untuk menolak yang terlalu besar tanpa menghitung semuanya). */
  count(c: pg.PoolClient, tenantId: string, f: Filters, cap: number): Promise<number>;
  batch(c: pg.PoolClient, tenantId: string, f: Filters, cursor: string[] | null, limit: number): Promise<Batch>;
}

/** Penampung parameter berposisi: p(v) menambahkan nilai dan mengembalikan penanda $n. */
const params = () => { const a: unknown[] = []; return { a, p: (v: unknown) => (a.push(v), `$${a.length}`) }; };
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const cappedCount = async (c: pg.PoolClient, from: string, where: string, a: unknown[], cap: number): Promise<number> =>
  (await c.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${from} WHERE ${where} LIMIT ${cap + 1}) x`, a)).rows[0].n;

// ---------------- messages ----------------
function messageConds(tenantId: string, f: Filters, p: (v: unknown) => string) {
  const w = [`m.tenant_id = ${p(tenantId)}`, `m.occurred_at >= ${p(f.from)}`, `m.occurred_at < ${p(f.to)}`];
  if (f.sessionId) w.push(`m.session_id = ${p(f.sessionId)}`);
  if (f.direction) w.push(`m.direction = ${p(f.direction)}`);
  return w;
}
const messages: ExportDef = {
  columns: ['occurred_at', 'direction', 'session_id', 'session_name', 'chat_id', 'contact_phone', 'contact_name', 'type', 'text', 'text_purged', 'status', 'provider_message_id', 'job_id'],
  needsRange: true,
  async count(c, tenantId, f, cap) {
    const { a, p } = params();
    return cappedCount(c, 'wa_messages m', messageConds(tenantId, f, p).join(' AND '), a, cap);
  },
  async batch(c, tenantId, f, cursor, limit) {
    const { a, p } = params();
    const w = messageConds(tenantId, f, p);
    if (cursor) w.push(`(m.occurred_at, m.id) > (${p(cursor[0])}::timestamptz, ${p(cursor[1])}::uuid)`);
    const r = await c.query(
      `SELECT m.occurred_at, m.direction, m.session_id, s.session_name, m.chat_id, ch.contact_phone, ch.display_name AS contact_name,
              m.message_type AS type, m.body AS text, (m.body_purged_at IS NOT NULL) AS text_purged, m.status, m.provider_message_id, m.queue_id AS job_id,
              to_char(m.occurred_at AT TIME ZONE 'UTC', ${ISO_US}) AS _c1, m.id AS _c2
         FROM wa_messages m
         JOIN wa_chats ch ON ch.tenant_id = m.tenant_id AND ch.id = m.chat_id
         JOIN wa_sessions s ON s.tenant_id = m.tenant_id AND s.id = m.session_id
        WHERE ${w.join(' AND ')} ORDER BY m.occurred_at, m.id LIMIT ${p(limit)}`, a);
    return finish(r.rows, ['_c1', '_c2']);
  },
};

// ---------------- outbound (laporan pengiriman) ----------------
function outboundConds(tenantId: string, f: Filters, p: (v: unknown) => string) {
  const w = [`q.tenant_id = ${p(tenantId)}`, `q.created_at >= ${p(f.from)}`, `q.created_at < ${p(f.to)}`];
  if (f.sessionId) w.push(`q.session_id = ${p(f.sessionId)}`);
  if (f.status) w.push(`q.status = ${p(f.status)}`);
  return w;
}
const outbound: ExportDef = {
  columns: ['created_at', 'job_id', 'session_id', 'to', 'type', 'status', 'attempts', 'last_error_code', 'provider_message_id', 'scheduled_at', 'completed_at', 'content_purged'],
  needsRange: true,
  async count(c, tenantId, f, cap) {
    const { a, p } = params();
    return cappedCount(c, 'message_queue q', outboundConds(tenantId, f, p).join(' AND '), a, cap);
  },
  async batch(c, tenantId, f, cursor, limit) {
    const { a, p } = params();
    const w = outboundConds(tenantId, f, p);
    if (cursor) w.push(`(q.created_at, q.id) > (${p(cursor[0])}::timestamptz, ${p(cursor[1])}::uuid)`);
    const r = await c.query(
      `SELECT q.created_at, q.id AS job_id, q.session_id, q.recipient AS "to", q.message_type AS type, q.status, q.attempts, q.last_error_code,
              q.provider_message_id, q.scheduled_at, q.completed_at, (q.content_purged_at IS NOT NULL) AS content_purged,
              to_char(q.created_at AT TIME ZONE 'UTC', ${ISO_US}) AS _c1, q.id AS _c2
         FROM message_queue q WHERE ${w.join(' AND ')} ORDER BY q.created_at, q.id LIMIT ${p(limit)}`, a);
    return finish(r.rows, ['_c1', '_c2']);
  },
};

// ---------------- chats ----------------
function chatConds(tenantId: string, f: Filters, p: (v: unknown) => string) {
  const w = [`c.tenant_id = ${p(tenantId)}`, `c.created_at < ${p(f.startedAt)}`];
  if (f.sessionId) w.push(`c.session_id = ${p(f.sessionId)}`);
  return w;
}
const chats: ExportDef = {
  columns: ['chat_id', 'session_id', 'contact_phone', 'contact_name', 'jid', 'last_message_at', 'created_at'],
  needsRange: false,
  async count(c, tenantId, f, cap) {
    const { a, p } = params();
    return cappedCount(c, 'wa_chats c', chatConds(tenantId, f, p).join(' AND '), a, cap);
  },
  async batch(c, tenantId, f, cursor, limit) {
    const { a, p } = params();
    const w = chatConds(tenantId, f, p);
    if (cursor) w.push(`c.id > ${p(cursor[0])}::uuid`);
    const r = await c.query(
      `SELECT c.id AS chat_id, c.session_id, c.contact_phone, c.display_name AS contact_name, c.remote_jid AS jid, c.last_message_at, c.created_at, c.id AS _c1
         FROM wa_chats c WHERE ${w.join(' AND ')} ORDER BY c.id LIMIT ${p(limit)}`, a);
    return finish(r.rows, ['_c1']);
  },
};

// ---------------- contacts (digabung per nomor, seperti GET /contacts) ----------------
const contacts: ExportDef = {
  columns: ['phone', 'name', 'chats', 'last_message_at'],
  needsRange: false,
  async count(c, tenantId, _f, cap) {
    const { a, p } = params();
    return (await c.query(`SELECT count(*)::int AS n FROM (SELECT DISTINCT contact_phone FROM wa_chats WHERE tenant_id = ${p(tenantId)} AND contact_phone IS NOT NULL LIMIT ${cap + 1}) x`, a)).rows[0].n;
  },
  async batch(c, tenantId, _f, cursor, limit) {
    const { a, p } = params();
    const w = [`tenant_id = ${p(tenantId)}`, 'contact_phone IS NOT NULL'];
    if (cursor) w.push(`contact_phone > ${p(cursor[0])}`);
    const r = await c.query(
      `SELECT contact_phone AS phone, (array_agg(display_name ORDER BY last_message_at DESC NULLS LAST) FILTER (WHERE display_name IS NOT NULL))[1] AS name,
              count(*)::int AS chats, max(last_message_at) AS last_message_at, contact_phone AS _c1
         FROM wa_chats WHERE ${w.join(' AND ')} GROUP BY contact_phone ORDER BY contact_phone LIMIT ${p(limit)}`, a);
    return finish(r.rows, ['_c1']);
  },
};

// ---------------- audit-logs ----------------
function auditConds(tenantId: string, f: Filters, p: (v: unknown) => string) {
  return [`a.tenant_id = ${p(tenantId)}`, `a.created_at >= ${p(f.from)}`, `a.created_at < ${p(f.to)}`];
}
const auditLogs: ExportDef = {
  columns: ['created_at', 'action', 'actor_email', 'actor_role', 'target_type', 'target_id', 'target_email', 'ip', 'request_id', 'details_json'],
  needsRange: true,
  async count(c, tenantId, f, cap) {
    const { a, p } = params();
    return cappedCount(c, 'audit_logs a', auditConds(tenantId, f, p).join(' AND '), a, cap);
  },
  async batch(c, tenantId, f, cursor, limit) {
    const { a, p } = params();
    const w = auditConds(tenantId, f, p);
    if (cursor) w.push(`(a.created_at, a.id) > (${p(cursor[0])}::timestamptz, ${p(cursor[1])}::bigint)`);
    const r = await c.query(
      `SELECT a.created_at, a.action, a.actor_email, a.actor_role, a.target_type, a.target_id, a.target_email, a.ip, a.request_id, a.details,
              to_char(a.created_at AT TIME ZONE 'UTC', ${ISO_US}) AS _c1, a.id AS _c2
         FROM audit_logs a WHERE ${w.join(' AND ')} ORDER BY a.created_at, a.id LIMIT ${p(limit)}`, a);
    const rows = r.rows.map((x) => { const { details, ...rest } = x; return { ...rest, details_json: JSON.stringify(details ?? {}) }; });
    return finish(rows, ['_c1', '_c2']);
  },
};

// ---------------- members ----------------
const members: ExportDef = {
  columns: ['user_id', 'email', 'role', 'status', 'joined_at'],
  needsRange: false,
  async count(c, tenantId, f, cap) {
    const { a, p } = params();
    return cappedCount(c, 'tenant_memberships m', `m.tenant_id = ${p(tenantId)} AND m.created_at < ${p(f.startedAt)}`, a, cap);
  },
  async batch(c, tenantId, f, cursor, limit) {
    const { a, p } = params();
    const w = [`m.tenant_id = ${p(tenantId)}`, `m.created_at < ${p(f.startedAt)}`];
    if (cursor) w.push(`m.user_id > ${p(cursor[0])}::uuid`);
    const r = await c.query(
      `SELECT m.user_id, m.member_email AS email, m.role, m.status, m.created_at AS joined_at, m.user_id AS _c1
         FROM tenant_memberships m WHERE ${w.join(' AND ')} ORDER BY m.user_id LIMIT ${p(limit)}`, a);
    return finish(r.rows, ['_c1']);
  },
};

/** Ambil kursor dari baris terakhir lalu buang kolom kursor (_c*) dari baris keluaran. */
function finish(rows: Row[], cursorCols: string[]): Batch {
  const last = rows[rows.length - 1];
  const cursor = last ? cursorCols.map((k) => String(last[k])) : null;
  const out = rows.map((r) => { const o: Row = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_c')) o[k] = v; return o; });
  return { rows: out, cursor };
}

export const DEFS: Record<ExportType, ExportDef> = { messages, outbound, chats, contacts, 'audit-logs': auditLogs, members };
