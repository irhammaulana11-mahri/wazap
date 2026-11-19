# Project Overview

## 1. Produk

WhatsApp Gateway adalah platform multi-tenant yang memungkinkan pengguna
mendaftar sendiri, menghubungkan satu atau lebih akun WhatsApp,
mengelola session, mengirim dan menerima pesan, serta mengintegrasikan
aplikasi eksternal melalui REST API dan webhook.

## 2. Keputusan produk yang telah ditetapkan

-   Model pengguna: self-service registration.
-   Setiap pendaftar memperoleh tenant/workspace sendiri.
-   Batas session: dinamis, mengikuti kebijakan platform, paket/kuota
    bila kelak diterapkan, dan kapasitas infrastruktur.
-   Akses: dashboard web dan REST API.
-   Banyak tenant dan banyak session harus dapat berjalan bersamaan.
-   Setiap session memiliki lifecycle, antrean logis, dan kepemilikan
    engine sendiri.
-   Isolasi tenant wajib diterapkan pada semua data dan operasi.
-   Sistem dimulai pada satu server Ubuntu tetapi harus siap dipisah ke
    beberapa server.

## 3. Kondisi infrastruktur awal

-   Ubuntu Server.
-   Intel Core i5 Gen 6, 4 core.
-   RAM 16 GB.
-   SSD 512 GB dan HDD 500 GB.
-   Sudah ada tujuh bot Python dan dua aplikasi web.
-   PostgreSQL sudah tersedia dan digunakan aplikasi lain.

Kondisi ini adalah konteks deployment awal, bukan jaminan kapasitas
session tertentu. Kapasitas harus ditentukan melalui load test dan
pengukuran aktual.

## 4. Teknologi baseline

-   Backend: Node.js + TypeScript + Fastify.
-   Frontend: React + Vite + TypeScript + Tailwind CSS.
-   Database: PostgreSQL.
-   PostgreSQL driver: `pg`; migration SQL versioned.
-   Realtime: Socket.IO.
-   WhatsApp adapter awal: Baileys.
-   Process manager: PM2.
-   Reverse proxy: Nginx.
-   Queue awal: PostgreSQL dengan claim aman dan
    `FOR UPDATE SKIP LOCKED`.
-   Redis/BullMQ: opsi tahap scale-out, bukan dependency wajib fase
    pertama.

Versi dependency harus dipilih berdasarkan kompatibilitas dan
dokumentasi resmi terkini saat implementasi. Lockfile wajib dikomit.

## 5. Batasan dan risiko

Baileys merupakan library tidak resmi yang berinteraksi dengan protokol
WhatsApp Web. Perubahan protokol, pembatasan akun, dan ketidakcocokan
versi merupakan risiko. Jangan menjanjikan SLA atau kapasitas sebelum
pengujian. Untuk penggunaan bisnis kritis, evaluasi adapter WhatsApp
Business Platform resmi.

## 6. Definisi selesai tingkat produk

-   Tenant dapat mendaftar, login, dan mengelola workspace.
-   Tenant dapat membuat beberapa session.
-   Session memiliki autentikasi, lifecycle, reconnect, dan ownership
    yang aman.
-   Pesan dapat dikirim asynchronous melalui API dan dashboard.
-   Pesan masuk dan status dapat diproses dan ditampilkan jika didukung
    library/platform.
-   Webhook dapat dikirim dengan signature, retry, dan delivery log.
-   Isolasi tenant diuji.
-   Restart dan pemulihan session diuji.
-   Monitoring dan backup terdokumentasi.
