import crypto from 'crypto';
import type { GatewayDb } from '../../database/gateway.js';
import { AppError } from '../../http/errors.js';
import type { Principal } from '../identity/principal.js';
import { revokeLeaseIn } from '../engine/lease.service.js';
import { qrAad } from '../engine/qr-store.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { invalidState, transitionSession, type Actor, type SessionRow, type SessionState } from './lifecycle.js';

const PUBLIC_COLS = `id, session_name, phone_number, status, status_reason, desired_state, adapter, created_at, updated_at`;
const ACTIVE: SessionState[] = ['INITIALIZING', 'QR_REQUIRED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'];
const WAITING: SessionState[] = ['PENDING_ASSIGNMENT', ...ACTIVE];

export const actorOf = (p: Principal): Actor => (p.type === 'user' ? 'USER' : 'API_KEY');
const notFound = () => new AppError('NOT_FOUND', 404, 'Session tidak ditemukan');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Representasi publik: tanpa engine_id/lease/kredensial. */
const view = (r: Partial<SessionRow>) => ({
  id: r.id, session_name: r.session_name, phone_number: r.phone_number ?? null, status: r.status,
  status_reason: r.status_reason ?? null, desired_state: r.desired_state, adapter: r.adapter,
  created_at: r.created_at, updated_at: r.updated_at,
});

/**
 * Layanan sesi untuk jalur tenant. tenantId SELALU dari principal terverifikasi. Semua query memakai
 * konteks RLS tenant + filter tenant eksplisit. Tidak ada koneksi WhatsApp di sini (Fase D); perubahan
 * status "diminta" dan dieksekusi control-plane/engine.
 */
