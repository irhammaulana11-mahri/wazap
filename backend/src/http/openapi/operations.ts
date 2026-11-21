import { z, type ZodType } from 'zod';
import * as S from './schemas.js';

export interface Operation {
  tag: string;
  summary: string;
  description?: string;
  /** Status sukses -> skema body (null = tanpa body, mis. 204). */
  responses: Record<number, ZodType | null>;
  /** Status galat khusus operasi (di luar yang diturunkan otomatis dari guard/skema). */
  errors?: number[];
  /** Header yang dibaca/ditulis lewat cookie refresh (bukan body). */
  cookie?: 'sets-refresh' | 'reads-refresh';
  /** Hanya pengguna dashboard (API key ditolak 403 oleh handler walau guard hanya `authenticate`). */
  userOnly?: boolean;
  /** Menerima header Idempotency-Key. */
  idempotency?: boolean;
  /** Respons sukses 200 berupa aliran non-JSON (mis. ekspor CSV/NDJSON): hanya status, Content-Type, dan header diperiksa, bukan isi. */
  stream?: { contentTypes: string[] };
}

const ok = S.okOf, list = S.listOf;
const EXPORT_STREAM = { contentTypes: ['text/csv', 'application/x-ndjson'] };
const EXPORT_NOTE = 'Hanya OWNER pengguna dashboard (API key ditolak), dengan konfirmasi kata sandi di body. Respons berupa berkas (Content-Disposition: attachment; X-Export-Rows = jumlah baris). Ekspor yang melebihi batas ditolak 422 EXPORT_TOO_LARGE SEBELUM data dikirim; jenis berentang waktu wajib from dan to. CSV: UTF-8 BOM, sel teks yang diawali = + - @ diberi awalan kutip tunggal (anti injeksi formula); NDJSON: baris terakhir adalah manifest.';
const ALERT_NOTE = 'Hanya OWNER pengguna dashboard (API key ditolak). Target kanal (token bot / URL webhook) dienkripsi dan tidak pernah dikembalikan. Notifikasi tidak memuat nomor telepon pelanggan akhir maupun isi pesan.';
const O = (tag: string, summary: string, responses: Operation['responses'], extra: Partial<Operation> = {}): Operation => ({ tag, summary, responses, ...extra });

