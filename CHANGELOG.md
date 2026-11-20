# Changelog

## Unreleased --- Backend: uji ketahanan dan perbaikan gangguan database (2026-11-20)

-   Perbaikan (ADR-038): koneksi DB yang diputus tidak lagi mematikan proses (listener `error` pada pool); leader control-plane memeriksa koneksinya dan kunci per schema; batas waktu koneksi `DB_CONNECT_TIMEOUT_MS`.
-   Perilaku API: database tidak tersedia kini `503 SERVICE_UNAVAILABLE` + `Retry-After: 2` (sebelumnya 500 `INTERNAL_ERROR`). Frontend: tampilkan "layanan sedang sibuk" dan coba lagi dengan backoff; ulangi kirim pesan dengan `Idempotency-Key` yang sama.
-   Tes: `resilience.test.ts` 12 tes baru; total 282 lulus.

## Unreleased --- Backend H4 lanjutan: 8 kode pemulihan, audit reset, pemulihan workspace (2026-11-20)

-   Berubah (kontrak): `recovery_code` menjadi `recovery_codes` (8 kode sekali pakai) pada register/join-request; `POST /auth/recovery-code` menjadi `POST /auth/recovery-codes` (+ `/confirm`); `reset-password` mengembalikan `remaining_recovery_codes`; `GET /auth/me` memuat `recovery`.
-   Baru: audit `account.password_reset` ke semua workspace anggota dan `join_request.created`; `POST /auth/deleted-workspaces` dan `POST /auth/restore-workspace` (OWNER, 30 hari). Migrasi 0017. Tes: 270 lulus.

## Unreleased --- Backend Fase H4: manajemen akun, kode pemulihan, ganti nama, hapus workspace (2026-11-20)

-   Baru: `POST /auth/change-password|change-email|recovery-code|reset-password|logout-all`, `PATCH /api-keys/:id`, `PATCH /sessions/:id`, `PATCH /tenant`, `DELETE /tenant`. Lupa kata sandi tanpa email lewat kode pemulihan (`recovery_code` pada register/join-request; alat operator `npm run admin:recovery-code`).
-   Keamanan: `token_version` mencabut access token seketika; kata sandi salah dijawab 403 (bukan 401); hapus workspace lunak lalu dihapus permanen setelah `RETENTION_TENANT_DAYS`. Hapus akun sendiri sengaja tidak ada. Migrasi 0016, ADR-037.
-   Tes: 267 lulus (15 baru di `test/account.test.ts`).

## Unreleased --- Backend H3 lanjutan: batas antrean dan retensi permintaan bergabung (2026-11-20)

-   Baru: batas antrean `JOIN_MAX_PENDING` (default 50 per tenant; `409 JOIN_QUEUE_FULL`, akun tidak dibuat; batas eksak walau pengajuan serentak) dan retensi `RETENTION_JOIN_REQUEST_DAYS` (default 90). Migrasi 0015 (kebijakan RLS khusus hitung antrean, platform SELECT/DELETE, indeks).
-   Tes: 252 lulus (4 baru).

## Unreleased --- Backend Fase H3: permintaan bergabung dengan kode workspace (2026-11-20)

-   Baru: kode workspace (`GET|PUT|DELETE /team/join-code`), `POST /auth/join-requests` (publik; kata sandi dibuat pemohon saat mendaftar), `GET /team/join-requests`, `POST /team/join-requests/:id/approve|reject`.
    Login pemohon sebelum disetujui: `403 JOIN_PENDING` / `JOIN_REJECTED`. Migrasi 0014 (RLS), env `JOIN_REQUEST_TTL_DAYS`, ADR-036. Undangan tetap ada.
-   Tes: 248 lulus (10 baru di `test/join.test.ts`), termasuk serangan RLS langsung oleh pemohon.

## Unreleased --- Backend: perbaikan hasil verifikasi role DB di staging (2026-11-20)

