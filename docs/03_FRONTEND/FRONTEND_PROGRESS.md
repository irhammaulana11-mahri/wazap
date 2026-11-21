# Frontend Progress

| Work item | Status | Owner | Evidence / PR / commit | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Vite/React scaffold & Design system | DONE | Frontend Agent | `frontend/vite.config.ts`, `frontend/package.json` | React 19, Vite, TypeScript, Tailwind CSS, Lucide Icons |
| Strict In-Memory Auth & Refresh Flow | DONE | Frontend Agent | `frontend/src/services/api.ts`, `AuthContext.tsx` | In-memory token store, single-flight 401 refresh via HttpOnly cookie, multi-tenant workspace switch |
| Register, Login, & Invite Accept Page | DONE | Frontend Agent | `LoginPage.tsx`, `RegisterPage.tsx`, `InviteAcceptPage.tsx` | Email + password (>=10) + tenant_name, alur terima undangan `/invite` dengan auto switch workspace |
| Dashboard & Real Usage Overview | DONE | Frontend Agent | `DashboardPage.tsx` | KPI real-time dari `/usage/summary`, status sesi aktif, antrean throughput, ringkasan pesan |
| WhatsApp Sessions & Ephemeral QR | DONE | Frontend Agent | `SessionsPage.tsx` | Mendukung 13 status sesi backend, aksi connect/disconnect/reconnect/delete, penanganan transisi `DISCONNECTING`, opsi batal koneksi, ephemeral QR clean on unmount/connect |
| Messages with Idempotency & History | DONE | Frontend Agent | `MessagesPage.tsx` | Pengiriman ber-Idempotency-Key, normalisasi nomor tujuan, filter sesi/status/tanggal, aksi cancel & retry |
| WhatsApp Chats & Interactive Messaging | DONE | Frontend Agent | `ChatsPage.tsx` | Nyata dari `/api/v1/chats` dan `/api/v1/chats/:id/messages`, balasan pesan langsung dari antarmuka chat |
| WhatsApp Contacts Directory | DONE | Frontend Agent | `ContactsPage.tsx` | Nyata dari `/api/v1/contacts`, pencarian instan, paginasi, aksi cepat kirim pesan |
| Webhooks Integration & Secret Lifecycle | DONE | Frontend Agent | `WebhooksPage.tsx` | Reveal-once signing secret dialog, rotasi secret, toggle active, test per endpoint, warning auto-consecutive failure |
| API Key Management & Scopes Matrix | DONE | Frontend Agent | `ApiKeysPage.tsx` | Scope granular valid tanpa wildcard `*`, reveal-once plain API key, revoke kunci |
| Team Collaboration & Zero-Email Invites | DONE | Frontend Agent | `TeamPage.tsx` | Matriks peran OWNER/ADMIN/MEMBER/VIEWER, dialog undang tanpa email: salin tautan, QR code klien (`qrcode`), kirim pesan WA |
| Usage Analytics & Time-Series Buckets | DONE | Frontend Agent | `UsagePage.tsx` | Visualisasi bar chart deret waktu `/usage/messages` (tz=Asia/Jakarta), kartu progress kuota, performa sesi |
| Tenant Quota Allocation Settings | DONE | Frontend Agent | `SettingsPage.tsx` | Redesign antarmuka kuota dengan slider interaktif, progress bar pemakaian, validasi limit di atas usage secara real-time, tab identitas & tab zona bahaya terisolasi |
| Workspace Audit Logs | DONE | Frontend Agent | `AuditLogsPage.tsx` | Khusus OWNER & ADMIN, pencatatan jejak audit aksi tim dan kuota, filter aksi dan pagination |
| Realtime Reconnection & State Sync | DONE | Frontend Agent | `SocketContext.tsx` | Socket.IO path `/api/v1/realtime`, auth token handshake, auto invalidasi cache saat reconnect/resync |
| Workspace Join Program & Public /join | DONE | Frontend Agent | `JoinPage.tsx`, `TeamPage.tsx`, `api.ts` | Pendaftaran via kode workspace `#code=`, sanitasi URL fragment, rotasi/disable kode di TeamPage, persetujuan/penolakan berjenjang |
| Zero-Email Recovery Code & /forgot-password | DONE | Frontend Agent | `ForgotPasswordPage.tsx`, `RecoveryCodeModal.tsx` | Sistem pemulihan akun tanpa email mandiri (`RC-XXXXX-...`), reset password aman, dialog unduh/salin kode sekali tampil |
| Account Security & Workspace Lifecycle | DONE | Frontend Agent | `ProfilePage.tsx`, `SettingsPage.tsx`, `SessionsPage.tsx`, `ApiKeysPage.tsx` | Ganti sandi, ganti email, buat recovery code baru, logout all, ganti nama workspace/sesi/API key, hapus workspace oleh OWNER |
| Profile Page Segmented Tab Redesign | DONE | Frontend Agent | `ProfilePage.tsx`, `Header.tsx`, `SecurityBanners.tsx` | Redesign antarmuka Profil dengan tab segmented terorganisir (Profil & Identitas, Keamanan & Kredensial, Kuota Workspace), routing URL `?tab=`, indikator alert recovery code |
| Workspace Restore & Disaster Recovery | DONE | Frontend Agent | `RestoreWorkspacePage.tsx`, `LoginPage.tsx` | Pemulihan mandiri workspace terhapus dalam masa tenggang 30 hari via `POST /auth/deleted-workspaces` dan `POST /auth/restore-workspace`, peringatan `must_recreate`, penanganan `403 NO_ACTIVE_TENANT` |
| Security Banners (Recovery & 2 OWNER) | DONE | Frontend Agent | `SecurityBanners.tsx`, `MainLayout.tsx` | Banner peringatan konfirmasi kode pemulihan (`confirmed=false`), sisa kode rendah (`<=2`), dan banner anjuran minimal 2 Owner untuk stabilitas tata kelola |
| Workspace Data Export (ADR-048) | DONE | Frontend Agent | `ExportDrawer.tsx`, `exportIntegrity.ts`, `exportRange.ts`, `SettingsPage.tsx`, `ChatsPage.tsx`, `ContactsPage.tsx`, `AuditLogsPage.tsx`, `TeamPage.tsx`, `api.ts` | Ekspor streaming CSV & NDJSON untuk 6 jenis data (`messages`, `outbound`, `chats`, `contacts`, `audit-logs`, `members`), verifikasi kelengkapan berkas via `verifyExportBlob` (sadar kutip/CRLF & manifest NDJSON), modul rentang anti-DST `buildExportRange`, tanpa angka cadangan kebijakan, `setPassword` di finally, penanganan 429 `retryAfterSec`, tampilan `request_id`, dan aksesibilitas fokus |
| Workspace Alert Notifications (ADR-049) | DONE | Frontend Agent | `AlertsTab.tsx`, `AlertChannelsSection.tsx`, `AlertChannelModal.tsx`, `AlertRulesSection.tsx`, `AlertDeliveriesSection.tsx`, `SettingsPage.tsx`, `api.ts` | Pengelolaan kanal (Telegram & Slack) dengan proteksi kata sandi, indikator kuota dinamis, uji kirim langsung live feedback, 8 aturan alarm katalog dengan ambang & cooldown, riwayat 50 pengiriman (DEAD error mapping), isolasi hak akses OWNER/ADMIN, zero policy fallbacks, dan proteksi rahasia token/URL |
| Roles Without ADMIN (ADR-053) | DONE | Frontend Agent | `types/index.ts`, `TeamPage.tsx`, `ProfilePage.tsx`, `Sidebar.tsx`, `Header.tsx`, `SettingsPage.tsx`, `AuditLogsPage.tsx`, `ConnectionsPage.tsx` | Penghapusan peran ADMIN di seluruh frontend (`Role = 'OWNER' \| 'MEMBER' \| 'VIEWER'`); token ADMIN dan `isOwnerOrAdmin` dibersihkan 100%; hak administratif eksklusif OWNER |
| Read-Only Quotas & Suspended State | DONE | Frontend Agent | `SettingsPage.tsx`, `LoginPage.tsx`, `AuditLogsPage.tsx`, `api.ts` | Penghapusan form mutasi kuota & `updateTenantSettings`; bilah kuota hanya-baca dikelola platform; pesan login 403 `WORKSPACE_SUSPENDED`; label "Pemilik platform" & format transisi `sebelum -> sesudah` di AuditLogs |
| Platform Admin Console SPA (ADR-054) | DONE | Frontend Agent | `platformApi.ts`, `PlatformLayout.tsx`, `PlatformLoginPage.tsx`, `PlatformWorkspacesPage.tsx`, `PlatformWorkspaceDetailPage.tsx`, `PlatformDefaultsPage.tsx`, `PlatformAuditPage.tsx`, `PlatformBackupPage.tsx`, `App.tsx` | SPA terpisah di `/platform/*` dengan autentikasi 2-langkah (email/password + TOTP), sesi in-memory tanpa disk/cookie, 12 method API platform, manajemen workspace, kuota, penangguhan, kuota default, audit log, dan status cadangan (baca-saja) |
| Frontend Verification & Build | DONE | Frontend Agent | `npm run build` | TypeScript strict check + Vite production bundle 100% clean (0 errors) |

