# Frontend Architecture

## Stack

React 19, Vite, TypeScript, Tailwind CSS v4, React Router v7, TanStack Query v5, Socket.IO Client.

## Application areas

- **Public:** Landing, register (`/register`), login (`/login`), terima undangan (`/invite`), permohonan gabung workspace (`/join`), pemulihan kata sandi (`/forgot-password`).
- **Workspace:** Dashboard (`/`), koneksi & integrasi (`/connections`), percakapan chat ala WhatsApp Web (`/chats`), kontak (`/contacts`), analitik penggunaan (`/usage`), manajemen tim & kode workspace (`/team`), pengaturan kuota & workspace (`/settings`), log audit (`/audit-logs`), profil & keamanan akun (`/profile`).
- **Platform/Tenant Switcher:** Multi-tenant dropdown switcher pada header untuk pengguna dengan membership lebih dari satu workspace.

## Rules

- Frontend tidak pernah mengakses PostgreSQL atau storage internal engine WhatsApp secara langsung.
- Semua data berasal dari REST API backend resmi (`/api/v1/...`).
- Pembaruan status realtime menggunakan Socket.IO pada path `/api/v1/realtime`.
- Konteks tenant ditentukan secara otoritatif oleh backend melalui token sesi aktif.
- Penanganan error ketat: membaca `body.error.code`, `body.error.message`, dan `body.error.details[]`.
- QR Code dan API Key plain-text bersifat **ephemeral** dan **tidak boleh disimpan di localStorage/sessionStorage**.
- Access token disimpan **hanya di memori** (`tokenStore`). Refresh token hanya tersimpan di cookie browser HttpOnly (`credentials: 'include'`).

## Implementasi Aktual (2026-11-20 - Fase H2)

### Struktur Direktori
```text
frontend/src/
├── components/
│   ├── layout/            # Sidebar, Header (dengan Tenant Switcher & status indicator), MainLayout
│   └── ui/                # LoadingState, EmptyState, ErrorState, MockNotice
├── context/
│   ├── AuthContext.tsx    # Manajemen auth berbasis cookie HttpOnly & in-memory token, me, switchTenant
│   └── SocketContext.tsx  # Socket.IO path /api/v1/realtime, token handshake & auto-resync
├── pages/
│   ├── DashboardPage.tsx  # Ringkasan KPI dari /usage/summary, sesi aktif, dan pesan terbaru
│   ├── SessionsPage.tsx   # 13 status sesi WhatsApp, ephemeral QR modal, connect/disconnect/reconnect/delete
│   ├── MessagesPage.tsx   # Message composer ber-Idempotency-Key, pagination, filter tanggal/sesi/status, cancel & retry
│   ├── ContactsPage.tsx   # Direktori kontak WhatsApp dari /api/v1/contacts, pagination, pencarian
│   ├── ChatsPage.tsx      # Antarmuka messenger 2 kolom dari /api/v1/chats dan /api/v1/chats/:id/messages
│   ├── WebhooksPage.tsx   # CRUD endpoint, reveal-once signing secret dialog, rotate secret, test per endpoint
│   ├── ApiKeysPage.tsx    # Pembuatan kunci dengan scope valid (tanpa *), reveal-once plain key, revoke
│   ├── TeamPage.tsx       # Anggota tim, matriks peran, dialog undang tanpa email (link, QR klien, WhatsApp)
│   ├── UsagePage.tsx      # Grafik time-series bar chart /usage/messages (tz=Asia/Jakarta), kartu progress kuota
│   ├── SettingsPage.tsx   # Konfigurasi batas kuota tenant (khusus OWNER), dibatasi minimums dan ceilings
│   ├── AuditLogsPage.tsx  # Pemantauan log audit aktivitas administratif untuk OWNER & ADMIN
│   ├── LoginPage.tsx      # Autentikasi email + password, pemrosesan single-flight refresh
│   ├── RegisterPage.tsx   # Pendaftaran email + password (min 10) + tenant_name
│   └── InviteAcceptPage.tsx # Validasi token undangan, registrasi anggota baru, auto switch workspace
├── services/
│   └── api.ts             # API Client lengkap: tokenStore, single-flight refresh handler, endpoint Fase A–H
├── types/
│   └── index.ts           # Schema models ketat sesuai backend contract
├── App.tsx                # Routing guard, React Query Client, AuthProvider, SocketProvider
└── main.tsx               # Root entry
```

### Flow Manajemen State, Keamanan, & Siklus Hidup Token
1. **Penyimpanan Token In-Memory (Zero Storage Leaks):**
   - Access token JWT disimpan secara eksklusif di variabel memori JavaScript (`tokenStore`) di dalam modul `services/api.ts`.
   - Tidak ada token, API key, ataupun credential rahasia yang disimpan di `localStorage` atau `sessionStorage`.
2. **Single-Flight 401 Refresh Handler:**
   - Refresh token dikelola oleh browser melalui cookie aman `HttpOnly` (`wzp_rt`).
   - Semua pemanggilan HTTP menyertakan `credentials: 'include'`.
   - Ketika beberapa permintaan paralel menghasilkan status `401 Unauthorized`, API client mengunci antrean refresh ke dalam satu `refreshPromise` tunggal (*single-flight lock*) untuk menghindari race condition pembakaran token rotasi backend. Setelah token baru didapat, permintaan asli diulangi satu kali. Jika gagal, sesi dibersihkan dan dialihkan ke login.
3. **Siklus Hidup QR Code Ephemeral:**
   - Payload `qr_data_url` hanya diminta ketika sesi berada dalam status `QR_REQUIRED`.
   - QR code tidak pernah dicatat ke log, localStorage, ataupun state persisten.
   - Polling QR otomatis dibersihkan dan modal ditutup saat komponen unmount, modal ditutup oleh user, atau ketika status sesi berganti menjadi `CONNECTED`, `ERROR`, atau `LOGGED_OUT`.
4. **Strategi Sinkronisasi Realtime & Tenant Switch:**
   - Koneksi WebSocket Socket.IO menggunakan path `/api/v1/realtime` dengan access token yang dikirim pada handshake `auth: { token }`.
   - Ketika koneksi socket terputus lalu tersambung kembali (`connect`) atau menerima event `realtime.resync`, query cache TanStack Query secara otomatis dibatalkan (`invalidateQueries`) untuk memastikan konsistensi data.
   - Saat pengguna berpindah workspace melalui `switchTenant`, seluruh query cache TanStack Query langsung dikosongkan (`queryClient.clear()`) dan koneksi socket disambung ulang dengan token baru.