-   Perbaikan: `npm run build` gagal dari checkout bersih (menyalin folder `legacy` yang tidak ada); migrator tidak lagi butuh hak CREATE pada database (cek `pg_namespace` sebelum `CREATE SCHEMA`).
-   Dokumen: `DB_ROLES.md` berstatus TERUJI (migrasi, `verify-db-roles.sh` 15/15, start `DB_ROLE_CHECK=enforce`, smoke test dengan role `wazap_app`); langkah REVOKE `schema_migrations` (default privileges ikut memberi hak app pada tabel itu).

## Unreleased --- Backend: perbaikan hasil code-review (2026-11-20)

-   Perbaikan: `tz` offset di `/usage/messages` ditolak 400 (sebelumnya bergeser 14 jam); `reissue` undangan kedaluwarsa memeriksa kuota anggota; audit tidak lagi membuang `max_api_keys`;
    PATCH `/tenant/settings` mengabaikan nilai yang tidak berubah.
-   Perilaku baru (offboarding, ADR-035): hapus/keluar anggota mencabut API key buatannya; hapus/tangguhkan/turunkan peran mencabut undangan tertunda buatannya. `GET /api-keys` memuat `created_by`.
-   Kode: helper bersama `team/team-lock.ts`. Tes: 238 lulus (8 baru).

## Unreleased --- Frontend Penyatuan Menu Koneksi & Layout Ergonomis (2026-11-20)

- **Menu Terpadu "Koneksi & API" (`/connections`):**
  - Menggabungkan pengelolaan Sesi WhatsApp, Kunci Akses REST API, dan Webhooks ke dalam satu halaman terpadu dengan navigasi Tab elegan.
  - Sidebar dirapikan menjadi 3 kategori logis (*Aktivitas Utama*, *Integrasi & Gateway*, *Konfigurasi & Kepatuhan*).
  - Tautan lama (`/sessions`, `/api-keys`, `/webhooks`) tetap diarahkan otomatis (*auto-redirect*) ke tab yang sesuai untuk menjamin kompatibilitas tautan.
- **Layout Ergonomis & Responsif Proporsional:**
  - Menghilangkan jarak kosong canggung di monitor desktop/laptop lebar dengan kontainer dinamis `max-w-[1440px]` dan padding berjenjang (`px-4 sm:px-6 lg:px-8 py-6`).
  - Menyelaraskan batas kiri dan kanan antara Header dan Main Content secara presisi sehingga nyaman dipandang di semua resolusi layar (ponsel, tablet, laptop, dan monitor lebar).

## Unreleased --- Frontend Peningkatan UI/UX Interaktif 6 Tahap (2026-11-20)

- **Tahap 1 (Setup Wizard Dashboard):** Widget interaktif "Panduan Memulai Gateway" 4-langkah dengan progress bar persentase selesai, kalkulasi otomatis status kesiapan, tombol CTA langsung, dan opsi tampil/sembunyi.
- **Tahap 2 (Live WhatsApp Phone Preview):** Simulator layar ponsel WhatsApp interaktif di samping composer pesan (`/messages`), formatting toolbar interaktif (`*bold*`, `_italic_`, `~strike~`, ````code````, emoji picker), dan auto-formatting kode negara internasional (+62).
- **Tahap 3 (Visual Pairing Guide Modal):** Panduan visual 3 langkah terstruktur pada modal QR WhatsApp (`/sessions`) dengan tombol penyegaran manual dan indikator auto-refresh.
- **Tahap 4 (Pengalaman Obrolan WhatsApp Web):** Desain obrolan 2 kolom dengan wallpaper doodle WhatsApp klasik (`/chats`), bubble chat hijau muda/putih, status centang ganda biru/abu (`READ`/`DELIVERED`), pencarian chat instan, dan bar emoji quick-insert.
- **Tahap 5 (Developer Code Playground):** Tab cuplikan kode integrasi siap salin (`/api-keys`) yang mendukung bahasa cURL, Node.js (Fetch), PHP (cURL), dan Python (requests) dengan tombol 1-klik salin snippet.
- **Tahap 6 (Notifikasi Toast & Audio Feedback):** Sistem notifikasi mengambang (`ToastContext`) terintegrasi dengan event Socket.IO (`message.incoming`, `session.connected`), audio feedback nada lembut berbasis Web Audio API murni (tanpa aset eksternal), serta tombol toggle mute/suara di Header.

