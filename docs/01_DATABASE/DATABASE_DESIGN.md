# PostgreSQL Database Design

## 1. Database boundary

Gunakan database khusus `whatsapp_gateway_db` dan role khusus. Jangan
mengubah database aplikasi lain.

## 2. Schema domains

-   `identity`: users, tenants, memberships, api_keys.
-   `sessions`: wa_sessions, session_events, engine_nodes,
    session_leases, credential_refs.
-   `messaging`: contacts, chats, messages, message_queue,
    message_attempts, templates.
-   `integration`: webhook_endpoints, webhook_deliveries, outbox_events,
    idempotency_keys.
-   `operations`: audit_logs, usage_events, system_settings.

Boleh menggunakan schema PostgreSQL terpisah atau prefix konsisten.
Pilih satu pola dan dokumentasikan.

## 3. Core entities

### tenants

UUID PK, name, slug unique, status, created_at, updated_at.

### users

UUID PK, email unique normalized, password_hash, status, created_at,
updated_at.

### tenant_memberships

tenant_id FK, user_id FK, role, status, created_at. Unique (tenant_id,
user_id).

### api_keys

UUID PK, tenant_id FK, name, key_prefix, key_hash, scopes JSONB,
last_used_at, expires_at, revoked_at. Secret hanya ditampilkan saat
pembuatan.

### wa_sessions

UUID PK, tenant_id FK, session_name, phone_number nullable, status,
adapter, engine_id nullable, auth_version, created_at, updated_at,
deleted_at. Unique constraints harus mempertimbangkan tenant dan
identitas session.

### engine_nodes

UUID PK, node_name, hostname, status, version, heartbeat_at,
resource_snapshot JSONB, capacity_config JSONB.

### session_leases

session_id PK/FK, engine_id FK, lease_expires_at, fencing_token BIGINT,
acquired_at, updated_at.

### session_credentials

session_id PK/FK, storage_key, encryption_key_version, auth_version,
updated_at. Tidak menyimpan plaintext credential.

### message_queue

UUID PK, tenant_id, session_id, idempotency reference, recipient,
message_type, payload JSONB, status, priority, attempts, max_attempts,
scheduled_at, processing_at, completed_at, last_error_code, created_at,
updated_at.

### message_attempts

UUID PK, job_id FK, attempt_number, engine_id, started_at, finished_at,
outcome, provider_message_id nullable, error_code nullable, error_detail
sanitized.

### wa_chats / wa_messages

Selalu membawa tenant_id. Terapkan composite FK untuk memastikan
chat/session/message tenant konsisten.

### outbox_events

UUID PK, tenant_id, aggregate_type, aggregate_id, event_type, payload
JSONB, status, attempts, available_at, created_at, delivered_at.

### webhook_endpoints / webhook_deliveries

Endpoint, secret reference, subscribed events, active state, response
status, attempt count, next retry, sanitized response metadata.

## 4. Data types and conventions

-   UUID untuk entity identifiers.
-   TIMESTAMPTZ untuk waktu.
-   JSONB untuk payload fleksibel, bukan pengganti kolom relasional
    penting.
-   BIGINT identity boleh digunakan untuk tabel log/telemetry ber-volume
    tinggi bila sesuai.
-   Semua timestamps UTC.
-   Explicit constraints untuk status dan foreign keys.

## 5. Tenant isolation

-   Tenant ID berasal dari authenticated principal/API key, bukan
    request body.
-   Terapkan authorization di service layer.
-   Gunakan PostgreSQL RLS sebagai defense in depth.
-   Gunakan `SET LOCAL` dalam transaksi untuk tenant context.
-   App DB role tidak boleh BYPASSRLS.
-   Test cross-tenant read/write pada setiap domain.
-   Composite foreign keys harus mencegah relasi lintas tenant.

## 6. Queue indexes

Pertimbangkan partial indexes untuk status pending, index
`(tenant_id, session_id, status, scheduled_at)`, dan index untuk lease
expiry. Validasi dengan EXPLAIN ANALYZE menggunakan data realistis.

## 7. Migration policy

-   Semua perubahan schema melalui migration versioned.
-   Migration harus dapat direview dan memiliki rollback/forward-fix
    plan.
-   Jangan menjalankan destructive migration otomatis di production.
-   Catat migration di `MIGRATION_LOG.md`.

## 8. Implementasi aktual (Fase B, 2026-11-19)

