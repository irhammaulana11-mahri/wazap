# Runbook operasional produksi

> **STATUS (2026-11-20):** disusun dari perilaku yang terbukti di staging (uji ketahanan, uji WhatsApp sungguhan, uji lama, latihan rotasi kunci dan cadangan). Perintah, kode galat, dan teks log di sini diperiksa otomatis (`test/runbook-docs.test.ts`).
> **Belum terbukti:** semua ini di server produksi nyata; ambang alarm final (menunggu uji lama dan rancangan pemantauan); latihan pemulihan penuh pada data produksi (lihat BACKUP_RESTORE.md).

## 0. Yang harus diisi tim sebelum produksi (tidak dapat saya ketahui)
Kontak on-call dan eskalasi, lokasi salinan cadangan (host/lokasi berbeda), domain dan penyedia sertifikat, siapa pemegang kunci master dan salinan offlinenya, ambang alarm final, kebijakan RPO/RTO yang disetujui bisnis.

## 1. Peta sistem

| Komponen | Proses | Health | Catatan |
|---|---|---|---|
| API | `wazap-api` (PM2, `dist/server.js`), `127.0.0.1:$PORT` di belakang Nginx TLS | `GET /health/live` (selalu 200), `GET /health/ready` (503 bila DB mati/sedang shutdown) | **satu instans** (batas laju di memori) |
| Worker (engine WhatsApp, control-plane, webhook, retensi) | `wazap-engine-NN` (PM2, `dist/worker.js`) | `127.0.0.1:$WORKER_HEALTH_PORT/health/ready` (loopback saja) | satu proses per `ENGINE_NODE_NAME` (kunci singleton) |
| Database | PostgreSQL, schema `gateway`, role terpisah migrator/aplikasi | `pg_isready` | RLS `ENABLE`+`FORCE` pada semua tabel |
| Tepi | Nginx TLS | `nginx -t` | X-Forwarded-For HARUS ditimpa; API hanya di loopback |

Log: `pm2 logs <nama>` (JSON pino: `level` 30 info, 40 warn, 50 error, 60 fatal; `reqId`, `proc`). Rahasia tidak pernah dicatat (kredensial, header otorisasi, cookie disamarkan).

## 2. Rutinitas
-   **Harian:** `pm2 list` (tidak ada restart tak terduga), cadangan terakhir sukses (exit 0, berkas baru, checksum), `GET /health/ready` API dan worker, jumlah sesi `CONNECTED` sesuai harapan, tidak ada lonjakan `DEAD` webhook.
-   **Mingguan:** ukuran tabel besar (`session_auth_state`, `message_queue`, `wa_messages`, `outbox_events`, `webhook_deliveries`, `audit_logs`) dan pertumbuhan disk/WAL; sisa masa berlaku sertifikat; log galat level 50+.
-   **Bulanan:** **latihan pemulihan** (BACKUP_RESTORE.md); tinjau Dependabot dan `npm audit`; tinjau pengguna dengan peran OWNER dan API key yang tidak dipakai.
-   **Tahunan / saat dicurigai bocor:** rotasi kunci master (bagian 6) dan `JWT_SECRET`.

## 3. Deploy dan rollback
Urutan (tidak boleh diubah): `git pull` → `npm ci` → `npm run build` → `npm run migrate:prod` (role migrator) → `pm2 restart` worker → `pm2 restart` API → `deploy/staging/bin/verify.sh`-setara (health, login, WebSocket) → pantau 10 menit.
-   Restart worker memutus sesi WhatsApp sekitar 10-15 detik lalu **kembali sendiri tanpa QR** (terbukti 11 dtk); lakukan di jam sepi. `kill_timeout` PM2 harus lebih besar dari `SHUTDOWN_TIMEOUT_MS` (15000).
-   Worker menolak start bila schema belum dimigrasi (jangan mulai worker sebelum `migrate:prod`).
-   **Rollback kode** hanya aman bila migrasi yang baru diterapkan bersifat aditif. Migrasi terapan tidak boleh diubah (CI menolaknya); perubahan destruktif dilakukan dua rilis (tambah, lalu hapus setelah kode lama tidak ada). Rollback skema = migrasi BARU yang membalik, bukan menyunting yang lama.
-   Jangan: `AUTO_MIGRATE=true` di produksi, mode cluster PM2 untuk API, dua worker bernama sama, menjalankan `verify.sh` dari IP yang sama dengan pengguna (menghabiskan kuota login; staging memakai `127.0.0.2`).

