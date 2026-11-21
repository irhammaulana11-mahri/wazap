#!/usr/bin/env bash
# Verifikasi produksi dari luar lewat domain sungguhan (sertifikat Let's Encrypt harus tepercaya TANPA --cacert). Exit 0 = semua lulus.
# Dasar: tidak membuat data di produksi. Opsi:  VERIFY_LOCAL=1 (jalankan DI server: periksa port loopback + health pekerja)
#   VERIFY_AUTH=1  (buat SATU akun uji acak dan periksa cookie/token/WebSocket; akun uji tetap ada, hapus lewat dashboard)
#   VERIFY_THROTTLE=1 (24 login salah dengan X-Forwarded-For palsu: membuktikan IP tak dapat dipalsukan; MENGUNCI IP penguji sementara, jalankan dari IP yang tidak dipakai admin)
#   ORIGIN_IP=<IP server>: uji LANGSUNG ke server (melewati CDN/Cloudflare) memakai nama host yang sama; WAJIB dijalankan bila DNS lewat Cloudflare.
#   VERIFY_BEHIND_CDN=1: uji lewat Cloudflare; melewati pemeriksaan milik tepi (TLS 1.1, versi/ pengalihan HTTP, umur sertifikat tepi).
#   VERIFY_TUNNEL=1 (bersama VERIFY_LOCAL=1, DI server): periksa sisi origin tunnel: Host lewat loopback, pengaman non-loopback 403, IP pengunjung di log akses.
# Env: DASH_HOST API_HOST WORKER_HEALTH_PORT(8101) API_PORT(3000)
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="$(cd "$D/../.." && pwd)"
DASH="${DASH_HOST:-wazap.bolinggo.org}"; API="${API_HOST:-api-wazap.bolinggo.org}"; AP="${API_PORT:-3000}"; WP="${WORKER_HEALTH_PORT:-8101}"
RES=(); if [ -n "${ORIGIN_IP:-}" ]; then RES=(--resolve "$DASH:443:$ORIGIN_IP" --resolve "$API:443:$ORIGIN_IP" --resolve "$DASH:80:$ORIGIN_IP" --resolve "$API:80:$ORIGIN_IP"); fi
CDN="${VERIFY_BEHIND_CDN:-0}"
fail=0; ok(){ printf '  LULUS   %s\n' "$1"; }; bad(){ printf '  GAGAL   %s\n' "$1"; fail=1; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (didapat: $2, diharapkan: $3)"; fi; }
cc(){ local c; c="$(curl -sS --max-time 15 "${RES[@]}" -o /dev/null -w '%{http_code}' "$@" 2>/dev/null)"; echo "${c:-000}"; }

for H in "$DASH" "$API"; do
  echo "== TLS dan header: $H"
  chk "HTTPS 200 dengan sertifikat tepercaya" "$(cc "https://$H/health/live")" 200
  if [ "$CDN" = 1 ]; then echo "  LEWAT   TLS 1.1 (milik tepi CDN; periksa dengan ORIGIN_IP)"; else echo | openssl s_client -connect "${ORIGIN_IP:-$H}:443" -servername "$H" -tls1_1 2>&1 | grep -q "Cipher is (NONE)\|alert\|no protocols" && ok "TLS 1.1 ditolak" || bad "TLS 1.1 diterima"; fi
  echo | openssl s_client -connect "${ORIGIN_IP:-$H}:443" -servername "$H" -tls1_3 >/dev/null 2>&1 && ok "TLS 1.3 tersedia" || bad "TLS 1.3 tidak tersedia"
  HD="$(curl -sSI --max-time 15 "${RES[@]}" "https://$H/health/live")"
  echo "$HD" | grep -qi '^strict-transport-security:' && ok "HSTS ada" || bad "HSTS tidak ada"
  if [ "$CDN" = 1 ]; then :; else echo "$HD" | grep -qiE '^server: nginx/[0-9]' && bad "versi Nginx bocor" || ok "versi Nginx tidak bocor"; fi
  echo "$HD" | grep -qi '^x-content-type-options: nosniff' && ok "nosniff" || bad "nosniff tidak ada"
  r="$(curl -sS --max-time 15 "${RES[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$H/uji")"
  case "$r" in "301 https://$H/uji") ok "HTTP dialihkan ke HTTPS" ;; *) bad "HTTP tidak dialihkan ke HTTPS ($r)" ;; esac
  d="$(echo | openssl s_client -connect "${ORIGIN_IP:-$H}:443" -servername "$H" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "$d" ]; then days=$(( ($(date -d "$d" +%s) - $(date +%s)) / 86400 )); [ "$days" -ge 14 ] && ok "sertifikat berlaku $days hari lagi" || bad "sertifikat tinggal $days hari"; else bad "sertifikat tidak terbaca"; fi
done

echo "== Dashboard dan API"
chk "dashboard / (index.html)" "$(curl -sS --max-time 15 "${RES[@]}" "https://$DASH/" | grep -c '<div id="root"')" 1
chk "rute SPA /connections" "$(curl -sS --max-time 15 "${RES[@]}" "https://$DASH/connections" | grep -c '<div id="root"')" 1
chk "/health/ready lewat dashboard (API+DB)" "$(cc "https://$DASH/health/ready")" 200
chk "/health/ready lewat host API" "$(cc "https://$API/health/ready")" 200
chk "dashboard: /api tanpa token ditolak 401" "$(cc "https://$DASH/api/v1/auth/me")" 401
chk "host API: /api tanpa token ditolak 401" "$(cc "https://$API/api/v1/auth/me")" 401
chk "host API tidak melayani dashboard (/ = 404)" "$(cc "https://$API/")" 404
chk "rute API tidak ada = 404 (bukan 502)" "$(cc "https://$DASH/api/v1/tidak-ada")" 404
# Peramban lain TIDAK boleh mendapat izin CORS dari host API (CORS_ORIGINS kosong)
acao="$(curl -sSI --max-time 15 "${RES[@]}" -H 'Origin: https://jahat.example' "https://$API/api/v1/auth/me" | grep -i '^access-control-allow-origin:' || true)"
[ -z "$acao" ] && ok "tidak ada Access-Control-Allow-Origin untuk origin asing" || bad "CORS terbuka: $acao"

if [ "${VERIFY_AUTH:-0}" = 1 ]; then
  echo "== Akun, cookie, token, WebSocket (membuat 1 akun uji)"
  EMAIL="verify-$(openssl rand -hex 5)@example.com"; PASS="$(openssl rand -hex 12)Aa1!"
  R="$(curl -sS --max-time 15 "${RES[@]}" -D /tmp/wzp.h.$$ -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"tenant_name\":\"Verifikasi\"}" "https://$DASH/api/v1/auth/register")"
  TOKEN="$(printf %s "$R" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  [ -n "$TOKEN" ] && ok "register menghasilkan access token" || bad "register gagal: $(printf %s "$R" | cut -c1-200)"
  CK="$(grep -i '^set-cookie:' /tmp/wzp.h.$$ | head -1)"; rm -f /tmp/wzp.h.$$
  echo "$CK" | grep -qi 'secure' && ok "cookie refresh: Secure" || bad "cookie refresh TANPA Secure"
  echo "$CK" | grep -qi 'httponly' && ok "cookie refresh: HttpOnly" || bad "cookie refresh TANPA HttpOnly"
  echo "$CK" | grep -qi 'samesite=strict' && ok "cookie refresh: SameSite=Strict" || bad "cookie refresh bukan SameSite=Strict: $CK"
  echo "$CK" | grep -qi 'domain=' && bad "cookie refresh memakai Domain= (harus host-only): $CK" || ok "cookie refresh host-only (tanpa Domain=)"
  chk "GET /auth/me dengan token (dashboard)" "$(cc -H "authorization: Bearer $TOKEN" "https://$DASH/api/v1/auth/me")" 200
  chk "GET /auth/me dengan token (host API)" "$(cc -H "authorization: Bearer $TOKEN" "https://$API/api/v1/auth/me")" 200
  O="$(WAZAP_BACKEND_DIR="$ROOT/backend" WS_RESOLVE_HOST="$DASH" WS_URL="https://$DASH" WS_TOKEN="$TOKEN" node "$ROOT/deploy/staging/bin/ws-check.mjs" 2>&1)"
  [ "$O" = "connected transport=websocket" ] && ok "Socket.IO tersambung via WebSocket" || bad "Socket.IO: $O"
