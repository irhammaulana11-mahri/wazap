# Changelog

## Unreleased --- Backend: ekspor data workspace (2026-11-20)

-   Baru (ADR-048): `POST /api/v1/exports/{messages|outbound|chats|contacts|audit-logs|members}` (CSV aman dari injeksi formula atau NDJSON dengan manifest, streaming berbatas) dan `GET /api/v1/exports/policy`. Hanya OWNER/ADMIN pengguna dashboard dengan konfirmasi kata sandi; 422 sebelum data bila melebihi batas; audit `data.exported`; saklar `EXPORT_ENABLED`. Konfigurasi baru `EXPORT_*`.
-   Database: migrasi 0019 (indeks `wa_messages (tenant_id, occurred_at, id)` dan `message_queue (tenant_id, created_at, id)`; `target_type` audit `export`).
-   Kode: `RateLimiter.blocked`, `identity.confirmPassword`; OpenAPI mendukung respons streaming (82 operasi). Tes: `export.test.ts` 18, `perf/export.perf.ts` 3. Runbook: playbook P15.

## Unreleased --- Rancangan ekspor data workspace (2026-11-20)

-   Diusulkan (ADR-048, `docs/02_BACKEND/DATA_EXPORT_DESIGN.md`): ekspor pesan, laporan pengiriman, chat, kontak, audit, dan anggota untuk OWNER/ADMIN dengan konfirmasi kata sandi, CSV/NDJSON streaming berbatas, dalam isolasi RLS tenant. Belum diimplementasikan.

## Unreleased --- Latihan pemulihan cadangan staging lulus (2026-11-20)

-   Bukti operasional: cadangan `wazap_staging` (27 tabel, 3.213 baris) dipulihkan ke database sementara dengan jumlah baris sama persis, RLS ENABLE+FORCE utuh pada semua tabel, 75 kebijakan, dan migrasi berurutan sampai 0018. Tidak ada perubahan kode.

## Unreleased --- Frontend masuk repo bersih, kontrak API, dan CI (2026-11-20)

-   Baru (ADR-047): frontend dibawa ke `clean/backend-v1` (commit tersendiri); `frontend/dist` dan arsip agent kit diabaikan git. CI: job `frontend` (typecheck + build) dan pagar hygiene arsip/`dist`/symlink.
-   Kontrak: `test/frontend-contract.test.ts` memeriksa semua panggilan `/api/v1` frontend terhadap `openapi.json` (66 dari 66 di `services/api.ts` cocok).
-   Dihapus: `frontend/src/api.ts`, klien prototipe lama yang tidak dipakai dan berisi endpoint yang sudah tidak ada.

## Unreleased --- Backend: runbook produksi, cadangan/pemulihan, latihan rotasi kunci (2026-11-20)

-   Baru (ADR-046): `docs/07_DEPLOYMENT/RUNBOOK.md` dan `BACKUP_RESTORE.md`; `deploy/ops/backup.sh`, `restore-drill.sh`, `setup-backup-role.sql`. Tidak ada perubahan kode aplikasi.
-   Temuan keamanan operasional: `pg_dump` oleh role biasa gagal dan meninggalkan berkas parsial di bawah FORCE RLS; cadangan harus lewat superuser atau role `BYPASSRLS` khusus (baca-saja).
-   Tes: `rotate-cli.test.ts` (CLI rotasi kunci sungguhan) dan `runbook-docs.test.ts` (dokumen operasi tidak boleh menyimpang dari kode).

## Unreleased --- Backend: spesifikasi OpenAPI dari kode dan mode kontrak (2026-11-20)

-   Baru (ADR-045): `docs/02_BACKEND/openapi.json` (OpenAPI 3.1, 75 operasi) dihasilkan dari skema Zod yang dipakai route dan metadata guard (`npm run openapi`). Tidak ada perubahan perilaku API.
-   Baru: mode kontrak `WAZAP_CONTRACT_CHECK=1` / `npm run test:contract`: setiap response asli di seluruh suite divalidasi terhadap skema terbit (dipakai CI). Tes: `openapi.test.ts` dan `contract.test.ts`, total 313 lulus.
-   Kode: tiap file route mengekspor `routeContracts`; guard ditempeli metadata (tanpa mengubah perilaku).

## Unreleased --- Backend: analisis dan tes perf auth state (2026-11-20)

-   Analisis (ADR-044): kekhawatiran skala `session_auth_state` (2,8 ribu baris per sesi) dibantah dengan pengukuran; penyimpanan malas, `open` konstan, 50 sesi bersamaan 6.900+ op/dtk tanpa galat. Tidak ada perubahan kode aplikasi.
-   Baru: `test/perf/auth-store.perf.ts` sebagai pagar regresi. Risiko tersisa dicatat (pool bersama lease/heartbeat pada DB berjarak, penyimpanan akun besar).

## Unreleased --- CI (2026-11-20)

