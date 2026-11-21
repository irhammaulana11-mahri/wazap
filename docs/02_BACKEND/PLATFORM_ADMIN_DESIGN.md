# Rancangan: Platform Admin (pemilik platform) dan penyederhanaan peran workspace

> **STATUS: DIPUTUSKAN SEBAGIAN (2026-11-21), belum ada kode.** Diputuskan pemilik: ADMIN dihapus sekarang (ADMIN lama menjadi MEMBER); kuota diatur penuh oleh platform dan OWNER hanya melihat; UI cadangan hanya-baca; konsol untuk sementara di HOST YANG SAMA (`wazap.bolinggo.org/platform`). Menunggu konfirmasi: paket keamanan untuk konsol di host yang sama (bagian 3A). Permintaan pemilik (2026-11-21): peran **platform admin / super admin** yang mengelola semua pemilik workspace dan **mengalokasikan kuota** (Batas Sesi WhatsApp, Batas Kecepatan/Rate Limit, Batas Kunci REST API, Batas Anggota Tim) per workspace, dengan tampilan frontend (termasuk status cadangan); dan di dalam workspace hanya **OWNER**, **member/agent**, dan **viewer** (tanpa ADMIN).

## 1. Kondisi saat ini (fakta dari kode)
-   Peran workspace: `OWNER > ADMIN > MEMBER > VIEWER` (`principal.ts`, CHECK di `tenant_memberships`, `team.service.ts`). `ADMIN` muncul di 12 berkas rute/layanan.
-   Kuota ada di `tenant_settings` (`max_sessions`, `max_api_keys`, `max_members`, `messages_per_minute`). **OWNER** dapat mengubahnya (`PATCH /tenant/settings`) di dalam batas atas **global** dari env (`LIMIT_CEIL_*`, sama untuk semua workspace). Tidak ada kuota per workspace dari sisi operator, tidak ada UI operator, tidak ada konsep operator di aplikasi (satu-satunya alat: env dan CLI `admin:recovery-code`).
-   Peran `ADMIN` hari ini = OWNER dikurangi: ubah kuota, kelola OWNER/ADMIN lain. Selebihnya sama: tim, undangan, webhook, API key, alarm, ekspor, audit.
-   **Tidak ada penegakan `tenants.status = 'SUSPENDED'`**: kolomnya ada, tetapi tidak dicek saat login, API key, realtime, engine, maupun webhook. Fitur "tangguhkan workspace" butuh pekerjaan nyata (bagian 5).
-   **Tidak ada 2FA/TOTP.** Autentikasi: kata sandi + access token + refresh cookie.
-   Konteks platform di basis data (`db.tx({platform:true})`) hanya boleh dipakai di `modules/engine/`, `runtime/`, `database/` (tes penjaga di `lifecycle.test.ts`). Rute HTTP tidak pernah memakainya.

## 2. Peran workspace yang diusulkan: OWNER, MEMBER (agent), VIEWER
| Kemampuan | OWNER | MEMBER (agent) | VIEWER |
|---|---|---|---|
| Sesi WhatsApp: lihat | ya | ya | ya |
| Sesi: buat/ubah/hapus, pairing | ya | ya | tidak |
| Pesan: baca / kirim | ya / ya | ya / ya | ya / tidak |
| Pemakaian (usage): lihat | ya | ya | ya |
| Webhook, API key, alarm, ekspor, log audit, undangan/anggota, pengaturan workspace | ya | **tidak** | tidak |
| Kuota | **hanya lihat** (diatur platform) | tidak | tidak |
Perubahan dari sekarang: semua hak `ADMIN` (webhook, API key, alarm, ekspor, audit, tim) menjadi **OWNER saja**. Satu workspace boleh punya lebih dari satu OWNER (perlindungan "OWNER terakhir" tetap). OWNER mengelola MEMBER dan VIEWER; `canManageRole` menjadi sederhana (OWNER mengelola semua selain dirinya sebagai OWNER terakhir).
**Migrasi 0021** (migrasi lama tidak boleh diubah): ubah CHECK `tenant_memberships.role`, `team_invites.role`, `join_requests.role` menjadi tiga nilai; baris `ADMIN` yang ada dikonversi ke **MEMBER** (turun hak, bukan naik; jalur aman). Dampak: tes, OpenAPI, frontend (pilihan peran, `canManageAlerts`, ekspor), dokumen kontrak. Belum ada tenant produksi, jadi biayanya paling kecil SEKARANG; makin lama makin mahal.

