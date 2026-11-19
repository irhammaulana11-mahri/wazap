import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * Kanal LISTEN/NOTIFY untuk fan-out realtime lintas instans API. NOTIFY ikut commit transaksi pemanggil.
 * Nama kanal diturunkan dari schema (md5) karena kanal berlaku se-database: schema berbeda tidak saling menerima event.
 */
export const channelFor = (schema: string) => 'wazap_ev_' + crypto.createHash('md5').update(schema).digest('hex');
const MAX_NOTIFY_BYTES = 7000; // batas PostgreSQL 8000

export interface ChannelEvent {
  tenantId: string;
  id: string;
  /** Nama event internal (outbox): session.status, message.sent, ... atau session.qr (sinyal, tanpa QR). */
  event: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export async function notifyEvents(c: pg.PoolClient, evs: ChannelEvent[]): Promise<void> {
  for (const e of evs) {
    let body = JSON.stringify({ t: e.tenantId, i: e.id, e: e.event, a: e.occurredAt, d: e.data });
    if (Buffer.byteLength(body) > MAX_NOTIFY_BYTES) body = JSON.stringify({ t: e.tenantId, i: e.id, e: e.event, a: e.occurredAt, d: {}, x: 1 });
    await c.query("SELECT pg_notify('wazap_ev_' || md5(current_schema()), $1)", [body]);
  }
}

export function parseChannelEvent(payload: string | undefined): ChannelEvent | null {
  if (!payload) return null;
  try {
    const o = JSON.parse(payload);
    if (typeof o.t !== 'string' || typeof o.i !== 'string' || typeof o.e !== 'string') return null;
    return { tenantId: o.t, id: o.i, event: o.e, occurredAt: String(o.a), data: o.d && typeof o.d === 'object' ? o.d : {} };
  } catch {
    return null;
  }
}

export type RoomKind = 'sessions' | 'messages' | 'qr';
export const roomOf = (tenantId: string, kind: RoomKind) => `t:${tenantId}:${kind}`;

export interface SocketEmit { name: string; room: RoomKind }

/** Pemetaan event internal => event Socket.IO (docs/04_INTEGRATION/SOCKET_EVENTS.md). Satu event dapat menghasilkan beberapa nama. */
export function toSocketEvents(e: ChannelEvent): SocketEmit[] {
  switch (e.event) {
    case 'session.qr': return [{ name: 'session.qr', room: 'qr' }];
    case 'session.status': {
      const out: SocketEmit[] = [{ name: 'session.status', room: 'sessions' }];
      const s = e.data.status;
      if (s === 'CREATED') out.push({ name: 'session.created', room: 'sessions' });
      else if (s === 'CONNECTED') out.push({ name: 'session.connected', room: 'sessions' });
      else if (s === 'DISCONNECTED' || s === 'LOGGED_OUT') out.push({ name: 'session.disconnected', room: 'sessions' });
      else if (s === 'RECONNECTING') out.push({ name: 'session.reconnecting', room: 'sessions' });
      return out;
    }
    case 'message.incoming': return [{ name: 'message.incoming', room: 'messages' }];
    case 'message.failed': return [{ name: 'message.status', room: 'messages' }, { name: 'message.failed', room: 'messages' }];
    case 'message.sent': case 'message.delivered': case 'message.read': case 'message.unknown': case 'message.cancelled':
      return [{ name: 'message.status', room: 'messages' }];
    default: return [];
  }
}