fi

if [ "${VERIFY_THROTTLE:-0}" = 1 ]; then
  echo "== TRUST_PROXY: IP klien tidak dapat dipalsukan"
  n=0; for i in $(seq 1 24); do
    c="$(cc -H 'content-type: application/json' -H "X-Forwarded-For: 10.$((RANDOM%250)).$((RANDOM%250)).$((RANDOM%250))" -d "{\"email\":\"nobody$i@example.com\",\"password\":\"salah-salah-1\"}" "https://$DASH/api/v1/auth/login")"
    [ "$c" = 429 ] && n=$((n+1)); sleep 0.25; done
  [ "$n" -ge 1 ] && ok "throttling login per-IP berlaku walau X-Forwarded-For dipalsukan ($n dari 24 ditolak)" || bad "X-Forwarded-For palsu menghindari throttling (0 dari 24 ditolak)"
fi

if [ "${VERIFY_LOCAL:-0}" = 1 ]; then
  echo "== Di server: permukaan jaringan"
  ss -ltn | awk '{print $4}' | grep -E ":($AP|$WP)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' && bad "API/pekerja mendengarkan bukan di loopback" || ok "API ($AP) dan pekerja ($WP) hanya di loopback"
  chk "health pekerja siap" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$WP/health/ready")" 200
  for p in /worker/health/ready /engine/health/ready; do curl -sS --max-time 15 "https://$DASH$p" | grep -q 'sessions_running\|engine_id' && { bad "health pekerja terekspos di $p"; WL=1; }; done
  [ "${WL:-0}" = 0 ] && ok "health pekerja tidak terekspos lewat Nginx"
  stat -c %a /var/lib/wazap/env/api.env /var/lib/wazap/env/worker.env 2>/dev/null | grep -qv '^600$' && bad "izin berkas env bukan 600" || ok "berkas env 0600"