## 3. Platform admin
-   **Identitas:** tabel `platform_admins (user_id PK -> users, created_at, created_by, status)`. Akun yang sama dapat menjadi OWNER workspace dan platform admin, tetapi **token platform berbeda dari token workspace**: klaim `typ: 'platform'`, tanpa `tenant_id`, masa berlaku pendek, tidak dapat dipakai di rute workspace, dan token workspace tidak dapat dipakai di rute platform (tes silang wajib).
-   **Pembuatan:** HANYA lewat CLI di server (`npm run admin:platform-admin -- --email ...`, pola yang sama dengan `admin:recovery-code`), tidak ada API/UI untuk membuat atau mencabut platform admin. Pencabutan juga CLI. Alasan: tidak ada jalur dari internet yang dapat membuat superuser.
-   **Akses data:** rute `/api/v1/platform/*` memakai konteks platform di DB. Ini **memperluas** kuasa proses API (hari ini hanya worker). Mitigasi: modul tunggal `modules/platform/` yang masuk daftar izin tes penjaga (diperbarui dan diuji), hanya operasi terkurasi (tanpa SQL bebas), semua tulis lewat audit platform append-only, dan **tidak ada** operasi yang membaca isi pesan, kontak, kredensial sesi, target alarm, atau kunci API (bagian 6).
-   **Kapasitas v1:**
    1.  **Daftar workspace**: nama, slug, status, email OWNER, tanggal, pemakaian agregat (sesi, anggota, API key, pesan 24 jam) terhadap kuota. Cari dan saring.
    2.  **Detail workspace**: kuota efektif dan pemakaian, daftar OWNER (email), riwayat perubahan kuota/status.
    3.  **Atur kuota per workspace** (4 kuota; wajib alasan; tidak boleh di bawah pemakaian saat ini; batas mutlak dari env `LIMIT_CEIL_*` tetap sebagai pagar salah ketik).
    4.  **Tangguhkan / aktifkan workspace** (wajib alasan; bagian 5).
    5.  **Kuota bawaan workspace baru** (tabel satu baris `platform_defaults`, dipakai saat registrasi).
    6.  **Audit platform** (siapa, aksi, workspace, sebelum/sesudah, alasan, IP, waktu).
    7.  **Status cadangan (hanya baca)** (bagian 7).
-   **v1.1 (setelah v1 stabil):** kelola akun pemilik: nonaktifkan/aktifkan akun (`users.status`), terbitkan kode pemulihan (menggantikan CLI), TOTP wajib untuk platform admin.
-   **Transparansi:** setiap perubahan oleh platform tercatat juga di log audit workspace ("diubah oleh platform", tanpa identitas operator pribadi), supaya OWNER tahu kuotanya bukan berubah sendiri.