## Latest update

- **Date:** 2026-11-20
- **Completed:**
  - Migrasi menyeluruh dari kontrak mock/prototipe lama ke kontrak backend NYATA Fase A–H2 sesuai `FRONTEND_HANDOFF.md`.
  - Penyatuan halaman WhatsApp Sessions, API Keys, dan Webhooks ke dalam rute terpadu `/connections` ("Koneksi & API") dengan tab navigasi intuitif.
  - Penyatuan menu Kirim Pesan dan Percakapan Chats ke dalam rute `/chats` ("Pesan & Obrolan") dengan tampilan split-panel autentik ala WhatsApp Web:
    - Panel kiri: Daftar obrolan aktif, pencarian pesan/kontak, switcher tab "Log Antrean Gateway" untuk monitoring pesan outbox, dan modal "Chat Baru / Kirim Pesan" ke nomor baru.
    - Panel kanan: Header kontak, wallpaper doodle WhatsApp autentik, bubble chat `#DCF8C6` (outbound) dan putih (inbound), centang status WhatsApp (sent, delivered, read), bar formatting cepat, dan pengiriman pesan via Enter.
  - Perbaikan proporsionalitas layout: Mengatur kontainer Header dan Main Content dengan lebar maksimal `max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6` yang terpusat dan ergonomis tanpa ruang kosong canggung di batas kiri dan kanan pada monitor lebar.
  - Rampingkan navigasi Sidebar menjadi 3 kelompok terstruktur: Aktivitas Utama, Integrasi & Gateway, serta Konfigurasi & Kepatuhan.
  - Penghapusan seluruh dependensi localStorage untuk credential dan QR code. Access token disimpan eksklusif di memori (`tokenStore`), refresh token menggunakan HttpOnly cookie (`credentials: 'include'`).
  - Implementasi single-flight lock refresh handler untuk mencegah race condition pencabutan refresh token pada request paralel 401.
  - Implementasi halaman `InviteAcceptPage.tsx` untuk menangani alur penerimaan undangan tenant dengan validasi token dan perpindahan workspace otomatis.
  - Implementasi visualisasi QR undangan di sisi klien menggunakan library `qrcode` dan integrasi tombol pengiriman undangan instan via WhatsApp gateway.
  - Penambahan halaman `AuditLogsPage.tsx` untuk pemantauan jejak audit kepatuhan oleh OWNER dan ADMIN.
- **In progress:**
  - Pemantauan stabilitas koneksi WebSocket saat sesi gateway Baileys melakukan pairing QR fisik.
- **Blocked:** -
- **API assumptions:**
  - Semua endpoint backend `/api/v1/*` aktif dan terhubung ke database PostgreSQL `wazap_db`.
  - Backend berjalan di `http://127.0.0.1:3000` dan diproxy melalui Vite dev server.
- **Documents updated:**
  - `docs/03_FRONTEND/FRONTEND_PROGRESS.md`
  - `docs/03_FRONTEND/FRONTEND_ARCHITECTURE.md`
  - `docs/03_FRONTEND/PAGE_SPECIFICATION.md`
  - `docs/03_FRONTEND/UI_UX_SPECIFICATION.md`
  - `docs/04_INTEGRATION/INTEGRATION_CONTRACT.md`
  - `CHANGELOG.md`
- **Tests executed and results:**
  - `npm --prefix frontend run build`: Kompilasi TypeScript strict dan bundling produksi Vite sukses tanpa error (0 errors).
  - Endpoint `POST /api/v1/auth/register` dan `GET /health` terverifikasi berfungsi sempurna terhadap backend server.