## 4. Indikator kesehatan (baseline terukur di staging, satu sesi)
| Indikator | Normal | Perhatikan |
|---|---|---|
| Sisa lease (`session_leases.lease_expires_at`) | 20-29 dtk (TTL 30, pembaruan tiap 10 dtk) | < 10 dtk berulang |
| Heartbeat engine (`engine_nodes.heartbeat_at`) | < 10 dtk | > 30 dtk |
| `session_leases.fencing_token` | stabil | naik tanpa restart/deploy = failover |
| RSS worker / API | ~127 MB / ~135 MB | tren naik terus (kebocoran) |
| Koneksi DB aplikasi | 5-6 (pool maks 10 per proses) | mendekati batas / `idle in transaction` |
Ambang alarm final ditetapkan setelah uji lama selesai dan rancangan pemantauan.

## 5. Playbook insiden
Format: gejala → cek → tindakan → verifikasi → jangan.

### P1. API menjawab 503 `SERVICE_UNAVAILABLE`
**Cek:** `pg_isready`; `GET /health/ready` (503 = DB tak terjangkau); log `DB_CONNECT_TIMEOUT_MS`/`ECONNREFUSED`. **Tindakan:** pulihkan PostgreSQL (disk penuh? `max_connections`? jaringan?). Proses API dan worker **tetap hidup** dan pulih sendiri (koneksi disambung ulang, leader control-plane memilih ulang, realtime mengirim `realtime.resync`). Klien mengulang dengan backoff (`Retry-After: 2`; pengiriman dengan `Idempotency-Key` sama). **Verifikasi:** `/health/ready` 200, sesi `CONNECTED`, antrean berjalan. **Jangan:** me-restart API/worker karena DB mati (tidak perlu, dan memutus sesi); mematikan proses karena `/health/ready` 503.

### P2. Worker crash loop (PM2 restart berulang, exit 1)
Baca log terakhir: 
-   `Schema "gateway" belum dimigrasi (tabel hilang: ...)` → jalankan `npm run migrate:prod`.
-   `Menolak start: role DB tidak aman (DB_ROLE_CHECK=enforce)` → role runtime superuser/`BYPASSRLS`/pemilik schema; pakai `wazap_app` (DB_ROLES.md), jalankan `backend/scripts/verify-db-roles.sh`.
-   `Engine "<nama>" sudah berjalan di proses lain` → dua proses `ENGINE_NODE_NAME` sama; `pm2 list`/`ps` cari yang kedua, beri nama unik. Jangan menghapus kunci advisory manual.
-   `engine: kunci singleton hilang dan tidak dapat direbut kembali` → koneksi DB terputus lama atau proses kedua merebut; worker berhenti rapi (kode 1) agar tidak ada dua pemilik; periksa DB lalu biarkan PM2 memulai ulang.
-   `WORKER_ROLES` salah / `CREDENTIAL_ENCRYPTION_KEYS belum diset` → perbaiki env.
**Jangan** menaikkan `max_restarts` untuk "menyembuhkan" loop; baca penyebabnya. Pasang alarm pada exit 1 berulang.

### P3. Sesi `LOGGED_OUT`
Dicabut dari ponsel (Perangkat tertaut → Keluar) atau oleh WhatsApp. Sistem: `status=LOGGED_OUT`, `desired_state=DISCONNECTED`, kredensial dan auth state **dihapus**, riwayat utuh, tidak ada reconnect berulang. **Tindakan:** pemilik menekan Hubungkan di dashboard dan memindai QR baru. **Jangan** mencoba memulihkan dari cadangan (sesi sudah dicabut di sisi WhatsApp). Lonjakan `LOGGED_OUT` banyak sesi sekaligus = kemungkinan pembatasan oleh WhatsApp: hentikan pengiriman massal, kurangi laju.