## 3A. Keamanan konsol di host yang sama (usulan, menunggu konfirmasi)
Karena konsol berada di `wazap.bolinggo.org` yang juga dipakai pelanggan, kebocoran satu kata sandi tidak boleh cukup untuk menguasai platform. Lapisan (dari terkuat):
1.  **MFA TOTP wajib di aplikasi** untuk setiap platform admin (RFC 6238, SHA-1, 6 digit, 30 dtk, jendela ±1, dikerjakan dengan `node:crypto` tanpa dependensi baru). Rahasia TOTP disimpan terenkripsi (AES-256-GCM dengan AAD `wazap:totp:v1|user`, sama seperti kredensial lain) dan ikut rotasi kunci. **Pendaftaran perangkat hanya lewat CLI di server**: `npm run admin:platform-admin -- --email ...` mencetak URI `otpauth://` SEKALI di terminal server (dan 10 kode pemulihan sekali pakai, hanya hash yang disimpan). Tidak ada jalur dari internet yang dapat mendaftarkan atau mengganti perangkat. Kode TOTP yang sama tidak dapat dipakai dua kali (langkah waktu terakhir disimpan).
2.  **Login platform terpisah** dari login pelanggan: `POST /platform/auth/login` (email + kata sandi, hanya untuk akun di `platform_admins`, galat seragam agar tidak membocorkan siapa admin) menghasilkan token MFA berumur 5 menit; `POST /platform/auth/verify` (kode TOTP) menghasilkan token platform berumur 15 menit tanpa refresh, dengan batas sesi mutlak 8 jam. Token workspace tidak pernah dapat menjadi token platform dan sebaliknya (tes silang).
3.  **Kode TOTP segar pada setiap perubahan** (kuota, tangguhkan, default): isi `otp` di tubuh permintaan; pembaca tidak perlu. Kesalahan 5 kali dalam 15 menit mengunci akun admin itu (sama seperti pola kata sandi pada kanal alarm; pengecekan kunci sebelum verifikasi).
4.  **Jejak dan pemberitahuan**: audit platform append-only (login berhasil/gagal, setiap perubahan, IP, alasan), dan notifikasi Telegram ke operator untuk login platform dan setiap perubahan (token bot tulis-saja di env API; opsional, fase P4 bila tidak dikerjakan di P1).
5.  **Jaringan** (tanpa kode, opsional tetapi disarankan karena Anda sudah memakai Cloudflare): **Cloudflare Access dengan cakupan path** pada `wazap.bolinggo.org/platform*` dan `wazap.bolinggo.org/api/v1/platform/*` (kebijakan: hanya surel admin; MFA/OTP dari Cloudflare). Berfungsi di host yang sama karena Access dapat dibatasi per path, dan SPA memanggil API satu origin. Nginx: `/api/v1/platform/` dijawab 404 di `api-wazap.bolinggo.org` (tes); zona batas laju khusus yang ketat untuk path platform.
**Yang tidak dapat dijanjikan:** di host yang sama, bug di aplikasi (mis. kelemahan XSS pada dashboard pelanggan) tetap berada di origin yang sama dengan konsol. Karena itu MFA dan kode segar per perubahan adalah pagar utama, dan pemisahan ke host admin (`admin-wazap`) tetap menjadi peningkatan yang disarankan setelah v1.

## 4. Kuota
-   `tenant_settings` tetap sumber kebenaran (tidak ada tabel kuota baru). **OWNER tidak lagi dapat mengubah kuota**: `PATCH /tenant/settings` dihapus (atau 403 permanen) dan tab Pengaturan menampilkan kuota hanya baca beserta pemakaian dan teks "hubungi pemilik platform untuk menambah kuota".
-   `LIMIT_CEIL_*` berubah arti: batas mutlak yang tidak dapat dilampaui platform admin pun (pagar salah ketik), bukan hak OWNER.
-   Titik penegakan sudah ada (sesi, API key, anggota, laju pesan); tes memastikan nilai per workspace yang dipakai.
-   Kuota bawaan registrasi diambil dari `platform_defaults` (bukan lagi DEFAULT kolom).

## 5. Penangguhan workspace (BELUM ada penegakan; ini inti pekerjaan)
Workspace berstatus `SUSPENDED` harus: (1) menolak login dan refresh baru untuk anggotanya di workspace itu (akun yang punya workspace lain tetap dapat memakai yang lain), (2) menolak access token dan API key milik workspace itu (cek status di jalur autentikasi, di-cache singkat), (3) memutus Socket.IO, (4) menghentikan sesi WhatsApp di engine (desired_state DISCONNECTED tanpa menghapus kredensial) dan tidak menjalankannya ulang, (5) menghentikan pengiriman webhook, antrean pesan, dan notifikasi alarm, (6) tetap menyimpan semua data (aktivasi ulang memulihkan). Pesan galat jelas: "Workspace ditangguhkan. Hubungi pemilik platform." Tes menyeluruh untuk setiap jalur di atas; tanpa itu penangguhan hanya kosmetik.

## 6. Privasi dan batas kuasa platform admin
Platform admin **tidak dapat**: membaca isi pesan, kontak, chat, kredensial/auth state sesi, target alarm, rahasia webhook, kunci API, atau data ekspor; menyamar sebagai pengguna; atau masuk ke workspace. Ia melihat metadata dan agregat saja. Ini dijaga oleh daftar operasi terkurasi dan tes yang membuktikan tidak ada rute platform yang mengembalikan kolom-kolom itu (uji berbasis skema OpenAPI dan uji isi respons). Kebijakan ini perlu ditulis di syarat layanan: pemilik platform dapat membatasi/menangguhkan workspace dan mengatur kuota.

