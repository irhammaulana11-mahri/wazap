# Changelog

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