### P4. Sesi tidak kembali `CONNECTED` setelah restart/deploy
**Cek:** `GET /sessions/:id/events` (urutan status), `session_leases` (engine pemilik, kedaluwarsa), log worker (`gagal menempatkan sesi`, `gagal memulihkan sesi dengan lease kedaluwarsa`, `auth_state_unavailable`). **Penyebab umum:** control-plane belum menjadi leader (tunggu satu putaran, ~5 dtk), kapasitas engine penuh (`ENGINE_MAX_SESSIONS`), kunci master tidak sama (auth state tidak terbaca → pair ulang), nomor sudah dipakai sesi lain (`duplicate_phone_number`). **Tindakan:** tunggu 1-2 menit; bila `ERROR`, `POST /sessions/:id/reconnect`.

### P5. Dugaan dua pemilik satu sesi / failover tak terduga
Tanda: `fencing_token` naik tanpa deploy, sesi bolak-balik, pesan ganda. Fencing mencegah penulisan persisten oleh pemilik lama, tetapi bukan soket. **Cek:** `engine_nodes` (dua node HEALTHY), `ENGINE_NODE_NAME` ganda, jam server (NTP), jeda DB panjang (lease habis). **Tindakan:** hentikan engine yang tidak seharusnya; pastikan nama node unik; periksa NTP; biarkan lease lama kedaluwarsa (30 dtk). Verifikasi satu `engine_id` memegang sesi.

### P6. Pesan `UNKNOWN` atau `RECONCILIATION_REQUIRED`
Artinya hasil kirim tidak pasti (proses mati saat mengirim). Sistem **tidak** mengirim ulang otomatis (mencegah pesan ganda). **Tindakan:** periksa di ponsel/riwayat chat apakah pesan sampai; bila belum, kirim ulang lewat `POST /messages/:id/retry` dengan `confirm_duplicate_risk: true` (operator menerima risiko ganda). **Jangan** menulis massal status di DB.

### P7. Webhook gagal terus / endpoint dinonaktifkan otomatis
`active=false` dengan `disabled_reason=AUTO_CONSECUTIVE_FAILURES` setelah `WEBHOOK_AUTO_DISABLE_AFTER` (10) pengiriman `DEAD` berturut-turut; percobaan ulang eksponensial hingga `WEBHOOK_MAX_ATTEMPTS` (8). **Tindakan:** perbaiki penerima, `PATCH /webhooks/:id {active:true}`, lalu replay yang `DEAD` (`POST /webhooks/:id/deliveries/:deliveryId/replay`; `event_id` tetap sama, penerima wajib idempoten dan tidak bergantung pada urutan). Penerima dengan alamat privat/redirect ditolak oleh kebijakan SSRF (bukan bug).

### P8. Pengguna melihat "Terlalu banyak percobaan" (429)
Batas per proses API (di memori): login 20 per 5 menit per IP dan 8 per 15 menit per email, register 5 per jam per IP, reset kata sandi 10 per jam per IP, API umum 600 per menit per IP dan 1.200 per menit per tenant. **Cek:** log Nginx `429` per jalur dan IP. **Penyebab umum:** `TRUST_PROXY` belum diset (semua pengguna dianggap satu IP), skrip uji dari IP yang sama, penyerangan. **Tindakan:** tunggu jendela habis (otomatis); darurat: `pm2 restart` API mereset penghitung (satu-satunya cara; berdampak pada semua pengguna, sesi WhatsApp tidak terganggu). **Jangan** menaikkan batas tanpa memahami penyebabnya.

### P9. Pengguna kehilangan kata sandi dan semua kode pemulihan
`RECOVERY_SOP.md` (`npm run admin:recovery-code -- --email <email>`). Verifikasi identitas pemohon di luar sistem terlebih dahulu.