-   **Pola schema:** PostgreSQL schema terpisah `gateway` (env `DB_SCHEMA`)
    di database dev `wazap_db`. Tabel prototipe lama tetap di schema
    `public` dan tidak disentuh sampai digantikan (Fase C-F). SQL
    migrasi memakai nama tanpa kualifikasi; runner menetapkan
    `search_path`. Pool gateway memakai `-c search_path=<schema>`.
-   **Prasyarat DB:** role aplikasi memerlukan `CREATE` pada database
    (`GRANT CREATE ON DATABASE wazap_db TO wazap_user`). Role tidak
    superuser dan tidak BYPASSRLS.
-   **Runner migrasi:** `backend/src/database/migrator.ts`; file
    `NNNN_nama.sql` berurutan, satu transaksi per file, tabel
    `schema_migrations` (version, name, checksum SHA-256), advisory lock,
    checksum berubah => error. Tidak ada rollback otomatis (forward-fix).
-   **Konteks RLS** (transaction-local via `set_config(..., true)`, hanya
    diisi dari principal terverifikasi, tidak dari input klien):
    `app.tenant_id`, `app.user_id`, `app.login_email`,
    `app.api_key_hash`, `app.refresh_hash`. Tiga yang terakhir hanya
    membuka satu baris yang sedang diverifikasi (lookup kredensial).
-   Semua tabel identity memakai `ENABLE` + `FORCE ROW LEVEL SECURITY`
    sehingga pemilik tabel pun tunduk pada kebijakan.
-   **Keterbatasan:** satu role dipakai untuk migrasi dan runtime di
    dev. Produksi sebaiknya memisahkan role pemilik (migrasi) dan role
    aplikasi (runtime, tanpa hak DDL).

## 9. Fase C: sessions, engines, lease (migrasi 0002)

-   **Konteks platform:** `app.scope = 'platform'` (via `DbContext.platform`)
    membuka akses lintas tenant pada `wa_sessions`, `wa_session_events`,
    `session_leases`, dan satu-satunya akses ke `engine_nodes` serta
    `session_credentials`. Hanya boleh dipakai di `src/modules/engine`,
    `src/runtime`, `src/database` (dijaga oleh tes yang memindai source).
    Jalur tenant tidak pernah memakai scope ini (TENANT_ISOLATION aturan 8).
-   **Lease:** satu baris `session_leases` per sesi, tidak pernah dihapus,
    sehingga `fencing_token` monoton. Trigger DB menolak token turun dan
    perpindahan owner tanpa kenaikan token. Takeover = UPDATE atomik
    (compare-and-set) hanya jika lease kosong atau kedaluwarsa.
-   **Penulisan berfencing:** `withFence` mengunci baris lease `FOR SHARE`;
    takeover menunggu commit, sehingga engine lama tidak dapat menulis
    setelah kehilangan kepemilikan. Tidak ada lock/transaksi selama
    network send (hanya selama penulisan DB singkat).
-   **Penempatan:** `pg_advisory_xact_lock` global + hitung beban dari
    lease aktif; tidak ada overcommit di bawah konkurensi (diuji).

## 10. Fase D: auth state terenkripsi & QR (migrasi 0003)

-   `session_auth_state (session_id, item_type, item_id)` PK; `ciphertext
    bytea` (AES-256-GCM, format `[1B fmt][4B key version][12B IV][ct][16B tag]`),
    `encryption_key_version`. Composite FK `(tenant_id, session_id)` ON DELETE
    CASCADE. RLS: hanya platform (engine).
-   `session_qr (session_id PK)`: QR terenkripsi berumur pendek
    (`expires_at`). RLS: SELECT untuk tenant pemilik (ciphertext; dekripsi di
    API) atau platform; INSERT/UPDATE/DELETE hanya platform.
-   `session_credentials` kini dipakai: satu baris per sesi
    (`storage_key='db:session_auth_state'`, `auth_version` naik tiap creds
    disimpan, bersama `wa_sessions.auth_version`).
-   Penghapusan: logout/delete menghapus `session_auth_state`, `session_qr`,
    `session_credentials` (`eraseAuthIn`). Tidak ada plaintext kredensial di DB
    (diuji).

## 11. Fase E: antrean pesan (migrasi 0004)

-   `message_queue`: lihat TABLE_SPECIFICATION. Idempotensi disimpan di baris job
    (`idempotency_key` + `request_hash`, unique per tenant, parsial) --- tidak
    ada tabel `idempotency_keys` terpisah (keputusan: satu sumber kebenaran).
-   `message_attempts` append-only: trigger melarang UPDATE pada percobaan
    yang sudah punya `outcome` dan DELETE langsung; RLS: tenant hanya SELECT.
