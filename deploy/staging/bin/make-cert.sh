#!/usr/bin/env bash
# Sertifikat self-signed staging (SAN = nama staging). Hanya untuk staging; produksi memakai CA sungguhan (Let's Encrypt).
set -euo pipefail
NAME="${SERVER_NAME:-staging.wazap.test}"; DIR="${1:-${WAZAP_ENV_DIR:-$HOME/.config/wazap-staging}/tls}"
umask 077; mkdir -p "$DIR"
[ -e "$DIR/fullchain.pem" ] && { echo "sudah ada: $DIR (tidak ditimpa)"; exit 0; }
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 -subj "/CN=$NAME" \
  -addext "subjectAltName=DNS:$NAME" -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" \
  -keyout "$DIR/privkey.pem" -out "$DIR/fullchain.pem" 2>/dev/null
chmod 600 "$DIR/privkey.pem"; chmod 644 "$DIR/fullchain.pem"
echo "sertifikat: $DIR/fullchain.pem ($(openssl x509 -in "$DIR/fullchain.pem" -noout -enddate))"
