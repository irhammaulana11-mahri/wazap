#!/usr/bin/env bash
# Pagar migrasi: (1) migrasi yang sudah ada di BASE TIDAK BOLEH diubah, diganti nama, atau dihapus (migrator menolak checksum berubah dan
# DB yang sudah menerapkannya tidak dapat menyala; insiden 0014), hanya penambahan berkas baru; (2) nomor berurutan 0001.. tanpa lubang/duplikat.
# Pemakaian: check-migrations.sh <BASE_REF_ATAU_SHA>   (BASE kosong/nol/tidak ditemukan => hanya pemeriksaan urutan)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
DIR=backend/src/database/migrations; BASE="${1:-}"; bad=0
if [ -n "$BASE" ] && ! [[ "$BASE" =~ ^0+$ ]] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  changes="$(git diff --name-status --no-renames "$BASE" HEAD -- "$DIR")"
  while IFS=$'\t' read -r st f; do
    [ -z "${st:-}" ] && continue
    [ "$st" = A ] || { echo "GAGAL: migrasi terapan tidak boleh diubah/dihapus: $st $f (buat migrasi BARU)"; bad=1; }
  done <<< "$changes"
else
  echo "peringatan: BASE '${BASE:-kosong}' tidak tersedia; pemeriksaan keabadian dilewati (hanya urutan)"
fi
prev=0
for f in $(ls "$DIR"/*.sql | sort); do
  b="$(basename "$f")"; v="${b%%_*}"
  [[ "$v" =~ ^[0-9]{4}$ ]] || { echo "GAGAL: nama migrasi tidak berawalan 4 digit: $b"; bad=1; continue; }
  v=$((10#$v))
  [ "$v" -eq $((prev+1)) ] || { echo "GAGAL: nomor migrasi tidak berurutan/duplikat di $b (setelah $prev)"; bad=1; }
  prev=$v
done
[ "$bad" = 0 ] && echo "migrasi OK ($prev berkas)"
exit "$bad"
