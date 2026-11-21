#!/usr/bin/env bash
# Pekerjaan cadangan harian untuk cron: cadangan (deploy/ops/backup.sh) lalu salinan DI LUAR HOST, dengan pemberitahuan Telegram (notify.sh) bila gagal.
# Konfigurasi dari ~/.config/wazap-backup/backup.env (dibuat backup-setup.sh; harus 0600). Log: ~/.local/state/wazap-backup/backup.log
# Kode keluar 0 = cadangan dan (bila dikonfigurasi) salinan luar host berhasil; 1 = gagal. Cron: 17 2 * * * /path/deploy/production/bin/backup-run.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="${WAZAP_OPS_DIR:-$HERE/../../ops}"
CONF="${WAZAP_BACKUP_ENV:-$HOME/.config/wazap-backup/backup.env}"
LOGDIR="${WAZAP_BACKUP_LOGDIR:-$HOME/.local/state/wazap-backup}"; mkdir -p "$LOGDIR"; LOG="$LOGDIR/backup.log"
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
# Berkas status JSON untuk konsol platform (hanya-baca, tanpa rahasia; ADR-054). Ditulis atomik; kegagalan menulis tidak menggagalkan cadangan.
STATUS_FILE_DEFAULT=/var/lib/wazap/status/backup.json
prev(){ [ -r "${STATUS_FILE:-}" ] && sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$STATUS_FILE" | head -n1; }
jstr(){ if [ -n "${1:-}" ]; then printf '"%s"' "$(printf '%s' "$1" | tr -d '"\\\n\r' | cut -c1-300)"; else printf 'null'; fi; }
location(){ if [ -n "${OFFSITE_OK_AT:-}" ]; then echo offsite; return; fi; local d_bk d_root d_pg; d_bk="$(stat -c %d "${BACKUP_DIR:-/}" 2>/dev/null || echo 0)"; d_root="$(stat -c %d / 2>/dev/null)"; d_pg="$(stat -c %d /var/lib/postgresql 2>/dev/null || echo "$d_root")"; if [ "$d_bk" != "$d_root" ] && [ "$d_bk" != "$d_pg" ]; then echo separate_disk; else echo same_disk; fi; }
write_status() { # $1 ok|fail  $2 alasan (gagal)  $3 nama berkas  $4 ukuran byte
  local f="${STATUS_FILE:-$STATUS_FILE_DEFAULT}" now ok_at fail_at fail_reason file size; now="$(date -u +%FT%TZ)"
  STATUS_FILE="$f"; mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  if [ "$1" = ok ]; then ok_at="$now"; fail_at="$(prev last_failure_at)"; fail_reason="$(prev last_failure_reason)"; file="$3"; size="$4"
  else ok_at="$(prev last_success_at)"; fail_at="$now"; fail_reason="$2"; file="$(prev last_file)"; size="$(sed -n 's/.*"last_size_bytes": *\([0-9]*\).*/\1/p' "$f" 2>/dev/null | head -n1)"; fi
  { printf '{"updated_at":%s,"last_success_at":%s,"last_failure_at":%s,"last_failure_reason":%s,"last_file":%s,"last_size_bytes":%s,"location":%s,"offsite_ok_at":%s}\n' \
      "$(jstr "$now")" "$(jstr "$ok_at")" "$(jstr "$fail_at")" "$(jstr "$fail_reason")" "$(jstr "$file")" "${size:-null}" "$(jstr "$(location)")" "$(jstr "${OFFSITE_OK_AT:-}")"; } > "$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
}
# Alasan kegagalan berasal dari keluaran skrip lain dan dapat memuat rahasia (pesan galat, URL): disamarkan SEKALI di sumber, sebelum masuk log, berkas status, dan pesan Telegram.
redact(){ printf '%s' "$1" | sed -E 's/(password|passwd|pwd|secret|token|apikey|api_key|authorization)([=:]|[[:space:]]+)[^[:space:]]+/\1=***/Ig; s#(://[^:/@[:space:]]+:)[^@[:space:]]+@#\1***@#g'; }
alert(){ local msg; msg="$(redact "$1")"; log "ALARM: $msg"; write_status fail "$msg"; "$OPS/notify.sh" PAGE "Cadangan WAZAP GAGAL" "$msg" >/dev/null 2>&1 || true; }
[ -r "$CONF" ] || { alert "konfigurasi tidak ada: $CONF"; exit 1; }
[ "$(stat -c %a "$CONF")" = 600 ] || { alert "izin $CONF harus 600"; exit 1; }
set -a; . "$CONF"; set +a
# 0. Pagar drive terpisah. Bila BACKUP_MOUNTPOINT diisi, drive itu HARUS ter-mount: drive yang lepas membuat `mkdir -p` membuat folder di disk OS dan cadangan menumpuk
#    di disk yang salah tanpa disadari (padahal tujuannya melindungi dari kegagalan disk OS). Ruang bebas juga diperiksa sebelum dump.
if [ -n "${BACKUP_MOUNTPOINT:-}" ]; then
  mountpoint -q "$BACKUP_MOUNTPOINT" || { alert "drive cadangan TIDAK ter-mount: $BACKUP_MOUNTPOINT (cadangan dibatalkan agar tidak menumpuk di disk OS)"; exit 1; }
  case "$BACKUP_DIR/" in "$BACKUP_MOUNTPOINT"/*) ;; *) alert "BACKUP_DIR ($BACKUP_DIR) tidak berada di bawah BACKUP_MOUNTPOINT ($BACKUP_MOUNTPOINT)"; exit 1 ;; esac
fi
mkdir -p "$BACKUP_DIR" 2>/dev/null; [ -w "$BACKUP_DIR" ] || { alert "BACKUP_DIR tidak dapat ditulis: $BACKUP_DIR"; exit 1; }
free_mb="$(df -Pm "$BACKUP_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
[ "${free_mb:-0}" -ge "${BACKUP_MIN_FREE_MB:-500}" ] || { alert "ruang bebas di $BACKUP_DIR hanya ${free_mb:-?} MB (minimal ${BACKUP_MIN_FREE_MB:-500} MB)"; exit 1; }
# 1. cadangan lokal (backup.sh punya pagar sendiri: parsial dibuang, checksum, retensi minimal 3)
out="$("$OPS/backup.sh" 2>&1)"; rc=$?
printf '%s\n' "$out" | while IFS= read -r l; do log "backup.sh: $(redact "$l")"; done
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
  : > "$LOGDIR/offsite.ok"; OFFSITE_OK_AT="$(date -u +%FT%TZ)"; log "salinan luar host OK: $(basename "$newest")"
elif [ -n "${OFFSITE_RCLONE_REMOTE:-}" ]; then
  rclone copy "$newest" "$OFFSITE_RCLONE_REMOTE" >> "$LOG" 2>&1 && rclone copy "$newest.sha256" "$OFFSITE_RCLONE_REMOTE" >> "$LOG" 2>&1 || { alert "salinan rclone ke luar host gagal"; exit 1; }
  : > "$LOGDIR/offsite.ok"; OFFSITE_OK_AT="$(date -u +%FT%TZ)"; log "salinan luar host OK (rclone): $(basename "$newest")"
else
  d_bk="$(stat -c %d "$BACKUP_DIR")"; d_root="$(stat -c %d /)"; d_pg="$(stat -c %d /var/lib/postgresql 2>/dev/null || echo "$d_root")"
  if [ "$d_bk" != "$d_root" ] && [ "$d_bk" != "$d_pg" ]; then
    : > "$LOGDIR/separate-disk.ok"
    log "INFO: cadangan di perangkat TERPISAH dari disk OS dan data PostgreSQL ($BACKUP_DIR): melindungi dari kegagalan satu disk, BUKAN dari kehilangan seluruh server (kebakaran, pencurian, ransomware, kesalahan operator); salinan di luar host tetap disarankan"
  else
    log "PERINGATAN: cadangan satu perangkat dengan OS/data PostgreSQL dan tanpa salinan di luar host (isi OFFSITE_* atau arahkan BACKUP_DIR ke drive terpisah); disk rusak = semua data hilang"
  fi
fi
write_status ok "" "$(basename "$newest")" "$(stat -c %s "$newest" 2>/dev/null)"
log "selesai OK"
exit 0
