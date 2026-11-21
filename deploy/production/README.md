# Produksi WAZAP: wazap.bolinggo.org (dashboard) dan api-wazap.bolinggo.org (API)

Tanpa rahasia di folder ini. Rahasia dibuat di server, `/var/lib/wazap/env/` (0600, di luar repo). Keputusan: ADR-050. Kesiapan dan syarat sebelum tenant sungguhan:
`docs/07_DEPLOYMENT/PRODUCTION_READINESS.md` (BACA DULU, bagian "Gerbang").

## Rancangan
-   `wazap.bolinggo.org`: berkas statis dashboard + `/api` dan Socket.IO diproksikan di host yang sama (satu origin: cookie refresh `SameSite=Strict`, tanpa CORS, frontend tidak perlu diubah).
-   `api-wazap.bolinggo.org`: API yang sama untuk integrasi (API key, Socket.IO). `CORS_ORIGINS` sengaja kosong: peramban dari origin lain tidak dapat memakai kredensial ke sini.
-   Satu sertifikat Let's Encrypt untuk kedua nama. API dan worker hanya di `127.0.0.1` (API :3000, health worker :8101). PostgreSQL tidak boleh publik.

| Berkas | Fungsi |
|---|---|
| `bin/db-setup.sh` | membuat database dan role (migrator/app) dengan kata sandi acak; menolak bila sudah ada |
| `bin/backup-setup.sh`, `bin/backup-run.sh` | role cadangan terbatas ke schema WAZAP (aman di server bersama), cadangan harian + salinan luar host + alarm Telegram |
| `bin/monitor-setup.sh` | pasang pemantau + alarm Telegram tanpa sudo: token lewat input tersembunyi, `monitor.env` 0600, pesan uji, cron tiap menit (idempoten, tidak menimpa) |
| `bin/make-env.sh` | membuat `api.env` dan `worker.env` (JWT dan kunci master BARU, DB dari berkas sumber); tidak menimpa |
| `bin/run.sh`, `ecosystem.config.cjs` | peluncur PM2 (`wazap-api`, `wazap-engine`); satu instans, bukan cluster |
| `nginx/*.tpl`, `bin/render-nginx.sh` | vhost dua host + penampung 443 (templat; tidak diedit tangan di /etc); `CATCHALL_443=0` bila sudah ada default_server di 443 |
| `bin/install-nginx.sh` | pasang ke Nginx sistem (**sudo**), dua tahap `http` lalu `https`; `nginx -t` dan rollback otomatis |
| `bin/release.sh` | rilis tanpa sudo: cek cadangan -> build -> migrasi -> worker -> API -> frontend |
| `bin/test-tunnel-vhost.sh` | uji perilaku vhost tunnel dengan Nginx sungguhan (berdampingan dengan situs lain, kontrol negatif); dipakai CI |
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

## Bila DNS lewat Cloudflare dengan proxy ke IP publik (BUKAN Tunnel)
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

## Jalur untuk server ini: Cloudflare TUNNEL (DIPILIH, berdasarkan preflight dan `cloudflared` aktif)
Lalu lintas: pengunjung, Cloudflare (TLS berakhir di sana), tunnel keluar, `cloudflared` di server, `http://127.0.0.1:80` (Nginx), API `127.0.0.1:3000`. Konsekuensinya: **tanpa port 443, tanpa sertifikat/certbot, dan mode SSL Cloudflare (Flexible/Full) tidak berlaku**; situs lain di zona yang sama tidak tersentuh. Lewati langkah 5 di "Urutan" dan ikuti ini.
**Alamat listen vhost WAJIB sama dengan situs lain di tunnel.** Server ini memakai `listen 127.0.0.1:80` (bimbel), jadi vhost kita bawaannya `listen 127.0.0.1:80` (`TUNNEL_LISTEN`). Nginx mencocokkan alamat:port dulu baru `server_name`: vhost wildcard (`listen 80`) di samping situs `127.0.0.1:80` TIDAK PERNAH dijangkau dan permintaan WAZAP dijawab situs lain (terbukti dengan Nginx sungguhan; `bin/test-tunnel-vhost.sh` menjadikannya uji permanen dengan kontrol negatif). Hanya bila SEMUA situs lain wildcard, pasang dengan `TUNNEL_LISTEN=80`. `preflight.sh` mendeteksi polanya.
Pengaman bawaan:
-   Dengan `listen 127.0.0.1:80`, permintaan dari internet ke IP server tidak sampai ke vhost kita (Cloudflare tidak dapat dilewati); pemeriksaan alamat koneksi asli (403) adalah lapis kedua.
-   IP pengunjung dibaca dari `CF-Connecting-IP` hanya bila koneksi dari loopback, sehingga throttling login, batas laju, dan audit memakai IP pengunjung. Tanpa header itu semua pengunjung terlihat `127.0.0.1` (diperiksa `verify.sh` lewat log akses).

