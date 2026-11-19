import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import { SendError, type AdapterFactory, type DisconnectKind, type SessionAdapter } from '../whatsapp/adapter.js';
import { canTransition, transitionSession, OWNED_STATES, type SessionState } from '../sessions/lifecycle.js';
import { eraseAuthIn, type AuthHandle, type AuthStore } from './auth-store.js';
import { FencedError, releaseLeaseIn, type Lease, type LeaseService } from './lease.service.js';
import type { QrStore } from './qr-store.js';
import type { ClaimedJob, JobResult, MessageQueue } from './message-queue.js';
import type { Inbox } from './inbox.js';
import { MediaError, type FetchedMedia, type MediaKind } from '../media/fetch.js';
import type { IncomingMessage, ReceiptUpdate } from '../whatsapp/adapter.js';

export interface RunnerLog {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export interface RunnerDeps {
  db: GatewayDb;
  leases: LeaseService;
  authStore: AuthStore;
  qrStore: QrStore;
  adapters: AdapterFactory;
  log: RunnerLog;
  reconnect: { baseMs: number; maxMs: number; maxAttempts: number; random?: () => number };
  queue: MessageQueue;
  inbox: Inbox;
  /** Unduh media klien (anti-SSRF, berbatas). Dipanggil SEBELUM pengiriman: galat di sini aman diulang/ditolak. */
  fetchMedia: (url: string, kind: MediaKind, hintMime?: string) => Promise<FetchedMedia>;
  send: { intervalMs: number; pollMs: number; timeoutMs: number; verifyRecipient: boolean; random?: () => number };
  /** Dipanggil sekali saat runner berhenti total (apa pun sebabnya). */
  onStopped: (runner: SessionRunner) => void;
}

/**
 * Menjalankan SATU sesi di engine ini di bawah satu lease. Semua penulisan persisten (status, kredensial, QR)
 * memakai fencing token; bila lease hilang, runner berhenti secara lokal tanpa menulis apa pun.
 * Event adapter diproses berurutan (antrean) agar urutan status di DB = urutan kejadian.
 */
export class SessionRunner {
  private status: SessionState;
  private adapter?: SessionAdapter;
  private auth?: AuthHandle;
  private gen = 0;
  private attempts = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private pumpOn = false;
  private pumpTimer?: NodeJS.Timeout;
  private inflight?: Promise<void>;

  constructor(
    private readonly d: RunnerDeps,
    readonly lease: Lease,
    readonly tenantId: string,
    initialStatus: SessionState
  ) {
    this.status = initialStatus;
  }

  get sessionId() {
    return this.lease.sessionId;
  }
  get isStopped() {
    return this.stopped;
  }
  get currentStatus() {
    return this.status;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(() => (this.stopped ? undefined : fn()));
    this.queue = run.catch(() => {});
    return run.catch((err) => {
      this.d.log.error({ sessionId: this.sessionId, err: (err as Error).message }, 'runner: operasi gagal');
      return undefined;
    });
  }

  /** Buka auth state lalu mulai koneksi. Kegagalan memuat kredensial => ERROR (tidak diam-diam membuat creds baru). */
  async start(): Promise<void> {
    try {
      this.auth = await this.d.authStore.open(this.lease, this.tenantId, { onFenced: () => void this.lost() });
    } catch (err) {
      if (err instanceof FencedError) return void (await this.lost());
      this.d.log.error({ sessionId: this.sessionId, err: (err as Error).message }, 'runner: gagal membuka auth state');
      return void (await this.finish('ERROR', 'auth_state_unavailable', {}));
    }
    await this.enqueue(() => this.spawn());
  }

  private async spawn(): Promise<void> {
    if (this.stopped || !this.auth) return;
    const gen = ++this.gen;
    const live = () => !this.stopped && gen === this.gen;
    const adapter = this.d.adapters.create({
      sessionId: this.sessionId,
      auth: this.auth,
      handlers: {
        onQr: (qr) => live() && void this.enqueue(() => this.onQr(qr)),
        onOpen: (info) => live() && void this.enqueue(() => this.onOpen(info.phoneNumber)),
        onClose: (info) => live() && void this.enqueue(() => this.onClose(info.kind, info.code)),
        onMessage: (m) => live() && void this.enqueue(() => this.onMessage(m)),
        onReceipt: (r) => live() && void this.enqueue(() => this.onReceipt(r)),
      },
    });
    this.adapter = adapter;
    try {
      await adapter.connect();
    } catch (err) {
      if (live()) await this.onClose('connection_lost', undefined);
      this.d.log.warn({ sessionId: this.sessionId, err: (err as Error).message }, 'runner: connect gagal');
    }
  }

