#!/usr/bin/env bash
# Verifikasi pemisahan role database (docs/07_DEPLOYMENT/DB_ROLES.md). Jalankan di STAGING sebagai/dengan kredensial role APP:
#   PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=wazap_staging APP_USER=wazap_app APP_PASSWORD=... SCHEMA=gateway ./scripts/verify-db-roles.sh
# Semua uji yang berpotensi mengubah skema dibungkus BEGIN...ROLLBACK, jadi aman dijalankan walau role ternyata terlalu berkuasa.
# Exit 0 = semua lulus; 1 = ada pelanggaran; 2 = salah konfigurasi.
set -u
: "${PGDATABASE:?isi PGDATABASE}" "${APP_USER:?isi APP_USER}" "${APP_PASSWORD:?isi APP_PASSWORD}"
SCHEMA="${SCHEMA:-gateway}"; PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"
# Kebijakan RLS memanggil ctx_uuid()/is_platform() tanpa nama schema: koneksi WAJIB ber-search_path = schema (seperti pool aplikasi).
export PGHOST PGPORT PGDATABASE PGCONNECT_TIMEOUT=5 PGOPTIONS="-c search_path=$SCHEMA"
fail=0
run() { PGPASSWORD="$APP_PASSWORD" psql -U "$APP_USER" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
ok()  { printf '  LULUS   %s\n' "$1"; }
bad() { printf '  GAGAL   %s\n' "$1"; fail=1; }

echo "Verifikasi role '$APP_USER' pada $PGDATABASE (schema $SCHEMA)"
run -c "select 1" >/dev/null 2>&1 || { echo "tidak dapat terhubung sebagai $APP_USER"; exit 2; }

# 1. atribut role
attrs=$(run -c "select rolsuper::text||','||rolbypassrls::text||','||rolcreaterole::text||','||rolcreatedb::text from pg_roles where rolname = current_user")
[ "$attrs" = "false,false,false,false" ] && ok "bukan superuser, tanpa BYPASSRLS/CREATEROLE/CREATEDB" || bad "atribut role tidak aman ($attrs)"

# 2. kepemilikan & hak DDL pada schema
own=$(run -c "select (nspowner = (select oid from pg_roles where rolname = current_user))::text from pg_namespace where nspname = '$SCHEMA'")
[ "$own" = "false" ] && ok "bukan pemilik schema $SCHEMA" || bad "role app PEMILIK schema $SCHEMA (dapat menonaktifkan RLS)"
cr=$(run -c "select has_schema_privilege(current_user, '$SCHEMA', 'CREATE')::text")
[ "$cr" = "false" ] && ok "tidak punya hak CREATE di schema" || bad "role app boleh CREATE di schema"

# 3. DDL ditolak (dibungkus transaksi yang di-rollback)
denied() { # $1 deskripsi, $2 sql
  if run -c "BEGIN; $2; ROLLBACK;" >/dev/null 2>&1; then bad "$1 DIIZINKAN (seharusnya ditolak)"; else ok "$1 ditolak"; fi
}
denied "CREATE TABLE di schema"            "CREATE TABLE $SCHEMA.zz_verify_role_probe (a int)"
denied "ALTER TABLE ... DISABLE RLS"        "ALTER TABLE $SCHEMA.message_queue DISABLE ROW LEVEL SECURITY"
denied "DROP POLICY"                        "DROP POLICY message_queue_all ON $SCHEMA.message_queue"
denied "TRUNCATE tabel (di luar DML)"       "TRUNCATE $SCHEMA.outbox_events"   # tabel tanpa FK masuk: ditolak hanya bila hak TRUNCATE tidak ada
denied "baca schema_migrations"             "SELECT 1 FROM $SCHEMA.schema_migrations LIMIT 1"

# 4. RLS efektif: tanpa konteks tenant/platform tidak ada baris yang terlihat
for t in message_queue wa_sessions wa_messages webhook_endpoints outbox_events session_auth_state; do
  n=$(run -c "select count(*) from $SCHEMA.$t" 2>/dev/null || echo "ERR")
  [ "$n" = "0" ] && ok "tanpa konteks, $t tidak menampilkan baris" || bad "tanpa konteks, $t menampilkan '$n' baris (RLS tidak efektif?)"
done

# 5. DML tetap berfungsi (dalam transaksi yang di-rollback): konteks platform dapat INSERT lalu ROLLBACK
if run -c "BEGIN; select set_config('app.scope','platform',true); SELECT 1 FROM $SCHEMA.engine_nodes LIMIT 1; ROLLBACK;" >/dev/null 2>&1; then ok "DML dengan konteks platform berfungsi"; else bad "DML dengan konteks platform GAGAL (hak tabel kurang?)"; fi

echo; [ $fail -eq 0 ] && echo "HASIL: semua lulus" || echo "HASIL: ada pelanggaran (lihat GAGAL di atas)"
exit $fail