fi
if [ "${VERIFY_TUNNEL:-0}" = 1 ]; then
  echo "== Di server: sisi origin Cloudflare Tunnel (Nginx :80)"
  oc(){ curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $1" "${@:2}" 2>/dev/null || true; }
  chk "dashboard lewat loopback (Host $DASH)" "$(oc "$DASH" http://127.0.0.1/)" 200
  chk "/health/ready lewat loopback" "$(oc "$DASH" http://127.0.0.1/health/ready)" 200
  chk "host API / = 404" "$(oc "$API" http://127.0.0.1/)" 404
  mip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
  if [ -n "$mip" ]; then nb="$(curl -sS --max-time 10 -H "Host: $DASH" "http://$mip/" 2>/dev/null)"
    case "$nb" in *'<div id="root"'*) bad "koneksi NON-loopback ($mip) dengan Host $DASH MENDAPAT dashboard: Cloudflare dapat dilewati (listen harus 127.0.0.1:80)" ;; *) ok "koneksi NON-loopback ($mip) dengan Host $DASH tidak mendapat dashboard (Cloudflare tidak dapat dilewati)" ;; esac
  else bad "IP lokal tidak terdeteksi untuk uji non-loopback"; fi
  cc "https://$DASH/health/live?verify=$RANDOM" >/dev/null; sleep 1
  L=/var/log/nginx/wazap-access.log
  if [ -r "$L" ]; then ln="$(grep ' /health/live ' "$L" | tail -n1)"
    case "$ln" in *"remote=127.0.0.1 "*|"") bad "log akses: IP pengunjung = 127.0.0.1 atau tidak ada (cloudflared tidak meneruskan CF-Connecting-IP? $ln)" ;; *"cf=-"*) bad "log akses: header CF-Connecting-IP kosong ($ln)" ;; *) ok "IP pengunjung terbaca di log akses: ${ln%% GET*}" ;; esac
  else bad "log akses $L tidak terbaca (pengguna harus anggota grup adm)"; fi
  systemctl is-active cloudflared >/dev/null 2>&1 && ok "cloudflared aktif" || bad "cloudflared tidak aktif"
fi
[ $fail = 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"; exit $fail