-   Baru (ADR-043): `.github/workflows/ci.yml` (backend, deploy-config, hygiene, audit), `dependabot.yml`, `backend/scripts/ci-test.sh` dan `check-migrations.sh`. Action dipin ke SHA; hak `contents: read`.
-   Pagar: tes dilewati dianggap gagal (tanpanya DB mati = 251 tes dilewati tapi hijau), migrasi terapan tidak boleh diubah, XFF Nginx harus ditimpa.
-   Perbaikan: semua skrip shell kini tercatat executable di git (sebelumnya 100644 karena `core.fileMode=false` di partisi NTFS; clone mendapat "Permission denied").

## Unreleased --- Backend: hasil uji WhatsApp sungguhan di staging (2026-11-20)

-   Terbukti dengan nomor nyata dan topologi produksi: pairing, restart API/engine tanpa QR, putus perangkat, teks dan media dua arah, SSRF media (8 variasi), dan webhook (HMAC, retry, redirect, replay). Tidak ada perubahan kode di entri ini.
-   Baru: `deploy/staging/tools/webhook-receiver.mjs` (penerima uji yang memverifikasi tanda tangan, dapat disetel gagal/redirect/lambat). Dokumen: temuan untuk frontend di `FRONTEND_HANDOFF.md`, perilaku urutan webhook di `WEBHOOK_SPECIFICATION.md`.

## Unreleased --- Backend: body JSON kosong diterima (2026-11-20)

-   Perbaikan (ADR-042): POST tanpa body dengan `content-type: application/json` (cara browser/fetch) tidak lagi 400. Memulihkan konfirmasi kode pemulihan, logout, dan `connect`/`disconnect`/`reconnect` sesi dari dashboard. JSON rusak, prototype poisoning, dan batas ukuran tetap ditolak. Tes: `empty-body.test.ts` 4 baru, total 304 lulus.
-   Staging: `verify.sh` memakai sumber 127.0.0.2 agar tidak menghabiskan kuota login per-IP milik browser.

## Unreleased --- Backend: satu chat per kontak, JID nomor vs LID (2026-11-20)

-   Perbaikan (ADR-041, migrasi 0018): balasan WhatsApp datang dengan JID `@lid` sedangkan pesan keluar memakai JID nomor, sehingga satu kontak muncul sebagai dua obrolan. Kini satu fungsi `resolve_chat` menentukan chat untuk semua penulis; chat ganda yang sudah ada digabung otomatis (pesan utuh).
-   Kontrak: `jid` pada `/chats` kini JID nomor bila nomor diketahui; `id` chat yang digabung tidak berlaku lagi. Tes: `chat-identity.test.ts` 8 baru, total 300 lulus.

## Unreleased --- Frontend Perbaikan Tombol Putus Sesi WhatsApp & Penanganan Status Transisi (2026-11-20)

- **Perbaikan Aksi Putuskan Sesi ([SessionsPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/SessionsPage.tsx)):**
  - **Penanganan Status `DISCONNECTING` & State Race:** Memperbaiki bug di mana sesi yang sedang dalam transisi `DISCONNECTING` langsung jatuh ke kondisi *else* sehingga keliru menampilkan tombol hijau *"Hubungkan"*. Kini tombol merender status *"Memutuskan Sesi..."* dengan spinner aktif secara presisi.
  - **Dukungan Pembatalan Koneksi:** Menambahkan tombol putus sesi sekunder pada status `QR_REQUIRED`, `CONNECTING`, `RECONNECTING`, dan `ERROR` sehingga pengguna dapat membatalkan atau mereset handshake koneksi yang macet tanpa harus menunggu timeout.
  - **Konfirmasi & Umpan Balik Toast:** Menambahkan konfirmasi persetujuan pengguna sebelum memutuskan sesi, serta pesan toast notifikasi sukses dan penanganan galat `onError` yang transparan.
  - **Opsi Putus Sesi di Drawer QR:** Menyediakan tombol pemutusan sesi langsung di dalam laci modal QR jika sesi terdeteksi telah `CONNECTED` atau gagal pairing.
  - **Proteksi Akses Peran:** Menonaktifkan aksi pemutusan bagi peran `VIEWER` dengan atribut tooltip keterangan yang jelas.

## Unreleased --- Frontend Redesign Pengaturan Kuota & Workspace: Slider Interaktif & Manajemen Modular (2026-11-20)

- **Redesign Halaman Pengaturan Kuota & Workspace ([SettingsPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/SettingsPage.tsx)):**
  - Mengubah antarmuka pengaturan kuota menjadi lebih profesional dan ramah pengguna dengan sistem **Tab Segmented**:
    - **Tab 1: Alokasi Kuota Gateway (`?tab=quota`):**
      - Input kuota interaktif menggabungkan **Slider Penggeser (*Range Slider*)** dan input angka stepper yang tersinkronisasi mulus secara *real-time*.
      - Bilah progres (*Progress Bar*) pemakaian visual yang dinamis untuk Sesi WhatsApp, Throughput Rate Limit, Kunci REST API, dan Anggota Tim.
      - Deteksi validasi *real-time* sebelum submit: mencegah input di bawah kapasitas yang sedang aktif digunakan (`used`) dengan peringatan visual jelas.
      - Bilah aksi cerdas: tombol *"Terapkan Pengaturan Kuota"* dan *"Kembalikan Nilai"* yang otomatis aktif/nonaktif sesuai perubahan state form.
    - **Tab 2: Identitas & Nama Workspace (`?tab=general`):**
      - Formulir pembaruan nama resmi workspace yang langsung tersinkronisasi ke seluruh antarmuka dan navbar.
    - **Tab 3: Zona Bahaya (`?tab=danger`):**
      - Area terisolasi khusus Owner untuk penghapusan workspace permanen dengan ringkasan kebijakan masa tenggang pemulihan 30 hari (ADR-037), serta konfirmasi verifikasi ketik nama persis dan kata sandi pemilik.

