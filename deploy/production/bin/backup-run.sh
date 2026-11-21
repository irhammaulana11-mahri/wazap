#!/usr/bin/env bash
# Pekerjaan cadangan harian untuk cron: cadangan (deploy/ops/backup.sh) lalu salinan DI LUAR HOST, dengan pemberitahuan Telegram (notify.sh) bila gagal.
# Konfigurasi dari ~/.config/wazap-backup/backup.env (dibuat backup-setup.sh; harus 0600). Log: ~/.local/state/wazap-backup/backup.log
# Kode keluar 0 = cadangan dan (bila dikonfigurasi) salinan luar host berhasil; 1 = gagal. Cron: 17 2 * * * /path/deploy/production/bin/backup-run.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$HERE/../../ops"
CONF="${WAZAP_BACKUP_ENV:-$HOME/.config/wazap-backup/backup.env}"
LOGDIR="${WAZAP_BACKUP_LOGDIR:-$HOME/.local/state/wazap-backup}"; mkdir -p "$LOGDIR"; LOG="$LOGDIR/backup.log"
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
alert(){ log "ALARM: $1"; "$OPS/notify.sh" PAGE "Cadangan WAZAP GAGAL" "$1" >/dev/null 2>&1 || true; }
[ -r "$CONF" ] || { alert "konfigurasi tidak ada: $CONF"; exit 1; }
[ "$(stat -c %a "$CONF")" = 600 ] || { alert "izin $CONF harus 600"; exit 1; }
set -a; . "$CONF"; set +a
# 1. cadangan lokal (backup.sh punya pagar sendiri: parsial dibuang, checksum, retensi minimal 3)
out="$("$OPS/backup.sh" 2>&1)"; rc=$?
printf '%s\n' "$out" | while IFS= read -r l; do log "backup.sh: $l"; done
[ "$rc" -eq 0 ] || { alert "backup.sh gagal (kode $rc): $(printf '%s' "$out" | tail -n1 | cut -c1-200)"; exit 1; }
newest="$(ls -1t "$BACKUP_DIR"/wazap-"$PGDATABASE"-"${SCHEMA:-gateway}"-*.dump "$BACKUP_DIR"/wazap-"$PGDATABASE"-"${SCHEMA:-gateway}"-*.dump.gpg 2>/dev/null | head -n1)"
[ -n "$newest" ] || { alert "cadangan berhasil tetapi berkasnya tidak ditemukan di $BACKUP_DIR"; exit 1; }
# 2. salinan di luar host
if [ -n "${OFFSITE_RSYNC_DEST:-}" ]; then
  if [[ "$OFFSITE_RSYNC_DEST" == *:* ]]; then
    ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes${OFFSITE_SSH_KEY:+ -i $OFFSITE_SSH_KEY}"
    rsync -a -e "$ssh_cmd" "$newest" "$newest.sha256" "$OFFSITE_RSYNC_DEST" >> "$LOG" 2>&1 || { alert "salinan rsync ke luar host gagal"; exit 1; }
  else
    [ -d "$OFFSITE_RSYNC_DEST" ] || { alert "tujuan salinan lokal tidak ada: $OFFSITE_RSYNC_DEST"; exit 1; }
    cp -p "$newest" "$newest.sha256" "$OFFSITE_RSYNC_DEST/" >> "$LOG" 2>&1 || { alert "salinan ke $OFFSITE_RSYNC_DEST gagal"; exit 1; }
  fi
  : > "$LOGDIR/offsite.ok"; log "salinan luar host OK: $(basename "$newest")"
elif [ -n "${OFFSITE_RCLONE_REMOTE:-}" ]; then
  rclone copy "$newest" "$OFFSITE_RCLONE_REMOTE" >> "$LOG" 2>&1 && rclone copy "$newest.sha256" "$OFFSITE_RCLONE_REMOTE" >> "$LOG" 2>&1 || { alert "salinan rclone ke luar host gagal"; exit 1; }
  : > "$LOGDIR/offsite.ok"; log "salinan luar host OK (rclone): $(basename "$newest")"
else
  log "PERINGATAN: tidak ada salinan di luar host (isi OFFSITE_* di $CONF); disk rusak = semua data hilang"
fi
log "selesai OK"
exit 0
