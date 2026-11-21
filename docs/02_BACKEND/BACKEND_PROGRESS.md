# Backend Progress

  ----------------------------------------------------------------------------
  Work item        Status         Owner          Evidence / PR  Notes
                                                 / commit       
  ---------------- -------------- -------------- -------------- --------------
  Backend scaffold REVIEW         Backend Agent Fase A, lihat    
                                                 Latest update  

  PostgreSQL       REVIEW          Backend Agent                 
  connection and                                                
  migrations                                                    

  Identity and     REVIEW          Backend Agent                 
  tenant isolation                                              

  API key and      REVIEW          Backend Agent                 
  scopes                                                        

  Session registry REVIEW         Backend Agent                 

  Engine registry  REVIEW         Backend Agent                 
  and lease                                                     

  Baileys adapter  REVIEW         Backend Agent                 

  Message queue    REVIEW         Backend Agent                 

  Messaging API    REVIEW         Backend Agent                 

  Webhook/outbox   REVIEW         Backend Agent                 

  Socket.IO events REVIEW         Backend Agent                 

  Security tests   REVIEW         QA/Backend                    
  ----------------------------------------------------------------------------

## Fase A (2026-11-19)

-   Date: 2026-11-19
-   Status: Fase A (scaffold + config + health) = REVIEW
-   Completed:
    -   Config tervalidasi Zod (`loadConfig`), fail-fast tanpa
        membocorkan nilai secret.
    -   `/health/live`, `/health/ready` (503 saat DB down atau
        shutdown), `/health` alias.
    -   Graceful shutdown (`src/runtime/shutdown.ts`): hook LIFO,
        idempoten, timeout, SIGINT/SIGTERM.
    -   Redaksi header authorization/x-api-key/cookie di log.
    -   Dependency di-pin (tanpa `^`), `engines.node >=22`.
    -   `backend/data/` masuk `.gitignore`.
    -   Script `typecheck` dan `test` (node:test + tsx).
-   Files created/changed: `backend/src/config/env.ts`,
    `backend/src/app.ts`, `backend/src/server.ts`,
    `backend/src/modules/health/health.routes.ts`,
    `backend/src/runtime/shutdown.ts`, `backend/test/health.test.ts`,
    `backend/package.json`, `.gitignore`.
-   Tests: `npm run typecheck` OK; `npm test` 8/8 pass. Smoke manual:
    server berjalan, `/health/live` 200, `/health/ready` 200 dengan
    PostgreSQL dev.
-   In progress: -
-   Blocked: -
-   Known limitations:
    -   Prototipe masih aktif: `runMigrations()` mengeksekusi semua
        `.sql` setiap start (diganti runner berversi pada Fase B),
        `session.manager.ts` menyimpan auth state plaintext di
        `backend/data/sessions` dan menyambungkan ulang sesi saat
        start (diganti engine/lease/encrypted store pada Fase C-D),
        auth login admin + `DEFAULT_TENANT_ID` (diganti Fase B).
    -   Graceful shutdown baru terverifikasi lewat unit test; SIGTERM
        live belum terverifikasi.
    -   Pemisahan proses `api`/`engine`/`worker` belum dibuat; baru
        entrypoint API.
    -   Socket.IO belum ditambahkan (Fase F).
-   Decisions required: runner migrasi (rencana: runner SQL sendiri
    berversi + tabel `schema_migrations`, tanpa ORM). Mohon konfirmasi
    sebelum Fase B.
-   Documents updated: BACKEND_PROGRESS.md, CHANGELOG.md.
-   Next recommended task: Fase B (migrasi 0001 identity/tenant, RLS,
    composite FK, API key ter-hash).


## Fase B --- migrations + identity/tenant (2026-11-19)

-   Status: **REVIEW** (implementasi + tes lolos; belum ada review/QA).
-   Completed: runner migrasi berversi; migrasi 0001 (tenants, users,
    tenant_memberships, tenant_settings, api_keys, refresh_tokens, RLS
    FORCE, composite FK); register/login/refresh(rotasi + deteksi
    reuse)/logout/me; API key (hash SHA-256, scopes, expiry, revoke,
    kuota); rate limit login/register; error envelope + `X-Request-Id`;
    password Argon2id (`@node-rs/argon2`).
-   Files: `backend/src/database/{migrator,gateway}.ts`,
    `database/migrations/0001_identity_tenant.sql`,
    `database/legacy/001_initial_schema.sql` (dipindah),
    `backend/src/http/errors.ts`, `backend/src/modules/identity/*`,
    `backend/src/app.ts`, `server.ts`, `config/env.ts`,
    `modules/auth/{login.routes,auth.guard}.ts` (legacy),
    `backend/test/{helpers,migrator,rls,identity}.test.ts`.
-   Dependency baru (pinned): `@node-rs/argon2@2.2.2`,
    `@fastify/cookie@11.1.5`.
-   Tests: `cd backend && npm run typecheck && npm test` => typecheck OK,
    **40/40 pass** (8 Fase A + 32 baru: migrator 3, RLS 8, identity 21).
    Tes DB memakai schema sementara `gw_test_*` yang di-drop otomatis.
    Migrasi 0001 diterapkan ke `gateway` di `wazap_db`; dijalankan dua
    kali (kedua idempoten).
-   Known limitations:
    -   Rate limiter in-memory (per proses); perlu store bersama saat
        multi-instance.
    -   Refresh paralel dari dua tab dengan token yang sama dianggap
        reuse dan mencabut sesi (trade-off keamanan).
    -   Pembersihan refresh token kedaluwarsa belum ada.
    -   Belum ada audit_logs (migrasi 0004), invite anggota, reset
        password, verifikasi email, dan bootstrap platform-admin.
    -   Dev memakai satu role DB untuk migrasi dan runtime.
    -   Prototipe legacy (login admin env, public.*, penyimpanan auth state
        plaintext) masih aktif; route-nya mengembalikan 501 untuk
        principal baru. Dihapus Fase C.
    -   Tes belum menjalankan server HTTP sungguhan (memakai
        `fastify.inject`).
-   Decisions required: (1) default kuota `tenant_settings` (3 session,
    20 API key, 60 pesan/menit) perlu dikonfirmasi; (2) token
    refresh via cookie HttpOnly dipilih sesuai opsi API_CONTRACT dan
    mengubah cara frontend menyimpan sesi; (3) kapan login legacy
    dimatikan (usul: akhir Fase C).
-   Documents updated: DATABASE_DESIGN, TABLE_SPECIFICATION, ERD,
    MIGRATION_LOG, API_CONTRACT, INTEGRATION_CONTRACT, TENANT_ISOLATION,
    BACKEND_PROGRESS, CHANGELOG.
-   Next recommended task: Fase C (migrasi 0002 session registry +
    engine_nodes + session_leases + session_credentials, lease/fencing).


## Fase C --- session registry + engine registry/lease/fencing (2026-11-19)

-   Status: **REVIEW** (implementasi + tes lolos; belum ada engine nyata).
-   Completed: migrasi 0002; lifecycle terpusat dengan event; API sessions
    (create/list/get/status/events/connect/disconnect/reconnect/delete);
    engine registry (register/heartbeat/sweep/drain); penempatan weighted
    least-loaded dengan kapasitas dan guard memori; lease + fencing (CAS,
    token monoton, `withFence` FOR SHARE); control-plane (pemulihan lease
    kedaluwarsa, finalisasi, penempatan adil antar tenant, leader election);
    ADR-010/011/012; legacy dinonaktifkan secara default.
-   Files: `backend/src/database/migrations/0002_sessions_engines.sql`,
    `backend/src/modules/sessions/{lifecycle,sessions.service,sessions.routes}.ts`,
    `backend/src/modules/engine/{engine.service,lease.service,control-plane}.ts`,
    `backend/src/modules/identity/guard.ts` (`requireAccess`),
    `backend/src/database/gateway.ts` (konteks platform), `app.ts`, `server.ts`,
    `config/env.ts`, `modules/sessions/legacy-session.routes.ts` (rename),
    `backend/test/{lifecycle,engine,sessions}.test.ts`.
