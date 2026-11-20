#!/usr/bin/env bash
# Render templat vhost. Pemakaian: render-nginx.sh <keluaran.conf> [LISTEN_PORT] [CERT_DIR] [WEB_ROOT]
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?keluaran}"; port="${2:-8443}"; cert="${3:-/etc/wazap-staging/tls}"; web="${4:-/var/www/wazap-staging}"
sed -e "s#@LISTEN_PORT@#$port#g" -e "s#@SERVER_NAME@#${SERVER_NAME:-staging.wazap.test}#g" -e "s#@CERT_DIR@#$cert#g" \
    -e "s#@WEB_ROOT@#$web#g" -e "s#@API_PORT@#${API_PORT:-3100}#g" "$D/nginx/wazap-staging.conf.tpl" > "$out"
