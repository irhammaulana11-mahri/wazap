#!/usr/bin/env bash
# Memasang vhost staging ke Nginx SISTEM. Jalankan dengan sudo. Idempoten; HANYA menambah satu berkas, tidak mengubah situs lain.
# Berhenti sebelum reload bila `nginx -t` gagal, dan membatalkan berkas barunya sendiri.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "jalankan dengan sudo" >&2; exit 1; }
D="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="$(cd "$D/../.." && pwd)"
OWNER="${SUDO_USER:?jalankan lewat sudo}"; HOMEDIR="$(getent passwd "$OWNER" | cut -d: -f6)"
NAME="${SERVER_NAME:-staging.wazap.test}"; PORT="${TLS_PORT:-8443}"
TLS_SRC="${WAZAP_ENV_DIR:-$HOMEDIR/.config/wazap-staging}/tls"
[ -r "$TLS_SRC/fullchain.pem" ] || { echo "buat sertifikat dahulu: deploy/staging/bin/make-cert.sh" >&2; exit 2; }
[ -f "$ROOT/frontend/dist/index.html" ] || { echo "frontend/dist belum ada (npm run build di frontend)" >&2; exit 2; }
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN && ! grep -rqs "wazap-staging" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
  echo "port $PORT sudah dipakai proses lain" >&2; exit 2; fi
install -d -m 755 /etc/wazap-staging/tls /var/www/wazap-staging
install -m 644 "$TLS_SRC/fullchain.pem" /etc/wazap-staging/tls/fullchain.pem
install -m 600 "$TLS_SRC/privkey.pem"   /etc/wazap-staging/tls/privkey.pem
rm -rf /var/www/wazap-staging/* && cp -r "$ROOT/frontend/dist/." /var/www/wazap-staging/ && chmod -R a+rX /var/www/wazap-staging
CONF=/etc/nginx/sites-available/wazap-staging
[ -e "$CONF" ] && cp -p "$CONF" "$CONF.bak.$(date +%s)"
SERVER_NAME="$NAME" "$D/bin/render-nginx.sh" "$CONF" "$PORT" /etc/wazap-staging/tls /var/www/wazap-staging
ln -sf "$CONF" /etc/nginx/sites-enabled/wazap-staging
if ! nginx -t; then rm -f /etc/nginx/sites-enabled/wazap-staging; echo "nginx -t gagal: vhost dilepas, Nginx TIDAK di-reload" >&2; exit 1; fi
grep -q "[[:space:]]$NAME\$" /etc/hosts || echo "127.0.0.1 $NAME" >> /etc/hosts
systemctl reload nginx
echo "OK: https://$NAME:$PORT (sertifikat self-signed; verifikasi: deploy/staging/bin/verify.sh)"