**Aturan yang wajib diikuti (semua pernah menimbulkan masalah nyata di server pertama):**
1.  **Jangan memakai `sudo` untuk `npm`, `release.sh`, `make-env.sh`, atau `pm2`.** Hanya langkah yang ditandai `sudo` di panduan ini. `release.sh` dengan sudo membuat proses WAZAP hidup di PM2 milik **root** (API berjalan sebagai root, `pm2 status` pengguna biasa tidak memuatnya, dan alarm "proses hilang" menyala), serta membuat `node_modules`, `dist`, `api.env`, dan berkas frontend milik root sehingga rilis berikutnya gagal dengan izin. Bila sudah terlanjur: `sudo pm2 delete wazap-api wazap-engine && sudo pm2 save --force`, `sudo chown -R $(id -un):$(id -gn) /var/www/wazap /var/www/wazap-web /var/lib/wazap`, lalu `release.sh` tanpa sudo.
2.  **Siapkan folder dulu** (sebelum `make-env.sh`): `sudo install -d -o $(id -un) -g $(id -gn) /var/lib/wazap /var/backups/wazap /var/www/wazap-web`. Tanpa ini `make-env.sh` gagal `mkdir: Permission denied`.
3.  **Jangan memuat `api.env` ke shell interaktif** (`set -a; . api.env`): `NODE_ENV=production` ikut terekspor dan `npm ci` melewatkan paket dev (`tsc: not found`). Selalu di dalam subshell: `( set -a; . /var/lib/wazap/env/api.env; set +a; perintah )`. `release.sh` sudah memakai `npm ci --include=dev` sebagai pengaman, tetapi kebiasaan ini tetap berlaku.
4.  **Cek berkas kredensial DB** sebelum `make-env.sh`: `ls -l $HOME/wazap-db.env` harus milik Anda (bukan root). `db-setup.sh` meminta sudo hanya untuk `psql`; berkas hasilnya milik pengguna.
5.  **Lokasi cadangan di drive terpisah:** `release.sh` membaca `BACKUP_DIR` dari `~/.config/wazap-backup/backup.env`. Jalankan `backup-run.sh` (bukan `deploy/ops/backup.sh`) sebelum rilis berikutnya agar cek "cadangan segar maks 2 jam" lulus.
6.  **Jangan menghapus berkas sementara kredensial (`shred`) sebelum `make-env.sh` berhasil**, dan jangan menjalankan `db-setup.sh` kedua kali (menolak bila role sudah ada; kata sandi lama tidak dapat dibaca ulang).

