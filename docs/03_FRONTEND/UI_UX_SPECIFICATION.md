# UI/UX Specification

## Visual Direction & Design System

Aplikasi WhatsApp Gateway mengadopsi antarmuka SaaS modern profesional:
- **Warna Identitas:** Emerald (`#059669` / `#10b981`) sebagai warna aksen utama WhatsApp Gateway, dipadukan dengan palet netral Slate (`#0f172a` sampai `#f8fafc`).
- **Tipografi:** Font sistem sans-serif modern dengan kontras tinggi, font mono untuk ID, phone numbers, scopes, dan JID.
- **Responsivitas:** Desktop-first dengan drawer sidebar fleksibel untuk layar tablet dan mobile.
- **Status Badges Konsisten:**
  - `CONNECTED` / `SENT` / `DELIVERED` / `READ`: Hijau (`emerald-50`, teks `emerald-700`).
  - `QR_REQUIRED` / `PENDING_ASSIGNMENT`: Ungu/Kuning dengan animasi pulse (`animate-pulse`).
  - `CONNECTING` / `RECONNECTING` / `INITIALIZING`: Biru/Sky dengan animasi spinner.
  - `ERROR` / `FAILED` / `AUTO_CONSECUTIVE_FAILURES`: Merah (`rose-50`, teks `rose-700`).
  - `DISCONNECTED` / `CANCELLED` / `LOGGED_OUT`: Abu-abu netral (`slate-100`, teks `slate-600`).

## Struktur Navigasi & Kontrol Header

1. **Header Workspace:**
   - **Tenant Switcher Dropdown:** Muncul otomatis jika pengguna memiliki lebih dari 1 keanggotaan workspace. Mengganti workspace langsung mengosongkan query cache dan menyambung ulang Socket.IO.
   - **System Health Indicator:** Menampilkan status realtime koneksi WebSocket (`ONLINE`/`OFFLINE`), status database PostgreSQL (`UP`/`DOWN`), dan status REST API (`OK`).
   - **Profil Pengguna & Logout:** Menampilkan email aktif, badge peran (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), dan tombol keluar yang membersihkan sesi HttpOnly.
   - **Kontainer Proporsional:** Lebar header dibatasi secara elegan dengan `max-w-[1440px] mx-auto` agar sejajar dengan batas konten utama pada layar lebar.
2. **Sidebar Menu Terpadu:**
   - **Aktivitas Utama:**
     - Ringkasan Dashboard (`/`)
     - Pesan & Obrolan (`/chats`) — antarmuka terpadu WhatsApp Web (pengiriman pesan, antrean outbox, obrolan realtime).
     - Kontak WhatsApp (`/contacts`)
   - **Integrasi & Gateway:**
     - Koneksi & API (`/connections`) — tab Sesi WhatsApp, Kunci API, dan Webhook.
     - Penggunaan & Kuota (`/usage`)
     - Anggota Tim (`/team`)
   - **Konfigurasi & Kepatuhan:**
     - Pengaturan (`/settings`)
     - Log Audit (`/audit-logs`)

## Komponen Kunci UI/UX

### 1. Antarmuka Terpadu Pesan & Obrolan WhatsApp Web (`/chats`)
- **Desain 2-Kolom Sejati:**
  - **Panel Kiri (Lebar 320px - 380px):**
    - Selector dropdown Sesi WhatsApp aktif.
    - Tombol Call-to-Action "Chat Baru" untuk membuka modal pengiriman pesan pertama ke nomor mana pun (auto +62).
    - Bilah pencarian kontak & isi pesan.
    - Tab Switcher: "Obrolan Aktif" vs "Log Antrean Gateway" (untuk monitoring pesan PENDING, RETRY, CANCELLED, FAILED).
    - Daftar obrolan berpaginasi dengan avatar inisial berwarna, badge unread, snippet pesan terakhir, dan timestamp.
  - **Panel Kanan (Area Percakapan Dinamis):**
    - Header kontak aktif: Avatar, nama/nomor, status koneksi sesi pengirim, dan tombol refresh riwayat.
    - Timeline percakapan berlatar belakang wallpaper doodle WhatsApp autentik.
    - Bubble chat: Hijau `#DCF8C6` (outbound) dan putih (inbound) dengan rounded bubble dan bayangan halus.
    - Indikator status centang WhatsApp: Centang ganda biru (`READ`), centang ganda abu (`DELIVERED`), centang tunggal abu (`SENT`), atau jam pasir (`PENDING`).
    - Quick Formatting Bar: Tombol format cepat teks (*tebal*, _miring_, ~coret~) dan emoji picker instan.
    - Composer terintegrasi: Input pesan responsif dengan dukungan tombol `Enter` untuk kirim langsung (atau `Shift+Enter` untuk baris baru) dan tombol kirim ikon pesawat kertas.

