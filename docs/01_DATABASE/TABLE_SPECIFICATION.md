# Table Specification

  Domain        Table                 Required purpose
  ------------- --------------------- --------------------------------------
  Identity      tenants               Workspace/customer
  Identity      users                 Login identity
  Identity      tenant_memberships    User roles in tenant
  Identity      api_keys              Hashed API credentials and scopes
  Identity      tenant_settings       Tenant configuration and quotas
  Sessions      wa_sessions           WhatsApp session registry
  Sessions      wa_session_events     Lifecycle audit
  Sessions      engine_nodes          Engine registration and heartbeat
  Sessions      session_leases        Single-owner lease and fencing
  Sessions      session_credentials   Encrypted storage reference/version
  Messaging     wa_contacts           Tenant-scoped contacts
  Messaging     wa_chats              Tenant/session conversations
  Messaging     wa_messages           Inbound/outbound message records
  Messaging     message_queue         Durable asynchronous jobs
  Messaging     message_attempts      Attempt-level result and diagnostics
  Messaging     message_templates     Tenant templates
  Integration   webhook_endpoints     Tenant webhook configuration
  Integration   webhook_deliveries    Delivery attempts
  Integration   outbox_events         Transactional event publication
  Integration   idempotency_keys      Request deduplication
  Operations    usage_events          Usage metering
  Operations    audit_logs            Security and admin audit
  Operations    system_settings       Platform-level settings

## Required design detail per table

For every migration, document: - Column name and type. - Nullability and
default. - Primary/foreign/unique/check constraints. - Tenant
ownership. - Indexes and reason. - Retention policy. - Sensitive-data
classification. - Migration and rollback considerations.

Do not invent undocumented columns in frontend or backend. Update this
file when schema changes are approved.

## Detail implementasi: migrasi 0001 (schema `gateway`)

Klasifikasi data: **S** = sensitif/secret-derived, **P** = personal, **I** = internal.
Semua timestamp `timestamptz` UTC. RLS: ENABLE+FORCE pada semua tabel di bawah.

### tenants (tenant-owned: `id`)
`id uuid PK default gen_random_uuid()`, `name varchar(255) NOT NULL`
(tidak kosong), `slug varchar(63) NOT NULL UNIQUE` (regex
`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`), `status` ACTIVE|SUSPENDED|DELETED
default ACTIVE, `created_at`, `updated_at` (trigger). Klasifikasi: I.
RLS: SELECT jika tenant aktif atau user anggota; INSERT/UPDATE/DELETE
hanya tenant aktif. Retensi: soft delete via status.

### users (global; bukan tenant-owned)
`id uuid PK`, `email varchar(254) NOT NULL UNIQUE` (CHECK lower-case,
berisi `@`), `password_hash text NOT NULL` (Argon2id; **S**),
`status` ACTIVE|DISABLED, `last_login_at`, `created_at`, `updated_at`.
Klasifikasi: P + S. RLS: SELECT jika `id = app.user_id` atau
`email = app.login_email`; INSERT/UPDATE/DELETE hanya `id = app.user_id`.

### tenant_memberships (tenant_id)
PK `(tenant_id, user_id)`; FK tenants & users `ON DELETE CASCADE`;
`role` OWNER|MEMBER|VIEWER (ADMIN dihapus di 0021, ADR-053); `status` ACTIVE|SUSPENDED default
ACTIVE; `created_at`. Index `(user_id)`. RLS: SELECT jika tenant aktif
atau user sendiri; mutasi hanya tenant aktif.

### tenant_settings (tenant_id)
PK/FK `tenant_id`; `max_sessions int default 3`, `max_api_keys int
default 20`, `messages_per_minute int default 60` (semua CHECK >= 0),
`settings jsonb default {}`, `updated_at`. Dibuat saat register. Default
kuota bersifat awal dan dapat diubah platform. RLS: hanya tenant aktif.