## Unreleased --- Frontend Integrasi Penuh Kontrak Backend Fase H2 (2026-11-20)

- **Penyelarasan Kontrak Backend Nyata (Zero Mock):**
  - Menghapus seluruh asumsi prototipe lama (kontrak login `{username, password}`, route `/messages/history` gabungan, mock palsu).
  - Mengintegrasikan seluruh halaman frontend React ke endpoint resmi backend Fase A–H2.
- **Autentikasi & Keamanan Ketat:**
  - Login dan Registrasi menggunakan format standar `{ email, password }` (dan `tenant_name` untuk pendaftaran).
  - Access token JWT disimpan **hanya di memori** (`tokenStore` di `services/api.ts`). Tidak ada token yang bocor ke `localStorage` maupun `sessionStorage`.
  - Refresh token dikelola via cookie browser `HttpOnly` (`credentials: 'include'`).
  - Mekanisme *single-flight refresh handler* dengan promise lock untuk mencegah race condition pencabutan refresh token pada request paralel yang mengembalikan HTTP 401.
  - Multi-tenant workspace switcher di header dengan auto-clear cache TanStack Query dan reconnect Socket.IO.
- **Sesi WhatsApp & Ephemeral QR:**
  - Dukungan lengkap untuk 13 status siklus hidup sesi WhatsApp: `CREATED`, `PENDING_ASSIGNMENT`, `INITIALIZING`, `QR_REQUIRED`, `CONNECTING`, `RECONNECTING`, `CONNECTED`, `DISCONNECTING`, `DISCONNECTED`, `LOGGED_OUT`, `ERROR`, `DELETING`, `DELETED`.
  - Aksi sesi: `createSession`, `connectSession`, `disconnectSession`, `reconnectSession`, `deleteSession`.
  - Modal pairing QR ephemeral via `GET /sessions/:id/qr` (`qr_data_url`) yang dibersihkan dari memori secara instan saat modal ditutup, komponen unmount, atau status sesi berubah menjadi `CONNECTED`.
- **Pengiriman & Riwayat Pesan:**
  - Header `Idempotency-Key` unik di-generate di sisi klien pada setiap pengiriman pesan untuk mencegah duplikasi.
  - Normalisasi visual nomor tujuan WhatsApp (deteksi awalan `08...` dengan opsi 1-klik `628...`).
  - Riwayat pesan terpaginasi dengan filter sesi, status (termasuk `UNKNOWN` dan `RECONCILIATION_REQUIRED`), rentang tanggal ISO, serta aksi `cancel` dan `retry` dengan konfirmasi risiko.
- **Chats & Kontak WhatsApp:**
  - Integrasi langsung ke endpoint `/api/v1/chats`, `/api/v1/chats/:id/messages`, dan `/api/v1/contacts`.
  - Antarmuka obrolan 2 kolom dengan timeline percakapan interaktif dan form balasan cepat.
  - Penanganan flag paginasi `meta.total_capped` ("10.000+").
- **Webhook & API Key:**
  - Webhook: CRUD endpoint, reveal-once dialog signing secret HMAC-SHA256, rotasi secret, toggle active, dan test ping per endpoint.
  - API Key: Pemilihan scope granular valid dari `VALID_API_KEY_SCOPES` (tanpa wildcard `*`), reveal-once plain-text key dialog, dan pencabutan kunci.
- **Kolaborasi Tim & Zero-Email Invites:**
  - Manajemen anggota tim: pembaruan peran (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), mutasi status, dan penghapusan anggota.
  - Dialog berbagi undangan tanpa email: (1) Salin tautan undangan langsung, (2) Render QR Code di sisi klien menggunakan pustaka `qrcode`, (3) Kirim pesan undangan via tautan WhatsApp `wa.me` atau langsung melalui nomor WhatsApp Gateway yang aktif.
  - Tombol terbit ulang tautan (`reissue`) dan pembatalan undangan (`revoke`).
  - Halaman penerima undangan `/invite` (`InviteAcceptPage.tsx`) dengan registrasi anggota baru dan perpindahan workspace otomatis.