### P10. Kunci master `CREDENTIAL_ENCRYPTION_KEYS` hilang atau bocor
-   **Hilang** (semua salinan): auth state tidak terbaca; semua sesi harus dipair ulang; rahasia webhook tidak terbaca (rotasi lewat `POST /webhooks/:id/rotate-secret` dan beri tahu penerima). Data pesan/tenant tidak hilang.
-   **Bocor (atau cadangan DB bocor bersama kuncinya):** anggap auth state terbuka. Buat kunci baru, tambahkan sebagai versi baru, rotasi (bagian 6) lalu pensiunkan kunci lama, dan **cabut perangkat tertaut dari ponsel / pair ulang** (kunci Signal yang bocor dapat membajak sesi walau database dirotasi).

### P11. `JWT_SECRET` bocor
Ganti nilainya dan restart API dan worker: semua access token lama (masa berlaku 15 menit) tidak valid; refresh token acak di database tidak terpengaruh sehingga klien menukar token lagi tanpa login ulang. Untuk mencabut pengguna tertentu seketika: ganti kata sandinya/`logout-all` (menaikkan `token_version`).

### P12. Disk penuh atau tabel membengkak
**Cek:** `df -h`, ukuran WAL, `pg_total_relation_size` tabel besar. **Tindakan:** bebaskan ruang (arsip WAL, cadangan lama); retensi berjalan tiap `RETENTION_INTERVAL_MINUTES` (60) dengan default konten 30 hari, baris 180, outbox 7, delivery webhook 30, audit 365, tenant terhapus 30, permintaan bergabung 90 (semua dapat diubah lewat env `RETENTION_*`). Disk penuh membuat DB menolak tulis: ikuti P1. **Jangan** menghapus baris tabel manual (RLS dan integritas).

### P13. Sertifikat TLS hampir/sudah kedaluwarsa
Cek: `echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | openssl x509 -noout -enddate`. Perbarui (`certbot renew`), `nginx -t`, `nginx -s reload`. Pasang pemeriksaan kedaluwarsa (alarm 21 hari). Sertifikat staging self-signed berlaku 365 hari sejak dibuat.

### P14. Cadangan gagal atau rusak
`backup.sh` keluar kode 1 dengan penyebab di log (role tanpa BYPASSRLS, `pg_dump` gagal, tabel tanpa entri data). Perbaiki dan jalankan ulang segera; jangan menunggu jadwal berikutnya. Cadangan yang checksumnya tidak cocok dibuang. Lakukan latihan pemulihan (BACKUP_RESTORE.md) setelah memperbaiki.

### P15. Ekspor data: lonjakan, penyalahgunaan, atau keluhan "ekspor ditolak"
**Cek:** audit `data.exported` per workspace (`GET /audit-logs` oleh OWNER, atau DB; `details.rows`, `bytes`, `outcome`, `ip`); beban API (`pm2`, `/health/ready`). **Penolakan wajar:** `422 EXPORT_TOO_LARGE` (persempit rentang; batas `EXPORT_MAX_ROWS`/`EXPORT_MAX_SPAN_DAYS`), `409 EXPORT_IN_PROGRESS` (satu ekspor per workspace), `429 RATE_LIMITED` (jatah `EXPORT_PER_USER_PER_HOUR`, atau `EXPORT_MAX_CONCURRENT` per proses), `403 INVALID_PASSWORD` (5 salah per 15 menit mengunci).
**Dugaan penyalahgunaan (sesi pengguna dibajak):** hentikan SEMUA ekspor seketika dengan `EXPORT_ENABLED=false` lalu `pm2 restart` API (ekspor menjawab 503 `NOT_CONFIGURED`; fitur lain tidak terganggu); cabut sesi pengguna (`logout-all` / ganti kata sandi, menaikkan `token_version`); tinjau audit `data.exported` untuk data yang sudah keluar. Aktifkan kembali setelah akun diamankan.
**Beban:** ekspor berjalan di proses API (satu instans) dengan batch pendek; bila API melambat saat ekspor besar, turunkan `EXPORT_MAX_CONCURRENT`/`EXPORT_MAX_ROWS`. **Jangan** menaikkan batas tanpa mengukur ulang (`test/perf/export.perf.ts`).

