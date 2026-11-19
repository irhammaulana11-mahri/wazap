# Migration Log

  --------------------------------------------------------------------------
  Version        Date           Change         Author/Agent   Status
  -------------- -------------- -------------- -------------- --------------
  0001           2026-11-19     Initial        Backend Agent  REVIEW
                                identity and                  
                                tenant schema                 

  0002           2026-11-19     Session and    Backend Agent  REVIEW
                                engine                        
                                registry                      

  0003           TBD            Messaging and  Backend Agent  NOT_STARTED
                                queue                         

  0004           TBD            Webhook,       Backend Agent  NOT_STARTED
                                outbox, audit,                
                                usage                         
  --------------------------------------------------------------------------

Each entry must link to migration filenames, test results, and any
manual deployment action.

## Entri

### 0001 --- `backend/src/database/migrations/0001_identity_tenant.sql`

-   Schema target: `gateway`. Tabel: tenants, users,
    tenant_memberships, tenant_settings, api_keys, refresh_tokens;
    fungsi set_updated_at, ctx_text, ctx_uuid; RLS ENABLE+FORCE.
-   Aksi manual deployment: `GRANT CREATE ON DATABASE <db> TO <app_role>`
    (sekali). Diterapkan ke dev `wazap_db` pada 2026-11-19.
-   Tes: `test/migrator.test.ts`, `test/rls.test.ts` (lihat
    BACKEND_PROGRESS). Rollback: forward-fix; dev `DROP SCHEMA gateway
    CASCADE`.
-   Catatan: migrasi prototipe lama dipindah ke
    `src/database/legacy/001_initial_schema.sql` (schema `public`, tetap
    dijalankan idempoten sampai dihapus di Fase C).

### 0002 --- `backend/src/database/migrations/0002_sessions_engines.sql`

-   Tabel: engine_nodes, wa_sessions, wa_session_events, session_leases,
    session_credentials; fungsi `is_platform()`, `enforce_fencing_monotonic()`;
    RLS ENABLE+FORCE; unique parsial nama/nomor.
-   Tidak ada aksi manual tambahan. Diterapkan ke dev `wazap_db` (schema
    `gateway`) 2026-11-19, dijalankan dua kali (idempoten).
-   Tes: `test/engine.test.ts`, `test/sessions.test.ts`, `test/lifecycle.test.ts`.
-   Rollback: forward-fix; dev saja `DROP SCHEMA gateway CASCADE`.

### 0003 --- `backend/src/database/migrations/0003_session_auth_state.sql`

-   Tabel: session_auth_state, session_qr; RLS ENABLE+FORCE (auth state
    platform-only; QR: SELECT tenant, tulis platform).
-   Aksi manual: set `CREDENTIAL_ENCRYPTION_KEYS` (`openssl rand -base64 32`,
    format `1:<base64>`). **Simpan master key di luar repo; tanpa key auth state
    tidak dapat dibaca.**
-   Diterapkan ke dev `wazap_db` (schema `gateway`) 2026-11-19, dijalankan dua
    kali (idempoten). Migrasi legacy (`public`) tidak lagi dijalankan; tabel
    `public.*` prototipe tetap ada (tidak dihapus otomatis).
-   Tes: `test/auth-store.test.ts`, `test/engine-runtime.test.ts`.
-   Rollback: forward-fix; dev `DROP TABLE session_qr, session_auth_state`.

### 0004 --- `backend/src/database/migrations/0004_message_queue.sql`

-   Tabel: message_queue, message_attempts; fungsi/trigger append-only
    attempts; RLS ENABLE+FORCE; kebijakan SELECT platform pada `tenant_settings`.
-   Tidak ada aksi manual. Diterapkan ke dev `wazap_db` (schema `gateway`)
    2026-11-19 lewat start server (idempoten pada start berikutnya).
-   Tes: `test/messages.test.ts` (20).
-   Rollback: forward-fix; dev `DROP TABLE message_attempts, message_queue;
    DROP POLICY tenant_settings_platform_select ON tenant_settings`.

### 0005 --- `backend/src/database/migrations/0005_outbox_webhooks.sql`

-   Tabel: outbox_events, webhook_endpoints, webhook_deliveries,
    webhook_delivery_attempts; trigger `outbox_from_session_event` (pada
    `wa_session_events`) dan `outbox_from_message_status` (pada
    `message_queue`); RLS ENABLE+FORCE (outbox: tenant hanya INSERT, baca/ubah/hapus
    platform; endpoint/delivery: tenant+platform; attempt: tenant SELECT, platform INSERT).
-   Tidak ada aksi manual (webhook butuh `CREDENTIAL_ENCRYPTION_KEYS`).
    Diterapkan ke dev `wazap_db` (schema `gateway`) 2026-11-19 lewat restart server.
-   Tes: `test/webhooks.test.ts` (20).
-   Rollback: forward-fix; dev `DROP TABLE webhook_delivery_attempts,
    webhook_deliveries, webhook_endpoints, outbox_events` + drop trigger.

### 0006 --- `backend/src/database/migrations/0006_chats_messages.sql`

-   Tabel: wa_chats, wa_messages; trigger `mirror_outbound_message` (cermin
    SENT/DELIVERED/READ) dan `outbox_from_incoming` (event `message.incoming`);
    index provider id pada `message_queue`; RLS (tenant SELECT, tulis platform).
-   Tidak ada aksi manual. Diterapkan ke dev 2026-11-19.
-   Tes: `test/inbox.test.ts` (9).
-   Rollback: forward-fix; dev `DROP TABLE wa_messages, wa_chats`.

### 0007 --- `backend/src/database/migrations/0007_media_messages.sql`

-   `message_queue.message_type` diperluas (image/video/audio/document); CHECK
    bentuk payload; trigger cermin memakai tipe & caption.
-   Tidak ada aksi manual. Diterapkan ke dev 2026-11-19.
-   Tes: `test/media.test.ts` (13).

### 0008 --- `backend/src/database/migrations/0008_retention.sql`

-   Kolom `message_queue.content_purged_at`; CHECK `recipient` mengizinkan bentuk
    termasker (`****1234`); CHECK konsistensi purge; index parsial penyapuan.
-   Tidak ada aksi manual. Diterapkan ke dev 2026-11-19.
-   Tes: `test/retention.test.ts` (7).
-   Catatan: setelah purge, nomor penerima pada baris antrean tidak dapat dipulihkan.

### 0009 --- `backend/src/database/migrations/0009_webhook_breaker.sql`

-   Kolom `webhook_endpoints.consecutive_failures`, `disabled_at`, `disabled_reason`; CHECK `disabled_at` hanya bila `active=false`.
-   Tidak ada aksi manual. Diterapkan ke dev 2026-11-19.
-   Tes: `test/webhook-breaker.test.ts` (4).

### 0010 --- `backend/src/database/migrations/0010_outbox_index.sql`

-   Ganti indeks parsial `idx_outbox_dispatched` dengan komposit `idx_outbox_status_dispatched (status, dispatched_at)`
    (penyapu retensi outbox: ~100 ms Seq Scan+Sort => ~0,6 ms Index Scan pada 200k baris).
-   Tidak ada aksi manual. Diterapkan ke dev 2026-11-19. Tes: `npm run test:perf`.
-   Catatan operasional: pada tabel `outbox_events` sangat besar, `CREATE INDEX` mengunci tulis selama pembuatan; di produksi
    pertimbangkan `CREATE INDEX CONCURRENTLY` di luar transaksi migrasi.