-   Index klaim parsial `(session_id, priority DESC, scheduled_at, created_at)
    WHERE status='PENDING'`; index PROCESSING kedaluwarsa; index pending-age;
    `(tenant_id, started_at DESC)` untuk jendela rate limit. Belum divalidasi
    EXPLAIN ANALYZE dengan data realistis.
-   RLS `tenant_settings`: ditambah kebijakan SELECT platform (engine membaca
    `messages_per_minute`).

## 12. Fase F: outbox, webhook, chat, media, retensi (migrasi 0005-0008)

-   **Outbox transaksional:** `outbox_events` diisi trigger pada `wa_session_events`
    (INSERT) dan `message_queue` (UPDATE OF status) serta `wa_messages` (INSERT IN)
    --- satu transaksi dengan perubahan sumber. Index parsial `PENDING (created_at,id)`
    dan `DISPATCHED (dispatched_at)` untuk penyapuan retensi. Tenant hanya dapat
    INSERT (lewat trigger dalam konteksnya); baca/ubah/hapus hanya platform.
-   **Webhook:** `webhook_endpoints` (secret terenkripsi + hint), `webhook_deliveries`
    (unik `(endpoint_id,event_id)`; klaim berbasis `locked_until`), `webhook_delivery_attempts`
    (metadata tersanitasi, tanpa body respons). FK komposit `(tenant_id, endpoint_id)` + cascade.
-   **Chat:** `wa_chats` unik `(session_id, remote_jid)`; `wa_messages` unik parsial
    `(session_id, direction, provider_message_id)` (idempotensi pesan masuk) dan
    `(queue_id)` (cermin pesan keluar). Tenant hanya SELECT; tulis platform.
    Trigger `mirror_outbound_message` mencerminkan SENT/DELIVERED/READ.
-   **Media:** `message_queue.message_type` image/video/audio/document; CHECK bentuk
    payload (`text` untuk teks, `url` untuk media).
-   **Retensi:** `content_purged_at`, nomor termasker, index parsial penyapuan; lihat ADR-022.
-   Index belum divalidasi EXPLAIN ANALYZE dengan data realistis.

## 13. Fase G: validasi indeks (`npm run test:perf`)

Data uji: 6 tenant, 18 sesi; `message_queue` 300k (1% FAILED, 0,7% PENDING, selebihnya selesai tersebar 400 hari),
`message_attempts` 150k, `wa_messages` 300k, `wa_chats` 30k, `outbox_events` 200k, `webhook_deliveries` 150k. PostgreSQL 18
konfigurasi default (shared_buffers 128MB), satu koneksi, mesin dev. **Bukan benchmark produksi**; waktu hanya indikatif.

| Kueri | Indeks yang dipakai | Waktu |
|---|---|---|
| klaim kandidat per sesi | `idx_message_queue_claim` | (plan) |
| jadwal terdekat sesi | `idx_message_queue_claim` | 2,1 ms |
| daftar pesan tenant | `idx_message_queue_tenant_list` | 0,28 ms |
| daftar pesan + filter status | `idx_message_queue_tenant_list` | 12 ms |
| **total pesan tenant (count eksak)** | `message_queue_tenant_id_id_key` | **84 ms (O(n))** |
| hitung PENDING tenant | `idx_message_queue_tenant_pending` | 0,68 ms |
| idempotensi (tenant,key) | `uq_message_queue_idem` | 0,02 ms |
| receipt (sesi, provider id) | `idx_message_queue_provider` | 0,07 ms |
| rate window tenant | `idx_message_attempts_rate` | 0,07 ms |
| daftar delivery endpoint / chat tenant / riwayat chat | indeks masing-masing | 0,11-0,13 ms |
| kontak (agregasi per nomor) | `wa_chats_tenant_id_id_key` | 13 ms (O(chat tenant)) |
| inbound: chat (sesi,jid) / cek duplikat | `..._remote_jid_key` / `uq_wa_messages_provider` | 0,06-0,08 ms |
| penyapu retensi (6 kueri) dan reap, outbox relay, klaim webhook | indeks parsial/komposit | (plan) |

Tindakan: `count(*)` eksak dibatasi (ADR-027); indeks outbox diganti (migrasi 0010). Throughput dasar (1 koneksi, 1 proses):
enqueue ~7 ms/pesan (~140/dtk sekuensial), relay outbox ~1,8 ms/event (~555/dtk). Belum diukur: klaim+kirim paralel
banyak sesi, banyak koneksi, beban campuran, dan pompa polling (satu query per sesi CONNECTED per `QUEUE_POLL_MS`).
