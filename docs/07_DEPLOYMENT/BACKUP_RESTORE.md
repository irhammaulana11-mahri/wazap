# Cadangan dan pemulihan

> **STATUS (2026-11-20):** skrip dan pagar diuji, dan **latihan pemulihan penuh pada data staging nyata LULUS** (lihat "Bukti"). Belum: uji hak role (`verify-db-roles.sh`) pada hasil pemulihan, role `wazap_backup` di server, WAL/PITR, penyalinan ke luar host.

## Yang harus dicadangkan (dan di mana)

| Aset | Cara | Catatan |
|---|---|---|
| Database PostgreSQL (schema `gateway`) | `deploy/ops/backup.sh` (pg_dump -Fc) terjadwal, plus WAL archiving/PITR bila RPO < 24 jam | Memuat data tenant dan **auth state WhatsApp yang terenkripsi** |
| **Kunci master** `CREDENTIAL_ENCRYPTION_KEYS` | password manager + salinan offline (lihat DEPLOYMENT_GUIDE) | **Tanpa kunci ini cadangan database tidak dapat membuka satu pun sesi WhatsApp** (semua sesi harus dipair ulang). Simpan di TEMPAT BERBEDA dari cadangan database |
| `JWT_SECRET`, kata sandi DB | secret manager / berkas 0600 di luar repo | JWT_SECRET hilang = semua access token tidak valid (refresh tetap bekerja) |
| Berkas env, ecosystem PM2, konfigurasi Nginx, sertifikat TLS | repo (`deploy/`) + salinan sertifikat | Rahasia TIDAK di repo |

Tidak dicadangkan: `node_modules`, `dist/`, log, data retensi yang sudah dibersihkan. Target yang disarankan (sesuaikan bisnis): RPO 24 jam (dump harian) atau menit (PITR), RTO 2 jam, retensi 14 hari harian + 8 mingguan, salinan di host/lokasi berbeda.

## PERINGATAN: hanya role yang melewati RLS dapat membuat cadangan lengkap

Semua tabel memakai `ENABLE` + `FORCE ROW LEVEL SECURITY`. Terbukti di staging (PostgreSQL 18):
-   `pg_dump` oleh role biasa (bahkan pemilik tabel, `wazap_migrator`) **gagal**: `query would be affected by row-level security policy for table "api_keys"` dan **meninggalkan berkas parsial** di disk.
-   `pg_dump --enable-row-security` juga gagal: `function ctx_text(unknown) does not exist` (pg_dump memakai `search_path` kosong, kebijakan kita memanggil fungsi tanpa nama schema).
-   Satu-satunya cara: superuser atau role `BYPASSRLS`. Siapkan role khusus `wazap_backup` (`deploy/ops/setup-backup-role.sql`: `BYPASSRLS`, `pg_read_all_data`, hanya baca). `BYPASSRLS` membaca data SEMUA tenant: batasi di `pg_hba.conf` hanya dari host cadangan, kredensial 0600, jangan dipakai aplikasi.
-   Jangan mematikan RLS (`NO FORCE`) demi cadangan: itu membuka isolasi tenant.

## Membuat cadangan

```bash
# env: PGDATABASE, BACKUP_PGUSER (+ PGPASSWORD atau PGPASSFILE); opsional BACKUP_DIR, RETENTION_DAYS, SCHEMA, GPG_RECIPIENT
PGDATABASE=wazap_prod BACKUP_PGUSER=wazap_backup BACKUP_DIR=/var/backups/wazap GPG_RECIPIENT=ops@contoh deploy/ops/backup.sh
```
`backup.sh` menolak role yang tidak melewati RLS, mengunci dump ke berkas sementara, memverifikasi daftar isi dan bahwa setiap tabel punya entri data, memindahkan secara atomik (tidak pernah ada `*.dump` parsial), menulis `.sha256`, menyimpan hanya 3 cadangan terbaru bila retensi menghapus, dan keluar **kode 1** pada kegagalan apa pun: pasang alarm pada kode keluar itu (cadangan yang diam-diam gagal adalah risiko terbesar).
Jadwal: `systemd timer` atau cron harian di luar jam sibuk; salin hasilnya ke lokasi lain (`rclone`/`rsync`) dan uji salinan itu, bukan hanya berkas lokal.