**T1. Siapkan server** (tanpa publikasi): langkah 0 sampai 4 di "Urutan" (kode, DB, env, kunci master), lalu
```bash
sudo install -d -o $(id -un) -g $(id -gn) /var/www/wazap /var/lib/wazap /var/backups/wazap /var/www/wazap-web   # /var/www/wazap sudah ada (root): preflight menampilkan isinya; ambil alih hanya bila kosong
sudo deploy/production/bin/install-nginx.sh tunnel     # vhost :80 untuk dua nama; nginx -t dan rollback otomatis; situs lain tidak diubah
SKIP_BACKUP_CHECK=1 deploy/production/bin/release.sh
pm2 startup                                             # salin dan jalankan perintah sudo yang dicetak pm2 (hanya sekali per server); cek: systemctl is-enabled pm2-$(id -un)
pm2 save                                                # menyimpan SEMUA proses PM2 pengguna ini (juga aplikasi lain di server bersama)
VERIFY_LOCAL=1 VERIFY_TUNNEL=1 deploy/production/bin/verify.sh   # sisi origin: harus lulus SEBELUM dipublikasikan
```
**T2. Publikasikan lewat tunnel** (Cloudflare Zero Trust, Networks, Tunnels, pilih tunnel yang sudah ada). Cek dulu jenisnya:
-   **Dikelola dari dashboard** (ExecStart cloudflared memakai `--token`; JANGAN menempel token ke chat): tab *Public Hostname*, tambah `wazap.bolinggo.org` dan `api-wazap.bolinggo.org`, Service **HTTP** `127.0.0.1:80` untuk keduanya (alamat eksplisit, bukan `localhost`, agar tidak ambigu IPv4/IPv6). Bila nama itu sudah ada di daftar (preflight melihat DNS-nya sudah ada), ubah Service-nya, jangan buat ganda.
-   **Dikelola lokal** (`/etc/cloudflared/config.yml`): tambah dua aturan `ingress` SEBELUM aturan penutup `http_status:404`, masing-masing `service: http://127.0.0.1:80`, jalankan `cloudflared tunnel route dns <nama-tunnel> <hostname>` untuk tiap nama, lalu `sudo systemctl restart cloudflared`.
**T3. Pengaturan Cloudflare untuk dua hostname itu:** aktifkan *Always Use HTTPS* (rule per-hostname), *WebSockets* menyala (Network), dan buat notifikasi *Tunnel Health* (Notifications) ke surel Anda. Batas: 100 dtk per permintaan (ekspor sangat besar dapat 524), unggahan 100 MB.
**T4. Verifikasi** dari mesin LAIN dan di server:
```bash
VERIFY_BEHIND_CDN=1 deploy/production/bin/verify.sh                          # dari luar, lewat Cloudflare
VERIFY_BEHIND_CDN=1 VERIFY_LOCAL=1 VERIFY_TUNNEL=1 VERIFY_AUTH=1 deploy/production/bin/verify.sh   # di server (membuat 1 akun uji)
```
**T5. Pemantau (penting di mode tunnel):** `MON_PUBLIC_URL=https://wazap.bolinggo.org` di `monitor.env` mengaktifkan alarm A27. Tanpa itu, `cloudflared` mati membuat situs tak dapat dijangkau tetapi TIDAK ada alarm (A1 memeriksa lewat loopback). Kosongkan `MON_TLS_HOST` (sertifikat dikelola Cloudflare).