## Unreleased --- Frontend Redesign Halaman Profil: Navigasi Tab Segmented & UX Lebih Profesional (2026-11-20)

- **Redesign Halaman Profil ([ProfilePage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/ProfilePage.tsx)):**
  - Mengganti tata letak vertikal bertumpuk yang panjang menjadi antarmuka **Tab Segmented** modern (*enterprise-grade*) yang bersih dan mudah digunakan:
    - **Tab 1: Profil & Identitas (`?tab=overview`):** Ringkasan kartu identitas akun, avatar inisial berstatus aktif, tombol salin instan *User ID* dan *Tenant ID*, informasi keamanan sesi (*In-Memory Token & HttpOnly Cookie*), daftar keanggotaan workspace, serta tabel matriks hak akses dan kewenangan peran aktif.
    - **Tab 2: Keamanan & Kredensial (`?tab=security`):** Panel indikator status 8 kode pemulihan akun (status konfirmasi dan sisa kode aktif dengan tanda peringatan interaktif jika $\le 2$), formulir pembaruan kata sandi (dengan visibilitas sandi & validasi $\ge 10$ karakter), pembaruan alamat email, penerbitan himpunan 8 kode baru via dialog modal reveal-once, dan tombol keluar dari semua perangkat (*Logout All*).
    - **Tab 3: Kuota Workspace (`?tab=quota`):** Status alokasi sumber daya gateway (Sesi WhatsApp, Throughput Rate Limit, Anggota Tim, Kunci API) dengan indikator progress visual yang proporsional, serta tombol navigasi langsung ke Pengaturan Kuota bagi Owner atau penjelas mode baca-saja bagi non-owner.
  - Integrasi navigasi tautan cerdas berbasis parameter URL `?tab=` pada [Header.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/layout/Header.tsx) dan [SecurityBanners.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/layout/SecurityBanners.tsx) sehingga pengguna langsung diarahkan ke tab yang relevan dalam satu kali klik.

## Unreleased --- Backend: staging TLS dengan Nginx dan API/worker terpisah (2026-11-20)

-   Baru: `deploy/staging/` (vhost Nginx TLS bertemplat, peluncur PM2, pembuat env acak, sertifikat staging, `verify.sh`). Tidak ada perubahan kode aplikasi atau kontrak API.
-   Perbaikan dokumentasi (keamanan, ADR-040): `X-Forwarded-For` di Nginx harus DITIMPA (`$remote_addr`), bukan ditambah; dengan `TRUST_PROXY=true` penambahan memungkinkan pemalsuan IP dan menghindari throttling login (terbukti 0/24 vs 24/24). PM2 tidak mendukung `env_file` (contoh lama dikoreksi).
-   Terbukti di staging lokal: TLS 1.2/1.3, cookie Secure/HttpOnly/SameSite, Socket.IO via WebSocket di balik TLS, restart API tidak menyentuh worker, restart worker rapi.

## Unreleased --- Backend: entrypoint proses pekerja terpisah (2026-11-20)

-   Baru: `npm run worker` / `node dist/worker.js` menjalankan engine WhatsApp, control-plane, webhook, dan retensi tanpa API (ADR-039). Produksi: API `ENABLE_EMBEDDED_*=false`.
-   Keamanan operasional: satu proses per `ENGINE_NODE_NAME` (kunci singleton); proses kedua dengan nama sama ditolak start-nya.
-   Konfigurasi baru: `WORKER_ROLES`, `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`. Tidak ada perubahan kontrak API. Tes: `worker.test.ts` 10 tes.

## Unreleased --- Backend: uji ketahanan dan perbaikan gangguan database (2026-11-20)

-   Perbaikan (ADR-038): koneksi DB yang diputus tidak lagi mematikan proses (listener `error` pada pool); leader control-plane memeriksa koneksinya dan kunci per schema; batas waktu koneksi `DB_CONNECT_TIMEOUT_MS`.
-   Perilaku API: database tidak tersedia kini `503 SERVICE_UNAVAILABLE` + `Retry-After: 2` (sebelumnya 500 `INTERNAL_ERROR`). Frontend: tampilkan "layanan sedang sibuk" dan coba lagi dengan backoff; ulangi kirim pesan dengan `Idempotency-Key` yang sama.
-   Tes: `resilience.test.ts` 12 tes baru; total 282 lulus.

## Unreleased --- Frontend Fase H4 Lanjutan: Pemulihan Workspace, Banner Kode Pemulihan & Banner 2 OWNER (2026-11-20)

