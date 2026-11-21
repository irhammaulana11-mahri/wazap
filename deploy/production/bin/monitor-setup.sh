#!/usr/bin/env bash
# Memasang pemantau + notifikasi Telegram di server produksi (sekali, TANPA sudo): menulis monitor.env (0600), menguji pengiriman, memasang cron tiap menit.
# Token bot dan URL heartbeat DIMINTA lewat input tersembunyi (tidak tampil di layar, tidak masuk riwayat shell, tidak masuk daftar proses) dan tidak dicetak.
# Menolak menimpa monitor.env yang sudah ada. Skrip pemantau: deploy/ops/monitor-check.sh; rancangan: docs/07_DEPLOYMENT/MONITORING_ALERTING.md.
#
# Pemakaian:   DRY_RUN=1 deploy/production/bin/monitor-setup.sh   lalu   deploy/production/bin/monitor-setup.sh
# Env: CONF_DIR($HOME/.config/wazap-monitor) PUBLIC_URL(https://wazap.bolinggo.org) API_PORT(3000) WORKER_HEALTH_PORT(8101) PM2_API(wazap-api) PM2_WORKER(wazap-engine)
#      BACKUP_ENV($HOME/.config/wazap-backup/backup.env; BACKUP_DIR dan BACKUP_MOUNTPOINT dibaca dari sini bila ada) DISK_PATHS(bawaan "/" + titik mount cadangan)
#      CRON(1; 0 = jangan pasang cron) CRONTAB_CMD(crontab) SEND_TEST(1; 0 = jangan kirim pesan uji)
# Masukan interaktif (tiga baris bila stdin bukan terminal): token bot, id obrolan/grup, URL heartbeat (boleh kosong).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
CONF="${CONF_DIR:-$HOME/.config/wazap-monitor}"; PUB="${PUBLIC_URL:-https://wazap.bolinggo.org}"
AP="${API_PORT:-3000}"; WP="${WORKER_HEALTH_PORT:-8101}"; PA="${PM2_API:-wazap-api}"; PW="${PM2_WORKER:-wazap-engine}"
BENV="${BACKUP_ENV:-$HOME/.config/wazap-backup/backup.env}"; CRONB="${CRONTAB_CMD:-crontab}"
CHECK="$ROOT/deploy/ops/monitor-check.sh"; NOTIFY="$ROOT/deploy/ops/notify.sh"
[ -x "$CHECK" ] && [ -x "$NOTIFY" ] || { echo "skrip pemantau tidak ditemukan/tidak dapat dieksekusi di $ROOT/deploy/ops" >&2; exit 2; }
case "$PUB" in https://*) ;; *) echo "PUBLIC_URL harus https://" >&2; exit 2 ;; esac
benv() { [ -r "$BENV" ] && grep -E "^$1=" "$BENV" | head -1 | cut -d= -f2- || true; }
BDIR="$(benv BACKUP_DIR)"; BMNT="$(benv BACKUP_MOUNTPOINT)"
DISKS="${DISK_PATHS:-/${BMNT:+ $BMNT}}"
CRONLINE="* * * * * $CHECK"

if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "[dry-run] menulis $CONF/monitor.env (0600): MON_API_URL=http://127.0.0.1:$AP MON_WORKER_URL=http://127.0.0.1:$WP MON_PM2_API=$PA MON_PM2_WORKER=$PW"
  echo "[dry-run]   MON_PUBLIC_URL=$PUB MON_BACKUP_DIR=${BDIR:-<kosong: alarm cadangan dilewati>} MON_DISK_PATHS=\"$DISKS\" MON_TLS_HOST kosong (sertifikat dikelola Cloudflare)"
  echo "[dry-run]   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MON_HEARTBEAT_URL (opsional): diminta lewat input tersembunyi"
  echo "[dry-run] mengirim satu pesan uji ke Telegram, lalu memasang cron: $CRONLINE"; exit 0
fi

