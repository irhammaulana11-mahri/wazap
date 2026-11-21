#!/usr/bin/env bash
# Membuat database, schema, dan dua role WAZAP (migrator = pemilik schema; app = DML saja) sesuai docs/07_DEPLOYMENT/DB_ROLES.md, dengan kata sandi ACAK yang
# ditulis ke berkas 0600 (format DB_ENV_SOURCE untuk make-env.sh). Kata sandi TIDAK dicetak dan tidak melewati argumen proses (lewat stdin psql).
# Aman untuk server bersama: MENOLAK bila database atau role sudah ada (tidak menimpa/mengubah apa pun milik aplikasi lain), hanya membuat objek wazap_*.
# Pemakaian (di server, pengguna dengan sudo):   deploy/production/bin/db-setup.sh
#   DRY_RUN=1 deploy/production/bin/db-setup.sh      (hanya mencetak langkah, tidak mengubah apa pun)
# Env: DB_NAME(wazap_prod) SCHEMA(gateway) APP_ROLE(wazap_app) MIGRATOR_ROLE(wazap_migrator) DB_HOST(127.0.0.1) DB_PORT(5432)
#      OUT(berkas keluaran; bawaan $HOME/wazap-db.env)  PSQL_CMD(perintah psql superuser; bawaan "sudo -u postgres psql")
# Lanjutan: DB_ENV_SOURCE="$OUT" deploy/production/bin/make-env.sh ; lalu hapus $OUT dengan shred.
set -euo pipefail
DB="${DB_NAME:-wazap_prod}"; SCHEMA="${SCHEMA:-gateway}"; APP="${APP_ROLE:-wazap_app}"; MIG="${MIGRATOR_ROLE:-wazap_migrator}"
HOST="${DB_HOST:-127.0.0.1}"; PORT="${DB_PORT:-5432}"; OUT="${OUT:-$HOME/wazap-db.env}"; PSQL="${PSQL_CMD:-sudo -u postgres psql}"
for v in "$DB" "$SCHEMA" "$APP" "$MIG"; do [[ "$v" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "nama tidak valid (huruf kecil, angka, garis bawah): $v" >&2; exit 2; }; done
say(){ printf '%s\n' "$*"; }
q(){ $PSQL -X -q -At -v ON_ERROR_STOP=1 "$@"; }

if [ "${DRY_RUN:-0}" = 1 ]; then
  say "[dry-run] akan memeriksa: database $DB, role $MIG dan $APP belum ada"
  say "[dry-run] akan membuat role $MIG dan $APP (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE, kata sandi acak 48 hex)"
  say "[dry-run] akan membuat database $DB (pemilik $MIG), mencabut CONNECT dari PUBLIC, schema $SCHEMA milik $MIG, hak default untuk $APP, search_path=$SCHEMA untuk $APP"
  say "[dry-run] akan menulis $OUT (0600) berisi DB_HOST=$HOST DB_PORT=$PORT DB_DATABASE=$DB DB_SCHEMA=$SCHEMA dan kredensial kedua role"
  exit 0
fi

[ ! -e "$OUT" ] || { echo "berkas keluaran sudah ada: $OUT (hapus manual dengan shred bila sengaja)" >&2; exit 2; }
q -d postgres -c "select 1" >/dev/null || { echo "tidak dapat menjalankan psql sebagai superuser (PSQL_CMD='$PSQL')" >&2; exit 2; }
ex_db="$(q -d postgres -c "select count(*) from pg_database where datname = '$DB'")"
ex_ro="$(q -d postgres -c "select string_agg(rolname, ', ') from pg_roles where rolname in ('$MIG','$APP')")"
[ "$ex_db" = 0 ] || { echo "database $DB sudah ada: berhenti (tidak ada yang diubah)" >&2; exit 2; }
[ -z "$ex_ro" ] || { echo "role sudah ada ($ex_ro): berhenti (tidak ada yang diubah)" >&2; exit 2; }

PW_MIG="$(openssl rand -hex 24)"; PW_APP="$(openssl rand -hex 24)"
say "membuat role $MIG dan $APP"
q -d postgres <<SQL >/dev/null
CREATE ROLE $MIG LOGIN PASSWORD '$PW_MIG' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE $APP LOGIN PASSWORD '$PW_APP' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE $DB OWNER $MIG;
REVOKE CONNECT ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $DB TO $MIG, $APP;
SQL
say "membuat schema $SCHEMA dan hak di $DB"
q -d "$DB" <<SQL >/dev/null
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA $SCHEMA AUTHORIZATION $MIG;
REVOKE ALL ON SCHEMA $SCHEMA FROM PUBLIC;
GRANT USAGE ON SCHEMA $SCHEMA TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIG IN SCHEMA $SCHEMA GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIG IN SCHEMA $SCHEMA GRANT USAGE, SELECT ON SEQUENCES TO $APP;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIG IN SCHEMA $SCHEMA GRANT EXECUTE ON FUNCTIONS TO $APP;
ALTER ROLE $APP SET search_path = $SCHEMA;
SQL
( umask 077; cat > "$OUT" <<ENV
DB_HOST=$HOST
DB_PORT=$PORT
DB_DATABASE=$DB
DB_SCHEMA=$SCHEMA
DB_USERNAME=$APP
DB_PASSWORD=$PW_APP
DB_MIGRATE_USERNAME=$MIG
DB_MIGRATE_PASSWORD=$PW_MIG
ENV
)
chmod 600 "$OUT"
say "SELESAI. Kredensial ditulis ke $OUT (0600), tidak dicetak."
say "Langkah berikut:"
say "  1. DB_ENV_SOURCE=$OUT deploy/production/bin/make-env.sh      (membuat env produksi dan kunci master)"
say "  2. shred -u $OUT                                              (hapus berkas sementara ini)"
say "  3. release.sh mencabut hak app pada schema_migrations otomatis; verifikasi akhir: backend/scripts/verify-db-roles.sh (APP_USER=$APP; kata sandi dari api.env, jangan dicetak)"