- **Pemulihan Workspace Terhapus (`/restore-workspace` & `LoginPage.tsx` - ADR-037):**
  - Implementasi halaman publik [RestoreWorkspacePage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/RestoreWorkspacePage.tsx):
    - Formulir pencarian berbasis kredensial akun Pemilik (`POST /api/v1/auth/deleted-workspaces`).
    - Penampilan daftar workspace dalam masa tenggang pemulihan 30 hari dengan tanggal kadaluwarsa (`restorable_until`) dan slug.
    - Dialog konfirmasi pemulihan dengan peringatan keamanan tegas mengenai entitas yang harus dibuat ulang (`must_recreate`: sesi WhatsApp/scan QR, API key, webhook, undangan).
    - Eksekusi pemulihan via `POST /api/v1/auth/restore-workspace` dengan umpan balik sukses serta arahan login kembali.
  - Penanganan khusus error `403 NO_ACTIVE_TENANT` di [LoginPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/LoginPage.tsx) dengan tombol cepat menuju halaman pemulihan, serta tautan tambahan di footer form login.
- **Banner Peringatan Keamanan & Anjuran 2 OWNER (`SecurityBanners.tsx`):**
  - Implementasi komponen [SecurityBanners.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/layout/SecurityBanners.tsx) yang tersemat pada [MainLayout.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/layout/MainLayout.tsx):
    - **Banner Kode Belum Dikonfirmasi:** Peringatan warna amber saat `recovery.confirmed === false` yang mengarahkan user ke pengaturan akun untuk menyimpan dan mengonfirmasi 8 kode pemulihan.
    - **Banner Sisa Kode Rendah:** Peringatan warna rose saat `recovery.codes_remaining <= 2` untuk segera menerbitkan himpunan kode pemulihan baru.
    - **Banner Anjuran Minimal 2 Owner:** Peringatan warna biru informatif jika workspace aktif hanya memiliki 1 Owner aktif, guna mencegah risiko workspace terkunci tanpa pengelola cadangan, lengkap dengan tombol navigasi instan ke halaman Manajemen Tim.

## Unreleased --- Frontend Fase H3 & H4: Permintaan Bergabung, Kode Workspace, Pemulihan Mandiri & Keamanan Akun (2026-11-20)

- **Permintaan Bergabung & Kode Workspace (`/join` & `TeamPage.tsx` - ADR-036):**
  - Implementasi halaman publik [JoinPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/JoinPage.tsx): mengekstrak kode workspace dari fragment URL `#code=...`, langsung membersihkan fragment dari address bar (`history.replaceState`), dan menyimpannya murni di state memori komponen.
  - Form permohonan mandiri: kode workspace, email, dan kata sandi pilihan pemohon (`POST /api/v1/auth/join-requests`).
  - Penanganan status penolakan/antrean di login: pesan ramah untuk `403 JOIN_PENDING` dan `403 JOIN_REJECTED`.
  - Tab *Kode & Permintaan Bergabung* di [TeamPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/TeamPage.tsx): manajemen kode workspace (`PUT /team/join-code` untuk rotasi reveal-once, `DELETE /team/join-code` untuk nonaktifkan) dan daftar permohonan (`GET /team/join-requests`) dengan dialog persetujuan pemilihan peran (`MEMBER`, `VIEWER`, `ADMIN`, `OWNER`) serta penolakan.
- **Sistem Pemulihan Mandiri Tanpa Email & Reset Kata Sandi (`/forgot-password` - ADR-037):**
  - Implementasi halaman publik [ForgotPasswordPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/ForgotPasswordPage.tsx) untuk reset kata sandi mandiri via kode pemulihan (`POST /api/v1/auth/reset-password`) dengan umpan balik sisa kode pemulihan yang tersisa.
  - Komponen dialog reveal-once [RecoveryCodeModal.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/auth/RecoveryCodeModal.tsx): menampilkan 8 kode pemulihan rahasia dengan tombol salin clipboard, unduh berkas teks `.txt`, dan konfirmasi wajib bertanda centang sebelum melanjutkan.
  - Terintegrasi pada [RegisterPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/RegisterPage.tsx), [JoinPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/JoinPage.tsx), dan penerbitan ulang di profil.
- **Keamanan Akun & Kredensial Pengguna di Profil (`ProfilePage.tsx`):**
  - Pembaruan kata sandi akun (`POST /auth/change-password`): merotasi access token di memori dan mencabut sesi di perangkat lain.
  - Pembaruan alamat email akun (`POST /auth/change-email`) dengan konfirmasi kata sandi dan penanganan `409 EMAIL_TAKEN`.
  - Penerbitan 8 kode pemulihan baru (`POST /auth/recovery-codes`) dengan konfirmasi penerimaan (`POST /auth/recovery-codes/confirm`).
  - Logout dari seluruh perangkat (`POST /auth/logout-all`) yang seketika membersihkan sesi dan token aktif.
