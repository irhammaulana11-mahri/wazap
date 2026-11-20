-- Role cadangan WAZAP (jalankan SEKALI sebagai superuser; idempoten). Alasan: semua tabel memakai FORCE ROW LEVEL SECURITY, sehingga pg_dump oleh role biasa
-- GAGAL ("query would be affected by row-level security policy") dan meninggalkan berkas parsial; --enable-row-security juga gagal karena pg_dump memakai
-- search_path kosong sedangkan kebijakan memanggil ctx_uuid()/ctx_text(). Hanya superuser atau role BYPASSRLS yang dapat membuat cadangan lengkap.
--   sudo -u postgres psql -d <database> -v dbname=<database> -f deploy/ops/setup-backup-role.sql
--   lalu atur kata sandi secara interaktif (jangan di argumen/riwayat shell):  \password wazap_backup
-- PERINGATAN: BYPASSRLS = dapat membaca data SEMUA tenant. Batasi di pg_hba.conf hanya dari host cadangan, simpan kredensial di luar repo (0600),
-- jangan pakai untuk aplikasi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wazap_backup') THEN
    CREATE ROLE wazap_backup LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT pg_read_all_data TO wazap_backup;               -- SELECT pada semua tabel/sekuens + USAGE schema (tanpa hak tulis)
GRANT CONNECT ON DATABASE :"dbname" TO wazap_backup;
ALTER ROLE wazap_backup SET default_transaction_read_only = on;
