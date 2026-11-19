# System Architecture

## 1. Gaya arsitektur

Multi-tenant modular architecture dengan event-driven processing.
Deployment pertama berupa satu server dengan proses runtime terpisah.
Desain harus memungkinkan API, engine, dan worker dipindahkan ke
beberapa host di masa depan.

## 2. Runtime processes

1.  `api`: Fastify REST API, authentication, authorization, tenant
    context.
2.  `realtime`: Socket.IO; dapat berjalan bersama API pada fase awal.
3.  `control-plane`: tenant/session manager, engine dispatcher, lease
    manager.
4.  `engine`: mempertahankan koneksi Baileys dan memproses event
    WhatsApp.
5.  `message-worker`: mengambil job dan menyerahkannya ke engine owner
    session.
6.  `webhook-worker`: mengirim outbox events ke endpoint tenant.
7.  `scheduler`: job terjadwal, lease expiry scan, retry/reconciliation.

Proses dapat digabung saat development, tetapi boundary modul harus
tetap jelas.

## 3. Session ownership

-   Setiap session hanya memiliki satu engine owner aktif.
-   Ownership dicatat melalui lease dengan expiry dan fencing token.
-   Engine heartbeat berkala.
-   Sebelum takeover, engine lama harus dihentikan/fenced dan auth state
    terakhir dipastikan tersimpan.
-   Fencing token harus diverifikasi sebelum operasi yang mengubah state
    persisten.
-   Jangan menjalankan dua koneksi aktif untuk auth state/session yang
    sama.

## 4. Engine pool

Engine mendaftarkan node ID, hostname, version, health, heartbeat,
resource metrics, dan kapasitas konfigurasi. Dispatcher memilih engine
berdasarkan health dan weighted capacity, bukan hanya jumlah session.
Jika tidak ada kapasitas, session masuk `PENDING_ASSIGNMENT`.

Satu engine dapat mengelola beberapa session. Batas session per engine
harus configurable dan ditetapkan dari load test, bukan angka asumsi.

## 5. Messaging

-   API memvalidasi request lalu menyimpan job.
-   API mengembalikan HTTP 202 dan job ID.
-   Dispatcher/worker mengambil job secara aman.
-   Fair scheduling mencegah satu tenant memonopoli kapasitas.
-   Setiap session memiliki serial outbound lane secara default.
-   Session berbeda dapat diproses bersamaan.
-   Hasil ambigu tidak boleh otomatis dikirim ulang tanpa rekonsiliasi.

## 6. Data stores

-   PostgreSQL: tenant, user, sessions registry, queue, messages
    metadata, audit, outbox, usage.
-   Private storage: Baileys auth state terenkripsi.
-   HDD/object storage: media dan backup sesuai kebijakan retensi.
-   Redis hanya ditambahkan saat bottleneck/scale-out memerlukannya.

## 7. Scale-out path

Tahap 1: single host, PostgreSQL queue, local private storage dengan
backup.

Tahap 2: pisahkan engine dan worker menjadi proses/host berbeda; gunakan
storage bersama yang aman dan message broker bila diperlukan.

Tahap 3: API replicas, distributed engine pool, Redis/BullMQ atau broker
setara, Socket.IO adapter, centralized secrets/storage/observability.

## 8. Reliability semantics

Tidak menjanjikan exactly-once WhatsApp delivery. Sistem menggunakan
durable jobs, idempotency untuk API submission, attempt records,
fencing, reconciliation, dan status `UNKNOWN` untuk hasil ambigu.