### 2. Antarmuka Terpadu Koneksi & API (`/connections`)
- Menyatukan manajemen koneksi teknis dalam 3 tab intuitif:
  - **Tab Perangkat WhatsApp:** Monitoring 13 status sesi Baileys, kartu sesi dengan indikator baterai/status, kontrol hubungkan/putuskan/sambung ulang/hapus, dan modal Ephemeral QR Pairing.
  - **Tab Kunci API:** Manajemen scoped API key granular, modal reveal-once kunci rahasia, dan pencabutan kunci.
  - **Tab Webhooks:** Konfigurasi webhook endpoint, rotasi secret HMAC SHA-256, uji ping (test delivery), dan log pengiriman.

### 3. Ephemeral QR Pairing Modal
- Hanya dimunculkan saat sesi berstatus `QR_REQUIRED`.
- Menggunakan `qr_data_url` beresolusi tinggi langsung di dalam modal terfokus dengan latar belakang blur.
- Bersih seketika saat modal ditutup atau saat sesi berhasil `CONNECTED` (auto-close).
- Bebas dari penyimpanan lokal (`localStorage`).

### 3. Reveal-Once Secret Dialog (Security Pattern)
- Digunakan pada:
  - Pembuatan API Key baru (`/api-keys`).
  - Pembuatan dan rotasi Webhook Secret (`/webhooks`).
  - Pembuatan tautan undangan tim (`/team`).
- Desain: Box monospace dengan tombol copy sekali klik dan peringatan tegas bahwa kunci/secret tidak dapat ditampilkan ulang setelah dialog ditutup.

### 4. Zero-Email Team Invitation Sharing & Join Code (`/team` & `/join`)
- Sesuai keputusan produk (tanpa pengiriman email otomatis), modal undangan dan kode pendaftaran workspace menyediakan 3 kanal instan:
  1. **Salin Tautan:** URL lengkap `/invite#token=...` atau `/join#code=...` untuk dibagikan via chat.
  2. **QR Code Klien:** Di-generate secara instan di peramban menggunakan pustaka `qrcode` agar calon anggota bisa langsung scan lewat kamera ponsel.
  3. **Kirim WhatsApp:** Tombol tautan langsung ke `wa.me/?text=...` atau kirim pesan instan langsung dari nomor sesi gateway yang sedang aktif.
  4. **Pendaftaran Mandiri & Persetujuan Berjenjang:** Calon anggota dapat mendaftar sendiri via `/join` dengan kode workspace dan kata sandi pilihannya, lalu diputuskan (setujui dengan peran / tolak) oleh OWNER atau ADMIN.

### 5. Dialog Reveal-Once & Pemulihan Akun Mandiri (`RecoveryCodeModal`)
- Kode pemulihan (`RC-XXXXX-...`) diberikan kepada pengguna baru saat mendaftar (`/register` atau `/join`) serta saat reset password (`/forgot-password`).
- Modal peringatan keamanan dengan tampilan kode mono tebal, tombol salin clipboard, tombol unduh berkas teks `.txt`, serta checkbox persetujuan wajib sebelum pengguna melanjutkan.

### 6. Formulir Kuota Tenant Berbatas Aman & Siklus Hidup Workspace (`/settings`)
- Khusus untuk peran `OWNER`.
- Input field dibatasi secara ketat oleh nilai atribut `minimums` dan `ceilings` dari respon backend.
- Menampilkan indikator jumlah sumber daya yang sedang aktif dipakai (`used`) agar pemilik workspace tidak menurunkan batas di bawah pemakaian riil.
- Pengelolaan nama resmi workspace (`PATCH /tenant`) dan zona bahaya penghapusan permanen (`DELETE /tenant`) dengan konfirmasi nama persis dan kata sandi pemilik.

### 7. Transformasi Slide-Over Drawer
- Seluruh dialog pop-up di tengah layar telah ditransformasikan menjadi panel **Slide-Over Drawer** dari sisi kanan layar (`animate-in slide-in-from-right`) dengan latar transparan gelap dan scroll terisolasi, menjaga kenyamanan workflow CRUD pengguna.