-   Tests: `cd backend && npm run typecheck && npm test` => typecheck OK,
    **70/70 pass** (40 sebelumnya + 30: lifecycle 5, engine 15, sessions 11 --
    termasuk konkurensi lease 8 engine, takeover menunggu penulisan berfencing,
    tanpa overcommit di bawah konkurensi, fairness antar tenant, isolasi tenant).
    Migrasi 0002 diterapkan ke `gateway` di `wazap_db` (dua kali, idempoten).
-   Known limitations:
    -   Belum ada engine/adapter nyata: sesi hanya mencapai INITIALIZING;
        konfirmasi terminasi proses lama tidak mungkin sebelum Fase D.
    -   Control-plane embedded di proses API; proses terpisah belum ada.
    -   Placement belum memakai CPU; hanya memori opsional.
    -   Event `wa_session_events` belum punya retensi/partisi.
    -   Tes konkurensi memakai satu proses Node (banyak koneksi), bukan
        banyak proses/host.
    -   Frontend lama tidak berfungsi sampai dimigrasikan (lihat
        INTEGRATION_CONTRACT).
    -   Auth state prototipe (plaintext) di `backend/data/sessions` belum
        dimigrasikan/dienkripsi (Fase D); kode legacy dihapus di Fase D.
-   Decisions required: (1) kapan kode legacy dihapus (usul: awal Fase D,
    setelah adapter baru); (2) strategi migrasi 2 sesi WhatsApp prototipe
    yang ada (re-pair via QR vs impor auth state terenkripsi).
-   Documents updated: DECISION_LOG, DATABASE_DESIGN, TABLE_SPECIFICATION,
    ERD, MIGRATION_LOG, SESSION_LIFECYCLE, ENGINE_ORCHESTRATION,
    API_CONTRACT, INTEGRATION_CONTRACT, TENANT_ISOLATION, BACKEND_PROGRESS,
    CHANGELOG.
-   Next recommended task: Fase D (interface adapter, implementasi Baileys,
    penyimpanan auth state terenkripsi + fencing, lifecycle driver engine,
    heartbeat/renew loop, reconnect backoff, recovery).

## Fase D --- adapter + engine lifecycle + auth state terenkripsi + recovery (2026-11-19)

-   Status: **REVIEW** (implementasi + tes + dokumen; pairing nyata dengan
    ponsel BELUM diuji, lihat limitations).
-   Completed: penghapusan kode legacy (ADR-013); enkripsi kredensial
    AES-256-GCM berkeyring bervensi (ADR-014); migrasi 0003
    (`session_auth_state`, `session_qr`); auth store Baileys terenkripsi
    berfencing; QR store; antarmuka `SessionAdapter` + `BaileysAdapter`
    (ADR-015); `SessionRunner` (QR, connect, restart-after-pairing, reconnect
    backoff+jitter, batas percobaan, logout, replaced, nomor duplikat,
    disconnect, delete, reconnect, kehilangan lease); `EngineRuntime`
    (register, heartbeat+snapshot, renew, pemulihan lease yatim saat start,
    shutdown rapi); `GET /sessions/:id/qr`; wiring server (engine embedded,
    fail fast tanpa kunci enkripsi).
-   Files: baru `backend/src/security/credential-crypto.ts`,
    `modules/engine/{auth-store,qr-store,session-runner,engine-runtime}.ts`,
    `modules/whatsapp/{adapter,baileys-adapter}.ts`,
    `database/migrations/0003_session_auth_state.sql`,
    `test/{crypto,auth-store,engine-runtime}.test.ts`, `test/fake-adapter.ts`.
    Diubah: `app.ts`, `server.ts`, `config/env.ts`, `identity/{guard,identity.routes,principal,tokens}.ts`,
    `engine/{lease.service,control-plane}.ts`, `sessions/{lifecycle,sessions.service,sessions.routes}.ts`,
    `.env.example`, tes helpers/health/identity/lifecycle. Dihapus: `modules/{whatsapp/session.manager,
    messaging,webhook,auth}`, `sessions/legacy-session.routes.ts`, `database/{index.ts,legacy}`.
-   Contracts changed: API_CONTRACT (QR + penghapusan kompatibilitas legacy),
    SESSION_LIFECYCLE (tabel kejadian; 2 transisi baru), ENGINE_ORCHESTRATION,
    INTEGRATION_CONTRACT, env baru/dihapus (CHANGELOG).
-   Tests: `cd backend && npm run typecheck && npm test` => typecheck OK,
    **92/92 pass** (70 sebelumnya, 1 dihapus [legacy], +23 baru: crypto 4,
    auth-store 4, engine-runtime 14, +1 identity). Konsisten di 3 kali ulang
    `engine-runtime`. Bukti nyata: migrasi 0003 diterapkan ke `gateway` (dua
    kali, idempoten); `BaileysAdapter` terhubung ke server WhatsApp dan
    menghasilkan QR (auth state memori); smoke server nyata (embedded engine +
    control-plane): register -> create -> PENDING_ASSIGNMENT -> INITIALIZING ->
    QR_REQUIRED -> `GET /qr` 200 `no-store` -> delete 202 -> 404 -> SIGTERM:
    engine berhenti lebih dulu lalu proses keluar bersih; log tidak memuat QR.
-   Known limitations:
    -   **Pairing nyata belum diuji**: alur scan QR -> `restart_required` ->
        `CONNECTED` -> penyimpanan creds/keys Baileys sungguhan ke DB belum
        dijalankan (butuh ponsel). Auth store diuji dengan data sintetis
        (Buffer, app-state-sync-key). Mohon uji manual dengan satu ponsel.
    -   Kegagalan `keys.set` karena fencing terjadi di dalam internal Baileys;
        perilaku Baileys terhadap rejection tidak diuji dengan socket nyata
        (mitigasi: `onFenced` menghentikan runner dan menutup socket).
    -   Socket zombie dapat tetap terhubung hingga <= sync interval + heartbeat
        setelah kehilangan lease (penulisan persisten tetap ditolak).
    -   Dua proses dengan `ENGINE_NODE_NAME` sama akan saling mengambil
        alih lease (konfigurasi salah; tidak dideteksi).
    -   Rotasi kunci: versi baru dapat ditambah, tetapi re-enkripsi massal
        blob lama belum ada. Kehilangan master key = semua sesi pair ulang.
    -   Renew lease per sesi (N query per heartbeat); belum di-batch.
    -   Engine embedded di proses API; entrypoint proses engine terpisah belum ada.
    -   `ENGINE_MAX_SESSIONS=10` hanya pengaman; kapasitas riil belum diukur.
    -   Pesan masuk/keluar, webhook, Socket.IO belum ada (Fase E/F).
    -   Sisa prototipe TIDAK dihapus otomatis: tabel `public.*` (termasuk 2 baris
        `public.wa_sessions`), folder plaintext `backend/data/sessions`
        (auth state 2 akun WhatsApp; masih sah sampai di-unlink dari ponsel), dan
        variabel `ADMIN_*` di `backend/.env`. Tenant uji "Smoke D"
        (`smoke-d@example.test`) tertinggal di schema `gateway` dari smoke test.
-   Decisions required: (1) hapus `backend/data/sessions` dan tabel
    `public.*` prototipe? (usul: hapus folder setelah kedua ponsel di-unlink dan
    di-pair ulang; tabel `public.*` boleh di-drop manual); (2) lanjut Fase E
    (queue + messaging) atau uji pairing nyata dulu.
-   Documents updated: DECISION_LOG (ADR-013..015), DATABASE_DESIGN, TABLE_SPECIFICATION,
    ERD, MIGRATION_LOG, SESSION_LIFECYCLE, ENGINE_ORCHESTRATION, API_CONTRACT,
    INTEGRATION_CONTRACT, TENANT_ISOLATION, SECURITY_POLICY, BACKEND_PROGRESS, CHANGELOG.
-   Next recommended task: Fase E (queue PostgreSQL `message_queue` dengan
    `FOR UPDATE SKIP LOCKED`, idempotency key, retry/backoff, rate limit per
    tenant/session, `POST /messages`, `SessionAdapter.sendText`, status pesan).