- **Analitik Penggunaan & Konfigurasi Kuota:**
  - Visualisasi ringkasan kuota dan throughput rate dari `/api/v1/usage/summary`.
  - Grafik batang deret waktu volume pesan per hari/jam dari `/api/v1/usage/messages` dengan parameter zona waktu `tz=Asia/Jakarta`.
  - Rincian performa sesi dari `/api/v1/usage/sessions`.
  - Formulir alokasi batas kuota tenant (`/settings`) khusus `OWNER`, dibatasi nilai `minimums` dan `ceilings` serta menangani kode galat `LIMIT_BELOW_USAGE`.
- **Log Audit Workspace:**
  - Halaman `/audit-logs` khusus `OWNER` dan `ADMIN` untuk memantau jejak audit aktivitas administratif, filter aksi, dan paginasi.
- **Sinkronisasi Realtime:**
  - Socket.IO terhubung ke path `/api/v1/realtime` dengan handshake token auth, auto-reconnect cache invalidation, dan penanganan event `auth.expired` serta `realtime.resync`.
- **Verifikasi Build:**
  - `npm --prefix frontend run build` sukses 100% dengan 0 kesalahan TypeScript.

## Unreleased --- Backend Fase H2 (2026-11-19)

-   Migrasi 0012--0013: `audit_logs` (append-only) dan pengetatan kebijakan pencatatan penerimaan undangan.
-   Endpoint baru: `GET /audit-logs`, `GET|PATCH /tenant/settings`, `POST /team/invitations/:id/reissue`. Respons undangan memuat `invite_url`. Kode galat baru: `LIMIT_BELOW_USAGE`.
-   Keputusan: undangan TANPA email (tautan/QR/WhatsApp via sesi tenant), audit log tim + kuota, kuota dapat diubah OWNER dalam batas atas global (`LIMIT_CEIL_*`).
-   `invite_url` memakai fragmen (`/invite#token=...`) agar token tidak masuk access log; `DASHBOARD_BASE_URL` divalidasi (http(s) tanpa kredensial/query/fragment; https di production).
-   Env baru: `DASHBOARD_BASE_URL`, `RETENTION_AUDIT_DAYS`, `LIMIT_CEIL_SESSIONS|API_KEYS|MEMBERS|MESSAGES_PER_MINUTE`.
-   Tes: 227 lulus (15 baru) + 9 validasi performa.

## Unreleased --- Backend Fase H (2026-11-19)

-   Migrasi 0011: `tenant_invitations`, `tenant_memberships.member_email`, `tenant_settings.max_members`, indeks `idx_wa_messages_tenant_in`.
-   Endpoint baru: `/team/members` (GET/PATCH/DELETE), `/team/invitations` (GET/POST/DELETE) + `/team/invitations/accept`, `POST /auth/switch-tenant`,
    `/usage/summary`, `/usage/messages`, `/usage/sessions`. `GET /messages` menerima `from`/`to` (rentang `created_at`, `from` inklusif, `to` eksklusif).
-   Kode galat baru: `INVALID_RANGE`, `CANNOT_MODIFY_SELF`, `INVALID_INVITATION`, `LAST_OWNER`, `ALREADY_MEMBER`, `INVITATION_EXISTS`. Env baru: `TEAM_INVITATION_TTL_HOURS`.
-   Frontend: mock `team`/`usage` dapat diganti endpoint nyata; lihat `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` dan `docs/08_AI_AGENTS/FRONTEND_AGENT_PROMPT.md` (diperbarui).
-   Tes: 212 lulus (19 baru) + 8 validasi performa.

## Unreleased --- Backend Fase G (2026-11-19)

-   Migrasi 0009 (circuit breaker webhook) dan 0010 (indeks komposit outbox, hasil validasi EXPLAIN).
-   **Perilaku baru:** 429 `RATE_LIMITED` + `Retry-After` (per IP dan per tenant); header keamanan pada semua respons;
    `meta.total_capped` pada `GET /messages` dan `/chats` (total dibatasi 10000); webhook dinonaktifkan otomatis setelah 10 delivery
    DEAD berturut-turut (objek webhook + `consecutive_failures`, `disabled_at`, `disabled_reason`).