/** Kunci: `METHOD /path` persis seperti didaftarkan di Fastify, tanpa awalan /api/v1 (kecuali /health*). Kelengkapan dijaga test/openapi.test.ts. */
export const OPERATIONS: Record<string, Operation> = {
  // ---- Kesehatan (di luar /api/v1, publik) ----
  'GET /health/live': O('Kesehatan', 'Liveness: proses hidup', { 200: S.Health }),
  'GET /health/ready': O('Kesehatan', 'Readiness: database terjangkau dan tidak sedang shutdown', { 200: S.Health, 503: S.Health }),
  'GET /health': O('Kesehatan', 'Alias readiness', { 200: S.Health, 503: S.Health }),

  // ---- Autentikasi ----
  'POST /auth/register': O('Autentikasi', 'Daftar akun dan workspace baru (OWNER)', { 201: ok(S.AuthSessionWithCodes) },
    { description: 'Mengembalikan access token dan 8 kode pemulihan (sekali tampil). Refresh token dikirim sebagai cookie HttpOnly.', cookie: 'sets-refresh', errors: [409] }),
  'POST /auth/login': O('Autentikasi', 'Login dengan email dan kata sandi', { 200: ok(S.AuthSession) }, { cookie: 'sets-refresh', errors: [403] }),
  'POST /auth/refresh': O('Autentikasi', 'Tukar cookie refresh dengan access token baru', { 200: ok(S.AuthSession) }, { cookie: 'reads-refresh' }),
  'POST /auth/logout': O('Autentikasi', 'Keluar (mencabut refresh token)', { 204: null }, { cookie: 'reads-refresh' }),
  'POST /auth/logout-all': O('Autentikasi', 'Keluar dari semua perangkat', { 204: null }),
  'POST /auth/switch-tenant': O('Autentikasi', 'Pindah workspace aktif', { 200: ok(S.AuthSession) }, { cookie: 'sets-refresh' }),
  'GET /auth/me': O('Autentikasi', 'Profil, keanggotaan, dan status kode pemulihan', { 200: ok(S.Me) }, { userOnly: true }),
  'POST /auth/change-password': O('Autentikasi', 'Ganti kata sandi (mencabut sesi lain)', { 200: ok(S.AuthSession) }, { cookie: 'sets-refresh' }),
  'POST /auth/change-email': O('Autentikasi', 'Ganti email akun', { 200: ok(S.ChangedEmail) }, { errors: [409] }),
  'POST /auth/recovery-codes': O('Autentikasi', 'Terbitkan 8 kode pemulihan baru (kode lama hangus)', { 200: ok(S.RecoveryCodes) }),
  'POST /auth/recovery-codes/confirm': O('Autentikasi', 'Nyatakan kode pemulihan sudah disimpan', { 200: ok(S.Confirmed) }),
  'POST /auth/reset-password': O('Autentikasi', 'Reset kata sandi dengan kode pemulihan (publik)', { 200: ok(S.ResetResult) }),
  'POST /auth/join-requests': O('Autentikasi', 'Ajukan bergabung ke workspace dengan kode workspace (publik)', { 201: ok(S.JoinSubmitted) }, { errors: [409] }),
  'POST /auth/deleted-workspaces': O('Autentikasi', 'Daftar workspace terhapus yang dapat dipulihkan (publik, kredensial OWNER)', { 200: ok(S.DeletedWorkspace.array()) }),
  'POST /auth/restore-workspace': O('Autentikasi', 'Pulihkan workspace terhapus (publik, kredensial OWNER)', { 200: ok(S.Restored) }),

  // ---- API key ----
  'GET /api-keys': O('API key', 'Daftar API key', { 200: list(S.ApiKey) }),
  'POST /api-keys': O('API key', 'Buat API key (nilai tampil sekali)', { 201: ok(S.ApiKeyCreated) }, { errors: [409] }),
  'PATCH /api-keys/:keyId': O('API key', 'Ubah nama dan scope API key', { 200: ok(S.ApiKey) }),
  'DELETE /api-keys/:keyId': O('API key', 'Cabut API key', { 200: ok(S.KeyRevoked) }),

  // ---- Sesi WhatsApp ----
  'POST /sessions': O('Sesi', 'Buat sesi WhatsApp', { 201: ok(S.Session) }, { errors: [409] }),
  'GET /sessions': O('Sesi', 'Daftar sesi', { 200: list(S.Session) }),
  'GET /sessions/:sessionId': O('Sesi', 'Detail sesi', { 200: ok(S.Session) }),
  'PATCH /sessions/:sessionId': O('Sesi', 'Ganti nama sesi', { 200: ok(S.Session) }),
  'GET /sessions/:sessionId/status': O('Sesi', 'Status ringkas sesi', { 200: ok(S.SessionStatus) }),
  'GET /sessions/:sessionId/events': O('Sesi', 'Riwayat perubahan status sesi', { 200: list(S.SessionEvent) }),
  'GET /sessions/:sessionId/qr': O('Sesi', 'QR untuk pairing (hanya saat QR_REQUIRED)', { 200: ok(S.SessionQr) }, { errors: [409] }),
  'POST /sessions/:sessionId/connect': O('Sesi', 'Hubungkan sesi', { 202: ok(S.Session) }, { errors: [409] }),
  'POST /sessions/:sessionId/disconnect': O('Sesi', 'Putuskan sesi (kredensial dipertahankan)', { 202: ok(S.Session) }, { errors: [409] }),
  'POST /sessions/:sessionId/reconnect': O('Sesi', 'Sambung ulang sesi', { 202: ok(S.Session) }, { errors: [409] }),
  'DELETE /sessions/:sessionId': O('Sesi', 'Hapus sesi (kredensial dihapus)', { 202: ok(S.Session) }),

  // ---- Pesan ----
  'POST /messages/send': O('Pesan', 'Kirim pesan teks (diantrekan)', { 202: ok(S.Job) }, { idempotency: true, errors: [409] }),
  'POST /messages/send-media': O('Pesan', 'Kirim media (gambar, video, audio, dokumen) dari URL https publik', { 202: ok(S.Job) }, { idempotency: true, errors: [409, 422] }),
  'POST /messages/bulk': O('Pesan', 'Kirim banyak pesan teks', { 202: ok(S.BulkResult) }, { idempotency: true, errors: [409] }),
  'GET /messages': O('Pesan', 'Riwayat antrean/kirim', { 200: list(S.Message) }),
  'GET /messages/:messageId': O('Pesan', 'Detail pesan beserta riwayat percobaan', { 200: ok(S.MessageDetail) }),
  'GET /messages/:messageId/status': O('Pesan', 'Status ringkas pesan', { 200: ok(S.MessageStatusView) }),
  'POST /messages/:messageId/cancel': O('Pesan', 'Batalkan pesan yang belum terkirim', { 200: ok(S.Message) }, { errors: [409] }),
  'POST /messages/:messageId/retry': O('Pesan', 'Kirim ulang pesan gagal/tidak pasti', { 202: ok(S.Message) }, { errors: [409] }),

  // ---- Chat dan kontak ----
  'GET /chats': O('Chat', 'Daftar chat (satu kontak = satu chat per sesi)', { 200: list(S.Chat) }),
  'GET /chats/:chatId/messages': O('Chat', 'Riwayat pesan sebuah chat', { 200: list(S.ChatMessage, S.PageMeta.extend({ chat: S.Chat })) }),
  'GET /contacts': O('Chat', 'Daftar kontak (digabung lintas sesi)', { 200: list(S.Contact) }),

  // ---- Webhook ----
  'POST /webhooks': O('Webhook', 'Daftarkan endpoint webhook (secret tampil sekali)', { 201: ok(S.WebhookWithSecret) }, { errors: [409, 422] }),
  'GET /webhooks': O('Webhook', 'Daftar endpoint webhook', { 200: list(S.Webhook) }),
  'PATCH /webhooks/:webhookId': O('Webhook', 'Ubah endpoint (URL, langganan event, aktif/nonaktif)', { 200: ok(S.Webhook) }, { errors: [422] }),
  'DELETE /webhooks/:webhookId': O('Webhook', 'Hapus endpoint', { 200: ok(S.Deleted) }),
  'POST /webhooks/:webhookId/rotate-secret': O('Webhook', 'Putar secret (secret baru tampil sekali)', { 200: ok(S.WebhookWithSecret) }),
  'POST /webhooks/:webhookId/test': O('Webhook', 'Kirim event webhook.test', { 202: ok(S.WebhookDelivery) }),
  'GET /webhooks/:webhookId/deliveries': O('Webhook', 'Riwayat pengiriman', { 200: list(S.WebhookDelivery) }),
  'GET /webhooks/:webhookId/deliveries/:deliveryId': O('Webhook', 'Detail pengiriman', { 200: ok(S.WebhookDelivery) }),
  'POST /webhooks/:webhookId/deliveries/:deliveryId/replay': O('Webhook', 'Kirim ulang event (event_id sama)', { 202: ok(S.WebhookDelivery) }, { errors: [409] }),

  // ---- Tim ----
  'GET /team/members': O('Tim', 'Daftar anggota', { 200: list(S.Member) }),
  'PATCH /team/members/:userId': O('Tim', 'Ubah peran/status anggota', { 200: ok(S.Member) }, { errors: [409] }),
  'DELETE /team/members/:userId': O('Tim', 'Keluarkan anggota atau keluar sendiri', { 200: ok(S.MemberRemoved) }, { errors: [409] }),
  'POST /team/invitations': O('Tim', 'Buat undangan (token tampil sekali)', { 201: ok(S.InvitationIssued) }, { errors: [409] }),
  'GET /team/invitations': O('Tim', 'Daftar undangan', { 200: list(S.Invitation) }),
  'DELETE /team/invitations/:invitationId': O('Tim', 'Cabut undangan', { 200: ok(S.Invitation) }),
  'POST /team/invitations/:invitationId/reissue': O('Tim', 'Terbitkan ulang tautan undangan', { 200: ok(S.InvitationIssued) }, { errors: [409] }),
  'POST /team/invitations/accept': O('Tim', 'Terima undangan', { 200: ok(S.Accepted) }, { errors: [409] }),
  'GET /team/join-code': O('Tim', 'Status kode workspace', { 200: ok(S.JoinCodeState) }),
  'PUT /team/join-code': O('Tim', 'Buat/putar kode workspace (tampil sekali)', { 200: ok(S.JoinCodeIssued) }, { description: '`join_url` null bila DASHBOARD_BASE_URL belum dikonfigurasi di server; kode tetap berlaku.' }),
  'DELETE /team/join-code': O('Tim', 'Nonaktifkan kode workspace', { 200: ok(S.JoinCodeState) }),
  'GET /team/join-requests': O('Tim', 'Daftar permintaan bergabung', { 200: list(S.JoinRequest) }),
  'POST /team/join-requests/:requestId/approve': O('Tim', 'Setujui permintaan bergabung', { 200: ok(S.JoinRequest) }, { errors: [409] }),
  'POST /team/join-requests/:requestId/reject': O('Tim', 'Tolak permintaan bergabung', { 200: ok(S.JoinRequest) }, { errors: [409] }),

  // ---- Workspace ----
  'PATCH /tenant': O('Workspace', 'Ganti nama workspace', { 200: ok(S.Tenant) }),
  'DELETE /tenant': O('Workspace', 'Hapus workspace (masa pemulihan)', { 200: ok(S.TenantDeleted) }),
  'GET /tenant/settings': O('Workspace', 'Kuota, batas atas, dan pemakaian', { 200: ok(S.TenantSettings) }),
  'PATCH /tenant/settings': O('Workspace', 'Ubah kuota dalam batas atas', { 200: ok(S.TenantSettings) }, { errors: [409] }),

  // ---- Ekspor data (ADR-048) ----
  'POST /exports/messages': O('Ekspor', 'Ekspor riwayat pesan masuk dan keluar (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'POST /exports/outbound': O('Ekspor', 'Ekspor laporan pengiriman (antrean keluar) (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'POST /exports/chats': O('Ekspor', 'Ekspor daftar chat (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'POST /exports/contacts': O('Ekspor', 'Ekspor kontak (digabung per nomor) (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'POST /exports/audit-logs': O('Ekspor', 'Ekspor log audit (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'POST /exports/members': O('Ekspor', 'Ekspor anggota tim (CSV atau NDJSON, streaming)', {}, { stream: EXPORT_STREAM, errors: [409, 422, 503], description: EXPORT_NOTE }),
  'GET /alerts/catalog': O('Notifikasi', 'Daftar aturan alarm, batas, dan status fitur (untuk UI)', { 200: ok(S.AlertCatalog) }),
  'GET /alerts/channels': O('Notifikasi', 'Daftar kanal notifikasi (target tidak pernah dikembalikan; hanya petunjuk 4 karakter)', { 200: ok(z.array(S.AlertChannel)) }),
  'POST /alerts/channels': O('Notifikasi', 'Buat kanal Telegram atau Slack-compatible (memerlukan kata sandi)', { 201: ok(S.AlertChannel) }, { errors: [409, 422, 429, 503], description: ALERT_NOTE }),
  'PATCH /alerts/channels/:channelId': O('Notifikasi', 'Ubah nama/aktif, atau ganti target (target memerlukan kata sandi)', { 200: ok(S.AlertChannel) }, { errors: [422, 429, 503], description: ALERT_NOTE }),
  'DELETE /alerts/channels/:channelId': O('Notifikasi', 'Hapus kanal (memerlukan kata sandi)', { 200: ok(S.Deleted) }, { errors: [429], description: ALERT_NOTE }),
  'POST /alerts/channels/:channelId/test': O('Notifikasi', 'Kirim pesan uji sinkron dan kembalikan hasilnya', { 200: ok(S.AlertTestResult) }, { errors: [429, 503], description: ALERT_NOTE }),
  'GET /alerts/rules': O('Notifikasi', 'Daftar aturan alarm beserta pengaturannya', { 200: ok(z.array(S.AlertRule)) }),
  'PUT /alerts/rules/:code': O('Notifikasi', 'Atur satu aturan alarm (aktif, ambang, jeda ulang, kanal)', { 200: ok(S.AlertRule) }, { errors: [503] }),
  'GET /alerts/deliveries': O('Notifikasi', 'Riwayat pengiriman notifikasi terbaru', { 200: ok(z.array(S.AlertDelivery)) }),
  'GET /exports/policy': O('Ekspor', 'Batas ekspor dan retensi data (untuk UI)', { 200: ok(S.ExportPolicy) }),

  // ---- Penggunaan dan audit ----
  'GET /usage/summary': O('Penggunaan', 'Ringkasan penggunaan dan kuota', { 200: ok(S.UsageSummary) }),
  'GET /usage/messages': O('Penggunaan', 'Deret waktu pesan (jam/hari, zona waktu IANA)', { 200: list(S.UsagePoint, S.UsageSeriesMeta) }),
  'GET /usage/sessions': O('Penggunaan', 'Pemakaian per sesi', { 200: ok(S.UsageSession.array()) }),
  'GET /audit-logs': O('Audit', 'Log audit (hanya OWNER)', { 200: list(S.AuditLog) }),
};
