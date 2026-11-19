import makeWASocket, { Browsers, DisconnectReason, normalizeMessageContent, type proto, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { SendError, type AdapterContext, type AdapterFactory, type DisconnectKind, type IncomingMessage, type IncomingType, type MediaPayload, type ReceiptUpdate, type SendOptions, type SessionAdapter } from './adapter.js';

const statusOf = (err: unknown): number | undefined => (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

export function classifyDisconnect(code: number | undefined): DisconnectKind {
  switch (code) {
    case DisconnectReason.loggedOut:
      return 'logged_out';
    case DisconnectReason.restartRequired:
      return 'restart_required';
    case DisconnectReason.connectionReplaced:
      return 'replaced';
    case DisconnectReason.badSession:
      return 'bad_session';
    default:
      return 'connection_lost';
  }
}

const MAX_TEXT = 16_384;
const digits = (jid: string | undefined) => (jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0]!.split(':')[0]!.replace(/\D/g, '') || undefined : undefined);

/**
 * Ekstrak pesan masuk dari WAMessage. Mengembalikan null untuk: pesan sendiri, grup/status/broadcast/newsletter,
 * pesan sistem (reaksi, protokol, poll, dll.), dan pesan tanpa id/isi. Murni (tanpa I/O) agar mudah diuji.
 */
export function extractIncoming(m: proto.IWebMessageInfo & { key: proto.IMessageKey & { remoteJidAlt?: string } }): IncomingMessage | null {
  const key = m.key;
  const jid = key?.remoteJid ?? undefined;
  if (!key || key.fromMe || !key.id || !jid) return null;
  if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) return null; // grup, status, broadcast, newsletter
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  let type: IncomingType; let text: string | undefined;
  if (c.conversation !== undefined && c.conversation !== null) { type = 'text'; text = c.conversation; }
  else if (c.extendedTextMessage) { type = 'text'; text = c.extendedTextMessage.text ?? undefined; }
  else if (c.imageMessage) { type = 'image'; text = c.imageMessage.caption ?? undefined; }
  else if (c.videoMessage) { type = 'video'; text = c.videoMessage.caption ?? undefined; }
  else if (c.audioMessage) type = 'audio';
  else if (c.documentMessage) { type = 'document'; text = c.documentMessage.caption ?? undefined; }
  else if (c.stickerMessage) type = 'sticker';
  else if (c.locationMessage || c.liveLocationMessage) type = 'location';
  else if (c.contactMessage || c.contactsArrayMessage) type = 'contact';
  else if (c.reactionMessage || c.protocolMessage || c.senderKeyDistributionMessage || c.pollUpdateMessage || c.editedMessage) return null;
  else type = 'other';
  const ts = Number((m.messageTimestamp as unknown) ?? 0);
  return {
    providerMessageId: key.id, jid, phone: digits(jid) ?? digits(key.remoteJidAlt), pushName: m.pushName?.slice(0, 100) || undefined,
    type, text: text ? text.slice(0, MAX_TEXT) : undefined, timestamp: new Date(ts > 0 ? ts * 1000 : Date.now()),
  };
}

