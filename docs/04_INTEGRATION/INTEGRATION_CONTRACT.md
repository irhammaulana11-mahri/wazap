# Integration Contract

## Source of truth

-   REST schemas: `docs/02_BACKEND/API_CONTRACT.md`
-   Realtime events: `docs/04_INTEGRATION/SOCKET_EVENTS.md`
-   Webhook events: `docs/04_INTEGRATION/WEBHOOK_SPECIFICATION.md`
-   Database semantics: `docs/01_DATABASE/`

## Rules

-   Backend owns API and event contracts.
-   Frontend consumes contracts; it must not invent endpoints or fields.
-   Any contract change must update docs and notify frontend/integration
    agents.
-   Use OpenAPI specification as machine-readable contract when
    implemented.
-   Use shared TypeScript types or generated client where practical.
-   Contract tests must validate response schemas and event payloads.

## Integration checklist

-   Auth and tenant context.
-   API key scopes.
-   Session create/connect/QR/status.
-   Message submission and job status.
-   Incoming message event.
-   Webhook signature and retry.
-   Pagination and errors.
-   Socket room authorization.

## Catatan Fase B untuk Frontend/Integration (2026-11-19)

-   Auth baru tersedia (lihat API_CONTRACT "Implementasi Fase B"):
    simpan `access_token` di memori, refresh lewat cookie HttpOnly
    (`credentials: 'include'`), tangani 401 dengan satu kali
    `POST /auth/refresh` lalu ulang request.
-   Respons memakai envelope `{success, data, meta}` / error
    `{success:false, error{code,message,details}, request_id}`.
-   Sesi/pesan/webhook untuk workspace baru belum tersedia (501) sampai
    Fase C-F. Frontend saat ini masih memakai login legacy.
-   Belum ada kontrak yang dibutuhkan frontend yang hilang untuk auth;
    endpoint register/invite anggota tenant belum ada.

## Catatan Fase C untuk Frontend/Integration

-   **Frontend lama (login username/password + `/api/v1/sessions` prototipe)
    tidak lagi berfungsi** karena `LEGACY_AUTH_ENABLED=false`. Frontend perlu
    memakai login email/register, `credentials: 'include'`, envelope
    `{success,data,meta}`, dan kontrak sessions baru (field `session_name`,
    `status` 13 state, `desired_state`).
-   QR belum tersedia (Fase D). Event realtime (Socket.IO) belum ada (Fase F);
    gunakan polling `GET /sessions/:id/status` dan `/events` sementara.
-   Kontrak yang dibutuhkan frontend namun belum ada: `GET /sessions/:id/qr`,
    Socket.IO events, ringkasan penggunaan.

## Catatan Fase D untuk Frontend/Integration

-   QR tersedia: `GET /api/v1/sessions/:id/qr` (lihat API_CONTRACT Fase D).
    Alur UI: buat sesi -> polling `/status`; saat `QR_REQUIRED` tampilkan
    `qr_data_url` dan perbarui tiap ~5 detik; saat `CONNECTED` berhenti.
    `ERROR` + `status_reason=qr_timeout` => tampilkan tombol "Buat QR baru"
    (`POST /connect`). `LOGGED_OUT` => perlu pair ulang (`POST /connect`).
-   Kompatibilitas legacy dihapus total (login username, token/API key
    `wazap_`, `/legacy/*`). Dua sesi WhatsApp prototipe harus dipasangkan ulang.
-   Pengiriman pesan, webhook, dan Socket.IO belum ada (Fase E/F).
-   Variabel lingkungan baru: lihat `backend/.env.example` (Fase D).

## Catatan Fase E untuk Frontend/Integration

-   Kirim teks: `POST /api/v1/messages/send` (202, async). Kirim selalu
    dengan `Idempotency-Key` unik per pesan logis; ulangi dengan kunci yang sama
    saat timeout jaringan. Pantau lewat `GET /messages/:id/status` (polling) sampai
    status akhir.
-   Tampilkan `SENT` sebagai "terkirim ke WhatsApp", bukan "diterima/dibaca".
    `UNKNOWN`/`RECONCILIATION_REQUIRED` => tawarkan "kirim ulang" dengan peringatan
    kemungkinan pesan ganda (`confirm_duplicate_risk`).
-   Antrean dapat tertunda oleh batas pesan/menit tenant dan jeda per sesi; 429
    `QUEUE_FULL` bila terlalu banyak pesan PENDING.
-   Belum ada: media, bulk, kontak/chat, pesan masuk, webhook, realtime (Fase F).

## Catatan Fase F untuk Frontend/Integration

-   **Webhook:** kelola lewat `/webhooks`; verifikasi `X-Wazap-Signature` atas raw body +
    timestamp; dedup `event_id`; balas 2xx cepat (timeout 10 dtk), proses async. Simpan secret
    saat dibuat (tidak dapat dilihat lagi; rotasi menghasilkan yang baru). Detail:
    WEBHOOK_SPECIFICATION.
-   **Realtime:** Socket.IO `path:/api/v1/realtime`, `auth:{token}`. Selalu muat ulang state
    setelah (re)connect dan saat `realtime.resync`; tangani `auth.expired` dengan refresh token.
    `session.qr` hanyalah sinyal: ambil gambar QR lewat `GET /sessions/:id/qr`. Detail: SOCKET_EVENTS.
-   **Status pesan:** `DELIVERED`/`READ` kini ada (receipt WhatsApp; bisa tidak datang bila
    penerima menonaktifkan read receipt). `SENT` tetap "diterima server WhatsApp".
-   **Media:** `POST /messages/send-media` dengan URL https publik (bukan unggahan). Tampilkan
    galat unduh (`MEDIA_*`) kepada pengguna. **Bulk:** `POST /messages/bulk` atomik (<= 100).
-   **Chat/kontak:** `GET /chats`, `/chats/:id/messages`, `/contacts`. Isi pesan lama bisa
    `null` (`text_purged`) setelah 30 hari; nomor pada antrean dimasker. Retry pesan yang isinya
    dihapus => 409 `CONTENT_PURGED`.
-   Hanya chat 1:1; grup/status/media masuk (unduhan) tidak didukung.

## Catatan Fase G untuk Frontend/Integration

-   Tangani `429 RATE_LIMITED`: tunda sesuai `Retry-After`, jangan retry buta. Batas dibagi per tenant.
-   `GET /messages` dan `/chats`: bila `meta.total_capped=true`, tampilkan "10.000+" alih-alih angka eksak; paginasi tetap berfungsi.
-   Webhook dapat dinonaktifkan otomatis: tampilkan `disabled_reason` dan tombol aktifkan ulang (`PATCH {active:true}`).
-   Socket.IO dan semua endpoint tetap sama; header keamanan baru tidak mengubah kontrak.