## Urutan (sekali di server baru)
**0. Server.** Jalankan `preflight.sh` (bagian "Data yang dibutuhkan") sampai tanpa GAGAL. Ubuntu LTS, Node 22, PostgreSQL 18, Nginx, PM2, certbot, git; pengguna non-root khusus (mis. `wazap`) yang punya sudo hanya untuk langkah bertanda sudo. Firewall: izinkan 22, 80, 443 saja (`ufw default deny incoming`). PostgreSQL mendengarkan loopback.
**1. DNS.** Rekaman A (dan AAAA bila ada IPv6) untuk `wazap` dan `api-wazap` ke IP publik server. Periksa: `dig +short wazap.bolinggo.org api-wazap.bolinggo.org`. Port 80 dan 443 harus terjangkau dari internet (tantangan ACME memakai 80).
**2. Kode.** `git clone <repo> /var/www/wazap && cd /var/www/wazap && git checkout <tag-atau-commit-rilis>`. Rilis hanya dari commit yang lulus `ci-test.sh` (atau CI GitHub hijau).
**3. Database** (skrip; digladi pada PostgreSQL 18 sementara: DB dan role dibuat, migrasi sebagai migrator, `verify-db-roles.sh` lulus penuh, API dan worker siap dengan `DB_ROLE_CHECK=enforce`):
```bash
DRY_RUN=1 deploy/production/bin/db-setup.sh     # lihat dulu langkahnya (tidak mengubah apa pun)
deploy/production/bin/db-setup.sh               # membuat database wazap_prod, role wazap_migrator dan wazap_app, kata sandi acak
```
Aman untuk server bersama: menolak bila database atau role sudah ada, hanya membuat objek `wazap_*`, tidak menyentuh `antrian_db`/`bimbel_kraksaan_db`. Kata sandi ditulis ke `~/wazap-db.env` (0600) dan TIDAK dicetak. Hak app pada `schema_migrations` dicabut otomatis oleh `release.sh`. Cadangan role `wazap_backup`: langkah 8.
**4. Env dan kunci master.** Prasyarat: folder sudah disiapkan (aturan 2) dan `ls -l $HOME/wazap-db.env` milik Anda.
```bash
DB_ENV_SOURCE=$HOME/wazap-db.env deploy/production/bin/make-env.sh
shred -u $HOME/wazap-db.env
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
**6. Rilis pertama** (DB kosong; belum ada cadangan, PM2 belum punya proses). JANGAN dengan sudo (aturan 1):
```bash
SKIP_BACKUP_CHECK=1 deploy/production/bin/release.sh
pm2 save && pm2 startup    # jalankan perintah sudo yang dicetak pm2 agar proses hidup lagi setelah reboot
```
**6b. Admin platform pertama** (setelah rilis; pengguna harus sudah mendaftar lewat dashboard; jalankan di terminal pribadi, rahasia TOTP dan kode pemulihan dicetak SEKALI dan jangan ditempel ke chat atau dialihkan ke berkas):
```bash
cd /var/www/wazap/backend && ( set -a; . /var/lib/wazap/env/api.env; set +a; node dist/runtime/platform-admin-cli.js create --email EMAIL_ANDA )
```
Masuk lewat `https://wazap.bolinggo.org/platform/login` (halaman terpisah dari `/login`, sengaja tanpa tautan dari aplikasi pelanggan; simpan sebagai bookmark). Detail: RUNBOOK P18.
**7. Verifikasi.** Dari mesin LAIN: `deploy/production/bin/verify.sh`. Di server: `VERIFY_LOCAL=1 VERIFY_AUTH=1 deploy/production/bin/verify.sh` (membuat satu akun uji; hapus lewat dashboard). Harus "SEMUA LULUS". `VERIFY_THROTTLE=1` mengunci IP penguji sementara: jalankan dari IP yang bukan IP admin. Setelah lulus dan Anda yakin domain stabil, naikkan HSTS: `HSTS_MAX_AGE=31536000 sudo -E deploy/production/bin/install-nginx.sh https`.
**8. Cadangan (WAJIB sebelum tenant sungguhan).** Memakai `backup-setup.sh` dan `backup-run.sh`, BUKAN `deploy/ops/setup-backup-role.sql`: skrip lama memberi `pg_read_all_data` (peran seluruh klaster), sehingga di server bersama kredensial cadangan dapat membaca `antrian_db` dan `bimbel_kraksaan_db` (terbukti di gladi). Role baru hanya punya SELECT pada schema WAZAP.
```bash
DRY_RUN=1 deploy/production/bin/backup-setup.sh      # lihat dulu
deploy/production/bin/backup-setup.sh                # role wazap_backup (terbatas ke wazap_prod), pgpass 0600, ~/.config/wazap-backup/backup.env
deploy/production/bin/backup-run.sh                  # uji sekali; periksa ~/.local/state/wazap-backup/backup.log
# edit ~/.config/wazap-backup/backup.env: isi SALAH SATU OFFSITE_* (salinan di luar host) dan, disarankan, GPG_RECIPIENT; uji ulang
crontab -e   # tambah:  17 2 * * * /var/www/wazap/deploy/production/bin/backup-run.sh
# latihan pemulihan pada cadangan nyata (butuh superuser, hasilnya database sementara yang dihapus otomatis):
# dump berizin 0600 milik pengguna aplikasi, jadi user postgres tidak dapat membacanya: salin ke folder sementara milik postgres (nama berkas EKSPLISIT, tanpa glob), lalu hapus salinannya
DUMP="$(ls -1t "$BACKUP_DIR"/*.dump | head -n1)"; B="$(basename "$DUMP")"      # BACKUP_DIR dari ~/.config/wazap-backup/backup.env
D="$(sudo mktemp -d /tmp/drill.XXXXXX)"; sudo chown postgres:postgres "$D"; sudo chmod 700 "$D"
sudo install -o postgres -g postgres -m 600 "$DUMP" "$D/$B"; sudo install -o postgres -g postgres -m 600 "$DUMP.sha256" "$D/$B.sha256"
sudo -u postgres env PGHOST=/var/run/postgresql deploy/ops/restore-drill.sh "$D/$B"     # harus berakhir "PEMULIHAN TERBUKTI UTUH"
sudo rm -rf "$D"; ls /tmp | grep -c drill                                              # harus 0: tidak ada salinan data produksi tertinggal
```
**Cadangan di drive terpisah (disk/NFS lain di server yang sama).** Periksa drive dulu: `BACKUP_MOUNTPOINT=/mnt/data deploy/production/bin/preflight.sh` (bagian 12: titik mount, perangkat berbeda dari `/` dan data PostgreSQL, dapat ditulis, ruang, `nofail` dan UUID di `/etc/fstab`). Lalu pasang dengan:
```bash
BACKUP_MOUNTPOINT=/mnt/data BACKUP_DIR=/mnt/data/wazap/backups deploy/production/bin/backup-setup.sh
```
`backup-run.sh` lalu MEMBATALKAN cadangan dan mengirim PAGE bila drive tidak ter-mount (tanpa pagar ini, drive yang lepas membuat cadangan menumpuk diam-diam di disk OS), atau ruang bebas kurang dari 500 MB. **Batas perlindungan:** drive terpisah di server yang sama melindungi dari kegagalan SATU disk, tetapi tidak dari kehilangan seluruh server (kebakaran, pencurian, ransomware, kesalahan operator, listrik). Pastikan itu perangkat FISIK berbeda (bukan partisi lain pada disk yang sama). Salinan di luar host tetap disarankan; log mencatat INFO (bukan PERINGATAN) bila cadangan di perangkat terpisah. Penyimpanan media pelanggan (gambar/berkas) belum menjadi fitur aplikasi: lihat PRODUCTION_READINESS.md.
Yang dicadangkan dan tidak: database `wazap_prod` (data tenant dan **auth state WhatsApp terenkripsi**) dicadangkan otomatis. **Kunci master (`CREDENTIAL_ENCRYPTION_KEYS`), `JWT_SECRET`, dan kata sandi DB TIDAK ada di cadangan database** (sengaja): simpan di password manager + salinan offline (langkah 4). Tanpa kunci master, cadangan DB tidak dapat membuka satu pun sesi WhatsApp. Konfigurasi Nginx dan skrip ada di repo; Public Hostname tunnel ada di dashboard Cloudflare (catat tujuannya). RPO = 24 jam (tanpa WAL/PITR). Kegagalan cadangan atau salinan luar host mengirim PAGE ke Telegram (notify.sh); tanpa salinan luar host, log mencatat PERINGATAN tiap hari.
**9. Pemantau.** Cara cepat: `DRY_RUN=1 deploy/production/bin/monitor-setup.sh` lalu `deploy/production/bin/monitor-setup.sh` (menanyakan token bot, ID grup, URL heartbeat dengan input tersembunyi; menulis berkas di bawah, mengirim pesan uji, memasang cron). Rincian isi berkas: `~/.config/wazap-monitor/monitor.env` (0600): `MON_API_URL=http://127.0.0.1:3000`, `MON_WORKER_URL=http://127.0.0.1:8101`, `MON_PM2_API=wazap-api`, `MON_PM2_WORKER=wazap-engine`, `MON_BACKUP_DIR` (diambil otomatis dari `backup.env`, mis. `/srv/backup-data/wazap/backups`), `MON_PUBLIC_URL=https://wazap.bolinggo.org`, `MON_TLS_HOST` kosong di mode tunnel, `MON_DISK_PATHS="/ <titik mount cadangan>"`, token Telegram, dan `MON_HEARTBEAT_URL` (layanan luar, mis. Healthchecks.io). Cron tiap menit `deploy/ops/monitor-check.sh`. Ulangi uji kegagalan di `MONITORING_ALERTING.md` bagian 11 pada server ini.
**10. Uji nyata.** Pairing WhatsApp sungguhan, kirim dan terima pesan, webhook ke penerima nyata, kanal alarm Telegram, ekspor kecil.