  // ---------- event handler (dijalankan di antrean) ----------

  private async onQr(qr: string): Promise<void> {
    try {
      await this.d.qrStore.put(this.lease, this.tenantId, qr);
    } catch (err) {
      if (err instanceof FencedError) return void (await this.lost());
      throw err;
    }
    if (this.status !== 'QR_REQUIRED') await this.setStatus('QR_REQUIRED', 'qr_generated');
  }

  private async onMessage(m: IncomingMessage): Promise<void> {
    try {
      await this.d.inbox.record(this.lease, this.tenantId, m);
    } catch (err) {
      if (err instanceof FencedError) return void (await this.lost());
      throw err; // dicatat enqueue(); satu pesan gagal tidak menghentikan sesi
    }
  }

  private async onReceipt(r: ReceiptUpdate): Promise<void> {
    try {
      await this.d.queue.receipt(this.lease, r.providerMessageId, r.status);
    } catch (err) {
      if (err instanceof FencedError) return void (await this.lost());
      throw err;
    }
  }

  private async onOpen(phoneNumber?: string): Promise<void> {
    this.attempts = 0;
    try {
      await this.fencedTx(async (c) => {
        await c.query('DELETE FROM session_qr WHERE session_id = $1', [this.sessionId]);
        return this.transition(c, 'CONNECTED', 'connection_open', { set: { phone_number: phoneNumber ?? null } });
      });
    } catch (err) {
      // uq_wa_sessions_phone: nomor yang sama sudah tersambung di sesi lain milik tenant ini.
      if ((err as { code?: string }).code === '23505') return this.finish('ERROR', 'duplicate_phone_number', {});
      throw err;
    }
    if (this.status === 'CONNECTED') this.startPump();
  }

