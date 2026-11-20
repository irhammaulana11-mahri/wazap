#!/usr/bin/env bash
# Cadangan logis (pg_dump -Fc) schema WAZAP dengan pagar. Dijalankan terjadwal (cron/systemd timer) oleh role BYPASSRLS/superuser (lihat setup-backup-role.sql).
# Env wajib : PGDATABASE, BACKUP_PGUSER  (kata sandi lewat PGPASSWORD atau PGPASSFILE; JANGAN di argumen)
# Env opsional: PGHOST(127.0.0.1) PGPORT(5432) SCHEMA(gateway) BACKUP_DIR(/var/backups/wazap) RETENTION_DAYS(14) GPG_RECIPIENT
# Jaminan: berkas hasil HANYA ada bila pg_dump sukses, daftar isi terbaca, dan semua tabel punya entri data; tidak pernah ada berkas parsial bernama
# *.dump; checksum SHA-256 menyertai; retensi tidak pernah menghapus 3 cadangan terbaru. Kode keluar 1 pada kegagalan apa pun (pasang alarm pada kode ini).
set -uo pipefail
: "${PGDATABASE:?isi PGDATABASE}" "${BACKUP_PGUSER:?isi BACKUP_PGUSER (superuser atau role BYPASSRLS)}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="$BACKUP_PGUSER" PGCONNECT_TIMEOUT=10
SCHEMA="${SCHEMA:-gateway}"; DIR="${BACKUP_DIR:-/var/backups/wazap}"; KEEP_DAYS="${RETENTION_DAYS:-14}"; MIN_KEEP=3
umask 077; mkdir -p "$DIR" || { echo "GAGAL: tidak dapat membuat $DIR" >&2; exit 1; }
log() { echo "$(date -u +%FT%TZ) backup: $*"; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; NAME="wazap-${PGDATABASE}-${SCHEMA}-${STAMP}.dump"; PARTIAL="$DIR/.${NAME}.partial"
trap 'rm -f "$PARTIAL"' EXIT
die() { log "GAGAL: $*"; exit 1; }

# 1. Pagar: role harus melewati RLS. Tanpa ini pg_dump gagal atau (dengan --enable-row-security) menghasilkan data kosong.
if [ "${BACKUP_SKIP_RLS_PREFLIGHT:-0}" != 1 ]; then   # hanya untuk menguji skrip pada database tanpa RLS; JANGAN dipakai di produksi
  bypass="$(psql -Atq -c "select (rolsuper or rolbypassrls)::text from pg_roles where rolname = current_user")" || die "tidak dapat terhubung sebagai $PGUSER"
  [ "$bypass" = true ] || die "role $PGUSER tidak melewati RLS: cadangan akan gagal/kosong. Gunakan superuser atau role BYPASSRLS (deploy/ops/setup-backup-role.sql)"
fi
tables="$(psql -Atq -c "select count(*) from information_schema.tables where table_schema = '$SCHEMA' and table_type = 'BASE TABLE'")" || die "tidak dapat membaca daftar tabel"
[ "${tables:-0}" -gt 0 ] || die "schema $SCHEMA tidak ada atau kosong"

# 2. Dump ke berkas sementara (tanpa --no-owner/--no-acl: kepemilikan migrator dan GRANT aplikasi ikut dicadangkan)
pg_dump -Fc -n "$SCHEMA" -f "$PARTIAL"; rc=$?
[ "$rc" -eq 0 ] || die "pg_dump gagal (kode $rc); berkas parsial dibuang"

# 3. Verifikasi: daftar isi terbaca dan setiap tabel punya entri data
entries="$(pg_restore --list "$PARTIAL" | grep -c ' TABLE DATA ')" || die "daftar isi cadangan tidak terbaca (berkas rusak)"
[ "$entries" -ge "$tables" ] || die "hanya $entries entri data untuk $tables tabel"

# 4. Pindah atomik + checksum
mv "$PARTIAL" "$DIR/$NAME" || die "tidak dapat memindahkan berkas"
( cd "$DIR" && sha256sum "$NAME" > "$NAME.sha256" ) || die "checksum gagal"
OUT="$DIR/$NAME"
if [ -n "${GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_RECIPIENT" -o "$DIR/$NAME.gpg" "$DIR/$NAME" || die "enkripsi gpg gagal"
  ( cd "$DIR" && sha256sum "$NAME.gpg" > "$NAME.gpg.sha256" ); shred -u "$DIR/$NAME" "$DIR/$NAME.sha256" 2>/dev/null || rm -f "$DIR/$NAME" "$DIR/$NAME.sha256"; OUT="$DIR/$NAME.gpg"
fi

# 5. Retensi: hapus yang lebih tua dari KEEP_DAYS, tetapi JANGAN PERNAH menyisakan kurang dari MIN_KEEP berkas terbaru
mapfile -t all < <(ls -1t "$DIR"/wazap-"$PGDATABASE"-"$SCHEMA"-*.dump "$DIR"/wazap-"$PGDATABASE"-"$SCHEMA"-*.dump.gpg 2>/dev/null)
i=0; for f in "${all[@]}"; do i=$((i+1)); [ "$i" -le "$MIN_KEEP" ] && continue; [ -n "$(find "$f" -mtime +"$KEEP_DAYS" -print 2>/dev/null)" ] && { rm -f "$f" "$f.sha256"; log "retensi: hapus $(basename "$f")"; }; done
log "OK $(basename "$OUT") $(stat -c %s "$OUT") byte, $entries entri data untuk $tables tabel"