## Fase E --- queue + messaging (2026-11-19)

-   Status: **REVIEW** (implementasi + tes + dokumen; pengiriman ke WhatsApp
    nyata BELUM diuji karena belum ada sesi yang dipairing).
-   Completed: migrasi 0004; `/messages/*` (send, list, detail, status, cancel,
    retry); idempotensi; validasi nomor; batas antrean per tenant; klaim
    `SKIP LOCKED` berfencing; lane serial per sesi dengan prioritas/jadwal/jeda;
    rate limit pesan/menit tenant; retry berbackoff+jitter; klasifikasi hasil
    (sent/retry/failed/unknown); rekonsiliasi PROCESSING terbengkalai; TTL
    pesan; pembatalan saat sesi dihapus; drain saat disconnect/shutdown;
    `sendText` Baileys (cek nomor terdaftar + timeout); perbaikan penempatan
    control-plane (ADR-016).
-   Files: baru `modules/messaging/{messages.service,messages.routes}.ts`,
    `modules/engine/message-queue.ts`, `database/migrations/0004_message_queue.sql`,
    `test/messages.test.ts`. Diubah: `whatsapp/{adapter,baileys-adapter}.ts`,
    `engine/{session-runner,engine-runtime,control-plane}.ts`, `app.ts`,
    `server.ts`, `config/env.ts`, `.env.example`, `test/{engine-runtime,fake-adapter}`.
-   Contracts changed: API_CONTRACT (Fase E), QUEUE_DESIGN, INTEGRATION_CONTRACT.
-   Tests: `cd backend && npm run typecheck && npm test` => typecheck OK,
    **112/112 pass** (92 + 20 baru: validasi, otorisasi scope, idempotensi
    termasuk 10 paralel, batas antrean, isolasi tenant, append-only attempts,
    kirim sukses, urutan prioritas+serial+jeda, retry/backoff/max attempts,
    nomor tidak valid, hasil ambigu + retry manual, engine mati saat kirim,
    rate limit tenant, klaim konkuren + fencing, fairness, cancel vs
    processing + drain, TTL/sesi dihapus, jadwal, regresi control-plane,
    log bersih). Stabil 3 kali. Smoke server nyata: migrasi 0004 terapan, send
    202, replay 202, payload beda 422, job PENDING tanpa sesi tersambung,
    CANCELLED `SESSION_DELETED` setelah sesi dihapus, shutdown bersih.
-   Known limitations:
    -   **Pengiriman nyata belum diuji** (butuh sesi dipairing). `sendText`
        Baileys (onWhatsApp, sendMessage, klasifikasi error) hanya diuji lewat
        adapter palsu; asumsi "error saat kirim = ambigu" konservatif.
    -   `SENT` = diterima socket; DELIVERED/READ belum (butuh event receipt).
    -   Belum: send-media, bulk, kontak/chat, pesan masuk (`wa_messages`).
    -   Isi pesan plaintext di DB tanpa retensi (lihat SECURITY_POLICY).
    -   Pompa polling per sesi (1 query/`QUEUE_POLL_MS` per sesi CONNECTED);
        belum LISTEN/NOTIFY. Belum ada batas konkurensi kirim global per engine.
    -   Rate limit pesan/menit menghitung percobaan (termasuk retry), bukan
        pesan unik; throughput tidak dibenchmark; index belum divalidasi
        EXPLAIN ANALYZE.
    -   Tenant uji `smoke-d@example.test` masih ada di `gateway`.
    -   Event/outbox untuk status pesan belum ada (Fase F).
-   Decisions required: (1) kebijakan retensi isi pesan (usul: hapus
    `payload.text` setelah N hari pada status akhir); (2) apakah `send-media`
    dan `bulk` masuk Fase E tambahan atau digabung setelah Fase F; (3) uji
    pairing + kirim nyata sebelum Fase F (usul tetap).
-   Documents updated: DECISION_LOG (ADR-016), QUEUE_DESIGN, API_CONTRACT,
    DATABASE_DESIGN, TABLE_SPECIFICATION, ERD, MIGRATION_LOG,
    ENGINE_ORCHESTRATION, INTEGRATION_CONTRACT, TENANT_ISOLATION,
    SECURITY_POLICY, BACKEND_PROGRESS, CHANGELOG.
-   Next recommended task: Fase F (outbox_events transaksional pada
    transisi sesi/pesan, webhook endpoints + delivery bertanda-tangan HMAC dengan
    retry, Socket.IO dengan otorisasi room per tenant, tanda terima
    DELIVERED/READ dan pesan masuk).

## Fase F --- webhook/outbox, realtime, pesan masuk & receipt, media, bulk, retensi (2026-11-19)

-   Status: **REVIEW** (implementasi + tes + dokumen). Perilaku terhadap WhatsApp NYATA untuk
    pesan masuk, receipt, media, dan bulk BELUM diuji manual (hanya adapter palsu + ekstraksi dari
    objek pesan sintetis). Dua uji manual dari Fase E juga belum dikonfirmasi: kirim pasca-restart dan
    unlink dari HP.
-   Completed (sub-tahap, masing-masing diuji sebelum lanjut):
    -   **F1** outbox transaksional (trigger) + relay; webhook (endpoint CRUD, secret terenkripsi tampil
        sekali, HMAC + timestamp, SSRF 3 lapis, retry/jitter, dead-letter, replay, test ping, rotasi).
    -   **F2** Socket.IO (auth handshake, room dari principal, fan-out LISTEN/NOTIFY lintas instans,
        validasi ulang kredensial, batas koneksi, `session.qr` sebagai sinyal tanpa QR).
    -   **F3** pesan masuk 1:1 (idempoten, berfencing), receipt DELIVERED/READ (hanya maju), cermin pesan
        keluar, `/chats`, `/chats/:id/messages`, `/contacts`.
    -   **F4** `send-media` (unduh server anti-SSRF, batas ukuran/tipe) dan `bulk` (atomik, idempoten per
        batch, urutan terjaga).
    -   **F5** retensi sesuai angka yang disetujui (30/180/7/30 hari, via env) + penyapu berbatch.
-   Files baru: `database/migrations/000{5,6,7,8}_*.sql`; `security/{ssrf,webhook-signature}.ts`;
    `runtime/poller.ts`; `modules/engine/{outbox-relay,webhook-delivery,inbox,retention}.ts`;
    `modules/webhooks/*`; `modules/realtime/{event-channel,realtime}.ts`; `modules/chats/*`;
    `modules/media/fetch.ts`; tes `test/{webhooks,realtime,inbox,media,retention}.test.ts`.
    Diubah: `whatsapp/{adapter,baileys-adapter}.ts`, `engine/{session-runner,engine-runtime,
    message-queue,qr-store}.ts`, `messaging/messages.{service,routes}.ts`, `app.ts`, `server.ts`,
    `config/env.ts`, `.env.example`, `test/fake-adapter.ts`. Dependensi baru: `socket.io@4.8.4`,
    dev `socket.io-client@4.8.4`.
-   Contracts changed: API_CONTRACT (webhooks, send-media, bulk, chats, contacts; status DELIVERED/READ;
    `media`, `content_purged`), WEBHOOK_SPECIFICATION, SOCKET_EVENTS (penyimpangan: `session.qr` sinyal,
    `queue.updated` ditunda), ADR-017..022.
-   Tests: `npm run typecheck` OK; `npm test` **172/172** lulus (112 -> 172: webhooks 20, realtime 11,
    inbox 9, media 13, retention 7), stabil 2 kali berturut-turut. Migrasi 0005-0008 terpasang di dev
    `wazap_db`/`gateway` (server `/health/ready` READY).
-   Bug nyata yang ditemukan tes dan diperbaiki: release ganda klien LISTEN (bisa menjatuhkan proses saat
    shutdown) dan ambiguitas tipe parameter SQL pada relay/pengirim webhook (hasil kirim tidak tercatat;
    galatnya sempat tertelan karena tes tanpa logger). Dicegah sejak rancangan, lalu dibuktikan tes: urutan
    bulk (`now()` sama dalam satu transaksi => `scheduled_at` dinaikkan per item).