  private async onClose(kind: DisconnectKind, code: number | undefined): Promise<void> {
    this.adapter = undefined;
    this.stopPump();
    const payload = { kind, code: code ?? null };
    switch (kind) {
      case 'logged_out':
        // Kredensial tidak sah lagi: hapus semua auth state, lepas lease. Perlu pair ulang (QR).
        return this.finish('LOGGED_OUT', 'logged_out', payload, { erase: true, desired: 'DISCONNECTED' });
      case 'replaced':
        return this.finish('ERROR', 'connection_replaced', payload);
      case 'bad_session':
        return this.finish('ERROR', 'bad_session', payload);
      case 'restart_required':
        // Normal setelah pairing: socket baru memakai creds yang baru tersimpan.
        if (this.status === 'QR_REQUIRED') await this.setStatus('CONNECTING', 'restart_after_pairing');
        return this.spawn();
      case 'connection_lost':
        if (this.status === 'QR_REQUIRED') return this.finish('ERROR', 'qr_timeout', payload); // QR tidak dipindai
        if (this.attempts >= this.d.reconnect.maxAttempts) return this.finish('ERROR', 'max_reconnect_attempts', payload);
        this.attempts++;
        if (this.status !== 'RECONNECTING') await this.setStatus('RECONNECTING', 'connection_lost', payload);
        this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const { baseMs, maxMs, random = Math.random } = this.d.reconnect;
    const cap = Math.min(maxMs, baseMs * 2 ** (this.attempts - 1));
    const delay = Math.round(cap / 2 + random() * (cap / 2)); // jitter 50-100%
    this.timer = setTimeout(() => void this.enqueue(() => this.spawn()), delay);
    this.timer.unref();
  }

  // ---------- penulisan berfencing ----------

  private async transition(c: pg.PoolClient, to: SessionState, reason: string, extra: { set?: object; payload?: object; desired?: 'CONNECTED' | 'DISCONNECTED' } = {}) {
    const row = await transitionSession(c, {
      sessionId: this.sessionId, tenantId: this.tenantId, to, actor: 'ENGINE', reason,
      payload: extra.payload, set: { ...(extra.set as object), ...(extra.desired ? { desired_state: extra.desired } : {}) },
    });
    if (row) this.status = row.status;
    return row;
  }

  private async fencedTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T | undefined> {
    try {
      return await this.d.leases.withFence(this.lease, fn);
    } catch (err) {
      if (err instanceof FencedError) {
        await this.lost();
        return undefined;
      }
      throw err;
    }
  }

  private async setStatus(to: SessionState, reason: string, payload?: object) {
    if (!canTransition(this.status, to)) return null;
    return this.fencedTx((c) => this.transition(c, to, reason, { payload }));
  }

  /** Transisi akhir + lepas lease dalam SATU transaksi berfencing, lalu berhenti lokal. */
  private async finish(to: SessionState, reason: string, payload: object, opts: { erase?: boolean; desired?: 'CONNECTED' | 'DISCONNECTED'; onlyIfStatus?: SessionState[] } = {}): Promise<void> {
    await this.closeAdapter('disconnect');
    const done = await this.fencedTx(async (c) => {
      if (opts.erase) await eraseAuthIn(c, this.sessionId);
      else await c.query('DELETE FROM session_qr WHERE session_id = $1', [this.sessionId]);
      const prev = (await c.query('SELECT status FROM wa_sessions WHERE id = $1', [this.sessionId])).rows[0]?.status as SessionState | undefined;
      if (opts.onlyIfStatus && (!prev || !opts.onlyIfStatus.includes(prev))) return null;
      const row = await this.transition(c, to, reason, { payload, desired: opts.desired });
      // Lease dilepas bila transisi berhasil ATAU status sudah bukan status "dimiliki" (tak ada yang akan melepasnya).
      if (row || !prev || !OWNED_STATES.includes(prev)) await releaseLeaseIn(c, this.lease);
      return row;
    });
    if (done !== undefined) this.stopLocal();
  }

  // ---------- pompa kirim (lane serial per sesi) ----------

  private startPump(): void {
    if (this.pumpOn || this.stopped) return;
    this.pumpOn = true;
    this.schedulePump(0);
  }

  private stopPump(): void {
    this.pumpOn = false;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
  }

  /** Berhenti meng-klaim job baru dan tunggu pengiriman yang sedang berjalan (maks timeout kirim + margin). */
  private async drainPump(): Promise<void> {
    this.stopPump();
    const f = this.inflight;
    if (f) await Promise.race([f, new Promise((r) => setTimeout(r, this.d.send.timeoutMs + 2000).unref())]);
  }

  private schedulePump(ms: number): void {
    if (!this.pumpOn || this.stopped) return;
    this.pumpTimer = setTimeout(() => {
      this.inflight = this.pumpOnce().finally(() => { this.inflight = undefined; });
    }, ms);
    this.pumpTimer.unref();
  }

  private async pumpOnce(): Promise<void> {
    let next = this.d.send.pollMs;
    try {
      if (!this.pumpOn || this.stopped || this.status !== 'CONNECTED' || !this.adapter) return;
      const c = await this.d.queue.claim(this.lease, this.tenantId);
      if (c.kind === 'job') {
        await this.deliver(c.job);
        const { intervalMs, random = Math.random } = this.d.send;
        next = Math.round(intervalMs * (1 + random() * 0.5)); // jeda antar kirim + jitter (anti-ban)
      } else if (c.kind === 'wait') next = Math.min(c.waitMs, 60_000);
    } catch (err) {
      if (err instanceof FencedError) return void (await this.lost());
      this.d.log.error({ sessionId: this.sessionId, err: (err as Error).message }, 'runner: pompa kirim gagal');
    }
    this.schedulePump(next);
  }

  private async deliver(job: ClaimedJob): Promise<void> {
    let result: JobResult;
    const adapter = this.adapter;
    if (!adapter) result = { kind: 'retry', errorCode: 'NOT_CONNECTED' };
    else {
      try {
        const opts = { timeoutMs: this.d.send.timeoutMs, verifyRecipient: this.d.send.verifyRecipient };
        let r: { providerMessageId?: string };
        if (job.type === 'text' || !job.media) r = await adapter.sendText(job.recipient, job.text, opts);
        else {
          const kind = job.type as MediaKind;
          let fetched: FetchedMedia;
          try { fetched = await this.d.fetchMedia(job.media.url, kind, job.media.mimetype); }
          catch (err) {
            const me = err instanceof MediaError ? err : new MediaError('MEDIA_FETCH_FAILED', true);
            throw new SendError(me.retryable ? 'transient' : 'permanent', me.code);
          }
          r = await adapter.sendMedia(job.recipient, {
            kind, data: fetched.data, mimetype: fetched.mimetype, filename: job.media.filename, caption: kind === 'audio' ? undefined : job.text || undefined,
          }, { ...opts, timeoutMs: opts.timeoutMs * 2 });
        }
        result = { kind: 'sent', providerMessageId: r.providerMessageId };
      } catch (err) {
        const e = err instanceof SendError ? err : new SendError('ambiguous', 'SEND_OUTCOME_UNKNOWN');
        result =
          e.kind === 'recipient_invalid' || e.kind === 'permanent' ? { kind: 'failed', errorCode: e.code }
          : e.kind === 'ambiguous' ? { kind: 'unknown', errorCode: e.code }
          : { kind: 'retry', errorCode: e.code };
      }
    }
    // Tulis hasil. FencedError => engine tidak lagi pemilik; job tetap PROCESSING dan akan direkonsiliasi (aman).
    await this.d.queue.complete(this.lease, job, result);
  }

  // ---------- dikendalikan runtime ----------

  /** Permintaan putus dari user: tutup socket (kredensial tetap), DISCONNECTING -> DISCONNECTED, lepas lease. */
  disconnectRequested(): Promise<void> {
    return this.enqueue(async () => {
      await this.drainPump();
      return this.finish('DISCONNECTED', 'owner_released', {}, { onlyIfStatus: ['DISCONNECTING'] });
    }) as Promise<void>;
  }

  /** Shutdown engine yang rapi: tutup socket, kembalikan sesi ke antrean agar ditempatkan di engine lain. */
  shutdownGracefully(): Promise<void> {
    return this.enqueue(async () => {
      await this.drainPump();
      await this.closeAdapter('disconnect');
      await this.fencedTx(async (c) => {
        const desired = (await c.query('SELECT desired_state FROM wa_sessions WHERE id = $1', [this.sessionId])).rows[0]?.desired_state;
        if (desired === 'CONNECTED') {
          await transitionSession(c, { sessionId: this.sessionId, tenantId: this.tenantId, to: 'PENDING_ASSIGNMENT', actor: 'ENGINE', reason: 'engine_shutdown', onlyFrom: OWNED_STATES });
        }
        await c.query('DELETE FROM session_qr WHERE session_id = $1', [this.sessionId]);
        await releaseLeaseIn(c, this.lease);
      });
      this.stopLocal();
    }) as Promise<void>;
  }

  /** Lease hilang/di-fence: hentikan lokal. TIDAK menulis ke DB. Sesi yang sedang dihapus di-unlink best-effort. */
  async lost(): Promise<void> {
    if (this.stopped) return;
    const deleting = await this.d.db
      .tx({ platform: true }, async (c) => (await c.query(`SELECT status FROM wa_sessions WHERE id = $1`, [this.sessionId])).rows[0]?.status)
      .then((s) => s === 'DELETING' || s === 'DELETED', () => false);
    await this.closeAdapter(deleting ? 'logout' : 'disconnect');
    this.stopLocal();
  }

  private async closeAdapter(mode: 'disconnect' | 'logout'): Promise<void> {
    this.stopPump();
    const a = this.adapter;
    this.adapter = undefined;
    this.gen++; // abaikan event dari adapter lama
    if (!a) return;
    try {
      await (mode === 'logout' ? a.logout() : a.disconnect());
    } catch {
      /* best effort */
    }
  }

  private stopLocal(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPump();
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    void this.adapter?.disconnect().catch(() => {});
    this.adapter = undefined;
    this.d.onStopped(this);
  }
}