### P16. Notifikasi alarm workspace: pelanggan tidak menerima, atau banjir
**Cek:** `GET /alerts/deliveries` oleh OWNER (atau tabel `alert_deliveries`): `status` dan `last_error_code`. `HTTP_401/403/404` = token bot dicabut atau chat hilang (pelanggan perbarui target); `RATE_CAPPED` = melewati `ALERTS_MAX_PER_CHANNEL_PER_HOUR`; `CHANNEL_INACTIVE` = kanal dinonaktifkan (otomatis setelah `ALERTS_AUTO_DISABLE_AFTER` kegagalan beruntun; audit `alert_channel.disabled`); `DNS_FAILED`/`TIMEOUT`/`TLS_ERROR`/`CONNECTION_FAILED` = masalah jaringan ke Telegram/Slack (bukan penolakan kredensial; UI lama menyebutnya "server menolak"). Tiap percobaan gagal dicatat di log worker sebagai `pengiriman alarm gagal` (deliveryId, kanal, aturan, percobaan, hasil, errorCode; tanpa token/target), jadi kegagalan sesaat yang berhasil pada percobaan ulang tetap terlihat. Sambungan jauh (RTT > 250 ms, mis. Telegram dari Indonesia) dulu gagal acak karena batas "happy eyeballs" Node 250 ms per alamat lalu jatuh ke IPv6 yang tidak terjangkau; `postJson` kini memakai `autoSelectFamilyAttemptTimeout` 1-5 dtk. Tidak ada baris sama sekali: periksa aturan aktif, kanal aktif, `ALERTS_ENABLED`, dan bahwa worker (peran webhook) hidup (poller `alert-evaluator`); kejadian saat worker mati lebih lama dari `ALERTS_LOOKBACK_MINUTES` tidak dikirim.
**Banjir:** matikan semua dengan `ALERTS_ENABLED=false` lalu `pm2 restart` API dan worker (konfigurasi tetap); periksa aturan berulang (`cooldown_minutes`) dan kanal yang diminta menurunkan ambang. **Jangan** menghapus baris `alert_deliveries` untuk "menghentikan" kiriman (idempotensi bergantung padanya); nonaktifkan kanal atau aturan.

### P17. URL publik tidak terjangkau (alarm A27), tetapi API lokal sehat
**Artinya:** jalur Cloudflare, tunnel, Nginx bermasalah; API dan worker tidak. **Cek urut:** `systemctl status cloudflared` (mati? `sudo systemctl restart cloudflared`; log: `journalctl -u cloudflared -n 50`); Cloudflare Zero Trust, Tunnels: status tunnel (Healthy/Down) dan Public Hostname masih menunjuk `http://localhost:80`; `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: wazap.bolinggo.org' http://127.0.0.1/health/live` (harus 200; bukan 200 berarti Nginx atau vhost: `sudo nginx -t`, `systemctl status nginx`); 403 dari perintah itu hanya bila bukan dari loopback. **IP pengunjung semua 127.0.0.1** di `/var/log/nginx/wazap-access.log` berarti cloudflared tidak meneruskan `CF-Connecting-IP` (throttling per-IP jadi bersama): periksa versi cloudflared dan konfigurasi tunnel. Jangan membuka akses langsung ke API (port 3000) sebagai jalan pintas.