### api_keys (tenant_id)
`id uuid PK`, `tenant_id` FK, `name`, `key_prefix varchar(16)` (12
karakter pertama untuk tampilan), `key_hash char(64) UNIQUE` (SHA-256
hex; **S**), `scopes jsonb` (CHECK array), `created_by_user_id`,
`last_used_at` (diperbarui paling cepat tiap 60 detik), `expires_at`,
`revoked_at`, `created_at`. `UNIQUE (tenant_id, id)` sebagai target
composite FK domain berikutnya. **Composite FK**
`(tenant_id, created_by_user_id) -> tenant_memberships` `ON DELETE SET
NULL (created_by_user_id)`: pembuat harus anggota tenant yang sama.
Index `(tenant_id, created_at DESC)`. RLS: SELECT jika tenant aktif atau
`key_hash = app.api_key_hash`; mutasi hanya tenant aktif. Raw key tidak
pernah disimpan.

### refresh_tokens (user-owned, membawa tenant_id)
**Tabel baru, tidak ada di daftar awal**; diperlukan oleh
`POST /auth/refresh`. `id`, `user_id`, `tenant_id`, `family_id`,
`token_hash char(64) UNIQUE` (**S**), `expires_at`, `revoked_at`,
`replaced_by_id`, `created_at`. Composite FK
`(tenant_id, user_id) -> tenant_memberships ON DELETE CASCADE`. Index
`family_id`, `user_id`. RLS: SELECT jika `user_id = app.user_id` atau
`token_hash = app.refresh_hash`; mutasi hanya `user_id = app.user_id`.
Retensi: pembersihan token kedaluwarsa belum diimplementasikan (todo).

Fungsi pendukung: `set_updated_at()`, `ctx_text(name)`, `ctx_uuid(name)`
(uuid rusak => NULL => tidak ada akses).

Rollback: tidak ada DROP otomatis; dev saja `DROP SCHEMA gateway CASCADE`.

## Detail implementasi: migrasi 0002 (schema `gateway`)

RLS: ENABLE+FORCE semua tabel. `platform` = konteks `app.scope='platform'`.

### engine_nodes (platform; bukan tenant-owned) --- klasifikasi I
`id`, `node_name UNIQUE`, `hostname`, `status` STARTING|HEALTHY|SUSPECT|
UNHEALTHY|DRAINING|STOPPED, `version`, `adapter_version`, `heartbeat_at`,
`resource_snapshot jsonb(object)`, `capacity_config jsonb` (wajib
`max_sessions` bilangan bulat >= 0; opsional `weight`,
`min_free_mem_mb`), `created_at`, `updated_at`. Index `(status,
heartbeat_at)`. RLS: hanya platform. Kapasitas adalah konfigurasi, bukan
angka asumsi; tentukan dari load test.

### wa_sessions (tenant_id) --- I; `phone_number` P
`id`, `tenant_id` FK cascade, `session_name varchar(50)`, `phone_number`,
`status` (13 state, CHECK), `status_reason`, **`desired_state`**
CONNECTED|DISCONNECTED (kolom baru: niat pengguna; dasar pemulihan),
`adapter` (BAILEYS), `engine_id` FK `ON DELETE SET NULL` (denormalisasi;
otoritas = `session_leases`), `auth_version`, `created_at`, `updated_at`,
`deleted_at` (CHECK: terisi tepat saat status DELETED). `UNIQUE
(tenant_id, id)` untuk composite FK. Unique parsial: nama
(`lower(session_name)` per tenant) dan `phone_number` per tenant selama
status bukan DELETING/DELETED. Index: tenant+created, antrean
PENDING_ASSIGNMENT, finalisasi (DISCONNECTING/DELETING), engine. RLS:
tenant aktif atau platform. Retensi: baris DELETED dipertahankan (soft).

### wa_session_events (tenant_id) --- I
`id bigint identity`, `tenant_id`, `session_id` (composite FK ke
`wa_sessions(tenant_id,id)` cascade), `event_type`, `from_status`,
`to_status`, `actor` USER|API_KEY|SYSTEM|ENGINE, `payload jsonb` (sudah
disanitasi; tanpa QR/kredensial/token), `created_at`. Append-only: hanya
kebijakan SELECT dan INSERT. Index `(session_id, id DESC)`.

