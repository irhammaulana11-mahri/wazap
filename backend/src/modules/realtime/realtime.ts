import type http from 'node:http';
import type pg from 'pg';
import { Server, type Socket } from 'socket.io';
import type { GatewayDb } from '../../database/gateway.js';
import type { IdentityService } from '../identity/identity.service.js';
import type { Principal } from '../identity/principal.js';
import { channelFor, parseChannelEvent, roomOf, toSocketEvents, type ChannelEvent, type RoomKind } from './event-channel.js';

export interface RealtimeLog {
  info: (o: any, m?: string) => void;
  warn: (o: any, m?: string) => void;
  error: (o: any, m?: string) => void;
}
export interface RealtimeOptions {
  path?: string;
  corsOrigins?: string[];
  /** Interval validasi ulang kredensial (token kedaluwarsa/dicabut, role berubah). */
  revalidateMs?: number;
  maxSocketsPerTenant?: number;
}
const ALL: RoomKind[] = ['sessions', 'messages', 'qr'];

/** Hak akses realtime. QR (sinyal) hanya untuk yang boleh mengelola sesi, sama seperti GET /sessions/:id/qr. */
export function kindsFor(p: Principal): RoomKind[] {
  if (p.type === 'user') return p.role === 'VIEWER' ? ['sessions', 'messages'] : ALL;
  if (p.scopes.includes('*')) return ALL;
  const k: RoomKind[] = [];
  if (p.scopes.includes('sessions:read')) k.push('sessions');
  if (p.scopes.includes('messages:read')) k.push('messages');
  if (p.scopes.includes('sessions:write')) k.push('qr');
  return k;
}

interface SockData { cred: string; tenantId: string; kinds: RoomKind[] }

/**
 * Socket.IO server-ke-klien (klien tidak dapat mengirim event atau memilih room). Otentikasi saat handshake dengan
 * access token / API key (hanya via `auth.token`, bukan query string agar tidak masuk log URL). Room dibentuk SERVER
 * dari principal terverifikasi: t:<tenant>:<sessions|messages|qr>. Event berasal dari PostgreSQL LISTEN/NOTIFY
 * sehingga semua instans API menerima event yang sama tanpa komponen tambahan.
 */