- **Siklus Hidup Workspace & Pembaruan Entitas:**
  - Pengubahan nama workspace (`PATCH /tenant`) dan zona bahaya penghapusan permanen (`DELETE /tenant`) dengan konfirmasi pengetikan nama persis dan kata sandi pemilik di [SettingsPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/SettingsPage.tsx).
  - Pengubahan nama sesi WhatsApp (`PATCH /sessions/:id`) via drawer geser di [SessionsPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/SessionsPage.tsx).
  - Pengubahan nama dan hak akses scopes API Key (`PATCH /api-keys/:id`) via drawer geser di [ApiKeysPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/ApiKeysPage.tsx).

## Unreleased --- Backend H4 lanjutan: 8 kode pemulihan, audit reset, pemulihan workspace (2026-11-20)

-   Berubah (kontrak): `recovery_code` menjadi `recovery_codes` (8 kode sekali pakai) pada register/join-request; `POST /auth/recovery-code` menjadi `POST /auth/recovery-codes` (+ `/confirm`); `reset-password` mengembalikan `remaining_recovery_codes`; `GET /auth/me` memuat `recovery`.
-   Baru: audit `account.password_reset` ke semua workspace anggota dan `join_request.created`; `POST /auth/deleted-workspaces` dan `POST /auth/restore-workspace` (OWNER, 30 hari). Migrasi 0017. Tes: 270 lulus.

## Unreleased --- Backend Fase H4: manajemen akun, kode pemulihan, ganti nama, hapus workspace (2026-11-20)

-   Baru: `POST /auth/change-password|change-email|recovery-code|reset-password|logout-all`, `PATCH /api-keys/:id`, `PATCH /sessions/:id`, `PATCH /tenant`, `DELETE /tenant`. Lupa kata sandi tanpa email lewat kode pemulihan (`recovery_code` pada register/join-request; alat operator `npm run admin:recovery-code`).
-   Keamanan: `token_version` mencabut access token seketika; kata sandi salah dijawab 403 (bukan 401); hapus workspace lunak lalu dihapus permanen setelah `RETENTION_TENANT_DAYS`. Hapus akun sendiri sengaja tidak ada. Migrasi 0016, ADR-037.
-   Tes: 267 lulus (15 baru di `test/account.test.ts`).

## Unreleased --- Frontend Logo Resmi Wazap & Redesign Halaman Login dan Register (2026-11-20)

