#!/usr/bin/env bash
# Rilis HANYA frontend (tanpa sudo): build lalu publikasikan ke WEB_ROOT. Tidak menyentuh basis data, migrasi, cadangan, maupun proses PM2 (API dan worker tidak restart).
# Pakai bila perubahan hanya di frontend/. Bila ada perubahan backend/migrasi, pakai release.sh.
#
# Pemakaian (dari checkout git bersih pada commit yang akan dirilis; jalankan `git pull` dulu):  deploy/production/bin/release-web.sh
# Cara publikasi (situs tidak pernah rusak di tengah jalan): (1) berkas ber-hash di assets/ DITAMBAHKAN dulu (versi lama tetap ada, jadi tab yang sedang terbuka tidak 404),
# (2) index.html diganti ATOMIK (tulis ke berkas sementara lalu rename), (3) berkas assets lama yang tidak dipakai versi baru dan berumur > KEEP_DAYS dihapus.
# Pemeriksaan sebelum menyentuh WEB_ROOT: semua berkas yang dirujuk index.html baru ada di hasil build; bila tidak, berhenti dan situs tidak berubah.
# Pembatalan: `git checkout <commit-sebelumnya>` lalu jalankan skrip ini lagi (aset lama masih ada selama KEEP_DAYS, jadi cepat dan aman).
# Env: WEB_ROOT(/var/www/wazap-web) KEEP_DAYS(7) WEB_DIST_DIR(frontend/dist) SKIP_BUILD(0; 1 = pakai hasil build yang sudah ada: hanya untuk uji, mencetak peringatan)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; WEB="${WEB_ROOT:-/var/www/wazap-web}"; KEEP="${KEEP_DAYS:-7}"; DIST="${WEB_DIST_DIR:-$ROOT/frontend/dist}"
say(){ printf '\n== %s\n' "$*"; }; die(){ echo "GAGAL: $*" >&2; exit 1; }
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || die "KEEP_DAYS harus bilangan bulat >= 1"
[ "$(id -u)" != 0 ] || die "jangan dijalankan sebagai root/sudo: berkas hasil build akan menjadi milik root dan rilis berikutnya gagal"
cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "ada perubahan lokal di berkas terlacak; rilis hanya dari commit bersih"
echo "Commit: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

say "1. Build frontend"
if [ "${SKIP_BUILD:-0}" = 1 ]; then echo "PERINGATAN: SKIP_BUILD=1, memakai hasil build yang sudah ada di $DIST (hanya untuk uji)"
else ( cd frontend && npm ci --include=dev --no-audit --no-fund && npm run build ); fi   # --include=dev: vite adalah paket dev; NODE_ENV=production di shell akan melewatkannya
[ -f "$DIST/index.html" ] && [ -d "$DIST/assets" ] || die "hasil build tidak lengkap di $DIST (index.html atau assets/ tidak ada)"

say "2. Pemeriksaan hasil build"
[ -d "$WEB" ] && [ -w "$WEB" ] || die "$WEB tidak dapat ditulis (jalankan install-nginx.sh sekali, atau: sudo chown -R \$(id -un) $WEB)"
missing=0
while IFS= read -r ref; do
  [ -f "$DIST/${ref#/}" ] || { echo "  berkas dirujuk index.html tetapi tidak ada di build: $ref" >&2; missing=1; }
done < <(grep -oE '(src|href)="/[^"#?]+' "$DIST/index.html" | sed -E 's/^(src|href)="//' | grep -vE '^//' | sort -u)
[ "$missing" = 0 ] || die "index.html merujuk berkas yang tidak ada; situs TIDAK diubah"
echo "semua berkas yang dirujuk index.html ada"

say "3. Publikasi"
mkdir -p "$WEB/assets"
cp -r "$DIST/assets/." "$WEB/assets/"                                    # tambah dulu; aset lama dipertahankan
for f in "$DIST"/*; do [ "$(basename "$f")" = index.html ] || [ "$(basename "$f")" = assets ] || cp -r "$f" "$WEB/"; done   # berkas statis lain (logo, favicon, dst.)
TMP="$WEB/.index.html.$$"; cp "$DIST/index.html" "$TMP"; mv -f "$TMP" "$WEB/index.html"                       # ganti atomik
chmod -R a+rX "$WEB"
echo "index.html diganti atomik; aset baru ditambahkan"

say "4. Bersihkan aset lama (tidak dipakai versi baru, berumur > $KEEP hari)"
n=0
while IFS= read -r old; do
  rel="${old#"$WEB"/}"
  [ -e "$DIST/$rel" ] && continue                                        # masih dipakai build ini
  rm -f -- "$old"; n=$((n+1))
done < <(find "$WEB/assets" -type f -mtime +"$KEEP" 2>/dev/null)
echo "dihapus: $n berkas"
echo; echo "Rilis frontend selesai. Muat ulang dengan Ctrl+F5. Cek: VERIFY_LOCAL=1 deploy/production/bin/verify.sh   (API dan worker tidak disentuh)"
