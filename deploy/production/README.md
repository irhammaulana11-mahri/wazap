# Produksi WAZAP: wazap.bolinggo.org (dashboard) dan api-wazap.bolinggo.org (API)

Tanpa rahasia di folder ini. Rahasia dibuat di server, `/var/lib/wazap/env/` (0600, di luar repo). Keputusan: ADR-050. Kesiapan dan syarat sebelum tenant sungguhan:
`docs/07_DEPLOYMENT/PRODUCTION_READINESS.md` (BACA DULU, bagian "Gerbang").

## Rancangan
-   `wazap.bolinggo.org`: berkas statis dashboard + `/api` dan Socket.IO diproksikan di host yang sama (satu origin: cookie refresh `SameSite=Strict`, tanpa CORS, frontend tidak perlu diubah).
-   `api-wazap.bolinggo.org`: API yang sama untuk integrasi (API key, Socket.IO). `CORS_ORIGINS` sengaja kosong: peramban dari origin lain tidak dapat memakai kredensial ke sini.
-   Satu sertifikat Let's Encrypt untuk kedua nama. API dan worker hanya di `127.0.0.1` (API :3000, health worker :8101). PostgreSQL tidak boleh publik.

| Berkas | Fungsi |
|---|---|
| `bin/make-env.sh` | membuat `api.env` dan `worker.env` (JWT dan kunci master BARU, DB dari berkas sumber); tidak menimpa |
| `bin/run.sh`, `ecosystem.config.cjs` | peluncur PM2 (`wazap-api`, `wazap-engine`); satu instans, bukan cluster |
| `nginx/*.tpl`, `bin/render-nginx.sh` | vhost dua host + penampung 443 (templat; tidak diedit tangan di /etc); `CATCHALL_443=0` bila sudah ada default_server di 443 |
| `bin/install-nginx.sh` | pasang ke Nginx sistem (**sudo**), dua tahap `http` lalu `https`; `nginx -t` dan rollback otomatis |
| `bin/release.sh` | rilis tanpa sudo: cek cadangan -> build -> migrasi -> worker -> API -> frontend |
| `bin/verify.sh` | gerbang dari luar lewat domain sungguhan (`ORIGIN_IP`, `VERIFY_BEHIND_CDN` bila lewat Cloudflare) |
| `bin/preflight.sh` | pemeriksa read-only sebelum memasang di server yang sudah dipakai aplikasi lain |

## Data yang dibutuhkan (kumpulkan SEBELUM mulai)
Jalankan dulu pemeriksa read-only di server (tidak mengubah apa pun, tidak mencetak rahasia):
```bash
git clone <repo> /var/www/wazap   # atau cukup salin deploy/production/bin/preflight.sh
SERVER_IP=<ip-publik-server> deploy/production/bin/preflight.sh | tee preflight.txt
```
Tempel `preflight.txt` ke percakapan. Ulangi sampai tidak ada **GAGAL** (GitHub/jaringan sesekali gagal sesaat: ulangi). Lalu siapkan jawaban berikut. **JANGAN pernah menempel kata sandi, token, atau isi berkas env ke chat.**