### session_leases (tenant_id) --- I
`session_id PK`, `tenant_id` (composite FK cascade), `engine_id` FK
`RESTRICT` nullable, `lease_expires_at` nullable (CHECK: keduanya NULL
bersamaan), `fencing_token bigint >= 0`, `acquired_at`, `updated_at`.
Baris dibuat saat sesi dibuat dan tidak pernah dihapus. Trigger
`enforce_fencing_monotonic`. Index kedaluwarsa dan engine (parsial).

### session_credentials (tenant_id) --- S (referensi saja)
`session_id PK`, `tenant_id` (composite FK cascade), `storage_key`,
`encryption_key_version > 0`, `auth_version`, `updated_at`. Hanya platform.
Belum dipakai sampai Fase D; dihapus saat sesi DELETED.

Rollback: forward-fix; dev `DROP TABLE` urut terbalik atau `DROP SCHEMA
gateway CASCADE`.

## Fase D (migrasi 0003)

### session_auth_state (tenant_id) --- S
`session_id`, `item_type varchar(64)`, `item_id varchar(255)` (PK gabungan),
`tenant_id` (composite FK cascade), `ciphertext bytea`,
`encryption_key_version int > 0`, `updated_at` (trigger). Index
`encryption_key_version` (untuk re-enkripsi saat rotasi). Hanya platform.

### session_qr (tenant_id) --- S
`session_id PK`, `tenant_id` (composite FK cascade), `ciphertext bytea`,
`encryption_key_version`, `expires_at`, `updated_at`. SELECT tenant/platform;
tulis hanya platform. Dihapus saat CONNECTED/putus/logout/delete.

Perubahan: `session_credentials` kini terisi (lihat DATABASE_DESIGN §10).
Rollback: forward-fix; dev `DROP TABLE session_qr, session_auth_state`.

## Fase E (migrasi 0004)

### message_queue (tenant_id) --- S
`id uuid PK`, `tenant_id`, `session_id` (composite FK ke wa_sessions, tanpa
cascade), `idempotency_key varchar(255)?`, `request_hash char(64)?`,
`recipient` (CHECK `^[0-9]{8,15}$`), `message_type` (`text`), `payload jsonb`
(`{text}`), `status` (CHECK 9 nilai), `priority smallint 0-9`, `attempts`,
`max_attempts 1-10`, `scheduled_at`, `processing_at/_expires_at/_engine_id`
(CHECK: `expires` terisi iff PROCESSING), `provider_message_id`, `completed_at`,
`last_error_code`, `actor`, timestamps. `UNIQUE(tenant_id,id)`. Unique parsial
`(tenant_id, idempotency_key)`.

### message_attempts (tenant_id) --- S
`id bigint identity PK`, `tenant_id`, `job_id` (composite FK cascade),
`attempt_number` (unique per job), `engine_id`, `started_at`, `finished_at`,
`outcome` (`SENT|RETRY|FAILED|UNKNOWN|ABANDONED`), `provider_message_id`,
`error_code`, `error_detail` (<=500, tersanitasi). Append-only (trigger).

Rollback: forward-fix; dev `DROP TABLE message_attempts, message_queue`.

## Fase F

### outbox_events (tenant_id) --- S
`id uuid PK`, `tenant_id` (FK tenants cascade), `aggregate_type` (`session|message`),
`aggregate_id`, `event_type` (<=48), `payload jsonb` (object), `status`
(`PENDING|DISPATCHED`), `created_at`, `dispatched_at` (CHECK: terisi iff DISPATCHED).
Ditulis trigger; relay (platform) membaca/menandai/menghapus.

### webhook_endpoints (tenant_id) --- S
`id`, `tenant_id`, `url` (<=2048, `^https?://`), `description`, `events text[]` (1-32),
`secret_ciphertext bytea` (AES-256-GCM), `secret_key_version`, `secret_hint` (4 karakter
terakhir), `active`, timestamps. `UNIQUE(tenant_id,id)`.

### webhook_deliveries (tenant_id) --- S
`id`, `tenant_id`, `endpoint_id` (FK komposit cascade), `event_id`, `event_type`,
`payload jsonb` (envelope), `status` (`PENDING|DELIVERED|DEAD`), `attempts`,
`max_attempts`, `next_attempt_at`, `locked_until`, `last_status_code`,
`last_error_code`, `last_duration_ms`, `delivered_at`, timestamps.
`UNIQUE(endpoint_id,event_id)`.