-   Known limitations / risks:
    -   Belum diuji dengan WhatsApp nyata: pesan masuk, receipt (`messages.update` status 3/4/5), media,
        bulk. Asumsi pemetaan status Baileys dari tipe proto, bukan dari pengamatan.
    -   Webhook: tanpa circuit breaker/auto-disable dan tanpa rate limit per endpoint; endpoint yang
        selalu gagal tetap menerima delivery baru (tiap delivery maks 8 percobaan lalu DEAD).
    -   Realtime: event terlewat saat koneksi putus (tanpa replay by id; ada `realtime.resync`);
        NOTIFY dibatasi 8 KB (payload besar dipangkas `data`); dedup klien per `(event_id,event)`.
    -   Pesan masuk: hanya 1:1; `@lid` tanpa pasangan nomor => `phone=null` dan chat balasan
        (`@s.whatsapp.net`) bisa terpisah dari chat masuk (`@lid`); media masuk tidak diunduh.
    -   Media: tipe konten dipercaya dari header; dibuffer di memori (<= `MEDIA_MAX_BYTES`); stiker keluar
        belum ada.
    -   Retensi: isi plaintext selama masa retensi; teks pesan masuk juga ada di outbox (<=7 hari) dan
        delivery webhook (<=30 hari); backup/`wa_session_events` tidak tercakup; penyapu per instans
        (idempoten, tanpa leader).
    -   Batas antrean pada `send` tunggal tidak memakai advisory lock (bulk memakainya): di bawah
        konkurensi tinggi batas `MAX_PENDING_PER_TENANT` dapat terlampaui sedikit.
    -   Pompa kirim masih polling; index belum divalidasi EXPLAIN ANALYZE; tidak ada benchmark.
-   Decisions required: (1) go-ahead Fase G (security hardening + tes) --- usul: setelah uji manual
    WhatsApp nyata (lihat di bawah); (2) kebijakan webhook yang terus gagal (auto-disable setelah N
    DEAD berturut-turut?); (3) apakah teks pesan masuk boleh ikut event webhook/realtime (saat ini ya);
    (4) housekeeping yang masih menunggu persetujuan: hapus `backend/data/sessions` (auth state
    plaintext prototipe), tabel legacy `public.*`, tenant uji `smoke-d@example.test`, variabel
    `ADMIN_*` di `.env`; (5) cadangkan `CREDENTIAL_ENCRYPTION_KEYS` di luar repo.
-   Uji manual yang disarankan (WhatsApp nyata): terima pesan teks dari HP (cek `/chats`, event webhook
    `message.incoming`); DELIVERED/READ pada pesan keluar; kirim gambar dan dokumen via `send-media`;
    `bulk` 3 pesan ke nomor sendiri; webhook ke endpoint uji publik (https) + verifikasi tanda tangan;
    koneksi Socket.IO dari klien; plus dua uji Fase E yang tersisa.
-   Documents updated: DECISION_LOG (ADR-017..022), DATABASE_DESIGN, ERD, TABLE_SPECIFICATION,
    MIGRATION_LOG, API_CONTRACT, SESSION_LIFECYCLE, ENGINE_ORCHESTRATION, QUEUE_DESIGN,
    INTEGRATION_CONTRACT, WEBHOOK_SPECIFICATION, SOCKET_EVENTS, INTEGRATION_PROGRESS,
    SECURITY_POLICY, TENANT_ISOLATION, BACKEND_PROGRESS, CHANGELOG, `.env.example`.
-   Next recommended task: Fase G (security hardening + tes): review RLS menyeluruh dengan role DB
    non-superuser untuk runtime, pemisahan role migrate/runtime, uji beban/EXPLAIN, rotasi kunci
    enkripsi, circuit breaker webhook, dan uji integrasi end-to-end.

### Verifikasi manual Fase F dengan WhatsApp nyata (2026-11-19)

Diuji pemilik proyek terhadap sesi nyata (server dev, nomor gateway + satu HP lain):

-   **Lolos:** pesan masuk 1:1 tersimpan (`/chats`, `/chats/:id/messages`, `/contacts`, nama pengirim
    terisi); receipt `DELIVERED` dan `READ` (API + webhook `message.delivered`/`message.read`);
    `send-media` gambar dan dokumen (status akhir `DELIVERED`); `bulk` 3 pesan (urut, `DELIVERED`);
    webhook end-to-end: `message.sent|delivered|read|incoming`, `session.status`, `webhook.test`,
    tanda tangan HMAC `VALID` dan secret salah ditolak (`INVALID`), retry/dedup `event_id`.
-   **Temuan:** `READ` baru datang setelah chat dibuka di HP penerima, lalu WhatsApp mengirim receipt
    untuk semua pesan yang belum terbaca sekaligus. Itu perilaku WhatsApp, bukan bug (pemetaan
    `messages.update` status 4/5 terbukti benar). Pencatatan diagnostik sementara sudah dihapus.
-   **Lolos (lanjutan):** kirim pesan setelah restart server (sesi pulih tanpa QR, pesan `DELIVERED` lalu
    `READ`); unlink dari HP => `LOGGED_OUT` (`status_reason=logged_out`), auth state dan QR terhapus dari DB.
    Dengan ini dua uji manual Fase E yang tertunda juga terverifikasi.
-   Pembersihan: webhook uji dan `WEBHOOK_ALLOW_HTTP`/`WEBHOOK_ALLOW_PRIVATE_TARGETS` di `.env` dev harus
    dihapus/diset `false` (dikerjakan pemilik proyek).

## Fase G --- security hardening + tes (2026-11-19)

-   Status: **REVIEW**. Semua yang dapat diuji tanpa akses admin database telah diuji. **Satu butir TIDAK dapat dibuktikan:**
    pemisahan role migrator/app (skrip SQL di `docs/07_DEPLOYMENT/DB_ROLES.md` belum dijalankan; saya tidak punya akses admin
    PostgreSQL dan percobaan memakai akun superuser ditolak oleh kebijakan izin --- tidak dilanjutkan).
-   Completed:
    -   **G1** pemeriksaan role DB saat start (tolak start bila superuser/BYPASSRLS di produksi), kredensial migrasi terpisah
        (`DB_MIGRATE_*`), `AUTO_MIGRATE`, CLI `npm run migrate[:prod]`.
    -   **G2** circuit breaker webhook (auto-disable setelah N DEAD berturut-turut) --- migrasi 0009.
    -   **G3** pembatasan laju API (IP + tenant), header keamanan, `requestTimeout`, `TRUST_PROXY`.
    -   **G4** alat rotasi kunci enkripsi `npm run keys:rotate` (compare-and-swap, idempoten, `--dry-run`, `retireReady`).
    -   **G5** tes cakupan RLS otomatis seluruh schema (tabel baru wajib RLS+FORCE+kebijakan).
    -   **G6** validasi indeks pada ~1,3 juta baris (`npm run test:perf`) --- migrasi 0010 + hitungan daftar berbatas.
    -   **G7** tes end-to-end jalur emas dua tenant (`test/e2e.test.ts`).
-   Temuan nyata dan tindakannya:
    -   Penyapu outbox memakai Seq Scan + Sort (~100 ms) pada 200k baris: indeks komposit `(status, dispatched_at)` => ~0,6 ms (0010).
    -   `count(*)` eksak pada daftar pesan tenant ~50k baris = 84 ms (O(n)): `meta.total` dibatasi `LIST_COUNT_CAP` + `total_capped` (ADR-027).
    -   Role runtime dev (`wazap_user`) bukan superuser/BYPASSRLS (RLS efektif) tetapi PEMILIK schema: peringatan saat start; pemisahan role di produksi wajib.
    -   `npm audit --omit=dev`: 0 kerentanan. Galat internal tidak bocor (500 generik). `.env` ter-ignore git.
