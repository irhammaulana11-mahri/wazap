#!/usr/bin/env bash
# Memasang vhost produksi ke Nginx SISTEM (sudo). Idempoten; HANYA menambah berkas wazap*, situs lain tidak diubah.
# Dua tahap karena sertifikat belum ada pada pemasangan pertama:
#   sudo install-nginx.sh http   -> hanya port 80 (ACME + pengalihan). Lalu jalankan certbot (README langkah 6).
#   sudo install-nginx.sh https  -> vhost TLS penuh (butuh sertifikat); `nginx -t` sebelum reload, rollback bila gagal.
# Env: CLOUDFLARE(0|1; 1 bila DNS lewat proxy Cloudflare: IP pengunjung dibaca dari CF-Connecting-IP, hanya dari rentang Cloudflare resmi)
#      DASH_HOST API_HOST CERT_DIR API_PORT HSTS_MAX_AGE(300; naikkan ke 31536000 setelah verify.sh lulus dan Anda yakin)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "jalankan dengan sudo" >&2; exit 1; }
mode="${1:?http|https}"; D="$(cd "$(dirname "$0")/.." && pwd)"
OWNER="${SUDO_USER:?jalankan lewat sudo}"
DASH="${DASH_HOST:-wazap.bolinggo.org}"; API="${API_HOST:-api-wazap.bolinggo.org}"; CERT="${CERT_DIR:-/etc/letsencrypt/live/$DASH}"
WEB=/var/www/wazap-web; CONF=/etc/nginx/sites-available/wazap; LOCDIR=/etc/nginx/wazap
install -d -m 755 /var/www/certbot "$LOCDIR"
install -d -m 755 -o "$OWNER" -g "$OWNER" "$WEB"   # dimiliki pengguna deploy: release.sh menyalin frontend tanpa sudo
[ -e "$WEB/index.html" ] || printf '<!doctype html><title>WAZAP</title>' > "$WEB/index.html"
case "$mode" in
  http)
    cat > "$CONF.new" <<E2
server {
    listen 80;
    listen [::]:80;
    server_name $DASH $API;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
E2
    ;;
  https)
    [ -r "$CERT/fullchain.pem" ] || { echo "sertifikat belum ada di $CERT (jalankan certbot dulu)" >&2; exit 2; }
    tmp="$(mktemp -d)"
    if [ "${CLOUDFLARE:-0}" = 1 ]; then
      { echo "# Dibuat install-nginx.sh dari https://www.cloudflare.com/ips-v4 dan ips-v6; perbarui dengan menjalankan ulang (rentang dapat berubah)."
        for f in ips-v4 ips-v6; do l="$(curl -fsS --max-time 15 "https://www.cloudflare.com/$f")" || { echo "tidak dapat mengambil daftar $f Cloudflare" >&2; exit 2; }
          printf '%s\n' "$l" | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' | sed 's/^/set_real_ip_from /; s/$/;/'; done
        echo "real_ip_header CF-Connecting-IP;"; echo "real_ip_recursive off;"; } > "$tmp/cloudflare-realip.conf"
      [ "$(grep -c '^set_real_ip_from' "$tmp/cloudflare-realip.conf")" -ge 10 ] || { echo "daftar IP Cloudflare terlalu pendek/rusak" >&2; exit 2; }
    fi
    DASH_HOST="$DASH" API_HOST="$API" CERT_DIR="$CERT" WEB_ROOT="$WEB" "$D/bin/render-nginx.sh" "$tmp" "${HSTS_MAX_AGE:-300}"
    install -m 644 "$tmp/wazap-locations.conf" "$LOCDIR/wazap-locations.conf"
    [ -s "$tmp/cloudflare-realip.conf" ] && install -m 644 "$tmp/cloudflare-realip.conf" "$LOCDIR/cloudflare-realip.conf"
    sed -i "s#$tmp#$LOCDIR#g" "$tmp/wazap.conf"; cp "$tmp/wazap.conf" "$CONF.new"; rm -rf "$tmp"
    ;;
  *) echo "mode: http|https" >&2; exit 1 ;;
esac
[ -e "$CONF" ] && cp -p "$CONF" "$CONF.bak.$(date +%s)"
mv "$CONF.new" "$CONF"; ln -sf "$CONF" /etc/nginx/sites-enabled/wazap
if ! nginx -t; then
  echo "nginx -t GAGAL: mengembalikan konfigurasi sebelumnya" >&2
  last="$(ls -1t "$CONF".bak.* 2>/dev/null | head -n1 || true)"
  if [ -n "$last" ]; then cp -p "$last" "$CONF"; else rm -f "$CONF" /etc/nginx/sites-enabled/wazap; fi
  exit 1
fi
systemctl reload nginx && echo "Nginx dimuat ulang (mode $mode)."