## Latihan pemulihan (WAJIB berkala: bulanan, dan setelah perubahan skema besar)

Cadangan yang belum pernah dipulihkan belum terbukti. `deploy/ops/restore-drill.sh` memulihkan ke database SEMENTARA, membuktikan data utuh, lalu MENGHAPUS database itu:

```bash
sudo -u postgres env PGHOST=/var/run/postgresql deploy/ops/restore-drill.sh /path/ke/wazap-....dump
# opsional uji hak role aplikasi: tambahkan APP_USER=wazap_app APP_PASSWORD=... APP_PGHOST=127.0.0.1
```
Yang dibuktikan: checksum berkas cocok; `pg_restore` tanpa galat (`--exit-on-error`); **jumlah baris tiap tabel sama persis dengan isi berkas cadangan**; semua tabel masih `ENABLE`+`FORCE RLS` dan kebijakan ada; nomor migrasi berurutan; (opsional) `verify-db-roles.sh` lulus pada hasil pemulihan.
Role `wazap_migrator`/`wazap_app` harus ada di cluster tujuan SEBELUM pemulihan (kepemilikan dan GRANT ikut dipulihkan). Role bersifat global dan TIDAK ikut dump: simpan skrip pembuatannya (DB_ROLES.md).

## Pemulihan sungguhan (bencana)

1.  Hentikan penulis: `pm2 stop` API dan semua worker (cegah dua pihak menulis).
2.  Buat database baru (atau kosongkan yang rusak), pastikan role ada, lalu `pg_restore --exit-on-error -d <db> <berkas.dump>` sebagai superuser.
3.  Jalankan `restore-drill`-style verifikasi pada hasilnya (jumlah baris, RLS, migrasi) sebelum membuka layanan.
4.  Terapkan migrasi yang lebih baru dari cadangan: `npm run migrate:prod` (migrator hanya menambah; migrasi terapan tidak berubah).
5.  Pastikan **kunci master yang sama** terpasang (`CREDENTIAL_ENCRYPTION_KEYS`); bila berbeda, auth state tidak terbaca (worker mencatat `auth_state_unavailable`) dan sesi harus dipair ulang.
6.  Mulai worker dahulu, lalu API. Pantau: sesi kembali `CONNECTED`; sesi yang sudah `LOGGED_OUT` di WhatsApp harus dipair ulang (cadangan tidak dapat menghidupkan sesi yang sudah dicabut dari ponsel).
7.  Catat kehilangan data: semua yang terjadi setelah waktu cadangan (pesan keluar dalam antrean, pesan masuk, perubahan akun) hilang; pesan WhatsApp yang sudah terkirim tetap terkirim (risiko kirim ganda saat antrean dipulihkan: lihat RUNBOOK P6).

## Bukti

-   **Latihan pemulihan penuh pada data staging nyata (2026-11-20, PostgreSQL 18, dijalankan oleh superuser):** `backup.sh` menghasilkan `wazap-wazap_staging-gateway-<waktu>.dump` (735.120 byte, 27 entri data untuk 27 tabel). `restore-drill.sh`: checksum berkas cocok; `pg_restore --exit-on-error` selesai tanpa galat; **jumlah baris sama persis di 27 tabel (3.213 baris)**; semua tabel masih `ENABLE`+`FORCE ROW LEVEL SECURITY`; 75 kebijakan RLS ada; nomor migrasi berurutan sampai 0018; database sementara dihapus otomatis. Hasil akhir: "PEMULIHAN TERBUKTI UTUH". Langkah hak role aplikasi dilewati (APP_USER/APP_PASSWORD tidak diisi).
-   Pagar (`backup.sh`, diuji lokal): role tanpa BYPASSRLS ditolak (exit 1, nol berkas); `pg_dump` yang gagal di tengah jalan (RLS) tidak meninggalkan berkas apa pun; cadangan utuh + checksum; jumlah baris yang dihitung dari isi dump cocok dengan sumber (250 dan 40); retensi menyisakan minimal 3 berkas; `restore-drill.sh` oleh bukan superuser gagal rapi (exit 2, tanpa database tersisa).
-   Rotasi kunci (bagian dari cadangan kunci): `test/rotate-cli.test.ts` menjalankan CLI sungguhan.