- **Logo Resmi WAZAP (`logo-wazap.jpeg`):**
  - Mengintegrasikan logo resmi aplikasi dari [Logo Wazap.jpeg](file:///media/data/PROJECT/WAZAP/docs/Logo%20Wazap.jpeg) ke dalam aset frontend ([logo-wazap.jpeg](file:///media/data/PROJECT/WAZAP/frontend/public/logo-wazap.jpeg) dan [logo-wazap.jpeg](file:///media/data/PROJECT/WAZAP/frontend/src/assets/logo-wazap.jpeg)).
  - Menerapkan logo resmi pada navigasi utama [Sidebar.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/components/layout/Sidebar.tsx), menggantikan placeholder inisial teks lama.
  - Menerapkan logo pada form autentikasi ([LoginPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/LoginPage.tsx) dan [RegisterPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/RegisterPage.tsx)), serta kartu penerimaan undangan ([InviteAcceptPage.tsx](file:///media/data/PROJECT/WAZAP/frontend/src/pages/InviteAcceptPage.tsx)).
- **Redesign Halaman Login & Register (Split-Screen Enterprise Layout):**
  - Mengadopsi tata letak modern *split-screen* responsive:
    - **Kolom Kiri (Desktop Hero Branding):** Background gelap elegan (`bg-slate-950`) dengan efek ambient glow, tipografi modern, logo resmi beresolusi tajam, serta kartu nilai tambah keamanan (*Keamanan & Isolasi Tenant Ketat* dan *High Throughput & Anti-Ban Rate Limit*).
    - **Kolom Kanan (Form Masuk / Daftar Modern):** Kartu form yang bersih dengan border halus, efek hover/focus interaktif pada input email, kata sandi, dan nama workspace.
  - **Fitur Toggle Password Visibility:** Menambahkan tombol interaktif intip/sembunyikan kata sandi (`Eye` & `EyeOff`) pada kolom password di halaman login maupun registrasi.
  - **Validasi & Penanganan Pesan Error Terstruktur:** Menampilkan banner error utama serta penanda pesan kesalahan per-field jika validasi gagal.

## Unreleased --- Backend H3 lanjutan: batas antrean dan retensi permintaan bergabung (2026-11-20)

-   Baru: batas antrean `JOIN_MAX_PENDING` (default 50 per tenant; `409 JOIN_QUEUE_FULL`, akun tidak dibuat; batas eksak walau pengajuan serentak) dan retensi `RETENTION_JOIN_REQUEST_DAYS` (default 90). Migrasi 0015 (kebijakan RLS khusus hitung antrean, platform SELECT/DELETE, indeks).
-   Tes: 252 lulus (4 baru).

## Unreleased --- Frontend Transformasi Modal Dialog Menjadi Slide-Over Drawer Preview (2026-11-20)

- **Transformasi Modal Menjadi Drawer Preview (`Drawer Slide-Over`):**
  - Menggantikan dialog pop-up di tengah layar menjadi panel **Slide-Over Drawer** dari sisi kanan layar dengan animasi `slide-in-from-right` dan latar belakang transparan gelap (`backdrop-blur-xs`).
  - Seluruh alur kerja dan fungsi CRUD (validasi, mutasi simpan, update realtime, reveal-once secret, pemindaian QR code) dipertahankan 100% konsisten.
  - Modul yang diperbarui:
    - **Sesi WhatsApp (`SessionsPage.tsx`):** Drawer *Tambah Sesi Baru* dan Drawer *Ephemeral QR Code Pairing*.
    - **Pesan & Obrolan (`ChatsPage.tsx`):** Drawer *Mulai Chat Baru / Kirim Pesan* dan Drawer *Detail Teknis Pesan Gateway*.
    - **Kunci Akses REST API (`ApiKeysPage.tsx`):** Drawer *Buat API Key Baru* dan Drawer *Simpan API Key (Reveal-Once)*.
    - **Webhooks Event (`WebhooksPage.tsx`):** Drawer *Tambah Endpoint Webhook* dan Drawer *Simpan Webhook Secret*.
    - **Manajemen Tim (`TeamPage.tsx`):** Drawer *Undang Anggota Tim* dan Drawer *Bagikan Tautan Undangan (Link, QR, WhatsApp)*.
    - **Riwayat Pesan (`MessagesPage.tsx`):** Drawer *Detail Pesan Gateway*.

## Unreleased --- Frontend Filter Jumlah Data per Halaman pada Seluruh Paginasi (2026-11-20)

- **Filter Jumlah Data Dinamis (Page Size Selector):**
  - Menambahkan pemilih jumlah data yang ditampilkan per halaman pada seluruh modul yang menggunakan paginasi:
    - **Log Audit Keamanan (`AuditLogsPage.tsx`):** Opsi 10, 20, 50, dan 100 log per halaman.
    - **Direktori Kontak WhatsApp (`ContactsPage.tsx`):** Opsi 10, 20, 50, dan 100 kontak per halaman.
    - **Pesan & Obrolan WhatsApp Web (`ChatsPage.tsx`):** Opsi 10, 20, dan 50 data per halaman baik pada tab *Daftar Obrolan* maupun tab *Log Antrean Outbox Gateway*.
    - **Riwayat Pesan Gateway (`MessagesPage.tsx`):** Opsi 10, 15, 25, 50, dan 100 pesan per halaman.
    - **Manajemen Anggota Tim (`TeamPage.tsx`):** Opsi 10, 20, 50, dan 100 anggota per halaman.
  - Setiap perubahan jumlah data per halaman secara otomatis me-reset navigasi ke halaman 1 (*page 1*) untuk menjamin konsistensi query dan data.

## Unreleased --- Frontend Penyesuaian Margin Body Page & Responsivitas Mobile Penuh (2026-11-20)

- **Optimasi Margin & Lebar Body Page (`MainLayout.tsx` & `Header.tsx`):**
  - Menghilangkan pembatas `max-w-[1440px] mx-auto` yang menyisakan margin kosong canggung di batas kiri dan kanan layar lebar.
  - Mengadopsi padding adaptif yang lebih mepet dan efisien: `px-3.5 sm:px-5 lg:px-6 py-5 sm:py-6`.
  - Pada monitor desktop & laptop: Konten memanfaatkan lebar viewport secara luas dengan jarak batas tepi ke sidebar dan tepi kanan hanya 24px (`lg:px-6`), membuat workspace terasa lega dan nyaman.
  - Pada layar mobile (< 640px): Margin aman sebesar 14px (`px-3.5`) memastikan konten tidak menempel ke tepi layar ponsel dan nyaman untuk jempol.
- **Dukungan Responsif Mobile Drawer (`Sidebar.tsx`):**
  - Pada layar mobile (< 1024px), sidebar desktop disembunyikan agar body page dapat memanfaatkan 100% lebar layar ponsel.
  - Ditambahkan tombol *Hamburger Menu* di Header untuk membuka drawer navigasi geser (*slide-in drawer*) dengan latar belakang blur dan tombol tutup (*X*), yang otomatis menutup saat rute halaman diklik.

## Unreleased --- Backend Fase H3: permintaan bergabung dengan kode workspace (2026-11-20)

-   Baru: kode workspace (`GET|PUT|DELETE /team/join-code`), `POST /auth/join-requests` (publik; kata sandi dibuat pemohon saat mendaftar), `GET /team/join-requests`, `POST /team/join-requests/:id/approve|reject`.
    Login pemohon sebelum disetujui: `403 JOIN_PENDING` / `JOIN_REJECTED`. Migrasi 0014 (RLS), env `JOIN_REQUEST_TTL_DAYS`, ADR-036. Undangan tetap ada.
-   Tes: 248 lulus (10 baru di `test/join.test.ts`), termasuk serangan RLS langsung oleh pemohon.

## Unreleased --- Backend: perbaikan hasil verifikasi role DB di staging (2026-11-20)

-   Perbaikan: `npm run build` gagal dari checkout bersih (menyalin folder `legacy` yang tidak ada); migrator tidak lagi butuh hak CREATE pada database (cek `pg_namespace` sebelum `CREATE SCHEMA`).
-   Dokumen: `DB_ROLES.md` berstatus TERUJI (migrasi, `verify-db-roles.sh` 15/15, start `DB_ROLE_CHECK=enforce`, smoke test dengan role `wazap_app`); langkah REVOKE `schema_migrations` (default privileges ikut memberi hak app pada tabel itu).

## Unreleased --- Frontend Penyelarasan Lebar Kontainer Halaman Pengaturan Kuota & Profil (2026-11-20)

- **Penyelarasan Lebar Halaman Penuh (`SettingsPage.tsx` & `ProfilePage.tsx`):**
  - Menghilangkan pembatas sempit `max-w-4xl mx-auto` pada halaman *Pengaturan Kuota Workspace* dan *Profil Saya*.
  - Kedua halaman kini menggunakan kontainer standar `<div className="space-y-6">` yang serasi dengan halaman lainnya (Dashboard, Koneksi & API, Obrolan, Penggunaan, Anggota Tim, Log Audit) dan memanfaatkan lebar kontainer responsif `max-w-[1440px]` secara proporsional.
  - Grid identitas profil ditingkatkan menjadi 4 kolom adaptif (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`) agar nyaman dipandang pada layar lebar.

## Unreleased --- Frontend Profil & Peningkatan Tampilan Pengaturan Kuota (2026-11-20)

- **Sidebar Ramping & Menu Profil Baru (`Sidebar.tsx`):**
  - Tombol logout di bagian bawah (footer) sidebar telah dihilangkan secara bersih karena fungsi logout terpusat di dropdown avatar header.
  - Ditambahkan menu **Profil Saya** (`/profile`) di bagian kelompok menu *Konfigurasi & Akun*.
  - Menu *Pengaturan Kuota* ditampilkan secara dinamis hanya untuk pengguna dengan wewenang `OWNER`.
- **Desain Ulang Halaman Pengaturan Kuota Workspace (`SettingsPage.tsx`):**
  - Tampilan form ditingkatkan menjadi kartu interaktif dengan badge indikator batas sistem (`min - maks`) dan status pemakaian saat ini (`used`).
  - Dilengkapi tombol reset nilai (*Kembalikan Nilai*) dan proteksi validasi terhadap error `LIMIT_BELOW_USAGE`.
  - Aksesibilitas visual untuk peran non-owner dengan peringatan wewenang *Read-Only*.
- **Desain Halaman Profil & Status Kuota yang Komprehensif (`ProfilePage.tsx`):**
  - Kartu identitas pengguna dengan avatar besar, email, User ID (copyable 1-klik), Tenant ID, dan status sesi in-memory yang aman.
  - Kartu status kuota workspace yang menampilkan kapasitas pemakaian (Sesi WhatsApp, Rate limit, Anggota Tim, Kunci API) dengan progress bar dinamis.
  - Banner penjelasan wewenang peran yang mendidik dan tabel matriks izin 4 peran (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`).

## Unreleased --- Frontend Header Breadcrumbs & Minimalist 3-Menu Dropdown (2026-11-20)

- **Header Breadcrumb Dinamis (`Header.tsx`):**
  - Menggantikan tombol tenant dengan breadcrumb navigasi halaman yang bersih dan informatif (`Home / [Nama Halaman Aktif]`) menggunakan `useLocation()`.
- **Avatar Inisial Minimalis:**
  - Tombol profil pengguna di header disederhanakan: hanya menampilkan lingkaran inisial huruf pengguna (*user initial avatar*) dengan dot online tanpa teks email panjang.
- **Header Dropdown Minimalis (Hanya 3 Menu):**
  - **Profil (`/profile`):** Mengarahkan ke halaman profil baru yang menampilkan identitas pengguna, status sesi in-memory, serta status kuota & penggunaan alokasi workspace secara transparan.
  - **Pengaturan:** 
    - Untuk peran **`OWNER`**: Diarahkan langsung ke halaman *Pengaturan Kuota Workspace* (`/settings`) untuk mengelola limit alokasi.
    - Untuk peran non-owner (**`ADMIN`**, **`MEMBER`**, **`VIEWER`**): Diarahkan ke `/profile` yang menampilkan status kuota dalam mode *Read-Only* dengan penjelasan wewenang peran.
  - **Logout:** Tombol keluar yang aman membersihkan seluruh sesi dan cookie HttpOnly.
- **Halaman Profil & Status Kuota (`ProfilePage.tsx`):**
  - Menyajikan data identitas user (User ID copyable, Email, Workspace Aktif), ringkasan alokasi kuota pemakaian (Sesi WhatsApp, Rate Limit, Anggota Tim, API Key), dan penjelasan kewenangan peran aktif.

## Unreleased --- Frontend Header Dropdown Profesional & Perbaikan Modal QR (2026-11-20)

- **Perbaikan Ephemeral QR Pairing Modal (`SessionsPage.tsx`):**
  - Mengatasi galat keliru `"QR tidak tersedia pada status CONNECTED"` saat ponsel berhasil memindai QR code atau ketika sesi WhatsApp telah tersambung.
  - Alur status sesi kini diperiksa terlebih dahulu sebelum memanggil endpoint QR. Transisi status `CONNECTED` langsung menampilkan pesan sukses hijau (*"Perangkat WhatsApp Terhubung!"*) dengan animasi checklist, nama sesi, dan auto-close yang mulus.
  - Status `CONNECTING`, `INITIALIZING`, dan `RECONNECTING` kini menampilkan indikator penyambungan ramah (*"Menghubungkan ke WhatsApp..."*) tanpa memunculkan kotak merah galat.
- **Header Profesional & Dropdown Profil Pengguna (`Header.tsx`):**
  - Desain topbar modern elegan dengan sentuhan *glassmorphism* (`backdrop-blur-md`), penataan proporsional, dan penyesuaian visual status diagnostik sistem (Socket.IO, Database PostgreSQL, REST API).
  - Komponen Dropdown Profil Pengguna dengan avatar inisial, email aktif, User ID dengan tombol salin 1-klik, dan ringkasan status keamanan in-memory session.
  - **Status Kewenangan Workspace:** Kartu identitas peran aktif pengguna (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`) lengkap dengan badge warna peran dan deskripsi wewenang operasionalnya di workspace tersebut.
  - **Menu Navigasi Pengaturan Berbasis Role:**
    - Tautan cepat ke *Pengaturan Kuota Workspace* (`/settings`) eksklusif untuk peran `OWNER`.
    - Tautan cepat ke *Manajemen Tim & Anggota* (`/team`) serta *Kunci API & Webhooks* (`/connections?tab=apikeys`) untuk `OWNER` dan `ADMIN`.
    - Tautan cepat ke *Perangkat WhatsApp* (`/connections?tab=sessions`) untuk semua peran operasional.
    - Tautan cepat ke *Log Audit Aktivitas* (`/audit-logs`) untuk `OWNER` dan `ADMIN`.
    - Tombol *Keluar dari Akun (Logout)* yang aman membersihkan sesi memori dan cookie HttpOnly.
  - **Modal "Profil & Matriks Hak Akses" (Role Permissions Matrix):**
    - Modal terfokus yang memvisualisasikan matriks hak akses 4 peran terhadap pengiriman pesan, pemindaian sesi QR, pembuatan API key & webhook, pengaturan kuota, dan audit log.
    - Menjelaskan kebijakan kepatuhan keamanan *zero-leakage* (Access token murni di memori, refresh token di HttpOnly cookie).

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

## Unreleased --- Frontend Dashboard Enterprise (2026-11-19)

- **Scaffold & Layout:** Implementasi dashboard React 19 + Vite + TypeScript + Tailwind CSS v4 sesuai spesifikasi `docs/03_FRONTEND/*`.
- **Navigasi & Routing:** Integrasi React Router v7 untuk 10 halaman workspace:
  - `Overview` (`/`): KPI aktif/terputus, metrik pesan hari ini, antrean, dan aktivitas terbaru.
  - `WhatsApp Sessions` (`/sessions`): Manajemen sesi multi-device, ephemeral QR flow modal (auto-refresh 2.5s, tidak disimpan di localStorage), aksi connect/disconnect/delete.
  - `Messages` (`/messages`): Composer pesan teks dengan validasi penerima, riwayat percakapan dengan filter arah (INBOUND/OUTBOUND), pencarian teks/nomor, dan status badge.
  - `Webhooks` (`/webhooks`): Endpoint CRUD, HMAC secret reveal-once, status filter, tes ping.
  - `API Keys` (`/api-keys`): Generator kredensial API key, reveal-once banner, penanda waktu terakhir digunakan, dan aksi pencabutan (revoke).
  - `Contacts` (`/contacts`), `Chat History` (`/chats`), `Usage & Limits` (`/usage`), `Team Members` (`/team`), `Settings` (`/settings`): Dilengkapi dengan banner `MockNotice` penanda typed mock untuk endpoint yang belum dirilis backend.
- **State & Realtime:**
  - Integrasi TanStack Query v5 untuk server state management, caching, dan automatic refetch.
  - Integrasi Socket.IO Client pada path `/api/v1/realtime` dengan automatic cache invalidation saat event `session.status` dan `message.incoming` diterima.
  - Header global dengan status badge real-time: Database (PostgreSQL), API Gateway, dan Socket.IO connection indicator.
- **Keamanan (Security):**
  - Token login disimpan secara eksklusif di `sessionStorage` (tidak di `localStorage`).
  - Halaman QR hanya tampil saat modal terbuka dan dibersihkan segera setelah sesi terhubung atau modal ditutup.
  - Route guard `ProtectedRoute` mengalihkan pengguna yang belum login ke `/login`.
- **Pengujian:** Kompilasi TypeScript strict dan production bundle Vite berhasil tanpa error (`npm run build`).


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
