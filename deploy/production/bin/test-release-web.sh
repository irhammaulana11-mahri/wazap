#!/usr/bin/env bash
# Uji PERILAKU release-web.sh pada repo git sementara (tanpa npm, tanpa root, tanpa menyentuh server): publikasi atomik, aset lama dipertahankan lalu dipangkas,
# pemeriksaan rujukan index.html (situs tidak berubah bila rusak), penolakan pohon kotor/WEB_ROOT tak dapat ditulis/KEEP_DAYS tak valid, dan skrip tidak menyentuh PM2/basis data.
# Pemakaian: deploy/production/bin/test-release-web.sh    Kode keluar 0 = semua lulus.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)/release-web.sh"
[ "$(id -u)" != 0 ] || { echo "jalankan sebagai non-root (skrip menolak root)" >&2; exit 2; }
T="$(mktemp -d)"; trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
R="$T/repo"; W="$T/web"; mkdir -p "$R/deploy/production/bin" "$R/frontend" "$W"; cp "$SRC" "$R/deploy/production/bin/release-web.sh"
( cd "$R" && git init -q && git config user.email t@t && git config user.name t && echo x > frontend/a.txt && git add -A && git commit -q -m uji )
S="$R/deploy/production/bin/release-web.sh"; fail=0
ok(){ printf '  LULUS   %s\n' "$1"; }; bad(){ printf '  GAGAL   %s\n' "$1"; fail=1; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (didapat: '$2', diharapkan: '$3')"; fi; }
mkdist(){ # $1 = nama js, $2 = nama css, $3 = rujukan tambahan (opsional)
  rm -rf "$R/frontend/dist"; mkdir -p "$R/frontend/dist/assets"; echo "js-$1" > "$R/frontend/dist/assets/$1"; echo "css-$2" > "$R/frontend/dist/assets/$2"; echo logo > "$R/frontend/dist/logo.png"
  printf '<!doctype html><link rel="stylesheet" href="/assets/%s"><script type="module" src="/assets/%s"></script><img src="/logo.png">%s\n' "$2" "$1" "${3:-}" > "$R/frontend/dist/index.html"; }
run(){ SKIP_BUILD=1 WEB_ROOT="$W" "$@" "$S" 2>&1; }

echo "== 1. Publikasi pertama"
mkdist app-AAA.js app-AAA.css
out="$(run env)"; rc=$?
chk "kode keluar 0" "$rc" 0
chk "index.html tersaji" "$(grep -c 'app-AAA.js' "$W/index.html")" 1
chk "aset dan berkas statis tersalin" "$(ls "$W/assets" | tr '\n' ' ')|$(ls "$W/logo.png")" "app-AAA.css app-AAA.js |$W/logo.png"
chk "tidak ada berkas sementara tertinggal" "$(ls -A "$W" | grep -c '^\.index')" 0

echo "== 2. Publikasi kedua: aset baru ditambah, aset lama dipertahankan, index diganti"
mkdist app-BBB.js app-BBB.css
run env >/dev/null; chk "index menunjuk versi baru" "$(grep -c 'app-BBB.js' "$W/index.html")" 1
chk "aset lama MASIH ada (tab yang terbuka tidak 404)" "$(ls "$W/assets" | tr '\n' ' ')" "app-AAA.css app-AAA.js app-BBB.css app-BBB.js "

echo "== 3. Pemangkasan: aset lama berumur > KEEP_DAYS dihapus, yang masih dipakai build tidak"
touch -d '30 days ago' "$W/assets/app-AAA.js" "$W/assets/app-AAA.css" "$W/assets/app-BBB.css"
mkdist app-BBB.js app-CCC.css          # app-BBB.css tidak lagi dirujuk, tetapi app-BBB.js masih
run env KEEP_DAYS=7 >/dev/null
chk "aset usang tak terpakai (AAA) dihapus; BBB.css tua dan tak terpakai dihapus" "$(ls "$W/assets" | tr '\n' ' ')" "app-BBB.js app-CCC.css "

echo "== 4. Pemeriksaan rujukan: index merujuk berkas yang tidak ada -> berhenti, situs TIDAK berubah"
before="$(cat "$W/index.html")"; mkdist app-DDD.js app-DDD.css '<script src="/assets/hilang.js"></script>'
out="$(run env)"; rc=$?
chk "kode keluar bukan 0" "$([ "$rc" != 0 ] && echo ya || echo tidak)" ya
chk "pesan menyebut berkas hilang" "$(printf '%s' "$out" | grep -c 'hilang.js')" 1
chk "index.html lama tidak berubah" "$(cat "$W/index.html")" "$before"
chk "aset baru tidak sempat disalin" "$(ls "$W/assets" | grep -c DDD)" 0

echo "== 5. Penolakan"
mkdist app-EEE.js app-EEE.css; echo kotor >> "$R/frontend/a.txt"
out="$(run env)"; rc=$?; chk "pohon git kotor ditolak" "$([ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'perubahan lokal' && echo ya || echo tidak)" ya
( cd "$R" && git checkout -q -- frontend/a.txt ) 
chmod a-w "$W"; out="$(run env)"; rc=$?; chmod u+w "$W"; chk "WEB_ROOT tak dapat ditulis ditolak" "$([ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'tidak dapat ditulis' && echo ya || echo tidak)" ya
out="$(run env KEEP_DAYS=0)"; rc=$?; chk "KEEP_DAYS=0 ditolak" "$([ "$rc" != 0 ] && echo ya || echo tidak)" ya
rm -rf "$R/frontend/dist"; out="$(run env)"; rc=$?; chk "tanpa hasil build ditolak" "$([ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'tidak lengkap' && echo ya || echo tidak)" ya

echo "== 6. Cakupan: frontend saja"
chk "skrip tidak memanggil pm2, migrasi, psql, atau cadangan" "$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE 'pm2|migrate|psql|backup|api\.env')" 0

[ $fail = 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"; exit $fail