-   **Start server:** menolak start bila role DB superuser/BYPASSRLS di production (`DB_ROLE_CHECK`); peringatan bila role runtime pemilik schema.
-   Skrip baru: `npm run migrate`, `migrate:prod`, `keys:rotate`, `test:perf`. Env baru: `DB_MIGRATE_*`, `AUTO_MIGRATE`, `DB_ROLE_CHECK`,
    `API_RATE_LIMIT_*`, `TRUST_PROXY`, `REQUEST_TIMEOUT_MS`, `WEBHOOK_AUTO_DISABLE_AFTER`, `LIST_COUNT_CAP`.
-   **Belum teruji:** skrip pemisahan role DB (`docs/07_DEPLOYMENT/DB_ROLES.md`).
-   Tes: 193 lulus (21 baru) + 6 validasi performa.
-   Skrip `backend/scripts/verify-db-roles.sh` (verifikasi pemisahan role; teruji terhadap role dev). Dokumentasi Nginx/rahasia/topologi (ADR-029).

## Unreleased --- Backend Fase F (2026-11-19)

-   Migrasi 0005-0008: outbox_events, webhook_endpoints/deliveries/attempts, wa_chats,
    wa_messages, pesan media, retensi (kolom `content_purged_at`, nomor termasker).
-   Endpoint baru: `/webhooks` (+ `rotate-secret`, `test`, `deliveries`, `replay`),
    `/messages/send-media`, `/messages/bulk`, `/chats`, `/chats/:id/messages`, `/contacts`.
    Socket.IO di `/api/v1/realtime`.
-   Status pesan kini dapat `DELIVERED`/`READ`; objek pesan memuat `media` dan
    `content_purged`. Kode error baru: `INVALID_WEBHOOK_URL`, `INVALID_MEDIA_URL`,
    `DUPLICATE_ITEM`, `CONTENT_PURGED`.
-   **Perilaku berubah:** isi pesan & nomor penerima dihapus/dimasker 30 hari setelah status akhir,
    baris dihapus setelah 180 hari (dapat diatur env). `retry` pesan yang isinya sudah dihapus => 409.
-   Env baru: `ENABLE_EMBEDDED_WEBHOOK_WORKER`, `OUTBOX_POLL_MS`, `WEBHOOK_*`, `REALTIME_*`,
    `MEDIA_*`, `BULK_MAX_MESSAGES`, `ENABLE_EMBEDDED_RETENTION`, `RETENTION_*`.
    `WEBHOOK_ALLOW_PRIVATE_TARGETS`/`MEDIA_ALLOW_PRIVATE_TARGETS`/`*_ALLOW_HTTP` harus `false` di produksi.
-   Dependensi baru: `socket.io@4.8.4` (dev: `socket.io-client@4.8.4`).
-   Tes: 172 lulus (60 baru).

## Unreleased --- Backend Fase C (2026-11-19)

-   Migrasi 0002: engine_nodes, wa_sessions, wa_session_events,
    session_leases (fencing monoton via trigger), session_credentials.
-   Endpoint baru: `/sessions` (create/list/get/status/events/connect/
    disconnect/reconnect/delete) dengan role + scope.
-   Engine registry, penempatan weighted least-loaded, lease/fencing,
    control-plane (pemulihan, finalisasi, penempatan adil).
-   **Kontrak berubah / breaking:** `LEGACY_AUTH_ENABLED` default `false`
    (login admin env dan route prototipe nonaktif; frontend lama tidak
    berfungsi sampai dimigrasikan). `/api/v1/sessions` kini kontrak baru.
-   Env baru: `ENGINE_LEASE_TTL_SECONDS`, `ENGINE_HEARTBEAT_SECONDS`,
    `ENGINE_SUSPECT_AFTER_SECONDS`, `ENGINE_UNHEALTHY_AFTER_SECONDS`,
    `CONTROL_PLANE_INTERVAL_MS`, `ENABLE_EMBEDDED_CONTROL_PLANE`.

## Backend Fase B (2026-11-19)

-   Migrasi 0001 (schema `gateway`): identity, tenant, API key, refresh
    token, RLS FORCE, composite FK. Runner migrasi berversi.