/** Status proto WebMessageInfo: 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED. Hanya untuk pesan KELUAR (fromMe). */
export function extractReceipt(u: { key: proto.IMessageKey; update: { status?: number | null } }): ReceiptUpdate | null {
  if (!u.key?.fromMe || !u.key.id || typeof u.update?.status !== 'number') return null;
  if (u.update.status === 3) return { providerMessageId: u.key.id, status: 'DELIVERED' };
  if (u.update.status === 4 || u.update.status === 5) return { providerMessageId: u.key.id, status: 'READ' };
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

class BaileysSession implements SessionAdapter {
  private sock?: WASocket;
  private closed = false;
  private opened = false;
  constructor(private readonly ctx: AdapterContext) {}

  async connect(): Promise<void> {
    const { auth, handlers } = this.ctx;
    const sock = makeWASocket({
      auth: auth.state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: pino({ level: 'silent' }), // log Baileys dapat memuat material sensitif
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      if (!this.closed) void auth.saveCreds().catch(() => {}); // kegagalan fencing ditangani engine lewat onFenced
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.closed || type !== 'notify') return; // 'append' = sinkronisasi riwayat: bukan pesan baru
      for (const m of messages) { const im = extractIncoming(m as any); if (im) handlers.onMessage(im); }
    });
    sock.ev.on('messages.update', (ups) => {
      if (this.closed) return;
      for (const u of ups) {
        const r = extractReceipt(u as any);
        if (r) handlers.onReceipt(r);
      }
    });
    sock.ev.on('connection.update', (u) => {
      if (this.closed) return;
      if (u.qr) handlers.onQr(u.qr);
      if (u.connection === 'open') {
        this.opened = true;
        const jid = sock.user?.id;
        handlers.onOpen({ phoneNumber: jid ? jid.split(':')[0].split('@')[0] : undefined });
      } else if (u.connection === 'close') {
        const code = statusOf(u.lastDisconnect?.error);
        this.closed = true;
        this.opened = false;
        handlers.onClose({ kind: classifyDisconnect(code), code });
      }
    });
  }

  async sendText(to: string, text: string, opts: SendOptions): Promise<{ providerMessageId?: string }> {
    return this.deliver(to, { text }, opts);
  }

  async sendMedia(to: string, m: MediaPayload, opts: SendOptions): Promise<{ providerMessageId?: string }> {
    const content =
      m.kind === 'image' ? { image: m.data, mimetype: m.mimetype, caption: m.caption }
      : m.kind === 'video' ? { video: m.data, mimetype: m.mimetype, caption: m.caption }
      : m.kind === 'audio' ? { audio: m.data, mimetype: m.mimetype, ptt: false }
      : { document: m.data, mimetype: m.mimetype, fileName: m.filename ?? 'file', caption: m.caption };
    return this.deliver(to, content as any, opts);
  }

  private async deliver(to: string, content: any, opts: SendOptions): Promise<{ providerMessageId?: string }> {
    const s = this.sock;
    if (!s || this.closed || !this.opened) throw new SendError('not_connected', 'NOT_CONNECTED');
    const jid = `${to}@s.whatsapp.net`;
    if (opts.verifyRecipient) {
      let exists: boolean | undefined;
      try {
        exists = (await withTimeout(s.onWhatsApp(jid), opts.timeoutMs))?.[0]?.exists;
      } catch {
        throw new SendError('transient', 'RECIPIENT_CHECK_FAILED'); // belum ada yang dikirim
      }
      if (!exists) throw new SendError('recipient_invalid', 'RECIPIENT_NOT_ON_WHATSAPP');
    }
    try {
      const res = await withTimeout(s.sendMessage(jid, content), opts.timeoutMs);
      return { providerMessageId: res?.key?.id ?? undefined };
    } catch {
      // Pesan mungkin sudah keluar (timeout/socket putus di tengah kirim): ambigu, bukan gagal pasti.
      throw new SendError('ambiguous', 'SEND_OUTCOME_UNKNOWN');
    }
  }

  private shutdown(): void {
    this.closed = true;
    const s = this.sock;
    this.sock = undefined;
    if (!s) return;
    try {
      s.ev.removeAllListeners('connection.update');
      s.ev.removeAllListeners('creds.update');
      s.ev.removeAllListeners('messages.upsert');
      s.ev.removeAllListeners('messages.update');
      s.end(undefined);
    } catch {
      /* socket sudah tertutup */
    }
  }

  async disconnect(): Promise<void> {
    this.shutdown();
  }

  async logout(): Promise<void> {
    const s = this.sock;
    if (s && !this.closed) {
      try {
        await s.logout();
      } catch {
        /* best effort: socket mungkin sudah putus */
      }
    }
    this.shutdown();
  }
}

export const baileysAdapterFactory: AdapterFactory = {
  name: 'baileys',
  version: '7.0.0-rc14',
  create: (ctx) => new BaileysSession(ctx),
};
