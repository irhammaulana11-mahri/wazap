# Deployment Guide

## Release checklist

1.  Review migrations and backup database.
2.  Build and test backend/frontend.
3.  Verify environment variables and secrets.
4.  Apply backward-compatible migrations.
5.  Deploy API and workers.
6.  Verify health checks and engine heartbeat.
7.  Verify tenant login and session recovery.
8.  Run smoke tests.
9.  Monitor queue, CPU, RAM, PostgreSQL and logs.
10. Document release and rollback/forward-fix.

## Recovery

-   Restore PostgreSQL from verified backup.
-   Restore encrypted auth state and matching key version.
-   Start control plane and engine only after ownership state is
    reconciled.
-   Do not start duplicate session owners during recovery.

## Operasi produksi\n\nRunbook operasional, playbook insiden, dan prosedur rotasi kunci: `RUNBOOK.md`. Cadangan dan pemulihan (termasuk peringatan RLS untuk `pg_dump`): `BACKUP_RESTORE.md`.\n\n## Catatan Fase G (hardening)

-   **Migrasi terpisah:** produksi `AUTO_MIGRATE=false`; deploy: `npm run build && npm run migrate:prod`, lalu `npm start`.
    Role database: lihat DB_ROLES.md (belum diuji).
-   **Role DB:** `DB_ROLE_CHECK=enforce` (default produksi) menolak start bila role runtime superuser/BYPASSRLS.
-   **Reverse proxy:** set `TRUST_PROXY=true` HANYA bila proxy tepercaya; tanpa itu pembatas IP menganggap semua klien satu IP.
    `WEBHOOK_ALLOW_HTTP`, `WEBHOOK_ALLOW_PRIVATE_TARGETS`, `MEDIA_ALLOW_HTTP`, `MEDIA_ALLOW_PRIVATE_TARGETS` HARUS `false`.
-   **Rotasi kunci:** tambah versi baru ke `CREDENTIAL_ENCRYPTION_KEYS`, set `CREDENTIAL_ACTIVE_KEY_VERSION`, restart semua instans,
    jalankan `npm run keys:rotate -- --dry-run` lalu `npm run keys:rotate`; pensiunkan kunci lama hanya bila `retireReady=true`.
-   **Cadangan kunci:** simpan `CREDENTIAL_ENCRYPTION_KEYS` di secret manager/offline di luar repo dan di luar cadangan DB yang sama.
-   **Validasi indeks:** `npm run test:perf` (butuh PostgreSQL dan hak CREATE SCHEMA; ~40 dtk).

-   **Proses pekerja terpisah (ADR-039):** produksi menjalankan `wazap-api` dengan `ENABLE_EMBEDDED_*=false` dan satu/lebih `dist/worker.js`
    (engine WhatsApp + control-plane + webhook + retensi). Urutan deploy: build -> `migrate:prod` -> restart pekerja -> restart API. Pekerja menolak
    start bila schema belum dimigrasi. Contoh PM2 dan variabel: PM2_CONFIGURATION.md. Tiap engine butuh `ENGINE_NODE_NAME` unik.
-   **Gangguan DB (ADR-038):** `DB_CONNECT_TIMEOUT_MS` (default 5000); DB tidak tersedia => API menjawab 503 `SERVICE_UNAVAILABLE` dan proses
    tetap hidup. Pantau `/health/ready` (API) dan `/health/ready` pekerja (loopback); jangan mematikan proses karena `/health/ready` 503.

## Topologi, rahasia, dan perisai tepi (keputusan ADR-029)

**Satu instans API.** Jangan memakai mode cluster PM2 untuk `wazap-api`: batas laju aplikasi in-memory per proses (N proses = N kali
batas). Engine boleh lebih dari satu proses (dibatasi lease), tetapi satu pemilik per sesi.

**Nginx** (vhost lengkap TERUJI di `deploy/staging/nginx/wazap-staging.conf.tpl`; potongan di bawah hanya ringkasan). `limit_req` per IP sebagai perisai pertama (lebih longgar daripada batas aplikasi 600/menit),
serta proxy WebSocket untuk Socket.IO. Set `TRUST_PROXY=true` di aplikasi HANYA setelah ini terpasang:

```nginx
limit_req_zone $binary_remote_addr zone=wazap_api:10m rate=30r/s;

server {
    # ... TLS ...
    location /api/v1/realtime/ {                      # Socket.IO (WebSocket)
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # TIMPA, jangan tambah (lihat peringatan)
        proxy_read_timeout 3600s;
    }
    location /api/ {
        limit_req zone=wazap_api burst=60 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # TIMPA, jangan tambah (lihat peringatan)
        client_max_body_size 1m;
    }
}
```

