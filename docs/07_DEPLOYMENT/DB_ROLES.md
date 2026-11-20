# Pemisahan role database (migrator vs aplikasi)

> **STATUS: TERUJI di PostgreSQL staging lokal (2026-11-20)** dengan role `wazap_migrator` dan `wazap_app` sungguhan. Hasil: migrasi 0001-0014
> sukses sebagai migrator; `scripts/verify-db-roles.sh` 15/15 lulus; server start dengan `DB_ROLE_CHECK=enforce` tanpa peringatan; smoke test (register, undangan,
> permintaan bergabung, audit, usage) lulus. Temuan saat pengujian (sudah diperbaiki di kode/dokumen): `CREATE SCHEMA IF NOT EXISTS` butuh hak CREATE pada database
> (migrator kini memeriksa `pg_namespace` dahulu); `ALTER DEFAULT PRIVILEGES` memberi hak DML app pada `schema_migrations` (lihat langkah REVOKE di bawah).
> **Belum:** pengujian di staging nyata (server terpisah, Nginx, TLS) dan dengan DBA sungguhan; pemantauan.

## Mengapa

Isolasi tenant bertumpu pada row-level security. Dua hal meniadakannya:

1.  **Superuser / `BYPASSRLS`**: melewati RLS sepenuhnya (FORCE RLS pun tidak berlaku). Aplikasi **menolak start**
    di produksi (`DB_ROLE_CHECK=enforce`, default saat `NODE_ENV=production`) bila role runtime seperti itu.
2.  **Pemilik schema / hak DDL**: aplikasi yang dibobol dapat `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` atau mengubah
    kebijakan. Di dev, `wazap_user` memiliki schema `gateway` (aplikasi memberi peringatan saat start). Di produksi,
    pisahkan: **migrator** (pemilik, hanya dipakai saat migrasi) dan **app** (hanya DML).

## Skrip (jalankan sebagai superuser, ganti kata sandi)

```sql
CREATE ROLE wazap_migrator LOGIN PASSWORD '<kuat-1>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE wazap_app      LOGIN PASSWORD '<kuat-2>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- schema dimiliki migrator; app hanya boleh memakai (USAGE), tidak boleh membuat objek
CREATE SCHEMA gateway AUTHORIZATION wazap_migrator;
REVOKE ALL ON SCHEMA gateway FROM PUBLIC;
GRANT USAGE ON SCHEMA gateway TO wazap_app;

-- objek yang DIBUAT migrator di masa depan otomatis diberi hak DML ke app
ALTER DEFAULT PRIVILEGES FOR ROLE wazap_migrator IN SCHEMA gateway GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wazap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wazap_migrator IN SCHEMA gateway GRANT USAGE, SELECT ON SEQUENCES TO wazap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wazap_migrator IN SCHEMA gateway GRANT EXECUTE ON FUNCTIONS TO wazap_app;

GRANT CONNECT ON DATABASE wazap_db TO wazap_migrator, wazap_app;

-- Kebijakan RLS memanggil ctx_uuid()/is_platform() tanpa nama schema, jadi koneksi HARUS ber-search_path=gateway
-- (pool aplikasi sudah menyetelnya; ini pengaman untuk koneksi lain, mis. psql/skrip verifikasi).
ALTER ROLE wazap_app SET search_path = gateway;
```

Konfigurasi aplikasi (`backend/.env` produksi):

```
DB_USERNAME=wazap_app            # runtime: DML saja
DB_PASSWORD=...
DB_MIGRATE_USERNAME=wazap_migrator   # hanya dipakai migrasi
DB_MIGRATE_PASSWORD=...
AUTO_MIGRATE=false               # migrasi dijalankan sebagai langkah deploy terpisah
DB_ROLE_CHECK=enforce
```

Deploy: `npm run build && npm run migrate:prod` (memakai `DB_MIGRATE_*`), lalu `npm start` (memakai `DB_USERNAME`).

## Hal yang perlu diperhatikan

-   Tabel yang dimiliki migrator juga tunduk pada FORCE RLS: **migrasi yang melakukan UPDATE/DELETE data
    (backfill) akan melihat 0 baris**. Tulis backfill sebagai langkah terpisah dengan konteks platform, atau
    sementara beri migrator `BYPASSRLS` hanya selama migrasi itu.
-   `schema_migrations` dimiliki migrator, tetapi `ALTER DEFAULT PRIVILEGES` di atas MEMBERI hak DML ke app pada tabel ini juga
    (ditemukan saat verifikasi staging). App tidak membutuhkannya dan dapat mengubah checksum migrasi bila dibobol, jadi setelah
    migrasi PERTAMA jalankan sekali: `REVOKE ALL ON gateway.schema_migrations FROM wazap_app;` (skrip verifikasi memeriksanya).
-   Runtime tidak menjalankan DDL (`CREATE SCHEMA`/`CREATE TABLE`) sama sekali; semua DDL ada di migrator.

## Daftar verifikasi (staging, sebelum produksi)

Otomatis: `backend/scripts/verify-db-roles.sh` (butir 2, 4, 5 di bawah + uji DDL ditolak; semua uji berisiko dibungkus rollback).
Skrip ini diuji terhadap role dev (pemilik schema: mendeteksi pelanggaran) dan terhadap `wazap_app` sungguhan di staging lokal (2026-11-20: semua lulus setelah REVOKE `schema_migrations`).


1.  `npm run migrate:prod` sukses dengan `DB_MIGRATE_*`; log menunjukkan `as: "migrator"`.
2.  Server start dengan `DB_USERNAME=wazap_app`: tidak ada peringatan role (`ownsSchema=false`, `canCreateInSchema=false`).
3.  Smoke: register, buat sesi, kirim pesan, webhook, Socket.IO, `GET /health/ready` READY.
4.  Sebagai `wazap_app`: `CREATE TABLE gateway.x (a int)` ditolak; `ALTER TABLE gateway.message_queue DISABLE ROW LEVEL SECURITY` ditolak;
    `SELECT * FROM gateway.message_queue` tanpa konteks tenant mengembalikan 0 baris.
5.  `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'wazap_app'` => `f | f`.
6.  Jalankan `npm run test:perf` dan `npm test` terhadap staging (schema sementara) memakai kredensial yang berhak CREATE SCHEMA.

## Role cadangan (wazap_backup)

`pg_dump` oleh role biasa GAGAL pada schema ini karena semua tabel `FORCE ROW LEVEL SECURITY` (terbukti; lihat BACKUP_RESTORE.md). Cadangan memakai role terpisah `wazap_backup`: `LOGIN`, `BYPASSRLS`, `pg_read_all_data`, `default_transaction_read_only = on`, tanpa hak tulis. Pembuatan (idempoten, oleh superuser): `deploy/ops/setup-backup-role.sql`, lalu `\password wazap_backup`.
`BYPASSRLS` membaca data semua tenant: batasi di `pg_hba.conf` hanya dari host cadangan, kredensial 0600 di luar repo, tidak pernah dipakai aplikasi. Role ini bersifat global dan tidak ikut dump: simpan skrip pembuatan role (migrator, aplikasi, cadangan) di runbook penyedia database.
