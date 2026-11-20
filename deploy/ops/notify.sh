#!/usr/bin/env bash
# Satu-satunya titik yang tahu kanal alarm. Pakai: notify.sh <PAGE|WARN|INFO|OK> <judul> [rincian]
# Kanal: berkas log (selalu) + Telegram (bila TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID terisi). Ganti kanal = ubah berkas ini saja.
# Rahasia dimuat dari MON_ENV_FILE (mode 0600), bukan dari repo. Isi pesan: JANGAN berisi rahasia, nomor pelanggan, atau isi pesan.
set -uo pipefail
sev="${1:?severity}"; title="${2:?judul}"; detail="${3:-}"
ENV_FILE="${MON_ENV_FILE:-$HOME/.config/wazap-monitor/monitor.env}"
if [ -f "$ENV_FILE" ]; then
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] || { echo "notify: $ENV_FILE harus mode 600" >&2; exit 2; }
  set -a; . "$ENV_FILE"; set +a
fi
LOG="${MON_LOG:-$HOME/.local/state/wazap-monitor/alerts.log}"; mkdir -p "$(dirname "$LOG")"
host="${MON_HOST_LABEL:-$(hostname -s)}"
case "$sev" in PAGE) icon="🚨";; WARN) icon="⚠️";; OK) icon="✅";; *) icon="ℹ️";; esac
msg="$icon [$sev] $title"$'\n'"host: $host"; [ -n "$detail" ] && msg+=$'\n'"$detail"
printf '%s %s | %s | %s\n' "$(date -u +%FT%TZ)" "$sev" "$title" "${detail//$'\n'/ }" >> "$LOG"
[ "${MON_DRY_RUN:-0}" = 1 ] && exit 0
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  # URL (berisi token) lewat stdin supaya tidak muncul di daftar proses (ps).
  rc="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" | \
    curl -sS --max-time 15 -K - --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=${msg:0:3500}" -o /dev/null -w '%{http_code}' 2>/dev/null)"
  [ "$rc" = 200 ] || { echo "$(date -u +%FT%TZ) notify: pengiriman Telegram GAGAL (HTTP ${rc:-000})" >> "$LOG"; exit 1; }
fi