-   Files baru: `database/{role-check,migrate-cli}.ts`, migrasi `0009`, `0010`; `runtime/{rotate-keys,rotate-keys-cli}.ts`; tes
    `test/{security,webhook-breaker,rotate-keys,e2e}.test.ts`, `test/perf/explain.perf.ts`; `docs/07_DEPLOYMENT/DB_ROLES.md`.
    Diubah: `app.ts`, `server.ts`, `config/env.ts`, `database/gateway.ts`, `identity/guard.ts`, `engine/webhook-delivery.ts`,
    `engine/auth-store.ts` (ekspor `aadOf`), `webhooks/webhooks.service.ts`, `messaging/messages.{service,routes}.ts`,
    `chats/chats.{service,routes}.ts`, `package.json` (script `migrate`, `migrate:prod`, `keys:rotate`, `test:perf`), `.env.example`.
-   Contracts changed: 429 `RATE_LIMITED` + `Retry-After`; header keamanan; `meta.total_capped`; objek webhook (+`consecutive_failures`,
    `disabled_at`, `disabled_reason`); ADR-023..028.
-   Tests: typecheck OK; `npm test` **193/193** (172 -> 193), stabil 2 kali berturut-turut; `npm run test:perf` 6/6.
-   Known limitations / risks (jujur):
    -   Skrip pemisahan role belum diuji; migrasi berisi backfill data akan terhalang RLS bagi pemilik (lihat DB_ROLES.md).
    -   Batas laju in-memory per proses (N instans = N kali batas); belum ada penyimpan bersama.
    -   Kunci master hanya di environment; belum ada integrasi KMS/secret manager; kehilangan kunci = semua sesi pair ulang.
    -   Validasi performa hanya satu koneksi pada mesin dev dengan PostgreSQL default: BUKAN uji beban. Belum ada uji beban
        multi-sesi/multi-koneksi, chaos nyata, SAST/DAST, atau uji penetrasi. Pompa kirim masih polling per sesi.
    -   `total_capped` hanya untuk pesan dan chat; kontak (13 ms pada 5k chat/tenant) dan daftar lain tumbuh linear.
    -   `CREATE INDEX` migrasi 0010 mengunci tulis `outbox_events` selama pembuatan (gunakan CONCURRENTLY di produksi besar).
    -   Pemisahan role mengubah cara deploy (langkah migrasi terpisah); belum ada pipeline CI/CD.
-   Decisions required: (1) siapa/kapan DBA menjalankan dan memverifikasi skrip `DB_ROLES.md` di staging (daftar verifikasi ada di dokumen);
    (2) penyimpan batas laju bersama (Redis) atau cukup 1 instans untuk saat ini; (3) kunci master: pakai secret manager apa;
    (4) housekeeping lama masih menunggu persetujuan (jangan dihapus tanpa izin): `backend/data/sessions` (auth state prototipe
    plaintext), tabel legacy `public.*`, tenant uji `smoke-d@example.test`, variabel `ADMIN_*` di `.env`; (5) cadangkan
    `CREDENTIAL_ENCRYPTION_KEYS` di luar repo; (6) apakah lanjut ke integrasi frontend (kontrak sudah berubah banyak sejak Fase B)
    atau uji beban dulu.
-   Documents updated: DECISION_LOG (ADR-023..028), DB_ROLES (baru), DEPLOYMENT_GUIDE, SECURITY_POLICY, TENANT_ISOLATION,
    DATABASE_DESIGN (§13), MIGRATION_LOG (0009, 0010), API_CONTRACT, WEBHOOK_SPECIFICATION, INTEGRATION_CONTRACT, TEST_PLAN,
    LOAD_TEST_PLAN, BACKEND_PROGRESS, CHANGELOG, `.env.example`.
-   Next recommended task: integrasi frontend terhadap kontrak baru, lalu uji beban/ketahanan di infrastruktur target dan
    verifikasi pemisahan role di staging.

### Keputusan pemilik proyek pasca-Fase G dan tindak lanjut (2026-11-19)

-   Keputusan: lihat DECISION_LOG ADR-029 (satu instans API tanpa Redis; berkas rahasia tanpa Vault/KMS; verifikasi role di staging;
    housekeeping disetujui; urutan berikutnya staging -> integrasi frontend -> uji beban).
-   Dilaksanakan: `ADMIN_*` dihapus dari `.env` dev; `backend/data/sessions` dihapus; schema `public` prototipe dicadangkan
    (`~/wazap-backups/`, izin 0600, di luar repo; baru di-DROP setelah ~30 hari); sidik jari kunci master dicatat pemilik proyek;
    `backend/scripts/verify-db-roles.sh` dibuat dan DIUJI terhadap role dev (mendeteksi pelanggaran, semua uji berisiko ter-rollback,
    RLS dan data dev tidak berubah). Dua bug skrip ditemukan saat diuji dan diperbaiki (search_path koneksi untuk fungsi RLS;
    probe TRUNCATE yang lulus karena alasan salah).
-   **Masih terbuka (tindakan manusia):** unlink perangkat tertaut lama pada 2 akun WhatsApp prototipe; salin kunci master ke password
    manager + offline; jalankan skrip role di staging terhadap role `wazap_app` sungguhan; frontend dibangun ulang oleh agent frontend.

## Fase H --- Team API, Usage API, filter tanggal pesan, switch-tenant (2026-11-19)

-   Status: **REVIEW** (implementasi + tes + dokumen; diminta dan disetujui pemilik proyek setelah serah-terima frontend menemukan gap `team` dan `usage`).
-   Completed: Team (`GET|PATCH|DELETE /team/members`, undangan `GET|POST|DELETE /team/invitations`, `POST /team/invitations/accept`), `POST /auth/switch-tenant`,
    Usage (`GET /usage/summary|messages|sessions`), filter `from`/`to` pada `GET /messages`; migrasi 0011; ADR-030 dan ADR-031.
-   Files baru: `database/migrations/0011_team_usage.sql`; `modules/team/{team.service,team.routes}.ts`; `modules/usage/{usage.service,usage.routes}.ts`;
    tes `test/{team,usage}.test.ts`. Diubah: `identity/{identity.service,identity.routes}.ts` (`switchTenant`, `member_email` saat register), `database/gateway.ts` (konteks `inviteHash`),
    `messaging/{messages.service,messages.routes}.ts` (filter tanggal), `app.ts`, `config/env.ts`, `test/perf/explain.perf.ts`, `.env.example`.
-   Tests: typecheck OK; `npm test` **212/212** (193 -> 212), stabil 2 kali; `npm run test:perf` 8/8 (kueri baru memakai indeks; layanan usage 6--40 ms pada jendela ~3,7 ribu pesan).
-   Temuan tes yang memperbaiki rancangan: kebijakan RLS tabel tim sengaja tidak memberi akses platform (tes membaca lewat konteks tenant); peran aktor dibaca ulang di dalam lock
    (balapan dua OWNER saling menurunkan menghasilkan tepat satu sukses dan selalu tersisa satu OWNER).
-   Known limitations / risks:
    -   Undangan tanpa email otomatis (token disampaikan manual oleh pengundang); belum ada audit log perubahan tim; belum ada ganti email/kata sandi/lupa kata sandi.
    -   `member_email` adalah salinan email; baris keanggotaan lama diisi lewat backfill (nullable bila pengguna uji dibuat langsung lewat SQL).
    -   Usage dihitung langsung dari tabel transaksi: biaya linear terhadap jumlah pesan dalam rentang (maks 92 hari); belum diuji pada tenant berjuta pesan per jendela; tidak ada agregat/cache.
    -   Data usage hanya sedalam masa retensi (180 hari); pesan keluar dihitung menurut status SAAT INI, bukan riwayat transisi.
    -   Migrasi 0011 melakukan backfill dengan `NO FORCE ROW LEVEL SECURITY` sementara: membutuhkan pemilik tabel (role migrator) dan mengunci tabel sebentar.
    -   Tidak ada UI/uji end-to-end terhadap frontend sungguhan (frontend sedang dibangun ulang agent lain).
-   Decisions required: (1) apakah email undangan otomatis diperlukan (butuh layanan SMTP/penyedia email dan keputusan keamanan sendiri); (2) apakah audit log tim diperlukan; (3) kebutuhan
    agregat/ekspor usage jangka panjang di atas 180 hari; (4) API ubah kuota tenant (saat ini hanya baca lewat `usage/summary`).
