#!/usr/bin/env bash
# Menyiapkan cadangan database WAZAP di server BERSAMA (sekali, oleh pengguna dengan sudo): role cadangan yang HANYA berlaku di database WAZAP,
# kata sandi acak di berkas pgpass 0600, dan berkas konfigurasi untuk backup-run.sh. Tidak mencetak kata sandi; menolak bila role sudah ada.
#
# MENGAPA BUKAN deploy/ops/setup-backup-role.sql di server bersama: skrip itu memberi `pg_read_all_data` (peran SELURUH klaster). Role BYPASSRLS dengan peran itu dapat
# membaca semua tabel di setiap database yang boleh dihubunginya, dan PostgreSQL mengizinkan CONNECT ke semua database secara bawaan (PUBLIC). Di server dengan
# database aplikasi lain (mis. antrian_db, bimbel_kraksaan_db), bocornya kredensial cadangan = bocornya data aplikasi lain. Di sini hak SELECT hanya pada schema WAZAP
# (pg_dump hanya perlu SELECT + USAGE; BYPASSRLS agar kebijakan RLS tidak menyaring baris), termasuk tabel yang dibuat migrasi di masa depan (hak default).
#
# Pemakaian:   DRY_RUN=1 deploy/production/bin/backup-setup.sh   lalu   deploy/production/bin/backup-setup.sh
# Env: DB_NAME(wazap_prod) SCHEMA(gateway) MIGRATOR_ROLE(wazap_migrator) BACKUP_ROLE(wazap_backup) DB_HOST(127.0.0.1) DB_PORT(5432)
#      CONF_DIR($HOME/.config/wazap-backup) BACKUP_DIR(/var/backups/wazap) RETENTION_DAYS(14) PSQL_CMD("sudo -u postgres psql")
#      BACKUP_MOUNTPOINT (titik mount drive terpisah, mis. /mnt/data; BACKUP_DIR harus di bawahnya, mis. /mnt/data/wazap/backups). Bila diisi, drive HARUS ter-mount saat setup
#      dan tiap backup-run.sh (cadangan dibatalkan + PAGE bila lepas, agar tidak menumpuk di disk OS).
set -euo pipefail
DB="${DB_NAME:-wazap_prod}"; SCHEMA="${SCHEMA:-gateway}"; MIG="${MIGRATOR_ROLE:-wazap_migrator}"; BK="${BACKUP_ROLE:-wazap_backup}"
HOST="${DB_HOST:-127.0.0.1}"; PORT="${DB_PORT:-5432}"; CONF="${CONF_DIR:-$HOME/.config/wazap-backup}"; BDIR="${BACKUP_DIR:-/var/backups/wazap}"; KEEP="${RETENTION_DAYS:-14}"; BMNT="${BACKUP_MOUNTPOINT:-}"
PSQL="${PSQL_CMD:-sudo -u postgres psql}"
for v in "$DB" "$SCHEMA" "$MIG" "$BK"; do [[ "$v" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "nama tidak valid: $v" >&2; exit 2; }; done
q(){ $PSQL -X -q -At -v ON_ERROR_STOP=1 "$@"; }
if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "[dry-run] role $BK: LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE, default_transaction_read_only=on, kata sandi acak; CONNECT hanya ke $DB"
  echo "[dry-run] di $DB: USAGE pada schema $SCHEMA, SELECT pada semua tabel dan sekuens $SCHEMA, hak default untuk objek yang dibuat $MIG. TIDAK memakai pg_read_all_data"
  echo "[dry-run] menulis $CONF/pgpass dan $CONF/backup.env (0600), membuat $BDIR; menampilkan baris cron"; exit 0
fi
[ ! -e "$CONF/pgpass" ] || { echo "sudah ada: $CONF/pgpass (hapus manual bila sengaja)" >&2; exit 2; }
q -d postgres -c "select 1" >/dev/null || { echo "tidak dapat menjalankan psql sebagai superuser (PSQL_CMD='$PSQL')" >&2; exit 2; }
[ "$(q -d postgres -c "select count(*) from pg_database where datname='$DB'")" = 1 ] || { echo "database $DB tidak ada (jalankan db-setup.sh dulu)" >&2; exit 2; }
[ "$(q -d postgres -c "select count(*) from pg_roles where rolname='$BK'")" = 0 ] || { echo "role $BK sudah ada: berhenti (tidak ada yang diubah)" >&2; exit 2; }
if [ -n "$BMNT" ]; then
  mountpoint -q "$BMNT" || { echo "BACKUP_MOUNTPOINT $BMNT bukan titik mount aktif (drive belum ter-mount?)" >&2; exit 2; }
  case "$BDIR/" in "$BMNT"/*) ;; *) echo "BACKUP_DIR ($BDIR) harus berada di bawah BACKUP_MOUNTPOINT ($BMNT)" >&2; exit 2 ;; esac
  [ "$(stat -c %d "$BMNT")" != "$(stat -c %d /)" ] || echo "PERINGATAN: $BMNT satu perangkat dengan / (bukan disk terpisah)" >&2
fi
PW="$(openssl rand -hex 24)"
q -d postgres <<SQL >/dev/null
CREATE ROLE $BK LOGIN PASSWORD '$PW' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE $BK SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE $DB TO $BK;
SQL
q -d "$DB" <<SQL >/dev/null
GRANT USAGE ON SCHEMA $SCHEMA TO $BK;
GRANT SELECT ON ALL TABLES IN SCHEMA $SCHEMA TO $BK;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA $SCHEMA TO $BK;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIG IN SCHEMA $SCHEMA GRANT SELECT ON TABLES TO $BK;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIG IN SCHEMA $SCHEMA GRANT SELECT ON SEQUENCES TO $BK;
SQL
umask 077; mkdir -p "$CONF"; chmod 700 "$CONF"
printf '%s:%s:%s:%s:%s\n' "$HOST" "$PORT" "$DB" "$BK" "$PW" > "$CONF/pgpass"; chmod 600 "$CONF/pgpass"
cat > "$CONF/backup.env" <<ENV
# Konfigurasi cadangan WAZAP (dibaca backup-run.sh). 0600, JANGAN di-commit.
PGDATABASE=$DB
BACKUP_PGUSER=$BK
PGHOST=$HOST
PGPORT=$PORT
PGPASSFILE=$CONF/pgpass
SCHEMA=$SCHEMA
BACKUP_DIR=$BDIR
BACKUP_MOUNTPOINT=$BMNT
BACKUP_MIN_FREE_MB=500
# Berkas status JSON untuk konsol platform (hanya-baca; PLATFORM_BACKUP_STATUS_FILE di api.env harus menunjuk ke sini).
STATUS_FILE=/var/lib/wazap/status/backup.json
RETENTION_DAYS=$KEEP
# Enkripsi (disarankan untuk salinan di luar host): isi dengan ID kunci publik GPG penerima (kunci publik diimpor ke keyring pengguna ini; kunci PRIVAT disimpan di tempat lain).
GPG_RECIPIENT=
# Salinan DI LUAR HOST (WAJIB sebelum tenant sungguhan; isi SALAH SATU). Tanpa ini backup-run.sh mencatat PERINGATAN tiap kali.
#   rsync lewat ssh:  OFFSITE_RSYNC_DEST=pengguna@host-lain:/path/cadangan/wazap/   dan   OFFSITE_SSH_KEY=$HOME/.ssh/id_backup (kunci khusus, tanpa shell login)
#   rclone:           OFFSITE_RCLONE_REMOTE=nama-remote:bucket/wazap
#   path lokal yang di-mount dari mesin lain (NFS/USB/storage): OFFSITE_RSYNC_DEST=/mnt/penyimpanan-lain/wazap/
OFFSITE_RSYNC_DEST=
OFFSITE_SSH_KEY=
OFFSITE_RCLONE_REMOTE=
ENV
chmod 600 "$CONF/backup.env"
if [ ! -d "$BDIR" ]; then mkdir -p "$BDIR" 2>/dev/null || sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" "$BDIR"; fi
echo "SELESAI. Kata sandi ditulis ke $CONF/pgpass (0600), tidak dicetak. Konfigurasi: $CONF/backup.env"
echo "Langkah berikut:"
echo "  1. Uji sekali:  $(cd "$(dirname "$0")" && pwd)/backup-run.sh"
echo "  2. Isi salah satu OFFSITE_* di $CONF/backup.env (dan GPG_RECIPIENT), lalu uji ulang"
echo "  3. Jadwalkan harian (crontab -e):  17 2 * * * $(cd "$(dirname "$0")" && pwd)/backup-run.sh"
echo "  4. Latihan pemulihan pada cadangan nyata (deploy/ops/restore-drill.sh; lihat docs/07_DEPLOYMENT/BACKUP_RESTORE.md)"
