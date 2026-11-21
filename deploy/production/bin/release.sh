#!/usr/bin/env bash
# Rilis aplikasi di server produksi (tanpa sudo). Urutan WAJIB (ADR-039): build -> cadangan segar -> migrate:prod -> restart pekerja -> restart API -> frontend.
# Pemakaian (dari checkout git bersih pada tag/commit yang akan dirilis):  deploy/production/bin/release.sh
# Rilis PERTAMA (DB kosong, belum ada cadangan, PM2 belum punya proses): SKIP_BACKUP_CHECK=1; proses dibuat otomatis dari ecosystem.config.cjs.
# Env: WAZAP_ENV_DIR(/var/lib/wazap/env) BACKUP_DIR(bawaan: dibaca dari ~/.config/wazap-backup/backup.env, lalu /var/backups/wazap) BACKUP_ENV BACKUP_MAX_AGE_H(2) SKIP_BACKUP_CHECK(0) WEB_ROOT(/var/www/wazap-web) API_PORT(3000) WORKER_HEALTH_PORT(8101)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; ENVDIR="${WAZAP_ENV_DIR:-/var/lib/wazap/env}"; WEB="${WEB_ROOT:-/var/www/wazap-web}"
AP="${API_PORT:-3000}"; WP="${WORKER_HEALTH_PORT:-8101}"; BK="${BACKUP_DIR:-}"; BENV="${BACKUP_ENV:-$HOME/.config/wazap-backup/backup.env}"
# Lokasi cadangan mengikuti konfigurasi yang ditulis backup-setup.sh (mis. drive terpisah); cek cadangan tidak boleh memeriksa folder yang salah.
[ -n "$BK" ] || { [ -r "$BENV" ] && BK="$(grep -E '^BACKUP_DIR=' "$BENV" | head -1 | cut -d= -f2-)" || true; }; BK="${BK:-/var/backups/wazap}"
start_or_restart(){ if pm2 describe "$1" >/dev/null 2>&1; then pm2 restart "$1" --update-env >/dev/null; else pm2 start "$ROOT/deploy/production/ecosystem.config.cjs" --only "$1" >/dev/null; fi; }
say(){ printf '\n== %s\n' "$*"; }; die(){ echo "GAGAL: $*" >&2; exit 1; }
cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "ada perubahan lokal di berkas terlacak; rilis hanya dari commit bersih"
echo "Commit: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
say "1. Cadangan segar (maks ${BACKUP_MAX_AGE_H:-2} jam) sebelum migrasi"
if [ "${SKIP_BACKUP_CHECK:-0}" != 1 ]; then
  nb="$(ls -1t "$BK"/*.dump 2>/dev/null | head -n1 || true)"; [ -n "$nb" ] || die "tidak ada cadangan di $BK (jalankan deploy/production/bin/backup-run.sh)"
  age=$(( ($(date +%s) - $(stat -c %Y "$nb")) / 3600 )); [ "$age" -le "${BACKUP_MAX_AGE_H:-2}" ] || die "cadangan terbaru berumur ${age} jam; jalankan deploy/production/bin/backup-run.sh dulu"
  echo "cadangan: $(basename "$nb") (${age} jam)"
fi
say "2. Build backend"
( cd backend && npm ci --include=dev --no-audit --no-fund && npm run build )   # --include=dev: tsc adalah paket dev; NODE_ENV=production di shell (mis. setelah memuat api.env) akan melewatkannya
say "3. Migrasi (role migrator)"
( cd backend && set -a && . "$ENVDIR/api.env" && set +a && npm run migrate:prod )
# schema_migrations dimiliki migrator, tetapi ALTER DEFAULT PRIVILEGES memberi hak DML ke app pada tabel ini (DB_ROLES.md). App tidak membutuhkannya dan dapat
# mengubah checksum migrasi bila dibobol. Pemilik boleh mencabutnya: idempoten, dijalankan tiap rilis.
( set -a; . "$ENVDIR/api.env"; set +a
  PGPASSWORD="$DB_MIGRATE_PASSWORD" psql -X -q -h "$DB_HOST" -p "$DB_PORT" -U "$DB_MIGRATE_USERNAME" -d "$DB_DATABASE" -v ON_ERROR_STOP=1 \
    -c "REVOKE ALL ON $DB_SCHEMA.schema_migrations FROM $DB_USERNAME" ) || die "gagal mencabut hak app pada schema_migrations"
echo "hak app pada schema_migrations dicabut"
say "4. Restart pekerja lalu API"
start_or_restart wazap-engine; for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$WP/health/ready" >/dev/null && break; sleep 2; [ "$i" = 30 ] && die "pekerja tidak siap"; done; echo "pekerja siap"
start_or_restart wazap-api; for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$AP/health/ready" >/dev/null && break; sleep 2; [ "$i" = 30 ] && die "API tidak siap"; done; echo "API siap"
say "5. Frontend"
( cd frontend && npm ci --no-audit --no-fund && npm run build )
[ -d "$WEB" ] && [ -w "$WEB" ] || die "$WEB tidak dapat ditulis (jalankan install-nginx.sh sekali)"
rm -rf "$WEB"/assets "$WEB"/index.html && cp -r frontend/dist/. "$WEB"/ && chmod -R a+rX "$WEB"
echo; echo "Rilis selesai. Jalankan: deploy/production/bin/verify.sh   (di server: VERIFY_LOCAL=1)"