## 6. Prosedur rotasi kunci master (terbukti dengan CLI sungguhan, `test/rotate-cli.test.ts`)
1.  Buat kunci baru: `openssl rand -base64 32`; tambahkan sebagai versi baru **tanpa menghapus yang lama**: `CREDENTIAL_ENCRYPTION_KEYS="1:<lama>,2:<baru>"`, `CREDENTIAL_ACTIVE_KEY_VERSION=2`. Cadangkan nilai itu ke password manager + salinan offline SEBELUM melanjutkan.
2.  Restart SEMUA proses (API dan setiap worker) agar semuanya menulis dengan versi 2.
3.  `cd backend && npm run keys:rotate -- --dry-run` (tidak mengubah; laporan `rotated`/`failed`; `failed` harus 0).
4.  `npm run keys:rotate` (nyata). Keluar 0 dan `retireReady: true` = semua baris sudah versi aktif. Keluar **2** = ada baris gagal didekripsi atau kunci lama belum aman dipensiunkan: JANGAN hapus kunci lama.
5.  Hanya bila `retireReady: true`: hapus versi lama dari env dan restart. Verifikasi: `npm run keys:rotate -- --dry-run` dengan kunci baru saja harus `failed: 0`, `rotated: 0`.
6.  Rotasi webhook secret tidak perlu (ikut dirotasi CLI); penerima tidak terpengaruh.
Terbukti: dry-run tidak mengubah apa pun; pensiun dini keluar 2 tanpa membocorkan rahasia atau kunci; konfigurasi salah keluar 1 dengan pesan jelas; idempoten.

### P18. Platform admin: daftar, MFA hilang, atau terkunci (ADR-054)
**Daftar admin pertama** (di server, terminal pribadi; pengguna harus SUDAH terdaftar lewat dashboard): `cd /var/www/wazap/backend && ( set -a; . /var/lib/wazap/env/api.env; set +a; node dist/runtime/platform-admin-cli.js create --email pemilik@contoh.id )` (subshell: memuat `api.env` ke shell interaktif mengekspor `NODE_ENV=production` dan merusak `npm ci` berikutnya; `node dist/...` tidak membutuhkan `tsx`/paket dev di server; `npm run admin:platform-admin` hanya untuk mesin pengembangan). Kunci setup TOTP dan 10 kode pemulihan dicetak SEKALI: masukkan ke aplikasi autentikator dan password manager, jangan dialihkan ke berkas atau ditempel ke chat. **MFA hilang atau kode pemulihan habis:** `... -- reset-mfa --email ...` (kode lama hangus). **Akun terkunci** (kesalahan beruntun): tunggu `PLATFORM_LOCK_MINUTES`, atau `reset-mfa`. **Cabut hak:** `... -- revoke --email ...`. **Daftar:** `... -- list`. **Matikan seluruh konsol segera:** `PLATFORM_ENABLED=false` di `api.env` lalu `pm2 restart wazap-api` (semua `/platform/*` menjadi 404; data tidak berubah). Setiap pembuatan, reset, pencabutan, login, dan kegagalan tercatat di `platform_audit_logs`.

### P19. Tangguhkan atau aktifkan workspace (platform admin, ADR-054)

Lewat konsol platform (`POST /platform/workspaces/:id/suspend` dan `/activate`, kode TOTP segar dan alasan wajib). **Efek tangguhkan:** akses HTTP, API key, refresh, dan realtime berhenti (realtime paling lama `REALTIME_REVALIDATE_SECONDS`, bawaan 30 dtk); sesi WhatsApp diputus lewat jalur putus biasa dan kredensialnya utuh; pengiriman webhook dan alarm ditahan (tidak dibuang); data tidak berubah. **Efek aktifkan:** akses pulih seketika; sesi yang tadinya berniat tersambung tersambung lagi otomatis tanpa scan QR (sesi yang sengaja diputus pengguna, `LOGGED_OUT`, atau `CREATED` tidak ikut). **Pemeriksaan:** `GET /platform/workspaces/:id` (status, `suspended_at`, pemakaian), `GET /platform/audit?tenant_id=...`; di DB sesi berstatus `DISCONNECTED` dengan `status_reason='tenant_suspended'` saat ditangguhkan dan `PENDING_ASSIGNMENT`/`CONNECTED` dengan `tenant_reactivated` setelah diaktifkan. **Bila sesi tidak menyambung kembali:** periksa `wa_sessions.resume_connect` (harus `false` setelah aktivasi), engine hidup (`/health/ready` worker), dan kapasitas engine (`noCapacity`). **Jangan** mengubah `tenants.status` langsung lewat SQL: jejak audit platform dan penandaan `resume_connect` dilewati. Penangguhan bukan penghapusan: untuk menghapus data tetap lewat jalur hapus workspace oleh OWNER.