## Rilis berikutnya
`git fetch && git checkout <tag>` lalu `deploy/production/bin/release.sh` (menolak bila cadangan lebih tua dari 2 jam; jalankan `deploy/ops/backup.sh` dulu). Migrasi tidak dapat dibatalkan (immutable): rollback kode = checkout tag lama + `release.sh` (migrasi harus kompatibel mundur) atau pulihkan cadangan (`RECOVERY_SOP.md`).

## Catatan
-   Perubahan konfigurasi Nginx: ubah templat di repo, render ulang lewat `install-nginx.sh https`; jangan edit `/etc/nginx/sites-available/wazap` langsung.
-   `bolinggo.org` mungkin memuat layanan lain: HSTS sengaja tanpa `includeSubDomains`/`preload`.
-   Batas laju aplikasi in-memory per proses: jangan jalankan lebih dari satu instans API.

## Konsol platform: gerbang jaringan dan Cloudflare Access (ADR-054)

Templat Nginx sudah memastikan: `/api/v1/platform/` hanya dilayani di host dashboard (`wazap.bolinggo.org`) dengan batas laju 2 r/s (burst 10), dan **404 di host API** (`api-wazap.bolinggo.org`). Terbukti oleh `bin/test-tunnel-vhost.sh` dan `verify.sh`. **Lapis luar yang disarankan (konfigurasi di Cloudflare, tanpa kode): Cloudflare Access dengan cakupan path** pada host yang sama:
1.  Cloudflare Zero Trust, Access, Applications, tambah aplikasi *Self-hosted*. Domain `wazap.bolinggo.org`, dua path: `/platform*` dan `/api/v1/platform/*`.
2.  Kebijakan *Allow*: hanya surel pemilik platform (satu per admin). Metode login: kode satu kali ke surel, atau penyedia identitas yang sudah Anda pakai. Durasi sesi pendek (mis. 8 jam).
3.  Jangan mencakup path lain (dashboard pelanggan dan API tetap publik). `/api/v1/auth/*` dan `/api/v1/platform/*` TIDAK sama: hanya yang kedua dipagari.
4.  Verifikasi: `VERIFY_BEHIND_CDN=1 deploy/production/bin/verify.sh` harus menampilkan "dihadang Cloudflare Access (302/403)" untuk `/api/v1/platform/me`; dari peramban yang sudah masuk Access, konsol berfungsi normal (fetch satu origin membawa cookie Access).
Access menambah gerbang MFA/OTP dari Cloudflare DI LUAR MFA TOTP aplikasi; keduanya wajib dilewati. Bila Access dimatikan, konsol tetap dilindungi TOTP aplikasi, login terpisah, dan batas laju.

