# Frontend Page Specification

| Halaman | Rute | Komponen Utama | Dependensi API Backend | Hak Akses Minimal |
| :--- | :--- | :--- | :--- | :--- |
| **Login** | `/login` | Form email & kata sandi, single-flight refresh auto-trigger | `POST /api/v1/auth/login` | Publik |
| **Register** | `/register` | Form email, password (>= 10 karakter), nama workspace, dialog kode pemulihan mandiri sekali tampil | `POST /api/v1/auth/register` | Publik |
| **Gabung Workspace** | `/join` | Form kode workspace (`#code=` fragment di URL, auto-purged dari address bar), email, password, dialog kode pemulihan akun baru | `POST /api/v1/auth/join-requests` | Publik |
| **Lupa Kata Sandi** | `/forgot-password` | Form reset kata sandi menggunakan email, kode pemulihan (`RC-XXXXX-...`), dan kata sandi baru; dialog penerbitan kode pemulihan baru | `POST /api/v1/auth/reset-password` | Publik |
| **Terima Undangan** | `/invite` | Validasi token undangan (dari fragment `#token=`), auto-switch tenant setelah diterima | `POST /api/v1/team/invitations/accept` | Publik / Terautentikasi |
| **Profil & Keamanan Akun** | `/profile` | Data user, status kuota workspace, matriks izin, pengaturan keamanan (ganti sandi, ganti email, terbitkan recovery code baru, logout-all) | `GET /auth/me`, `POST /auth/change-password`, `POST /auth/change-email`, `POST /auth/recovery-code`, `POST /auth/logout-all`, `GET /tenant/settings` | Semua Peran |
| **Dashboard** | `/` | Kartu KPI kuota & throughput, ringkasan sesi aktif, antrean pesan, quick actions | `GET /api/v1/usage/summary`, `GET /api/v1/sessions`, `GET /api/v1/messages` | Semua Peran |
| **Pesan & Obrolan (WhatsApp Web Layout)** | `/chats` (alias `/messages`) | Antarmuka terpadu ala WhatsApp Web 2-kolom: Panel kiri (Obrolan & Log Antrean Gateway, pencarian, tombol Chat Baru), Panel kanan (timeline doodle wallpaper, chat bubble hijau `#DCF8C6`/putih, status centang biru/abu, formatting bar, composer Enter) | `GET /api/v1/chats`, `GET /api/v1/chats/:id/messages`, `POST /api/v1/messages/send`, `GET /api/v1/messages`, `POST /messages/:id/cancel`, `retry` | Semua Peran (Kirim: MEMBER) |
| **Direktori Kontak** | `/contacts` | Tabel kontak WhatsApp tersinkronisasi, pencarian instan nama & nomor | `GET /api/v1/contacts` | Semua Peran |
| **Koneksi & Integrasi (Terpadu)** | `/connections` (alias `/sessions`, `/api-keys`, `/webhooks`) | Tabbed view terpadu: Perangkat WhatsApp (13 status sesi, ubah nama sesi, ephemeral QR modal), Kunci API (scoped tokens, edit nama/scope, reveal-once), dan Webhooks (endpoint CRUD & secret rotation) | `GET /api/v1/sessions`, `PATCH /sessions/:id`, `GET /api/v1/api-keys`, `PATCH /api-keys/:id`, `GET /api/v1/webhooks`, `POST /webhooks/...` | Sesi: MEMBER, API/Webhook: ADMIN |
| **Analitik & Penggunaan** | `/usage` | Kartu progress kuota, grafik bar deret waktu volume pesan (`tz=Asia/Jakarta`), tabel performa per sesi | `GET /api/v1/usage/summary`, `GET /api/v1/usage/messages`, `GET /api/v1/usage/sessions` | Semua Peran |
| **Manajemen Tim** | `/team` | Tab Anggota (daftar, peran, status, hapus), Tab Undangan (buat, salin, QR, WhatsApp, reissue, revoke), Tab Kode & Permintaan Bergabung (putar/disable kode, setujui/tolak permohonan) | `GET|PATCH|DELETE /team/members`, `GET|POST|DELETE /team/invitations`, `GET|PUT|DELETE /team/join-code`, `GET|POST /team/join-requests` | ADMIN / OWNER |
| **Pengaturan Kuota & Workspace** | `/settings` | Formulir konfigurasi batas alokasi kuota tenant (`minimums`/`ceilings`), ubah nama workspace, zona bahaya hapus workspace permanen | `GET|PATCH /api/v1/tenant/settings`, `PATCH /api/v1/tenant`, `DELETE /api/v1/tenant` | Khusus OWNER |
| **Audit Logs** | `/audit-logs` | Tabel log jejak audit administratif, filter berdasarkan jenis aksi, paginasi | `GET /api/v1/audit-logs` | ADMIN / OWNER |

## Checklist Kepatuhan Kontrak Halaman

- **Zero Storage Leaks:** Tidak ada data rahasia (QR code, token JWT, webhook secret, API key plain-text) yang disimpan di `localStorage` atau `sessionStorage`.
- **Typed API Client:** Semua pemanggilan API menggunakan fungsi bertipe di `src/services/api.ts` yang selaras dengan `docs/02_BACKEND/API_CONTRACT.md`.
- **Idempotency Kontrol:** Pengiriman pesan (`/messages/send`) selalu menghasilkan header `Idempotency-Key` unik di sisi klien untuk mencegah duplikasi pesan.
- **Paginasi & Capped Handling:** Paginasi dihormati pada semua tabel data besar, termasuk penanganan flag `meta.total_capped` ("10.000+").
- **Koneksi Realtime & Resync:** Reconnection Socket.IO pada path `/api/v1/realtime` secara otomatis meng-invalidasi query TanStack Query untuk memastikan state data selalu mutakhir.
- **Proporsional & Responsif:** Header dan Main Content konsisten menggunakan kontainer `max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6` yang terpusat dan ergonomis di seluruh resolusi layar.
