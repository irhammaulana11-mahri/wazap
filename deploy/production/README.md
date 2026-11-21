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
| `nginx/*.tpl`, `bin/render-nginx.sh` | vhost dua host (templat; tidak diedit tangan di /etc) |
| `bin/install-nginx.sh` | pasang ke Nginx sistem (**sudo**), dua tahap `http` lalu `https`; `nginx -t` dan rollback otomatis |
| `bin/release.sh` | rilis tanpa sudo: cek cadangan -> build -> migrasi -> worker -> API -> frontend |
| `bin/verify.sh` | gerbang dari luar lewat domain sungguhan |

## Urutan (sekali di server baru)
**0. Server.** Ubuntu LTS, Node 22, PostgreSQL 18, Nginx, PM2, certbot, git; pengguna non-root khusus (mis. `wazap`) yang punya sudo hanya untuk langkah bertanda sudo. Firewall: izinkan 22, 80, 443 saja (`ufw default deny incoming`). PostgreSQL mendengarkan loopback.
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
sudo deploy/production/bin/install-nginx.sh https        # HSTS 300 dtk dulu
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