**PERINGATAN (ditemukan dan dibuktikan di staging, ADR-040):** `X-Forwarded-For` HARUS ditimpa (`$remote_addr`), BUKAN ditambah
(`$proxy_add_x_forwarded_for`). Dengan `TRUST_PROXY=true` aplikasi memakai nilai terkiri; bila Nginx hanya menambahkan, klien mengirim
`X-Forwarded-For: <IP acak>` dan menghindari throttling login/register per-IP serta memalsukan IP di audit (uji: 0 dari 24 percobaan login
ditolak dengan `$proxy_add_x_forwarded_for`, 24 dari 24 dengan `$remote_addr`). API juga WAJIB `HOST=127.0.0.1`; bila port API terjangkau langsung,
header palsu bekerja walau Nginx benar. `deploy/staging/bin/verify.sh` memeriksa keduanya.

**Berkas rahasia (tanpa Vault/KMS).** Simpan `CREDENTIAL_ENCRYPTION_KEYS`, `JWT_SECRET`, dan kata sandi DB di satu berkas di luar repo,
bukan di berkas ecosystem PM2 yang di-commit:
-   Dengan **systemd**: `/etc/wazap/secrets.env` milik `root:root`, izin `0600`; unit memakai `EnvironmentFile=/etc/wazap/secrets.env`
    dan `User=wazap` (systemd membaca berkas sebagai root lalu menjalankan proses sebagai user non-root).
-   Dengan **PM2** (proses berjalan sebagai user aplikasi): `/var/lib/wazap/secrets.env` (sesuai SERVER_CONFIGURATION) milik user aplikasi,
    izin `0600`, direktori `0700`; muat sebelum `pm2 start` (`set -a; . /var/lib/wazap/secrets.env; set +a`).
-   Jangan pernah menaruh berkas ini di folder repo, cadangan database yang sama, atau log.

**Cadangan kunci master (wajib sebelum tenant sungguhan):**
1.  Salin nilai `CREDENTIAL_ENCRYPTION_KEYS` ke password manager (label versi + tanggal) dan satu salinan offline.
2.  Catat sidik jari (bukan rahasia): `grep ^CREDENTIAL_ENCRYPTION_KEYS= .env | cut -d= -f2- | sha256sum`. Salinan valid bila sidik jarinya sama.
3.  Cadangan database dan kunci disimpan di TEMPAT BERBEDA. Kehilangan kunci = semua sesi harus dipair ulang (data pesan/tenant tidak hilang).
4.  Latih `npm run keys:rotate -- --dry-run` lalu rotasi nyata di staging sekali.

## Alamat dashboard dan batas atas kuota (Fase H2)

-   `RETENTION_TENANT_DAYS` (30): masa tunggu sebelum data workspace yang dihapus dihapus permanen. Pengguna yang kehilangan SEMUA kode pemulihan (SOP: `RECOVERY_SOP.md`): `npm run admin:recovery-code -- --email ...` (produksi: `node dist/runtime/recovery-code-cli.js --email ...`; cetak himpunan 8 kode SEKALI dan menghanguskan kode lama; wajib memastikan peminta pemilik akun lewat kanal yang terverifikasi sebelum menyerahkan).
-   `JOIN_MAX_PENDING` (50) batas permintaan bergabung yang menunggu per tenant; `RETENTION_JOIN_REQUEST_DAYS` (90) retensi baris permintaan.
-   `JOIN_REQUEST_TTL_DAYS` (default 14): masa berlaku permintaan bergabung (ADR-036). Tautan kode workspace: `<DASHBOARD_BASE_URL>/join#code=...` (fragmen, sama seperti undangan).
-   `DASHBOARD_BASE_URL`: alamat dashboard yang dibuka pengguna di browser (domain yang dilayani Nginx untuk frontend), mis. `https://wa.contoh.co.id`. Bukan alamat API
    (`127.0.0.1:3000`) dan bukan server dev Vite. Wajib `https` di production (server menolak start bila tidak). Bila dashboard di subpath, sertakan subpathnya dan pastikan rute `/invite`
    dilayani di sana. Tautan undangan yang dihasilkan: `<DASHBOARD_BASE_URL>/invite#token=...`. Token ada di fragmen (`#`) sehingga TIDAK dikirim browser ke Nginx (tidak masuk access log atau Referer);
    token juga sekali pakai, terikat email, dan kedaluwarsa 7 hari. Frontend wajib menghapus token dari address bar setelah dibaca (lihat FRONTEND_HANDOFF bagian 4.6).
-   `LIMIT_CEIL_*`: batas atas kuota yang dapat diatur OWNER (bawaan 10/50/50/120; ADR-033). Tinjau sebelum produksi. Menyamakan dengan nilai bawaan tenant (3/20/10/60) membuat kuota efektif hanya dapat diubah operator.
