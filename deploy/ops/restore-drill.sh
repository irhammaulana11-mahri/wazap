#!/usr/bin/env bash
# Latihan pemulihan: memulihkan cadangan ke database SEMENTARA dan membuktikan datanya utuh, lalu MENGHAPUS database itu (salinan data produksi
# tidak boleh tertinggal). Jalankan oleh superuser (perlu CREATE DATABASE), mis.:  sudo -u postgres env PGHOST=/var/run/postgresql deploy/ops/restore-drill.sh <berkas.dump>
# Env opsional: PGHOST PGPORT PGUSER  APP_PGHOST(127.0.0.1; host TCP untuk uji role aplikasi)  SCHEMA(gateway)  APP_USER+APP_PASSWORD (menjalankan backend/scripts/verify-db-roles.sh pada hasil pemulihan)  KEEP=1 (jangan hapus)
# Pembuktian: (1) pemulihan tanpa galat, (2) jumlah baris per tabel SAMA dengan isi berkas cadangan (tepat, bukan perkiraan), (3) semua tabel masih ENABLE+FORCE RLS,
# (4) nomor migrasi berurutan, (5) hak role aplikasi/migrator utuh (bila APP_* diisi). Kode keluar 1 bila ada yang gagal.
set -uo pipefail
DUMP="${1:?pemakaian: restore-drill.sh <berkas.dump>}"; [ -r "$DUMP" ] || { echo "berkas tidak terbaca: $DUMP" >&2; exit 2; }
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGCONNECT_TIMEOUT=10
SCHEMA="${SCHEMA:-gateway}"; DB="wazap_drill_$(date -u +%Y%m%d%H%M%S)_$$"; HERE="$(cd "$(dirname "$0")" && pwd)"; fail=0
ok() { printf '  LULUS   %s\n' "$1"; }; bad() { printf '  GAGAL   %s\n' "$1"; fail=1; }
CREATED=0
cleanup() { [ "$CREATED" = 1 ] || return 0; if [ "${KEEP:-0}" = 1 ]; then echo "KEEP=1: database $DB dipertahankan (HAPUS manual: dropdb $DB)"; else psql -Atq -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 && echo "database sementara $DB dihapus"; fi; }
trap cleanup EXIT
if [ -f "$DUMP.sha256" ]; then ( cd "$(dirname "$DUMP")" && sha256sum -c --quiet "$(basename "$DUMP").sha256" ) && ok "checksum berkas cocok" || { bad "checksum berkas TIDAK cocok (cadangan rusak)"; exit 1; }; fi
echo "Latihan pemulihan: $(basename "$DUMP") -> database sementara $DB"
psql -Atq -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\"" || { echo "tidak dapat membuat database (perlu superuser)"; exit 2; }
CREATED=1
pg_restore --exit-on-error -d "$DB" "$DUMP" 2> >(sed 's/^/    pg_restore: /' >&2); rc=$?
[ "$rc" -eq 0 ] && ok "pg_restore selesai tanpa galat" || { bad "pg_restore gagal (kode $rc). Bila 'role ... does not exist': buat role migrator/aplikasi dahulu (docs/07_DEPLOYMENT/DB_ROLES.md)"; exit 1; }
# (2) jumlah baris per tabel: isi berkas cadangan vs hasil pemulihan
want="$(pg_restore -f - --data-only "$DUMP" 2>/dev/null | awk '/^COPY /{t=$2; c=1; n[t]=0; next} /^\\\.$/{c=0} c{n[t]++} END{for(t in n) print t, n[t]}' | sort)"
[ -n "$want" ] || { bad "tidak ada data terbaca dari berkas cadangan"; exit 1; }
mism=0; total=0; tables=0
while read -r t n; do
  got="$(psql -Atq -d "$DB" -c "select count(*) from $t")"; tables=$((tables+1)); total=$((total+n))
  [ "$got" = "$n" ] || { bad "tabel $t: dump=$n pulih=$got"; mism=1; }
done <<< "$want"
[ "$mism" = 0 ] && ok "jumlah baris sama persis di $tables tabel ($total baris)"
# (3) RLS aktif dan dipaksa pada semua tabel (kecuali schema_migrations)
norls="$(psql -Atq -d "$DB" -c "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '$SCHEMA' and c.relkind = 'r' and c.relname <> 'schema_migrations' and not (c.relrowsecurity and c.relforcerowsecurity)")"
[ -z "$norls" ] && ok "semua tabel masih ENABLE+FORCE ROW LEVEL SECURITY" || bad "tabel tanpa RLS penuh setelah pemulihan: $(echo $norls)"
pol="$(psql -Atq -d "$DB" -c "select count(*) from pg_policies where schemaname = '$SCHEMA'")"; [ "${pol:-0}" -gt 0 ] && ok "$pol kebijakan RLS ada" || bad "tidak ada kebijakan RLS"
# (4) migrasi berurutan
gaps="$(psql -Atq -d "$DB" -c "select count(*) from (select version::int v, row_number() over (order by version) rn from $SCHEMA.schema_migrations) x where v <> rn")"
last="$(psql -Atq -d "$DB" -c "select max(version) from $SCHEMA.schema_migrations")"
[ "$gaps" = 0 ] && ok "nomor migrasi berurutan sampai $last" || bad "nomor migrasi tidak berurutan"
# (5) hak role aplikasi (opsional)
if [ -n "${APP_USER:-}" ] && [ -n "${APP_PASSWORD:-}" ]; then
  PGHOST="${APP_PGHOST:-127.0.0.1}" PGDATABASE="$DB" APP_USER="$APP_USER" APP_PASSWORD="$APP_PASSWORD" SCHEMA="$SCHEMA" "$HERE/../../backend/scripts/verify-db-roles.sh" >/tmp/wazap-drill-roles.$$ 2>&1 && ok "verify-db-roles.sh lulus pada hasil pemulihan" || { bad "verify-db-roles.sh gagal pada hasil pemulihan"; sed 's/^/    /' /tmp/wazap-drill-roles.$$; }
  rm -f /tmp/wazap-drill-roles.$$
else echo "  (lewati) hak role: isi APP_USER dan APP_PASSWORD untuk menjalankan verify-db-roles.sh"; fi
[ "$fail" = 0 ] && echo "PEMULIHAN TERBUKTI UTUH" || echo "ADA YANG GAGAL"; exit "$fail"
