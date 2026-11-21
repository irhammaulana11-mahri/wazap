#!/usr/bin/env bash
# Render templat vhost produksi ke dua berkas: <dir>/wazap.conf dan <dir>/wazap-locations.conf.
# Pemakaian: render-nginx.sh <direktori-keluaran> [HSTS_MAX_AGE]   Env: DASH_HOST API_HOST CERT_DIR WEB_ROOT API_PORT TUNNEL(0|1; Cloudflare Tunnel, HTTP:80 hanya dari loopback) CLOUDFLARE(0|1) CATCHALL_443(1; 0 bila sudah ada default_server di 443)
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?direktori keluaran}"; hsts="${2:-300}"
DASH="${DASH_HOST:-wazap.bolinggo.org}"; API="${API_HOST:-api-wazap.bolinggo.org}"
CERT="${CERT_DIR:-/etc/letsencrypt/live/$DASH}"; WEB="${WEB_ROOT:-/var/www/wazap-web}"; PORT="${API_PORT:-3000}"
mkdir -p "$out"; LOC="$out/wazap-locations.conf"; REALIP=""
if [ "${CLOUDFLARE:-0}" = 1 ]; then
  [ -s "$out/cloudflare-realip.conf" ] || { echo "CLOUDFLARE=1 butuh $out/cloudflare-realip.conf (dibuat install-nginx.sh dari daftar IP resmi Cloudflare)" >&2; exit 2; }
  REALIP="include $out/cloudflare-realip.conf;"
fi
sed -e "s#@API_PORT@#$PORT#g" "$D/nginx/wazap-locations.conf.tpl" > "$LOC"
if [ "${TUNNEL:-0}" = 1 ]; then   # Cloudflare Tunnel: tanpa TLS/443/sertifikat/penampung
  sed -e "s#@DASH_HOST@#$DASH#g" -e "s#@API_HOST@#$API#g" -e "s#@WEB_ROOT@#$WEB#g" -e "s#@API_PORT@#$PORT#g" -e "s#@HSTS_MAX_AGE@#$hsts#g" \
      -e "s#@LOC_FILE@#$LOC#g" -e "s#@ACCESS_LOG@#${ACCESS_LOG:-/var/log/nginx/wazap-access.log}#g" "$D/nginx/wazap-tunnel.conf.tpl" > "$out/wazap.conf"
  exit 0
fi
sed -e "s#@DASH_HOST@#$DASH#g" -e "s#@API_HOST@#$API#g" -e "s#@CERT_DIR@#$CERT#g" -e "s#@WEB_ROOT@#$WEB#g" \
    -e "s#@API_PORT@#$PORT#g" -e "s#@HSTS_MAX_AGE@#$hsts#g" -e "s#@LOC_FILE@#$LOC#g" -e "s#@REALIP@#$REALIP#g" "$D/nginx/wazap.conf.tpl" > "$out/wazap.conf"
[ "${CATCHALL_443:-1}" = 1 ] && cat "$D/nginx/catchall.conf.tpl" >> "$out/wazap.conf"
true