-   Documents updated: API_CONTRACT, DATABASE_DESIGN (§14), TABLE_SPECIFICATION, ERD, MIGRATION_LOG (0011), DECISION_LOG (ADR-030/031), SECURITY_POLICY, TENANT_ISOLATION,
    INTEGRATION_CONTRACT, FRONTEND_HANDOFF, FRONTEND_AGENT_PROMPT, TEST_PLAN, BACKEND_PROGRESS, CHANGELOG, `.env.example`.
-   Next recommended task: verifikasi integrasi frontend terhadap kontrak (login, tim, usage), lalu uji beban/ketahanan di staging dan verifikasi role database.

## Fase H2 --- audit log, API kuota tenant, undangan tanpa email (2026-11-19)

-   Status: **REVIEW**. Menindaklanjuti keputusan pemilik proyek: tidak ada email undangan (pakai metode lain), audit log perubahan tim, dan API ubah kuota.
-   Completed: `audit_logs` (+ `GET /audit-logs`) dengan pencatatan atomik untuk 8 aksi tim dan `settings.updated`; `POST /team/invitations/:id/reissue`; `invite_url`
    (`DASHBOARD_BASE_URL`); `GET|PATCH /tenant/settings` (OWNER, dalam batas atas global `LIMIT_CEIL_*`); retensi audit (`RETENTION_AUDIT_DAYS`); migrasi 0012 dan 0013; ADR-032..034.
-   Files baru: `migrations/0012_audit_logs.sql`, `0013_audit_accept_policy.sql`; `modules/audit/{audit,audit.service,audit.routes}.ts`; `modules/tenant/{settings.service,settings.routes}.ts`;
    tes `test/{audit,settings}.test.ts`. Diubah: `team/{team.service,team.routes}.ts`, `engine/retention.ts`, `app.ts`, `config/env.ts`, `test/perf/explain.perf.ts`, `test/retention.test.ts`, `.env.example`.
-   Tests: typecheck OK; `npm test` **227/227** (212 -> 227), stabil 2 kali; `npm run test:perf` 9/9 (audit: 0,05--0,21 ms pada 100 ribu baris).
-   Temuan tes yang memperbaiki kode: (1) penyapu retensi audit tidak menghapus apa pun karena `SELECT ... FOR UPDATE` mensyaratkan kebijakan UPDATE yang sengaja tidak ada --- penguncian dihapus;
    (2) kebijakan pencatatan "undangan diterima" terlalu longgar (pemegang token dapat memalsukan) --- diperketat di migrasi 0013 (0012 sudah diterapkan sehingga tidak diedit).
-   Known limitations / risks:
    -   Model otorisasi kuota (OWNER dalam ceiling env) adalah **interpretasi saya** atas "API ubah kuota"; bila yang dimaksud adalah operator/platform-admin, API itu belum ada (butuh peran platform-admin dan kredensial terpisah).
    -   Audit hanya mencakup tim dan pengaturan; tidak mencakup login, sesi, pesan, webhook, API key; operator DB dapat mengubah jejak (tanpa rantai hash/penyimpanan eksternal).
    -   Ceiling bawaan (10/50/50/120) belum didasarkan pengukuran risiko ban/kapasitas.
    -   Pengiriman undangan lewat WhatsApp dilakukan frontend memakai API pesan yang ada (belum ada endpoint khusus); token ikut di payload antrean sampai retensi (30 hari) menghapusnya.
-   Decisions required: (1) konfirmasi model kuota (OWNER dalam ceiling vs. operator-only); (2) nilai ceiling produksi; (3) perluasan audit ke aksi lain; (4) nilai `DASHBOARD_BASE_URL` produksi.
-   Documents updated: API_CONTRACT, DATABASE_DESIGN (§15), TABLE_SPECIFICATION, ERD, MIGRATION_LOG (0012/0013), DECISION_LOG (ADR-032..034), SECURITY_POLICY, TENANT_ISOLATION, INTEGRATION_CONTRACT,
    FRONTEND_HANDOFF, FRONTEND_AGENT_PROMPT, TEST_PLAN, BACKEND_PROGRESS, CHANGELOG, `.env.example`.

### Keputusan terkonfirmasi pasca-Fase H2 (2026-11-19)

-   Model kuota (OWNER dalam ceiling env, bukan API operator) **disetujui** pemilik proyek; ceiling bawaan 10/50/50/120 dipertahankan sampai ditinjau sebelum produksi
    (tinjau terhadap kapasitas server dan risiko ban WhatsApp). API platform-admin tetap tidak ada.
-   Validasi `DASHBOARD_BASE_URL` diperketat: wajib http(s) tanpa kredensial/query/fragment, dan **https di production** (gagal start dengan pesan yang menyebut variabelnya).
    Cacat ditemukan tes: `new URL()` di dalam `refine` melempar `TypeError` mentah untuk nilai tanpa skema; kini ditangkap. Tes: `test/config.test.ts` (3). Total `npm test`: 230.
-   Masih terbuka: nilai `DASHBOARD_BASE_URL` produksi (alamat dashboard sebenarnya) dan peninjauan ceiling produksi.

-   **Tindak lanjut (2026-11-19):** `invite_url` kini memakai fragmen (`#token=`) sesuai saran yang disetujui pemilik proyek, sehingga token tidak dikirim ke server dashboard dan tidak
    masuk access log Nginx/Referer. Kontrak untuk frontend berubah (halaman `/invite` membaca `location.hash` lalu menghapusnya dari address bar); `FRONTEND_HANDOFF.md` dan
    `FRONTEND_AGENT_PROMPT.md` diperbarui. Tes `audit.test.ts` kini memastikan tautan tanpa query string.

## Code review (tingkat high) dan perbaikannya (2026-11-20)

-   Status: **REVIEW** (review kode otomatis selesai dan temuan ditindaklanjuti; `/security-review` belum dijalankan).
-   Temuan (8) dan tindakan: #5 zona waktu offset salah 14 jam (terbukti: 12:00 UTC -> 05:00; diperbaiki: hanya nama IANA yang dikenal PostgreSQL), #2 reissue melewati kuota (terbukti; kuota diperiksa saat
    menghidupkan undangan kedaluwarsa), #3 undangan melampaui wewenang pembuat (dicabut otomatis), #4 API key anggota yang dihapus (dicabut saat dihapus/keluar; sebagian valid: skenario scope `*` tidak mungkin tetapi
    masalah intinya benar), #1 audit membuang `max_api_keys` (terbukti; filter memakai batas kata), #8 PATCH kuota menolak nilai lama setelah ceiling turun (nilai yang sama = no-op), #7 helper terduplikasi
    (`team/team-lock.ts` + tes pemindai sumber), #6 dokumentasikan saja (diterima).
-   Keputusan pemilik proyek: perbaiki yang jelas; API key dicabut saat DIHAPUS (bukan saat ditangguhkan); undangan dicabut otomatis (ADR-035).
-   **Bug ditemukan saat memperbaiki:** pencabutan key awalnya tidak bekerja karena FK `api_keys(tenant_id, created_by_user_id) -> tenant_memberships ... ON DELETE SET NULL` mengosongkan pembuat saat keanggotaan
    dihapus, dan pencabutan saya berjalan sesudahnya. Diperbaiki dengan mencabut SEBELUM menghapus; konsekuensi: `created_by` bernilai `null` untuk key anggota yang sudah dihapus (jejak id ada di audit).
-   Tests: typecheck OK; `npm test` **238/238** (230 -> 238: `test/review-fixes.test.ts`), stabil 2 kali.
-   Masih terbuka: `/security-review`; keputusan apakah kuota efektif harus dipotong ke ceiling yang diturunkan; perubahan belum di-commit ke cabang bersih.
-   Documents updated: API_CONTRACT, DECISION_LOG (ADR-035), SECURITY_POLICY, FRONTEND_HANDOFF, TEST_PLAN, BACKEND_PROGRESS, CHANGELOG.

## Fase H3 --- permintaan bergabung dengan kode workspace (2026-11-20)

