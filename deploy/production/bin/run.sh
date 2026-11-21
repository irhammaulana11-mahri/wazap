#!/usr/bin/env bash
# Peluncur untuk PM2: memuat berkas env rahasia (di luar repo, harus 0600) lalu exec node. Pemakaian: run.sh api|worker
set -euo pipefail
role="${1:?api|worker}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
f="${WAZAP_ENV_DIR:-/var/lib/wazap/env}/$role.env"
[ -r "$f" ] || { echo "berkas env tidak ada: $f" >&2; exit 2; }
[ "$(stat -c %a "$f")" = "600" ] || { echo "izin $f harus 600" >&2; exit 2; }
set -a; . "$f"; set +a
cd "$ROOT/backend"
case "$role" in api) exec node dist/server.js ;; worker) exec node dist/worker.js ;; *) echo "peran tidak dikenal" >&2; exit 2 ;; esac