-   Endpoint baru: `/auth/register|login|refresh|logout|me`,
    `/api-keys` (GET/POST/DELETE). Format envelope dan kode error stabil.
-   **Kontrak berubah:** auth dashboard memakai access token + refresh
    cookie HttpOnly; API key baru berformat `gwk_...`; login
    `{username,password}` tetap sebagai kompatibilitas sementara.
-   Route prototipe sessions/messages/webhooks hanya untuk principal
    legacy (501 untuk workspace baru) sampai Fase C-F.
-   Dependency: `@node-rs/argon2`, `@fastify/cookie` (pinned).

## Backend Fase A (2026-11-19)

-   Config environment tervalidasi Zod, fail-fast.
-   Endpoint `/health/live` dan `/health/ready` (kontrak: tidak ada
    perubahan pada `API_CONTRACT.md`; health berada di luar `/api/v1`).
    `/health` kini bisa mengembalikan 503.
-   Graceful shutdown dan redaksi secret pada log.
-   Dependency backend di-pin; `backend/data/` di-ignore git.

## 1.0.0 --- Initial AI Agent Development Kit

-   Menetapkan keputusan produk self-service, dynamic sessions,
    dashboard + API.
-   Menetapkan arsitektur multi-tenant dan engine pool.
-   Menetapkan PostgreSQL sebagai database.
-   Menetapkan Baileys adapter dengan risiko terdokumentasi.
-   Menetapkan queue PostgreSQL untuk tahap awal.
-   Menambahkan prompt Master, Backend, Frontend, Integration, QA.
-   Menambahkan aturan dokumentasi dan handoff antar-agent.

## Fase D --- Adapter, engine runtime, auth state terenkripsi (2026-11-19)

-   Dihapus: seluruh kode legacy prototipe (login admin, route legacy,
    session.manager, messaging/webhook prototipe, `database/legacy`) dan env
    terkait. Sesi prototipe harus dipasangkan ulang (ADR-013).
-   Ditambah: migrasi 0003 (`session_auth_state`, `session_qr`), enkripsi
    AES-256-GCM berkeyring (`security/credential-crypto.ts`), auth store
    berfencing, QR store, `SessionAdapter` + `BaileysAdapter`, `SessionRunner`,
    `EngineRuntime` (heartbeat, renew, recovery, reconnect backoff, shutdown
    rapi), `GET /sessions/:id/qr`.
-   Transisi lifecycle baru: `INITIALIZING -> RECONNECTING`,
    `QR_REQUIRED -> CONNECTED`.
-   Env baru: `ENABLE_EMBEDDED_ENGINE`, `ENGINE_NODE_NAME`, `ENGINE_MAX_SESSIONS`,
    `ENGINE_WEIGHT`, `ENGINE_MIN_FREE_MEM_MB`, `ENGINE_SYNC_INTERVAL_MS`,
    `RECONNECT_*`, `QR_TTL_SECONDS`, `CREDENTIAL_ENCRYPTION_KEYS`.
    Dihapus: `ADMIN_*`, `TOKEN_TTL_SECONDS`, `DEFAULT_TENANT_ID`,
    `SESSION_DATA_PATH`, `LEGACY_AUTH_ENABLED`.

## Fase E --- Antrean pesan & pengiriman (2026-11-19)

-   Ditambah: migrasi 0004 (`message_queue`, `message_attempts`), API
    `/messages/send|list|detail|status|cancel|retry`, idempotensi, batas
    pesan/menit, lane serial per sesi, retry berbackoff, rekonsiliasi hasil
    ambigu, `SessionAdapter.sendText` (+ `SendError`), pompa kirim di
    `SessionRunner`, reap pesan di control-plane.
-   Diperbaiki: penempatan sesi tidak lagi berhenti total saat satu sesi PENDING
    lease-nya masih dipegang pihak lain.
-   Env baru: `MESSAGE_*`, `MAX_PENDING_PER_TENANT`, `SEND_TIMEOUT_MS`,
    `SESSION_SEND_INTERVAL_MS`, `QUEUE_POLL_MS`, `VERIFY_RECIPIENT`.