Status: **DONE** (implementasi + tes + dokumen). Migrasi 0014; `team/join.service.ts`, `team/join.routes.ts`; login memberi `JOIN_PENDING/JOIN_REJECTED`; ADR-036.
Bukti: `npm test` 248 lulus (10 baru: `test/join.test.ts` mencakup alur penuh, kode salah/diputar/dinonaktifkan, email terdaftar, wewenang penyetuju, tolak/kedaluwarsa, kuota, validasi, dan serangan RLS langsung oleh pemohon).
Belum: batas jumlah permintaan tertunda per tenant dan audit pembuatan permintaan (lihat risiko di ADR-036); UI frontend; verifikasi manual terhadap server nyata.
Temuan dari verifikasi role DB staging (2026-11-20): skrip `build` menyalin folder `legacy` yang tidak ada (diperbaiki); migrator butuh hak CREATE pada database karena `CREATE SCHEMA IF NOT EXISTS` (diperbaiki: cek `pg_namespace` dahulu);
`ALTER DEFAULT PRIVILEGES` memberi hak DML app pada `schema_migrations` (dokumen DB_ROLES.md memuat langkah REVOKE).

### Verifikasi role DB di staging lokal (2026-11-20) --- DONE
Database `wazap_staging` dengan role `wazap_migrator` (pemilik schema) dan `wazap_app` (DML saja), `NODE_ENV=production`, `DB_ROLE_CHECK=enforce`, `AUTO_MIGRATE=false`.
Bukti: `npm run migrate:prod` menerapkan 0001-0014 (`as: "migrator"`); `verify-db-roles.sh` 15/15 lulus (bukan superuser/BYPASSRLS, bukan pemilik schema, DDL/DISABLE RLS/DROP POLICY/TRUNCATE ditolak, `schema_migrations` tertutup, RLS menyembunyikan baris tanpa konteks, DML platform berfungsi);
server start bersih; `/health/ready` READY; smoke test register, undangan, permintaan bergabung (setujui, login), audit, usage lulus di role terbatas.
Temuan: lihat `docs/07_DEPLOYMENT/DB_ROLES.md`. Sisa: staging nyata (server terpisah, Nginx/TLS), pemantauan, entrypoint engine terpisah.

### H3 lanjutan --- batas antrean dan retensi permintaan bergabung (2026-11-20) --- DONE
Migrasi 0015; `JOIN_MAX_PENDING` (50), `409 JOIN_QUEUE_FULL`, pengajuan diserialkan dengan lock tim; retensi `RETENTION_JOIN_REQUEST_DAYS` (90) dengan laporan `joinRequestsDeleted`. Bukti: `npm test` 252 lulus (4 baru).
Sisa risiko: akun pemohon yang tidak pernah disetujui tetap di `users` (tanpa akses platform); pembuatan permintaan tidak diaudit.

## Fase H4 --- manajemen akun dan workspace (2026-11-20) --- DONE (belum diuji di staging)
Migrasi 0016; `identity.service` (ganti kata sandi/email, kode pemulihan, reset, logout-all, edit API key), `tenant/tenant.service` (ganti nama, hapus), `PATCH /sessions/:id`, retensi workspace terhapus, CLI `admin:recovery-code`; ADR-037.
Bukti: `npm test` 267 lulus (15 baru). Keputusan: reset lewat kode pemulihan (bukan tautan admin: risiko ambil alih lintas tenant). Hapus akun sendiri tidak disediakan sesuai arahan.
Belum: uji manual di staging (migrasi 0016 dengan role terbatas); UI frontend; audit reset kata sandi; pemulihan workspace terhapus.

### H4 lanjutan --- kode cadangan, audit reset, pemulihan workspace (2026-11-20) --- DONE (teruji di staging, role wazap_app)
Migrasi 0017; 8 kode pemulihan + `me.recovery` + konfirmasi; audit `account.password_reset` (semua workspace anggota) dan `join_request.created`; `POST /auth/deleted-workspaces` dan `/auth/restore-workspace`; `tenants.deleted_at`.
Bukti: `npm test` 270 lulus; staging: migrasi 0017 dari data 0016, `verify-db-roles.sh` lulus, alur register, reset, audit, hapus, pulihkan, login berhasil, log bersih. Sisa risiko: semua kode hilang bergantung operator; email tidak terverifikasi.

## Uji ketahanan (2026-11-20) --- DONE
`test/resilience.test.ts` (12 tes). Menemukan dan memperbaiki 3 celah nyata (ADR-038): (1) pool tanpa listener `error` membuat proses
crash saat koneksi DB diputus; (2) leader control-plane tidak menyadari koneksinya mati (potensi dua leader); (3) tanpa batas waktu
koneksi permintaan menggantung saat DB hang, dan galat DB menjadi 500 (kini 503 + Retry-After). Konfigurasi baru `DB_CONNECT_TIMEOUT_MS`.
Bukti: `npm test` 282 lulus; uji mutasi membuktikan tiap tes menangkap regresinya. Belum: WhatsApp sungguhan, disk penuh, uji beban.

## Entrypoint proses pekerja terpisah (2026-11-20) --- DONE
`src/worker.ts`, `runtime/workers.ts` (komposisi bersama dengan server.ts), `engine-singleton.ts`, `health-server.ts`, `db-guard.ts`; env `WORKER_ROLES`,
`WORKER_HEALTH_PORT/HOST`; skrip `worker`, `dev:worker`, `start:worker`; contoh PM2. ADR-039. Menutup celah dua proses engine bernama sama (berbagi engine_id dan token).
Bukti: `npm test` lulus, termasuk proses nyata (start, duplikat ditolak, SIGTERM rapi); `npm run build` menghasilkan `dist/worker.js`.
Belum: uji dengan WhatsApp sungguhan di staging (API dan pekerja terpisah), multi-host, pemantauan/alarm atas keluar kode 1.

## Staging TLS (Nginx) dengan API dan worker terpisah (2026-11-20) --- DONE (lokal)
`deploy/staging/` (ADR-040). `verify.sh` lulus semua (TLS, cookie, WebSocket, XFF palsu, loopback). Menemukan dua kekeliruan di dokumen sendiri
(XFF ditambah, bukan ditimpa; `env_file` PM2 tidak ada) dan membuktikan perbaikannya dengan uji mutasi. Kunci master dan JWT staging baru (acak, 0600, di luar repo).
Terpasang di Nginx sistem dan `verify.sh` lulus. **Belum:** Let's Encrypt/domain publik, cadangan kunci master staging, CSP dashboard, uji WhatsApp sungguhan, pemantauan.

## Uji WhatsApp sungguhan (staging, API + worker terpisah) (2026-11-20) --- DONE
Nomor nyata, topologi produksi (API dan worker proses terpisah, Nginx TLS, `NODE_ENV=production`, role DB terpisah). Terbukti:
-   **Sesi:** QR (~6 dtk) -> CONNECTED; auth state terenkripsi (kunci v1); restart API tidak menyentuh sesi; restart engine memulihkan sesi dari auth state dalam 11 dtk tanpa QR (fencing token naik).
-   **Putus perangkat dari ponsel:** `LOGGED_OUT`, `desired=DISCONNECTED`, kredensial dan auth state terhapus (0 baris), riwayat utuh, tanpa reconnect berulang, event di outbox; pairing ulang berhasil.
-   **Pesan:** teks keluar/masuk, receipt DELIVERED/READ, gambar dan dokumen keluar (READ), gambar/video/dokumen masuk (tipe benar, tanpa duplikat, event outbox). Tipe media salah => FAILED `MEDIA_TYPE_INVALID` tanpa retry sia-sia.
-   **SSRF media:** http, 127.0.0.1, localhost, [::1], 169.254.169.254, dan DNS yang menunjuk ke loopback (localtest.me) semuanya 422 sebelum masuk antrean.
-   **Webhook (penerima nyata, `deploy/staging/tools/webhook-receiver.mjs`):** HMAC valid + timestamp segar pada semua 18 permintaan; `webhook.test`; sent/delivered/incoming; retry (500, 500, 200) dengan `event_id` dan `delivery_id` tetap, jeda ~9 dan ~16 dtk;
    redirect 302 tidak diikuti (gagal + retry); replay mengirim `event_id` yang sama; pulih sendiri setelah penerima sehat (8/8 DELIVERED).