## 7. Tampilan frontend dan status cadangan
-   **Konsol platform** adalah bagian terpisah di frontend (`/platform/*`), terlihat hanya untuk token platform; dashboard workspace tidak memuat menu platform.
-   **Untuk sementara di host yang sama** (keputusan pemilik): `wazap.bolinggo.org/platform`, dengan paket keamanan bagian 3A. `/api/v1/platform/` dijawab 404 di `api-wazap.bolinggo.org`. Pemisahan ke host admin di belakang Cloudflare Access (path-scoped atau host sendiri) tetap peningkatan yang disarankan.
-   **Status cadangan (hanya baca):** `backup-run.sh` menulis berkas status JSON (waktu terakhir sukses/gagal, ukuran, `offsite.ok`/`separate-disk.ok`, umur) ke `/var/lib/wazap/status/backup.json` (dibaca API, tanpa kredensial). Tidak ada tombol "jalankan/pulihkan" yang mengeksekusi dari API: itu membuat proses API memegang kredensial cadangan (`BYPASSRLS`). Opsi lanjutan bila diinginkan: API menulis berkas permintaan yang diambil cron/systemd path milik pengguna cadangan (kredensial tetap di luar API).
-   Frontend dikerjakan agen frontend dengan prompt dari dokumen ini (pola yang sama dengan UI ekspor dan notifikasi): backend dibuat dan diuji lebih dulu, kontrak OpenAPI dan tes perilaku klien mengunci frontend.

## 8. Keputusan pemilik
| # | Keputusan | Status |
|---|---|---|
| 1 | Lokasi dan perlindungan konsol | host yang sama untuk sementara; paket keamanan 3A (MFA TOTP + login terpisah + kode segar per perubahan + Cloudflare Access path-scoped opsional) **menunggu konfirmasi** |
| 2 | Hapus peran `ADMIN` sekarang, ADMIN lama menjadi MEMBER | **DIPUTUSKAN** |
| 3 | Kuota diatur penuh oleh platform, OWNER hanya melihat | **DIPUTUSKAN** |
| 4 | UI cadangan: status hanya-baca | **DIPUTUSKAN** |

## 9. Fase kerja (tiap fase selesai hanya dengan implementasi, tes, dokumen, bukti)
-   **P0** Peran: migrasi 0021, hapus ADMIN di kode/tes/OpenAPI/frontend/dokumen. (Sebelum tenant sungguhan.)
-   **P1** Backend platform: `platform_admins` (+ rahasia TOTP terenkripsi, kode pemulihan, langkah waktu terakhir), `platform_defaults`, `platform_audit_logs` (RLS FORCE, hanya konteks platform), token `typ: platform`, guard dan tes silang, modul `platform/`, CLI admin, penegakan penangguhan (bagian 5), kuota per workspace dan OWNER hanya-baca, status cadangan, pembaruan tes penjaga konteks platform. Migrasi 0022.
-   **P2** Gerbang jaringan: `/api/v1/platform/` 404 di host API (diuji di `test-tunnel-vhost.sh`), zona batas laju path platform, panduan Cloudflare Access path-scoped.
-   **P3** Frontend: prompt agen, konsol platform, UI kuota hanya-baca di Pengaturan, perubahan pilihan peran (tanpa ADMIN).
-   **P4** (opsional) notifikasi Telegram login/perubahan platform, kelola akun pemilik, pemisahan ke host admin.

## 10. Bukti selesai yang akan diminta
Tes silang token (workspace tidak bisa ke `/platform`, platform tidak bisa ke rute workspace); tes isolasi (platform admin tidak pernah menerima isi pesan/kontak/kredensial; uji skema respons); tes penangguhan menyeluruh (login, refresh, token, API key, realtime, engine, webhook, antrean, alarm; aktivasi ulang memulihkan); tes kuota per workspace dan OWNER 403/hanya-baca; tes audit platform dan jejak di audit workspace; tes migrasi 0021 (ADMIN menjadi MEMBER) dan tes penjaga konteks platform; tes vhost (`/api/v1/platform/` hanya di host admin); regresi seluruh suite.

## 11. Risiko
Perluasan kuasa proses API (konteks platform) adalah risiko utama; dibatasi modul tunggal terkurasi, audit, host admin di belakang Cloudflare Access, dan tanpa akses isi. Tanpa TOTP, keamanan akun platform bertumpu pada kata sandi + Cloudflare Access (fase 1). Penghapusan ADMIN adalah perubahan yang memutus kompatibilitas klien; aman hanya sebelum ada pengguna. Penangguhan yang tidak menyeluruh memberi rasa aman palsu; karena itu bagian 5 dijadikan syarat selesai.