export function attachRealtime(deps: {
  httpServer: http.Server;
  identity: Pick<IdentityService, 'authenticateApiKey' | 'authenticateAccessToken'>;
  db: GatewayDb;
  log: RealtimeLog;
  opts?: RealtimeOptions;
}) {
  const { db, log, identity } = deps;
  const o = deps.opts ?? {};
  const maxPerTenant = o.maxSocketsPerTenant ?? 50;
  const channel = channelFor(db.schema);
  const io = new Server(deps.httpServer, {
    path: o.path ?? '/api/v1/realtime',
    serveClient: false,
    maxHttpBufferSize: 4096,
    cors: { origin: o.corsOrigins?.length ? o.corsOrigins : false, credentials: true },
  });
  const perTenant = new Map<string, number>();

  const authenticate = async (cred: unknown): Promise<Principal | null> => {
    if (typeof cred !== 'string' || !cred || cred.length > 4096) return null;
    return cred.startsWith('gwk_') ? identity.authenticateApiKey(cred) : identity.authenticateAccessToken(cred);
  };
  const applyRooms = (s: Socket<any, any, any, SockData>, kinds: RoomKind[]) => {
    for (const k of ALL) (kinds.includes(k) ? s.join(roomOf(s.data.tenantId, k)) : s.leave(roomOf(s.data.tenantId, k)));
    s.data.kinds = kinds;
  };

  io.use(async (socket, next) => {
    try {
      const cred = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const p = await authenticate(cred);
      if (!p) return next(Object.assign(new Error('UNAUTHENTICATED'), { data: { code: 'UNAUTHENTICATED' } }));
      const kinds = kindsFor(p);
      if (!kinds.length) return next(Object.assign(new Error('FORBIDDEN'), { data: { code: 'FORBIDDEN' } }));
      if ((perTenant.get(p.tenantId) ?? 0) >= maxPerTenant) return next(Object.assign(new Error('TOO_MANY_CONNECTIONS'), { data: { code: 'TOO_MANY_CONNECTIONS' } }));
      socket.data = { cred: cred as string, tenantId: p.tenantId, kinds } satisfies SockData;
      next();
    } catch (err) {
      log.error({ err }, 'realtime: autentikasi gagal');
      next(Object.assign(new Error('INTERNAL_ERROR'), { data: { code: 'INTERNAL_ERROR' } }));
    }
  });

  io.on('connection', (socket: Socket<any, any, any, SockData>) => {
    const tid = socket.data.tenantId;
    perTenant.set(tid, (perTenant.get(tid) ?? 0) + 1);
    applyRooms(socket, socket.data.kinds);
    socket.emit('ready', { v: 1, tenant_id: tid, rooms: socket.data.kinds });
    socket.on('disconnect', () => {
      const n = (perTenant.get(tid) ?? 1) - 1;
      if (n <= 0) perTenant.delete(tid); else perTenant.set(tid, n);
    });
    // Sengaja TIDAK ada handler event dari klien.
  });

  const dispatch = (e: ChannelEvent) => {
    for (const m of toSocketEvents(e)) {
      io.to(roomOf(e.tenantId, m.room)).emit(m.name, { v: 1, event_id: e.id, event: m.name, occurred_at: e.occurredAt, tenant_id: e.tenantId, data: e.data });
    }
  };

  // --- LISTEN/NOTIFY dengan reconnect ---
  let closed = false;
  let listener: pg.PoolClient | undefined;
  let retry: NodeJS.Timeout | undefined;
  let backoff = 500;
  let firstReady: () => void;
  const ready = new Promise<void>((r) => (firstReady = r));
  let everConnected = false;
  const released = new WeakSet<pg.PoolClient>();
  /** pool.release() hanya boleh dipanggil sekali per klien (event 'end'/'error' dan close() dapat bertumpuk). */
  const releaseOnce = (c: pg.PoolClient | undefined, destroy: boolean) => {
    if (!c || released.has(c)) return;
    released.add(c);
    c.release(destroy);
  };

  async function connectListener() {
    if (closed) return;
    let c: pg.PoolClient | undefined;
    try {
      c = await db.pool.connect();
      const dead = () => { if (listener === c) listener = undefined; releaseOnce(c, true); scheduleRetry(); };
      c.on('error', dead);
      c.on('end', dead);
      c.on('notification', (m) => { if (m.channel === channel) { const e = parseChannelEvent(m.payload); if (e) dispatch(e); } });
      await c.query(`LISTEN ${channel}`);
      listener = c;
      backoff = 500;
      if (everConnected) io.emit('realtime.resync', { v: 1 }); // event mungkin terlewat selama putus: klien harus memuat ulang state
      everConnected = true;
      firstReady();
    } catch (err) {
      log.warn({ err }, 'realtime: gagal LISTEN, akan dicoba lagi');
      releaseOnce(c, true);
      scheduleRetry();
    }
  }
  function scheduleRetry() {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = undefined; void connectListener(); }, backoff);
    retry.unref();
    backoff = Math.min(backoff * 2, 10_000);
  }
  void connectListener();

  // --- validasi ulang kredensial ---
  const sweep = setInterval(() => {
    void (async () => {
      for (const s of io.sockets.sockets.values() as Iterable<Socket<any, any, any, SockData>>) {
        try {
          const p = await authenticate(s.data.cred);
          const kinds = p && p.tenantId === s.data.tenantId ? kindsFor(p) : [];
          if (!kinds.length) { s.emit('auth.expired', { v: 1 }); s.disconnect(true); }
          else if (kinds.join() !== s.data.kinds.join()) applyRooms(s, kinds);
        } catch (err) {
          log.warn({ err }, 'realtime: validasi ulang gagal'); // jangan putuskan karena galat sementara
        }
      }
    })();
  }, o.revalidateMs ?? 30_000);
  sweep.unref();

  return {
    io,
    ready: () => ready,
    async close() {
      closed = true;
      clearInterval(sweep);
      if (retry) clearTimeout(retry);
      const l = listener; listener = undefined;
      if (l) { await l.query(`UNLISTEN ${channel}`).catch(() => {}); releaseOnce(l, false); }
      // Tutup koneksi socket saja; http server dimiliki Fastify (io.close() akan ikut menutupnya).
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}
export type Realtime = ReturnType<typeof attachRealtime>;
