#!/usr/bin/env bash
# Pemantau tahap 1 (sinyal di luar database). Dijalankan tiap menit oleh cron/systemd timer. Rancangan: docs/07_DEPLOYMENT/MONITORING_ALERTING.md
# Env (semua opsional kecuali yang bertanda *):
#   MON_API_URL(http://127.0.0.1:3000)  MON_WORKER_URL(kosong=lewati)  MON_PM2_API MON_PM2_WORKER (nama proses PM2; kosong=lewati)
#   MON_BACKUP_DIR(kosong=lewati) MON_BACKUP_MAX_AGE_H(26)  MON_DISK_PATHS("/")  MON_TLS_HOST(host:port, kosong=lewati)
#   MON_LOG_FILES(berkas log dipisah spasi)  MON_HEARTBEAT_URL(ping dead-man's switch)  MON_STATE_DIR  NOTIFY(path notify.sh)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; NOTIFY="${NOTIFY:-$HERE/notify.sh}"
ENV_FILE="${MON_ENV_FILE:-$HOME/.config/wazap-monitor/monitor.env}"; [ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
S="${MON_STATE_DIR:-$HOME/.local/state/wazap-monitor/state}"; mkdir -p "$S"
API="${MON_API_URL:-http://127.0.0.1:3000}"; NOW="$(date +%s)"
exec 9>"$S/.lock"; flock -n 9 || exit 0   # satu pemeriksaan pada satu waktu

# alarm <id> <sev> <gagal:0|1> <tahan_dtk> <judul> <rincian> [kirim_ulang_dtk]
# Menyala setelah kondisi gagal bertahan >= tahan; kirim ulang tiap kirim_ulang (PAGE 900, selain itu 1800); kirim OK saat pulih.
alarm() {
  local id="$1" sev="$2" bad="$3" hold="$4" title="$5" detail="$6" resend="${7:-}" f="$S/alarm.$1"
  [ -n "$resend" ] || { [ "$sev" = PAGE ] && resend=900 || resend=1800; }
  local first="" sent=""; [ -f "$f" ] && read -r first sent < "$f"
  if [ "$bad" = 1 ]; then
    [ -n "$first" ] || { first="$NOW"; sent=""; }
    if [ $((NOW-first)) -ge "$hold" ] && { [ -z "$sent" ] || [ $((NOW-sent)) -ge "$resend" ]; }; then "$NOTIFY" "$sev" "$title" "$detail"; sent="$NOW"; echo "$title" > "$f.title"; fi
    echo "$first ${sent:-}" > "$f"
  elif [ -f "$f" ]; then
    [ -n "$sent" ] && "$NOTIFY" OK "Pulih: $(cat "$f.title" 2>/dev/null || echo "$id")" ""
    rm -f "$f" "$f.title"
  fi
}
code() { local c; c="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null)"; echo "${c:-000}"; }

# A1/A2 API
live="$(code "$API/health/live")"; ready="$(code "$API/health/ready")"
alarm A1 PAGE $([ "$live" = 200 ] && echo 0 || echo 1) 120 "API mati (/health/live=$live)" "Playbook P1"
alarm A2 PAGE $([ "$live" = 200 ] && [ "$ready" != 200 ] && echo 1 || echo 0) 180 "API tidak siap (/health/ready=$ready)" "Playbook P1 (DB bermasalah atau sedang shutdown)"
# Worker (bila ada endpoint kesehatan)
if [ -n "${MON_WORKER_URL:-}" ]; then w="$(code "$MON_WORKER_URL/health/ready")"; alarm A4 PAGE $([ "$w" = 200 ] && echo 0 || echo 1) 120 "Worker tidak siap (/health/ready=$w)" "Playbook P4"; fi

# A3 PM2: status errored/stopped, atau restart_time naik >=3 dalam 10 menit
if command -v pm2 >/dev/null; then
  J="$(pm2 jlist 2>/dev/null)"
  for n in ${MON_PM2_API:-} ${MON_PM2_WORKER:-}; do
    st="$(jq -r --arg n "$n" '.[]|select(.name==$n)|.pm2_env.status' <<<"$J")"; rt="$(jq -r --arg n "$n" '.[]|select(.name==$n)|.pm2_env.restart_time' <<<"$J")"
    H="$S/restarts.$n"; echo "$NOW ${rt:-0}" >> "$H"; tail -n 30 "$H" > "$H.t" && mv "$H.t" "$H"
    old="$(awk -v t=$((NOW-600)) '$1>=t{print $2; exit}' "$H")"; delta=$(( ${rt:-0} - ${old:-${rt:-0}} ))
    bad=0; { [ -z "$st" ] || [ "$st" = errored ] || [ "$st" = stopped ]; } && bad=1; [ "$delta" -ge 3 ] && bad=1
    alarm "A3.$n" PAGE $bad 0 "Proses PM2 $n bermasalah (status=${st:-hilang}, restart 10 mnt terakhir=$delta)" "Playbook P2"
  done
fi

# A17 galat log: baris level error/fatal (pino 50/60) baru dalam 5 menit > 20
if [ -n "${MON_LOG_FILES:-}" ]; then
  total=0
  for lf in $MON_LOG_FILES; do [ -f "$lf" ] || continue
    k="$S/off.$(echo "$lf" | tr / _)"; size="$(stat -c %s "$lf")"; off="$(cat "$k" 2>/dev/null || echo "$size")"; [ "$off" -gt "$size" ] && off=0
    c="$(tail -c +$((off+1)) "$lf" | grep -cE '"level":(50|60)[,}]' || true)"; total=$((total+c)); echo "$size" > "$k"
  done
  W="$S/errwin"; echo "$NOW $total" >> "$W"; tail -n 400 "$W" > "$W.t" && mv "$W.t" "$W"
  sum="$(awk -v t=$((NOW-300)) '$1>=t{s+=$2}END{print s+0}' "$W")"
  alarm A17 WARN $([ "$sum" -gt 20 ] && echo 1 || echo 0) 0 "Lonjakan galat log: $sum baris error/fatal dalam 5 mnt" "Playbook P1"
fi

# A18-A20 cadangan: terbaru <= MAX_AGE jam, dan berkas .sha256 cocok
if [ -n "${MON_BACKUP_DIR:-}" ]; then
  newest="$(ls -1t "$MON_BACKUP_DIR"/*.dump 2>/dev/null | head -n1)"; max="${MON_BACKUP_MAX_AGE_H:-26}"
  if [ -z "$newest" ]; then alarm A19 PAGE 1 0 "Tidak ada berkas cadangan di $MON_BACKUP_DIR" "Playbook P14"
  else
    age=$(( (NOW-$(stat -c %Y "$newest"))/3600 ))
    alarm A19 PAGE $([ "$age" -gt "$max" ] && echo 1 || echo 0) 0 "Cadangan terbaru berumur ${age} jam (batas ${max})" "Playbook P14: $(basename "$newest")"
    ok=1; [ -f "$newest.sha256" ] && { (cd "$MON_BACKUP_DIR" && sha256sum -c --quiet "$(basename "$newest").sha256" >/dev/null 2>&1) || ok=0; } || ok=0
    alarm A20 PAGE $([ $ok = 1 ] && echo 0 || echo 1) 0 "Checksum cadangan terbaru tidak cocok/hilang" "Playbook P14: $(basename "$newest")"
  fi
fi

# A21 disk
for p in ${MON_DISK_PATHS:-/}; do
  u="$(df --output=pcent "$p" 2>/dev/null | tail -n1 | tr -dc 0-9)"; [ -n "$u" ] || continue; id="A21.$(echo "$p" | tr / _)"
  if [ "$u" -ge 90 ]; then alarm "$id" PAGE 1 600 "Disk $p ${u}% terpakai" "Playbook P12"
  else alarm "$id" WARN $([ "$u" -ge 80 ] && echo 1 || echo 0) 600 "Disk $p ${u}% terpakai" "Playbook P12"; fi
done

# A22 sertifikat TLS (periksa sekali per jam)
if [ -n "${MON_TLS_HOST:-}" ] && [ ! -f "$S/tls.checked" -o "$(find "$S/tls.checked" -mmin +60 2>/dev/null)" ]; then
  touch "$S/tls.checked"
  end="$(echo | openssl s_client -connect "$MON_TLS_HOST" -servername "${MON_TLS_HOST%%:*}" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$end" ]; then alarm A22 WARN 1 0 "Sertifikat TLS $MON_TLS_HOST tidak terbaca" "Playbook P13"
  else d=$(( ($(date -d "$end" +%s)-NOW)/86400 )); sv=WARN; [ "$d" -lt 7 ] && sv=PAGE
    alarm A22 "$sv" $([ "$d" -lt 21 ] && echo 1 || echo 0) 0 "Sertifikat TLS $MON_TLS_HOST kedaluwarsa ${d} hari lagi" "Playbook P13" 86400; fi
fi

# A26 heartbeat luar: dikirim HANYA bila pemeriksaan di atas selesai (pemantau hidup). Layanan luar yang mengalarm bila ping berhenti.
[ -n "${MON_HEARTBEAT_URL:-}" ] && curl -fsS -m 10 -o /dev/null "$MON_HEARTBEAT_URL" || true
exit 0