| # | Data | Cara mengecek / dari mana | Dipakai untuk |
|---|---|---|---|
| 1 | IP publik server (IPv4, dan IPv6 bila ada) | dari panel penyedia/ISP, bukan dari `ip addr` bila di belakang NAT | rekaman DNS, perbandingan di preflight |
| 2 | **DNS lewat Cloudflare atau tidak?** (awan oranye / Tunnel / hanya DNS) | panel DNS; preflight mendeteksi; `dig +short wazap.bolinggo.org` (IP 104.x/172.64-71.x/2606:4700 = Cloudflare) | menentukan `CLOUDFLARE=1`, IP pengunjung, sertifikat; **saat ini DNS menunjuk ke Cloudflare** |
| 3 | Siapa yang memegang port 80/443 (Nginx/Apache/Docker/Traefik) | preflight bagian 5 dan 6 | README mengasumsikan Nginx; selain itu vhost disesuaikan |
| 4 | Versi Nginx (butuh >= 1.25.1 untuk `http2 on;`) | `nginx -v`; preflight | sintaks vhost |
| 5 | Nama `server_name` lain yang sudah ada, termasuk `bolinggo.org` itu sendiri | preflight bagian 6 | menghindari bentrok vhost |
| 6 | Port 3000 dan 8101 bebas? Bila tidak, port pengganti | preflight bagian 5 | `API_PORT`, `WORKER_HEALTH_PORT` |
| 7 | Versi Node (>= 22) dan cara memasangnya untuk pengguna aplikasi | `node -v`; preflight | build dan jalan; jangan ubah Node sistem milik aplikasi lain |
| 8 | PostgreSQL: versi (diuji di 18, minimal teknis 14), lokasi (lokal/jauh), nama database yang diinginkan, apakah `max_connections` cukup | preflight bagian 7; `sudo -u postgres psql -c 'show max_connections'` | langkah 3, role, koneksi |
| 9 | Pengguna Linux pelaksana aplikasi (bukan root), dan apakah PM2 sudah dipakai pengguna itu untuk aplikasi lain | preflight bagian 1 dan 4 | `pm2 save` menyimpan SEMUA proses pengguna itu |
| 10 | Sertifikat: sudah ada certbot? sertifikat untuk bolinggo.org yang sudah ada? surel untuk pemberitahuan Let's Encrypt | `certbot certificates` (sudo) | langkah 5; surel Anda ketik sendiri saat certbot |
| 11 | Firewall di server dan di penyedia (security group): 80/443 terbuka dari internet; 5432/3000/8101 tertutup | `sudo ufw status`; panel penyedia; uji dari jaringan lain: `curl -I http://wazap.bolinggo.org` | ACME dan akses pengguna |
| 12 | Ruang cadangan dan tujuan salinan di luar host (rclone/rsync/objek storage) | `df -h /var/backups`; tentukan tujuan | gerbang 2 |
| 13 | Layanan heartbeat luar (mis. Healthchecks.io) dan bot Telegram untuk alarm operator | buat akun/bot sendiri; token ditulis langsung ke `monitor.env` | gerbang 5 |
| 14 | Kontak operator di luar jam kerja | keputusan Anda | siapa yang menerima PAGE |

Data yang TIDAK saya perlukan dan tidak boleh dikirim: kata sandi DB, `CREDENTIAL_ENCRYPTION_KEYS`, `JWT_SECRET`, token bot. Semuanya dibuat atau diketik langsung di server.

## Bila DNS lewat Cloudflare (kondisi saat ini)
Tanpa langkah ini semua pengunjung terlihat berasal dari satu IP (IP Cloudflare): throttling login, batas laju, dan audit per-IP menjadi salah.
1.  Pasang vhost dengan `CLOUDFLARE=1`: `sudo CLOUDFLARE=1 deploy/production/bin/install-nginx.sh https`. Skrip mengambil daftar IP resmi Cloudflare, lalu Nginx hanya mempercayai `CF-Connecting-IP` dari rentang itu (pemalsuan header dari sumber lain diabaikan; terbukti di uji). Jalankan ulang tiap beberapa bulan agar daftar IP segar.
2.  **Mode SSL Cloudflare: JANGAN diubah untuk seluruh zona.** Server ini menjalankan situs lain di zona yang sama (`bimbel.bolinggo.org`, `api-bimbel.bolinggo.org`) yang origin-nya hanya mendengarkan HTTP:80 (kemungkinan mode "Flexible"; konfirmasi di Cloudflare, SSL/TLS, Overview). Mengubah mode se-zona ke Full/Strict membuat situs-situs itu error 521/525. Gunakan **Configuration Rule per-hostname** (Rules, Configuration Rules): kondisi `Hostname equals wazap.bolinggo.org` atau `api-wazap.bolinggo.org`, aksi `SSL = Full (strict)`. Urutan aman:
    1.  Tahap http + certbot sambil mode zona tetap seperti sekarang (tantangan HTTP-01 sampai ke origin lewat :80). Bila Cloudflare memaksa "Always Use HTTPS" dan tantangan gagal, matikan sementara untuk dua hostname itu lewat rule yang sama, atau pakai Cloudflare Origin Certificate (SSL/TLS, Origin Server) dan arahkan `CERT_DIR` ke berkasnya.
    2.  Pasang vhost https (`CLOUDFLARE=1`), lalu uji LANGSUNG ke origin: `ORIGIN_IP=<ip> deploy/production/bin/verify.sh`.
    3.  BARU buat Configuration Rule Full (strict) untuk dua hostname itu, lalu uji lewat Cloudflare dengan `VERIFY_BEHIND_CDN=1`.
    Penampung 443 (`ssl_reject_handshake`) membuat nama host lain yang kelak masuk ke 443 ditolak, bukan menampilkan dashboard WAZAP. Port 443 harus dibuka di firewall server (dan hanya dari rentang Cloudflare bila memungkinkan).
