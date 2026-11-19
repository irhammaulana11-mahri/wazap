import type { AuthHandle } from '../engine/auth-store.js';
import type { MediaKind } from '../media/fetch.js';

/**
 * Kontrak adapter WhatsApp. Engine hanya bergantung pada antarmuka ini sehingga library (Baileys) dapat diganti
 * tanpa mengubah lifecycle/lease/fencing. Fase D: koneksi, QR, status, putus, logout. Pengiriman pesan: Fase E.
 */
export type DisconnectKind =
  | 'logged_out' //        akun/perangkat di-unlink; kredensial tidak valid lagi (final)
  | 'restart_required' //  normal setelah pairing; buat socket baru segera
  | 'replaced' //          sesi diambil klien lain (jangan berebut)
  | 'bad_session' //       state rusak (final sampai pair ulang)
  | 'connection_lost'; //  jaringan/timeout/tidak dikenal: boleh reconnect dengan backoff

/** Pesan masuk 1:1 (grup/status/broadcast/newsletter dan pesan sendiri TIDAK diteruskan). Media tidak diunduh: hanya tipe (+ caption). */
export type IncomingType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'other';
export interface IncomingMessage {
  providerMessageId: string;
  jid: string;
  /** Nomor telepon (digit) bila dapat ditentukan; JID @lid tanpa pasangan nomor => undefined. */
  phone?: string;
  pushName?: string;
  type: IncomingType;
  text?: string;
  timestamp: Date;
}
export interface ReceiptUpdate {
  providerMessageId: string;
  status: 'DELIVERED' | 'READ';
}

export interface AdapterHandlers {
  onMessage(m: IncomingMessage): void;
  onReceipt(r: ReceiptUpdate): void;
  /** QR pairing baru (rotasi berkala). RAHASIA: jangan dilog atau masuk payload event. */
  onQr(qr: string): void;
  onOpen(info: { phoneNumber?: string }): void;
  onClose(info: { kind: DisconnectKind; code?: number }): void;
}

/**
 * Klasifikasi kegagalan kirim. Pembeda utama: apakah pesan MUNGKIN sudah keluar.
 *  - not_connected / transient: gagal SEBELUM dikirim => aman di-retry.
 *  - recipient_invalid: permanen (nomor tidak terdaftar di WhatsApp).
 *  - ambiguous: error saat/ setelah pesan diserahkan ke socket => hasil tidak diketahui; jangan di-retry otomatis.
 */
export type SendErrorKind = 'not_connected' | 'transient' | 'recipient_invalid' | 'permanent' | 'ambiguous';
export class SendError extends Error {
  constructor(readonly kind: SendErrorKind, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export interface SendOptions {
  timeoutMs: number;
  /** Periksa dulu bahwa nomor terdaftar di WhatsApp. */
  verifyRecipient: boolean;
}

export interface MediaPayload {
  kind: MediaKind;
  data: Buffer;
  mimetype: string;
  filename?: string;
  caption?: string;
}

export interface SessionAdapter {
  /** Kirim media (sudah diunduh & divalidasi oleh engine). Semantik galat sama dengan sendText. */
  sendMedia(to: string, media: MediaPayload, opts: SendOptions): Promise<{ providerMessageId?: string }>;
  /** Kirim teks. Melempar SendError. Hanya yang dikonfirmasi adapter yang dilaporkan sebagai sukses (SENT, bukan delivered). */
  sendText(to: string, text: string, opts: SendOptions): Promise<{ providerMessageId?: string }>;
  /** Mulai koneksi. Event dikirim ke handlers. Aman dipanggil sekali per instans. */
  connect(): Promise<void>;
  /** Tutup socket TANPA logout (kredensial tetap sah). Idempoten; tidak memicu onClose. */
  disconnect(): Promise<void>;
  /** Unlink perangkat di WhatsApp (best effort) lalu tutup. Idempoten; tidak memicu onClose. */
  logout(): Promise<void>;
}

export interface AdapterContext {
  sessionId: string;
  auth: AuthHandle;
  handlers: AdapterHandlers;
}

export interface AdapterFactory {
  readonly name: string;
  readonly version: string;
  create(ctx: AdapterContext): SessionAdapter;
}