### 8. Required State Handling
Setiap halaman wajib mengimplementasikan 5 keadaan visual:
1. **Loading State:** Spinner transparan dengan pesan kontekstual.
2. **Empty State:** Ilustrasi ikon elegan dengan judul, deskripsi, dan tombol aksi pertama (Call-to-Action).
3. **Error State:** Kotak peringatan jelas dengan kode error, deskripsi ramah, dan tombol "Coba Lagi" (Retry).
4. **Unauthorized State:** Tampilan terisolasi khusus peran non-otoritas (misal saat non-admin mengakses `/audit-logs` atau `/settings`).
5. **Success Feedback:** Alert banner hijau yang menghilang otomatis setelah 3-4 detik.

### 9. Antarmuka Ekspor Data Workspace & Privasi (`ExportDrawer` & `/settings?tab=data`)
- **Pola Drawer Slide-Over:** Menggunakan komponen `ExportDrawer` yang konsisten dari sisi kanan layar, dengan fokus otomatis ke input kata sandi jika terjadi kesalahan.
- **Transparansi Kebijakan Retensi:** Kartu informasi retensi hari (`content_days`, `row_days`, `audit_days`) ditampilkan di tab Data & Privasi untuk seluruh anggota tim, mengedukasi batas masa simpan data.
- **Katalog Ekspor & Kontekstual:** Kartu ekspor di tab Data & Privasi serta tombol kontekstual pada halaman Pesan/Chats, Kontak, Audit Logs, dan Tim untuk peran OWNER dan ADMIN.
- **Pilihan Format & Keamanan Formula:** Pilihan format CSV (dengan label anti-formula injection `= + - @`) dan NDJSON (dengan manifest baris akhir).
- **Pemilih Rentang Tanggal Cepat:** Tombol preset "30 Hari Terakhir", "Bulan Ini", "Bulan Lalu", dan "7 Hari" dengan validasi interaktif tidak melebihi `max_span_days`.
- **Indikator Streaming & Tombol Batal:** Menampilkan byte terunduh secara dinamis (`formatBytes`) dan tombol Batal ber-`AbortController` yang menghentikan transmisi dan memicu pencatatan audit `aborted` di server.
- **Pemeriksaan Kelengkapan Berkas:** Pengujian otomatis `_manifest.rows` pada NDJSON dan baris data CSV terhadap header `X-Export-Rows` sebelum berkas diserahkan ke sistem unduhan peramban.

### 10. Antarmuka Notifikasi Alarm Workspace (`/settings?tab=notifications` - ADR-049)
- **Akses Eksklusif OWNER/ADMIN:** Tab Notifikasi dilindungi pembatasan peran di tingkat navigasi tab dan komponen; pengguna unauthorized disajikan kartu "Akses Dibatasi".
- **Banner Status Operator:** Jika operator menonaktifkan fitur alarm (`catalog.enabled === false`), banner peringatan ramah ditampilkan di bagian atas tab dan seluruh tombol modifikasi (tulis) dinonaktifkan secara otomatis tanpa menyembunyikan konfigurasi yang sudah ada.
- **Kanal Notifikasi Multi-Platform:** Menampilkan daftar kartu kanal (Telegram bot dan Slack/Discord webhook), petunjuk target 4 digit terakhir (`••••abcd`), tombol aktifkan/nonaktifkan instan, tombol ganti target, dan hapus kanal berkonfirmasi kata sandi.
- **Indikator Kuota Kanal Dinamis:** Menampilkan rasio pemakaian kanal terhadap kuota maksimum server (`max_channels`) tanpa nilai tebakan, serta menonaktifkan tombol tambah saat kuota penuh.
- **Live Test Feedback:** Tombol "Uji Kirim" menyajikan umpan balik langsung berbasis `aria-live="polite"` dengan waktu respons (ms), membedakan pesan sukses dari kegagalan autentikasi (401/403/404) dan jaringan (TIMEOUT/DNS).
- **Aturan Pemicu dari Katalog Otoritatif:** 8 aturan alarm resmi dari katalog server dengan deskripsi lengkap, sakelar aktif `aria-checked`, input ambang toleransi min..max (untuk aturan berambang), jeda ulang cooldown menit (untuk aturan berulang), serta selektor multi-kanal maksimal 5 kanal.
- **Riwayat Pengiriman & Pemetaan Galat:** Tabel 50 pengiriman log alarm terbaru dengan badge status (`SENT`, `PENDING`, `DEAD`), keterangan galat ramah pengguna (`HTTP_401/403/404`, `RATE_CAPPED`, `CHANNEL_INACTIVE`), dan tombol muat ulang manual tanpa auto-polling agresif.