export function createSessionService(db: GatewayDb, opts: { crypto?: CredentialCrypto } = {}) {
  async function load(c: import('pg').PoolClient, tenantId: string, id: string) {
    if (!UUID_RE.test(id)) throw notFound();
    const r = (await c.query(`SELECT ${PUBLIC_COLS} FROM wa_sessions WHERE id = $1 AND tenant_id = $2 AND status <> 'DELETED' FOR UPDATE`, [id, tenantId])).rows[0];
    if (!r) throw notFound();
    return r as SessionRow;
  }

  return {
    async create(p: Principal, input: { name: string; autoConnect: boolean }) {
      const tenantId = p.tenantId;
      const id = crypto.randomUUID();
      try {
        return await db.tx({ tenantId }, async (c) => {
          const lim = (await c.query('SELECT max_sessions FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
          const used = (await c.query(`SELECT count(*)::int n FROM wa_sessions WHERE tenant_id = $1 AND status NOT IN ('DELETING','DELETED')`, [tenantId])).rows[0].n;
          if (!lim || used >= lim.max_sessions) throw new AppError('QUOTA_EXCEEDED', 409, 'Batas jumlah session tercapai');
          await c.query(`INSERT INTO wa_sessions (id, tenant_id, session_name) VALUES ($1,$2,$3)`, [id, tenantId, input.name.trim()]);
          await c.query(`INSERT INTO session_leases (session_id, tenant_id) VALUES ($1,$2)`, [id, tenantId]);
          await c.query(
            `INSERT INTO wa_session_events (tenant_id, session_id, event_type, to_status, actor) VALUES ($1,$2,'session.created','CREATED',$3)`,
            [tenantId, id, actorOf(p)]
          );
          let row: Partial<SessionRow> | null = (await c.query(`SELECT ${PUBLIC_COLS} FROM wa_sessions WHERE id = $1`, [id])).rows[0];
          if (input.autoConnect) {
            row = await transitionSession(c, { sessionId: id, tenantId, to: 'PENDING_ASSIGNMENT', actor: actorOf(p), reason: 'create_auto_connect', set: { desired_state: 'CONNECTED' } });
          }
          return view(row!);
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError('SESSION_NAME_TAKEN', 409, `Nama session "${input.name}" sudah dipakai`);
        throw e;
      }
    },

    async list(tenantId: string, q: { page: number; pageSize: number; status?: SessionState }) {
      return db.tx({ tenantId }, async (c) => {
        const where = `tenant_id = $1 AND status <> 'DELETED' AND ($2::text IS NULL OR status = $2)`;
        const total = (await c.query(`SELECT count(*)::int n FROM wa_sessions WHERE ${where}`, [tenantId, q.status ?? null])).rows[0].n;
        const rows = (await c.query(
          `SELECT ${PUBLIC_COLS} FROM wa_sessions WHERE ${where} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
          [tenantId, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize]
        )).rows;
        return { rows: rows.map(view), total };
      });
    },

    async get(tenantId: string, id: string) {
      return db.tx({ tenantId }, async (c) => view(await load(c, tenantId, id)));
    },

    async events(tenantId: string, id: string, page: number, pageSize: number) {
      return db.tx({ tenantId }, async (c) => {
        await load(c, tenantId, id);
        const total = (await c.query('SELECT count(*)::int n FROM wa_session_events WHERE session_id = $1 AND tenant_id = $2', [id, tenantId])).rows[0].n;
        const rows = (await c.query(
          `SELECT id, event_type, from_status, to_status, actor, payload, created_at FROM wa_session_events
           WHERE session_id = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT $3 OFFSET $4`,
          [id, tenantId, pageSize, (page - 1) * pageSize]
        )).rows;
        return { rows, total };
      });
    },

    /**
     * QR pairing terkini. Hanya saat status QR_REQUIRED dan QR belum kedaluwarsa. QR = kredensial login WhatsApp:
     * tidak pernah dilog, tidak masuk event, respons harus no-store. Dibaca lewat RLS tenant, didekripsi di sini.
     */
    async getQr(tenantId: string, id: string) {
      if (!opts.crypto) throw new AppError('NOT_CONFIGURED', 503, 'Enkripsi kredensial belum dikonfigurasi');
      if (!UUID_RE.test(id)) throw notFound();
      const row = await db.tx({ tenantId }, async (c) => {
        const s = (await c.query(`SELECT status FROM wa_sessions WHERE id = $1 AND tenant_id = $2 AND status <> 'DELETED'`, [id, tenantId])).rows[0];
        if (!s) throw notFound();
        if (s.status !== 'QR_REQUIRED') throw new AppError('QR_NOT_AVAILABLE', 409, `QR tidak tersedia pada status ${s.status}`);
        const q = (await c.query(`SELECT ciphertext, expires_at FROM session_qr WHERE session_id = $1 AND tenant_id = $2 AND expires_at > now()`, [id, tenantId])).rows[0];
        if (!q) throw new AppError('QR_NOT_AVAILABLE', 409, 'QR belum tersedia atau sudah kedaluwarsa; coba lagi sesaat');
        return q as { ciphertext: Buffer; expires_at: Date };
      });
      return { qr: opts.crypto.decrypt(row.ciphertext, qrAad(id)).toString('utf8'), expires_at: row.expires_at };
    },

    /** Minta koneksi. Idempoten bila sudah berjalan/menunggu penempatan. */
    async connect(p: Principal, id: string, reason = 'user_connect') {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const s = await load(c, p.tenantId, id);
        if (WAITING.includes(s.status)) {
          if (s.desired_state !== 'CONNECTED') await c.query(`UPDATE wa_sessions SET desired_state='CONNECTED' WHERE id=$1 AND tenant_id=$2`, [id, p.tenantId]);
          return view({ ...s, desired_state: 'CONNECTED' });
        }
        const t = await transitionSession(c, { sessionId: id, tenantId: p.tenantId, to: 'PENDING_ASSIGNMENT', actor: actorOf(p), reason, set: { desired_state: 'CONNECTED' } });
        if (!t) throw invalidState(s.status, 'menyambungkan');
        return view(t);
      });
    },

    /** Minta pemutusan. Sesi yang dimiliki engine -> DISCONNECTING (engine/control-plane menyelesaikan). */
    async disconnect(p: Principal, id: string) {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const s = await load(c, p.tenantId, id);
        if (['CREATED', 'DISCONNECTED', 'DISCONNECTING', 'LOGGED_OUT', 'ERROR'].includes(s.status)) {
          await c.query(`UPDATE wa_sessions SET desired_state='DISCONNECTED' WHERE id=$1 AND tenant_id=$2`, [id, p.tenantId]);
          return view({ ...s, desired_state: 'DISCONNECTED' });
        }
        const to: SessionState = s.status === 'PENDING_ASSIGNMENT' ? 'DISCONNECTED' : 'DISCONNECTING';
        const t = await transitionSession(c, { sessionId: id, tenantId: p.tenantId, to, actor: actorOf(p), reason: 'user_disconnect', set: { desired_state: 'DISCONNECTED' } });
        if (!t) throw invalidState(s.status, 'memutus');
        return view(t);
      });
    },

    /** Mulai ulang: lepas lease (owner lama kehilangan kepemilikan) lalu minta penempatan baru. */
    async reconnect(p: Principal, id: string) {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const s = await load(c, p.tenantId, id);
        if (s.status === 'PENDING_ASSIGNMENT') return view(s);
        if (!ACTIVE.includes(s.status)) {
          if (['DISCONNECTING', 'DELETING'].includes(s.status)) throw invalidState(s.status, 'menyambungkan ulang');
        }
        const t = await transitionSession(c, { sessionId: id, tenantId: p.tenantId, to: 'PENDING_ASSIGNMENT', actor: actorOf(p), reason: 'user_reconnect', set: { desired_state: 'CONNECTED' } });
        if (!t) throw invalidState(s.status, 'menyambungkan ulang');
        await revokeLeaseIn(c, id, p.tenantId);
        return view(t);
      });
    },

    /** Hapus: lease dicabut, status DELETING; control-plane menuntaskan (hapus referensi kredensial -> DELETED). */
    async remove(p: Principal, id: string) {
      return db.tx({ tenantId: p.tenantId }, async (c) => {
        const s = await load(c, p.tenantId, id);
        if (s.status === 'DELETING') return view(s);
        const t = await transitionSession(c, { sessionId: id, tenantId: p.tenantId, to: 'DELETING', actor: actorOf(p), reason: 'user_delete', set: { desired_state: 'DISCONNECTED' } });
        if (!t) throw invalidState(s.status, 'menghapus');
        await revokeLeaseIn(c, id, p.tenantId);
        return view(t);
      });
    },
  };
}
export type SessionService = ReturnType<typeof createSessionService>;