3.  Batas Cloudflare: 100 dtk per permintaan (ekspor yang sangat besar dapat berakhir 524; pecah rentang tanggal), unggahan maksimum 100 MB, WebSocket didukung (aktifkan di Network).
4.  Disarankan: firewall origin hanya menerima 80/443 dari rentang IP Cloudflare, agar origin tidak dapat dijangkau langsung.
5.  Verifikasi DUA kali: lewat Cloudflare `VERIFY_BEHIND_CDN=1 deploy/production/bin/verify.sh`, dan langsung ke origin `ORIGIN_IP=<ip-server> deploy/production/bin/verify.sh` (menguji TLS, header, dan sertifikat milik kita sendiri).
6.  **Cloudflare Tunnel** (bukan awan oranye ke IP publik) topologinya berbeda: port 80/443 publik tidak dibuka dan asal tunnel diarahkan ke Nginx lokal. Bila Anda memakai Tunnel, beri tahu saya sebelum lanjut agar templatnya disesuaikan.

## Urutan (sekali di server baru)
**0. Server.** Jalankan `preflight.sh` (bagian "Data yang dibutuhkan") sampai tanpa GAGAL. Ubuntu LTS, Node 22, PostgreSQL 18, Nginx, PM2, certbot, git; pengguna non-root khusus (mis. `wazap`) yang punya sudo hanya untuk langkah bertanda sudo. Firewall: izinkan 22, 80, 443 saja (`ufw default deny incoming`). PostgreSQL mendengarkan loopback.
**1. DNS.** Rekaman A (dan AAAA bila ada IPv6) untuk `wazap` dan `api-wazap` ke IP publik server. Periksa: `dig +short wazap.bolinggo.org api-wazap.bolinggo.org`. Port 80 dan 443 harus terjangkau dari internet (tantangan ACME memakai 80).
**2. Kode.** `git clone <repo> /var/www/wazap && cd /var/www/wazap && git checkout <tag-atau-commit-rilis>`. Rilis hanya dari commit yang lulus `ci-test.sh` (atau CI GitHub hijau).
**3. Database.** Buat database dan role `wazap_migrator` + `wazap_app` sesuai `docs/07_DEPLOYMENT/DB_ROLES.md`; verifikasi `backend/scripts/verify-db-roles.sh`. Tulis kredensialnya ke berkas sementara 0600 (mis. `/tmp/wazap-db.env`, 8 variabel `DB_*`).
**4. Env dan kunci master.**
```bash
DB_ENV_SOURCE=/tmp/wazap-db.env deploy/production/bin/make-env.sh
shred -u /tmp/wazap-db.env
```
**SEKARANG** simpan `CREDENTIAL_ENCRYPTION_KEYS` (dari `/var/lib/wazap/env/api.env`) ke password manager + salinan offline, dan catat sidik jari yang dicetak. Kunci hilang = semua sesi WhatsApp harus dipair ulang; ini tidak bisa dipulihkan dari cadangan DB.
**5. Nginx tahap HTTP, lalu sertifikat.**
```bash
sudo deploy/production/bin/install-nginx.sh http
sudo certbot certonly --webroot -w /var/www/certbot -d wazap.bolinggo.org -d api-wazap.bolinggo.org
sudo certbot renew --dry-run
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx >/dev/null && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo deploy/production/bin/install-nginx.sh https        # HSTS 300 dtk dulu. Lewat Cloudflare: sudo CLOUDFLARE=1 ... (lihat bagian Cloudflare)
```
**6. Rilis pertama** (DB kosong; belum ada cadangan, PM2 belum punya proses):
```bash
SKIP_BACKUP_CHECK=1 deploy/production/bin/release.sh
pm2 save && pm2 startup    # jalankan perintah sudo yang dicetak pm2 agar proses hidup lagi setelah reboot
```
**7. Verifikasi.** Dari mesin LAIN: `deploy/production/bin/verify.sh`. Di server: `VERIFY_LOCAL=1 VERIFY_AUTH=1 deploy/production/bin/verify.sh` (membuat satu akun uji; hapus lewat dashboard). Harus "SEMUA LULUS". `VERIFY_THROTTLE=1` mengunci IP penguji sementara: jalankan dari IP yang bukan IP admin. Setelah lulus dan Anda yakin domain stabil, naikkan HSTS: `HSTS_MAX_AGE=31536000 sudo -E deploy/production/bin/install-nginx.sh https`.
**8. Cadangan (WAJIB sebelum tenant sungguhan).** `deploy/ops/setup-backup-role.sql`, jalankan `deploy/ops/backup.sh` sekali, jadwalkan harian (cron), salin ke tempat LAIN di luar host (rclone/rsync/objek storage), lalu `deploy/ops/restore-drill.sh` pada cadangan nyata. Detail: `docs/07_DEPLOYMENT/BACKUP_RESTORE.md`.
**9. Pemantau.** `~/.config/wazap-monitor/monitor.env` (0600): `MON_API_URL=http://127.0.0.1:3000`, `MON_WORKER_URL=http://127.0.0.1:8101`, `MON_PM2_API=wazap-api`, `MON_PM2_WORKER=wazap-engine`, `MON_BACKUP_DIR=/var/backups/wazap`, `MON_TLS_HOST=wazap.bolinggo.org:443`, `MON_DISK_PATHS="/ /var/lib/postgresql"`, token Telegram, dan `MON_HEARTBEAT_URL` (layanan luar, mis. Healthchecks.io). Cron tiap menit `deploy/ops/monitor-check.sh`. Ulangi uji kegagalan di `MONITORING_ALERTING.md` bagian 11 pada server ini.
**10. Uji nyata.** Pairing WhatsApp sungguhan, kirim dan terima pesan, webhook ke penerima nyata, kanal alarm Telegram, ekspor kecil.

## Rilis berikutnya
`git fetch && git checkout <tag>` lalu `deploy/production/bin/release.sh` (menolak bila cadangan lebih tua dari 2 jam; jalankan `deploy/ops/backup.sh` dulu). Migrasi tidak dapat dibatalkan (immutable): rollback kode = checkout tag lama + `release.sh` (migrasi harus kompatibel mundur) atau pulihkan cadangan (`RECOVERY_SOP.md`).

## Catatan
-   Perubahan konfigurasi Nginx: ubah templat di repo, render ulang lewat `install-nginx.sh https`; jangan edit `/etc/nginx/sites-available/wazap` langsung.
-   `bolinggo.org` mungkin memuat layanan lain: HSTS sengaja tanpa `includeSubDomains`/`preload`.
-   Batas laju aplikasi in-memory per proses: jangan jalankan lebih dari satu instans API.