### webhook_delivery_attempts (tenant_id) --- S
`id bigint identity`, `tenant_id`, `delivery_id` (FK komposit cascade),
`attempt_number`, `started_at`, `duration_ms`, `status_code`, `error_code`,
`outcome` (`DELIVERED|RETRY|DEAD`). Tenant SELECT; platform INSERT.

### wa_chats (tenant_id) --- S
`id`, `tenant_id`, `session_id` (FK komposit), `remote_jid` (<=96), `contact_phone`
(5-20 digit, nullable untuk `@lid` tanpa pasangan nomor), `lid_jid` (<=96, nullable; JID `@lid` kontak, 0018), `display_name`, `last_message_at`, timestamps.
`UNIQUE(session_id,remote_jid)`, `UNIQUE(session_id,lid_jid) WHERE lid_jid IS NOT NULL`, `UNIQUE(tenant_id,id)`. Satu kontak = satu chat per sesi: `remote_jid` kanonik
adalah JID nomor (`<nomor>@s.whatsapp.net`) bila nomor diketahui; semua penulis memakai fungsi `resolve_chat` (ADR-041).

### wa_messages (tenant_id) --- S
`id`, `tenant_id`, `session_id`, `chat_id` (FK komposit cascade), `direction`
(`IN|OUT`), `provider_message_id`, `message_type` (text/image/video/audio/document/
sticker/location/contact/other), `body` (teks/caption; null setelah retensi),
`status` (`RECEIVED|SENT|DELIVERED|READ`; CHECK terhadap arah), `queue_id` (cermin
keluar), `occurred_at`, `created_at`, `body_purged_at`.

### message_queue (perubahan Fase F)
`message_type` + `image|video|audio|document`; CHECK bentuk payload; `content_purged_at`;
`recipient` boleh termasker `^\*{4,11}[0-9]{4}$` setelah retensi.

Rollback: forward-fix; dev DROP tabel Fase F.

## Fase H

### tenant_invitations (tenant_id) --- S
`id`, `tenant_id` (FK tenants cascade), `email` (huruf kecil), `role` (OWNER/MEMBER/VIEWER), `token_hash char(64)` UNIQUE (SHA-256; token mentah tidak disimpan),
`status` (`PENDING|ACCEPTED|REVOKED`), `invited_by`, `expires_at`, `created_at`, `accepted_at`, `accepted_by`. Unik parsial `(tenant_id, email) WHERE status='PENDING'`.
RLS: tenant mengelola miliknya; penerima menemukan undangan HANYA lewat `app.invite_hash`; penerima hanya dapat mengubah PENDING (belum kedaluwarsa) menjadi ACCEPTED atas namanya.
Platform TIDAK punya akses (disengaja).

### tenant_memberships (perubahan)
`+ member_email varchar(254)` (salinan email agar daftar tim tidak membaca `users`; nullable untuk baris lama/uji). Kebijakan INSERT tambahan `memberships_insert_invited`:
penerima hanya boleh menyisipkan keanggotaan dirinya bila token undangan valid, email akunnya = email undangan, dan peran = peran undangan.

### tenant_settings (perubahan)
`+ max_members integer NOT NULL DEFAULT 10` (anggota + undangan tertunda).

### audit_logs (tenant_id) --- S (Fase H2)
`id bigint identity PK`, `tenant_id` (FK tenants cascade), `actor_user_id` (tanpa FK: jejak bertahan walau akun dihapus), `actor_email`, `actor_role` (salinan saat kejadian),
`action` (`^[a-z_]+\.[a-z_]+$`), `target_type` (`member|invitation|settings`), `target_id`, `target_email`, `details jsonb` (objek; tanpa rahasia), `ip varchar(45)`,
`request_id`, `created_at`. Append-only. RLS: tenant SELECT/INSERT; penerima undangan hanya boleh mencatat `invitation.accepted` miliknya (token + email cocok);
DELETE hanya platform (retensi).
