#!/usr/bin/env bash
# Membuat api.env dan worker.env staging DI LUAR repo (izin 0600) dengan JWT_SECRET dan kunci master BARU (acak, tidak dicetak).
# Kredensial DB (role app + migrator) disalin dari berkas sumber (default backend/.env.staging); tidak ada rahasia dicetak.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="${WAZAP_ENV_DIR:-$HOME/.config/wazap-staging}"
SRC="${DB_ENV_SOURCE:-$ROOT/backend/.env.staging}"
NAME="${SERVER_NAME:-staging.wazap.test}"; TLS_PORT="${TLS_PORT:-8443}"
[ -r "$SRC" ] || { echo "sumber kredensial DB tidak ada: $SRC" >&2; exit 2; }
umask 077; mkdir -p "$DIR"; chmod 700 "$DIR"
if [ -e "$DIR/api.env" ] || [ -e "$DIR/worker.env" ]; then
  echo "Sudah ada di $DIR: TIDAK ditimpa (kunci master lama harus tetap). Hapus manual bila sengaja ingin membuat ulang." >&2; exit 0
fi
v() { grep -E "^$1=" "$SRC" | head -1 | cut -d= -f2-; }
for k in DB_HOST DB_PORT DB_DATABASE DB_SCHEMA DB_USERNAME DB_PASSWORD DB_MIGRATE_USERNAME DB_MIGRATE_PASSWORD; do
  [ -n "$(v $k)" ] || { echo "variabel $k tidak ada di $SRC" >&2; exit 2; }; done
JWT="$(openssl rand -base64 48 | tr -d '\n=/+')"
KEY="1:$(openssl rand -base64 32)"
common() {
  cat <<E2
NODE_ENV=production
LOG_LEVEL=info
DB_HOST=$(v DB_HOST)
DB_PORT=$(v DB_PORT)
DB_DATABASE=$(v DB_DATABASE)
DB_SCHEMA=$(v DB_SCHEMA)
DB_USERNAME=$(v DB_USERNAME)
DB_PASSWORD=$(v DB_PASSWORD)
DB_MIGRATE_USERNAME=$(v DB_MIGRATE_USERNAME)
DB_MIGRATE_PASSWORD=$(v DB_MIGRATE_PASSWORD)
AUTO_MIGRATE=false
DB_ROLE_CHECK=enforce
JWT_SECRET=$JWT
CREDENTIAL_ENCRYPTION_KEYS=$KEY
CREDENTIAL_ACTIVE_KEY_VERSION=1
DASHBOARD_BASE_URL=https://$NAME:$TLS_PORT
E2
}
{ echo "# api staging (dibuat $(date -u +%FT%TZ)); JANGAN di-commit"; common
  cat <<E2
PORT=${API_PORT:-3100}
HOST=127.0.0.1
TRUST_PROXY=true
COOKIE_SECURE=true
ENABLE_EMBEDDED_CONTROL_PLANE=false
ENABLE_EMBEDDED_ENGINE=false
ENABLE_EMBEDDED_WEBHOOK_WORKER=false
ENABLE_EMBEDDED_RETENTION=false
E2
} > "$DIR/api.env"
{ echo "# worker staging (dibuat $(date -u +%FT%TZ)); JANGAN di-commit"; common
  cat <<E2
ENGINE_NODE_NAME=engine-stg-01
WORKER_ROLES=engine,control-plane,webhook,retention
WORKER_HEALTH_PORT=${WORKER_HEALTH_PORT:-8101}
WORKER_HEALTH_HOST=127.0.0.1
E2
} > "$DIR/worker.env"
chmod 600 "$DIR/api.env" "$DIR/worker.env"
echo "Dibuat: $DIR/api.env dan $DIR/worker.env (0600)."
echo "Sidik jari kunci master (bukan rahasia): $(printf %s "$KEY" | sha256sum | cut -c1-16)"
echo "WAJIB: simpan CREDENTIAL_ENCRYPTION_KEYS ke password manager + salinan offline sebelum dipakai (lihat DEPLOYMENT_GUIDE)."