[ ! -e "$CONF/monitor.env" ] || { echo "sudah ada: $CONF/monitor.env (hapus manual bila sengaja membuat ulang)" >&2; exit 2; }
if [ -n "$BMNT" ]; then mountpoint -q "$BMNT" || { echo "PERINGATAN: $BMNT (dari backup.env) tidak ter-mount; alarm disk dan cadangan akan menyala" >&2; }; fi

ask() { # $1 prompt, $2 var; sembunyikan ketikan bila terminal
  if [ -t 0 ]; then read -rsp "$1: " "$2"; echo >&2; else read -r "$2" || true; fi
}
ask "Token bot Telegram (dari @BotFather; tidak tampil)" TOKEN
ask "ID obrolan/grup Telegram (angka, grup biasanya diawali minus)" CHAT
ask "URL heartbeat (mis. Healthchecks.io; Enter bila belum ada)" HB
[[ "$TOKEN" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "format token bot tidak valid (bentuk 123456789:AA...); tidak ada yang ditulis" >&2; exit 2; }
[[ "$CHAT" =~ ^-?[0-9]{5,}$ ]] || { echo "ID obrolan harus angka (grup: diawali '-'); tidak ada yang ditulis" >&2; exit 2; }
[ -z "$HB" ] || [[ "$HB" =~ ^https://[^[:space:]\"\'\\]+$ ]] || { echo "URL heartbeat harus https:// tanpa spasi atau tanda kutip; tidak ada yang ditulis" >&2; exit 2; }

umask 077; mkdir -p "$CONF"; chmod 700 "$CONF"
{
  echo "# Konfigurasi pemantau WAZAP produksi (dibuat $(date -u +%FT%TZ)). 0600, JANGAN di-commit."
  echo "MON_HOST_LABEL=wazap-prod"
  echo "MON_API_URL=http://127.0.0.1:$AP"
  echo "MON_WORKER_URL=http://127.0.0.1:$WP"
  echo "MON_PM2_API=$PA"
  echo "MON_PM2_WORKER=$PW"
  echo "MON_PUBLIC_URL=$PUB"
  echo "MON_TLS_HOST="
  [ -z "$BDIR" ] || echo "MON_BACKUP_DIR=$BDIR"
  echo "MON_DISK_PATHS=\"$DISKS\""
  echo "TELEGRAM_BOT_TOKEN=$TOKEN"
  echo "TELEGRAM_CHAT_ID=$CHAT"
  [ -z "$HB" ] || echo "MON_HEARTBEAT_URL=$HB"
} > "$CONF/monitor.env"
chmod 600 "$CONF/monitor.env"
unset TOKEN HB
echo "Dibuat: $CONF/monitor.env (0600). Nilai rahasia tidak dicetak." >&2

if [ "${SEND_TEST:-1}" = 1 ]; then
  if MON_ENV_FILE="$CONF/monitor.env" "$NOTIFY" INFO "Pemantau WAZAP produksi terpasang" "Pesan uji dari monitor-setup.sh. Bila Anda membaca ini, kanal alarm bekerja."; then
    echo "Pesan uji dikirim: periksa grup Telegram. Bila TIDAK masuk, periksa token/ID dan bot sudah ditambahkan ke grup (log: ~/.local/state/wazap-monitor/alerts.log)." >&2
  else
    echo "PERINGATAN: pengiriman pesan uji GAGAL. Konfigurasi tetap ditulis; periksa token dan ID obrolan, dan bahwa bot sudah menjadi anggota grup (lihat alerts.log)." >&2
  fi
fi

if [ "${CRON:-1}" = 1 ]; then
  cur="$($CRONB -l 2>/dev/null || true)"
  if printf '%s\n' "$cur" | grep -qF "$CHECK"; then echo "cron sudah memuat $CHECK: tidak diubah." >&2
  else { [ -z "$cur" ] || printf '%s\n' "$cur"; printf '%s\n' "$CRONLINE"; } | $CRONB - && echo "Cron terpasang (tiap menit): $CRONLINE" >&2; fi
fi
echo "Langkah berikut: uji kegagalan nyata (MONITORING_ALERTING.md bagian 11), mis. 'pm2 stop wazap-api' selama >2 menit lalu 'pm2 start wazap-api'; pesan PAGE lalu OK harus masuk." >&2
