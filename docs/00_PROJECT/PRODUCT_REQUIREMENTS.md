# Product Requirements

## 1. Aktor

-   Visitor: melihat halaman publik dan mendaftar.
-   Tenant Owner: pemilik workspace.
-   Tenant Admin: mengelola anggota, API key, session, webhook.
-   Operator: mengelola session dan pesan sesuai izin.
-   Viewer: membaca data sesuai izin.
-   Super Admin: mengelola platform dan tenant untuk keperluan
    operasional.

## 2. Modul produk

### Identity dan tenant

-   Registrasi, login, logout, refresh token.
-   Pembuatan tenant otomatis saat registrasi.
-   Keanggotaan tenant dan role.
-   API key per tenant dengan scopes dan revoke.

### WhatsApp sessions

-   Membuat, melihat, menghubungkan, memutuskan, reconnect, dan
    menghapus session.
-   QR/pairing hanya dapat dilihat oleh user berizin.
-   Status dan event lifecycle.
-   Satu owner engine aktif untuk satu session.

### Messaging

-   Kirim teks dan media sesuai kemampuan adapter.
-   Terima pesan dan event yang didukung.
-   Riwayat chat dan pesan.
-   Job asynchronous, status, attempt, retry terkontrol.
-   Idempotency key pada endpoint pengiriman.
-   Status `UNKNOWN` untuk hasil pengiriman ambigu.

### Integrasi

-   REST API versioned.
-   Webhook dengan HMAC signature, timestamp, retry, delivery log.
-   Socket.IO untuk dashboard realtime.

### Operasional

-   Usage metrics.
-   Audit log.
-   Health check dan worker heartbeat.
-   Backup dan restore.
-   Monitoring resource dan queue.

## 3. Persyaratan non-fungsional

-   Tenant isolation by design.
-   Password hashing dengan algoritma modern yang sesuai.
-   API key hanya disimpan dalam bentuk hash; secret ditampilkan sekali
    saat dibuat.
-   Session credentials dienkripsi dan tidak pernah dikirim ke frontend.
-   Semua endpoint memiliki validasi input dan otorisasi.
-   Pagination untuk daftar dan riwayat.
-   Structured logging tanpa secret atau isi sensitif yang tidak
    diperlukan.
-   Rate limiting per tenant, API key, dan session.
-   Job claim aman terhadap pemrosesan ganda.
-   Graceful shutdown dan recovery.
-   Tidak ada klaim exactly-once delivery; gunakan at-least-once job
    processing dengan idempotency dan rekonsiliasi status.

## 4. Prinsip batas penggunaan

Batas session, pesan, concurrency, dan kapasitas harus dikonfigurasi dan
dapat diubah tanpa mengubah source code. Default awal harus konservatif
dan tidak boleh dianggap sebagai kapasitas produksi sebelum load test.

Pengiriman harus mengikuti kebijakan WhatsApp dan hukum yang berlaku.
Hindari spam, unsolicited bulk messaging, dan pola yang meningkatkan
risiko pembatasan akun.