**Bug nyata yang ditemukan dan diperbaiki:** chat ganda per kontak (ADR-041, 0018); POST tanpa body dari browser 400 (ADR-042); kuota login per-IP dihabiskan skrip uji (ADR-042).
**Temuan untuk frontend:** konfirmasi kode pemulihan menelan galat diam-diam (`catch {}`) sehingga kegagalan tidak terlihat; tidak ada tombol konfirmasi di luar modal penerbitan kode.
**Catatan:** satu sesi menyimpan ~2.844 baris `session_auth_state` (sebagian besar `lid-mapping`/`tctoken`/`pre-key`, 432 KB); DIUKUR dan tidak menjadi masalah skala (ADR-044: `open` konstan, 50 sesi 6.900+ op/dtk). Isi media masuk tidak diunduh (hanya tipe dan caption). Event datang tidak berurutan saat ada retry (`delivered` dapat mendahului `sent`).
**Belum:** uji lama berjam-jam, banyak sesi per engine, media masuk diunduh, circuit breaker webhook dengan penerima nyata (diuji otomatis saja), grup (diabaikan), alarm/pemantauan, Let's Encrypt.

## Runbook produksi, cadangan, dan latihan rotasi kunci (2026-11-20) --- SEBAGIAN
`RUNBOOK.md` (peta sistem, rutinitas, deploy/rollback, indikator, 14 playbook insiden, rotasi kunci), `BACKUP_RESTORE.md`, `deploy/ops/{backup.sh,restore-drill.sh,setup-backup-role.sql}`, ADR-046. Menemukan bahwa `pg_dump` gagal/parsial di bawah FORCE RLS dan menutupnya dengan pagar dan role BYPASSRLS.
Bukti: tes CLI rotasi, tes dokumen, uji pagar skrip. **Latihan pemulihan penuh pada staging nyata LULUS** (27 tabel, 3.213 baris sama persis, RLS utuh, migrasi sampai 0018). **Belum:** role `wazap_backup` di server dan uji hak role pada hasil pemulihan, WAL/PITR, penyalinan cadangan ke luar host, uji di produksi, kontak on-call dan ambang alarm.

## Ekspor data workspace (2026-11-20) --- BACKEND DONE, frontend belum
`DATA_EXPORT_DESIGN.md` (ADR-048): enam jenis ekspor, OWNER/ADMIN + konfirmasi kata sandi, streaming CSV/NDJSON dengan batas dan pra-hitung, RLS tenant, audit `data.exported`, saklar `EXPORT_ENABLED`, migrasi 0019, playbook RUNBOOK P15.
Bukti: 18 tes fungsional + 3 tes perf (30 ribu baris: ~50 ribu baris/dtk, +30 MB, nol idle-in-tx; indeks 0019 dipakai) + kontrak OpenAPI (82 operasi) + uji mutasi pada tiap pengaman. **Belum:** frontend (lihat FRONTEND_HANDOFF), uji 200 ribu baris pada DB berjarak, ekspor asinkron/terjadwal, akses API key.

## Notifikasi alarm per workspace (ADR-049) --- backend selesai (2026-11-20)

Migrasi 0020, API `/alerts/*`, evaluator dan pengirim di worker, rotasi kunci dan retensi diperluas, 24 tes baru. UI selesai (agen frontend). **Uji nyata di staging lulus (2026-11-21):** kanal Telegram dibuat lewat UI, pesan uji tiba, aturan `session.logged_out` aktif, perangkat WhatsApp diputus dan notifikasi tiba dalam ±54 dtk (payload hanya nama sesi). Temuan dari uji nyata: (1) `CONNECTION_FAILED` acak karena batas sambungan 250 ms Node (RTT Telegram 230-320 ms) lalu IPv6 tidak terjangkau; diperbaiki di `postJson` (`autoSelectFamilyAttemptTimeout`), 8/8 berhasil, tes `delivery-connect.test.ts`; (2) kegagalan percobaan tidak terlihat di log; kini dicatat (`pengiriman alarm gagal`), tes baru; (3) event `INITIALIZING -> LOGGED_OUT` saat pairing ulang juga memicu notifikasi bila aturan baru aktif dalam jendela lookback (sesuai rancangan). Belum diuji di staging: aturan selain `session.logged_out`, batas 30/jam, nonaktif otomatis (semuanya ada tes otomatis), Slack, pesan UI untuk `CONNECTION_FAILED` (masih berbunyi "server menolak"; ke agen frontend). Lihat `docs/02_BACKEND/ALERT_NOTIFICATIONS_DESIGN.md` bagian 12.

## Platform admin dan peran workspace (ADR-053, ADR-054) (2026-11-21) --- P0, P1a, dan P1b SELESAI, P1c belum

**P0 selesai:** peran ADMIN dihapus (migrasi 0021), workspace hanya OWNER/MEMBER/VIEWER; tes migrasi khusus. **P1a selesai:** `platform_admins` + MFA TOTP (RFC 6238), login dua langkah, token platform terpisah dari token workspace, CLI `admin:platform-admin`, kebijakan RLS sempit, audit platform append-only, saklar `PLATFORM_ENABLED`, rotasi kunci master mencakup rahasia TOTP. 408 tes: 407 lulus, 0 gagal, 1 sengaja dilewati (uji penerimaan frontend peran). **Belum:** P1b (daftar/detail workspace, kuota per workspace dan OWNER hanya-baca, kuota bawaan registrasi dari `platform_defaults`, tangguhkan/aktifkan, audit platform, status cadangan), P1c (penegakan penangguhan: sesi berjalan, webhook, antrean, alarm, realtime), P2 (gerbang jaringan host API), P3 (frontend: peran dan konsol platform).

**P1b selesai:** daftar/detail workspace, kuota per workspace (TOTP segar, alasan, audit platform dan jejak transparansi di audit workspace), OWNER hanya-baca (`403 QUOTA_MANAGED_BY_PLATFORM`), kuota bawaan registrasi dari `platform_defaults`, daftar audit platform, status cadangan hanya-baca (`backup-run.sh` menulis JSON, alasan kegagalan disamarkan). Tes baru: `platform-workspaces.test.ts` (12), `platform-privacy.test.ts` (3, pemindai sumber). 418 tes: 417 lulus, 0 gagal, 1 sengaja dilewati. **Belum:** P1c (penegakan penangguhan menyeluruh; tangguhkan/aktifkan), P2 (gerbang jaringan host API), P3 (frontend).

**P1c selesai:** `POST /platform/workspaces/:id/suspend|activate` (TOTP segar, alasan, audit platform dan jejak transparansi); penangguhan dapat dipulihkan dan ditegakkan di semua jalur (HTTP/API key/refresh/login/pindah/undangan, realtime, sesi, webhook, alarm); `login` memberi `403 WORKSPACE_SUSPENDED` setelah kata sandi benar. Balapan "diaktifkan saat DISCONNECTING" ditemukan dan ditutup (`resumeWanted` di control-plane). `platform-suspension.test.ts` (7 tes, engine sungguhan, penerima webhook lokal, Socket.IO; 0 gagal dari 4 pengulangan). 425 tes: 424 lulus, 0 gagal, 1 sengaja dilewati. **Belum:** P2 (gerbang jaringan: `/api/v1/platform/` 404 di host API, zona batas laju path platform, panduan Cloudflare Access), P3 (frontend: peran tanpa ADMIN dan konsol platform), P4 (opsional).

**P2 selesai:** gerbang jaringan konsol (404 di host API, zona batas laju `wazap_platform` di host dashboard, panduan Cloudflare Access; `test-tunnel-vhost.sh` dan `verify.sh` memeriksanya). **P3 disiapkan:** prompt agen frontend dan uji penerimaan `frontend-platform-client.test.ts` (aktif dengan `FRONTEND_PLATFORM_CHECK=1`, bersama `FRONTEND_ROLES_CHECK=1`); frontend belum dikerjakan. **Belum:** frontend (peran tanpa ADMIN, kuota hanya-baca, konsol platform), deploy ke staging (migrasi 0021 dan 0022, admin pertama lewat CLI), Cloudflare Access (tindakan pemilik).
