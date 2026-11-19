import { SendError, type AdapterContext, type AdapterFactory, type DisconnectKind, type SessionAdapter } from '../src/modules/whatsapp/adapter.js';

/** Adapter terkontrol untuk tes: tes memicu event secara manual. Mencatat panggilan. */
export class FakeSession implements SessionAdapter {
  calls: string[] = [];
  closed = false;
  connectError?: Error;
  constructor(readonly ctx: AdapterContext) {}
  /** Skrip hasil kirim: tiap elemen dipakai sekali (SendError => dilempar). Habis => sukses. */
  sendScript: (SendError | { delayMs: number; then?: SendError } | 'ok')[] = [];
  sent: { to: string; text: string }[] = [];
  private seq = 0;
  sending = 0; maxConcurrent = 0; sendTimes: number[] = [];
  media: { to: string; kind: string; bytes: number; caption?: string; filename?: string; mimetype: string }[] = [];
  async sendMedia(to: string, m: import('../src/modules/whatsapp/adapter.js').MediaPayload) {
    const r = await this.sendText(to, `[media:${m.kind}]`);
    this.sent.pop(); // sendText mencatat teks palsu; catat sebagai media saja
    this.media.push({ to, kind: m.kind, bytes: m.data.length, caption: m.caption, filename: m.filename, mimetype: m.mimetype });
    return r;
  }
  async sendText(to: string, text: string) {
    this.calls.push('send'); this.sendTimes.push(Date.now());
    this.sending++; this.maxConcurrent = Math.max(this.maxConcurrent, this.sending);
    try {
      const step = this.sendScript.shift() ?? 'ok';
      if (typeof step === 'object' && 'delayMs' in step) { await new Promise((r) => setTimeout(r, step.delayMs).unref()); if (step.then) throw step.then; }
      else if (step instanceof SendError) throw step;
      if (this.closed) throw new SendError('not_connected', 'NOT_CONNECTED');
      this.sent.push({ to, text });
      return { providerMessageId: `PM-${++this.seq}` };
    } finally { this.sending--; }
  }
  async connect() { this.calls.push('connect'); if (this.connectError) throw this.connectError; }
  async disconnect() { this.calls.push('disconnect'); this.closed = true; }
  async logout() { this.calls.push('logout'); this.closed = true; }
  qr(v: string) { this.ctx.handlers.onQr(v); }
  incoming(m: Partial<import('../src/modules/whatsapp/adapter.js').IncomingMessage> & { providerMessageId: string }) {
    this.ctx.handlers.onMessage({ jid: `${m.phone ?? '6281111111111'}@s.whatsapp.net`, phone: '6281111111111', type: 'text', text: 'halo', timestamp: new Date(), ...m });
  }
  receipt(providerMessageId: string, status: 'DELIVERED' | 'READ') { this.ctx.handlers.onReceipt({ providerMessageId, status }); }
  open(phone = '6281234567890') { this.ctx.handlers.onOpen({ phoneNumber: phone }); }
  close(kind: DisconnectKind, code?: number) { this.ctx.handlers.onClose({ kind, code }); }
}

export class FakeAdapterFactory implements AdapterFactory {
  readonly name = 'fake';
  readonly version = '0.0.0';
  created: FakeSession[] = [];
  nextConnectError?: Error;
  create(ctx: AdapterContext) {
    const s = new FakeSession(ctx);
    if (this.nextConnectError) { s.connectError = this.nextConnectError; this.nextConnectError = undefined; }
    this.created.push(s);
    return s;
  }
  forSession(id: string) { return this.created.filter((s) => s.ctx.sessionId === id); }
  last(id: string) { const l = this.forSession(id); return l[l.length - 1]; }
}
