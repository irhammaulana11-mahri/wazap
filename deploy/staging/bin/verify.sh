#!/usr/bin/env bash
# Verifikasi staging dari luar (lewat TLS Nginx). Exit 0 = semua lulus. Membuat SATU akun uji (email acak) di DB staging.
# Env: SERVER_NAME(staging.wazap.test) TLS_PORT(8443) WAZAP_ENV_DIR WORKER_HEALTH_PORT(8101) API_PORT(3100)
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="$(cd "$D/../.." && pwd)"
NAME="${SERVER_NAME:-staging.wazap.test}"; PORT="${TLS_PORT:-8443}"; ENVDIR="${WAZAP_ENV_DIR:-$HOME/.config/wazap-staging}"
CERT="$ENVDIR/tls/fullchain.pem"; BASE="https://$NAME:$PORT"; WP="${WORKER_HEALTH_PORT:-8101}"; AP="${API_PORT:-3100}"
C=(curl -sS --max-time 15 --resolve "$NAME:$PORT:127.0.0.1" --cacert "$CERT")
fail=0; ok(){ printf '  LULUS   %s\n' "$1"; }; bad(){ printf '  GAGAL   %s\n' "$1"; fail=1; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (didapat: $2, diharapkan: $3)"; fi; }
code(){ "${C[@]}" -o /dev/null -w '%{http_code}' "$@"; }

echo "== TLS"
chk "sertifikat tepercaya (--cacert) dan HTTPS 200" "$(code "$BASE/health/live")" 200
if echo | openssl s_client -connect 127.0.0.1:$PORT -servername "$NAME" -tls1_1 2>&1 | grep -q "Cipher is (NONE)\|alert\|no protocols"; then ok "TLS 1.1 ditolak"; else bad "TLS 1.1 diterima"; fi
echo | openssl s_client -connect 127.0.0.1:$PORT -servername "$NAME" -tls1_3 >/dev/null 2>&1 && ok "TLS 1.3 tersedia" || bad "TLS 1.3 tidak tersedia"
H="$("${C[@]}" -sI "$BASE/health/live")"
echo "$H" | grep -qi '^strict-transport-security:' && ok "HSTS ada" || bad "HSTS tidak ada"
echo "$H" | grep -qiE '^server: nginx/[0-9]' && bad "versi Nginx bocor di header Server" || ok "versi Nginx tidak bocor"
echo "$H" | grep -qi '^x-content-type-options: nosniff' && ok "nosniff" || bad "nosniff tidak ada"

echo "== Dashboard dan health"
chk "/ (index.html)" "$(code "$BASE/")" 200
chk "rute SPA /connections jatuh ke index.html" "$("${C[@]}" "$BASE/connections" | grep -c '<div id="root"')" 1
chk "/health/ready (API+DB)" "$(code "$BASE/health/ready")" 200
chk "API tidak ada: 404 JSON/bukan 502" "$(code "$BASE/api/v1/tidak-ada")" 404

echo "== Akun, cookie, dan token"
EMAIL="stg-$(openssl rand -hex 5)@example.com"; PASS="$(openssl rand -hex 12)Aa1!"
R="$("${C[@]}" -D /tmp/wz.h.$$ -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"tenant_name\":\"Staging Check\"}" "$BASE/api/v1/auth/register")"
TOKEN="$(printf %s "$R" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && ok "register lewat TLS menghasilkan access token" || { bad "register gagal: $(printf %s "$R" | cut -c1-200)"; }
CK="$(grep -i '^set-cookie:' /tmp/wz.h.$$ | head -1)"; rm -f /tmp/wz.h.$$
echo "$CK" | grep -qi 'secure' && ok "cookie refresh: Secure" || bad "cookie refresh TANPA Secure: $CK"
echo "$CK" | grep -qi 'httponly' && ok "cookie refresh: HttpOnly" || bad "cookie refresh TANPA HttpOnly"
echo "$CK" | grep -qi 'samesite=' && ok "cookie refresh: SameSite" || bad "cookie refresh TANPA SameSite"
chk "GET /auth/me dengan token" "$(code -H "authorization: Bearer $TOKEN" "$BASE/api/v1/auth/me")" 200
chk "tanpa token ditolak" "$(code "$BASE/api/v1/auth/me")" 401

echo "== Realtime (WebSocket lewat TLS)"
O="$(NODE_EXTRA_CA_CERTS="$CERT" WAZAP_BACKEND_DIR="$ROOT/backend" WS_RESOLVE_HOST="$NAME" WS_URL="$BASE" WS_TOKEN="$TOKEN" node "$D/bin/ws-check.mjs" 2>&1)"
[ "$O" = "connected transport=websocket" ] && ok "Socket.IO tersambung via WebSocket" || bad "Socket.IO: $O"

echo "== TRUST_PROXY: IP klien tidak dapat dipalsukan"
n429=0; for i in $(seq 1 24); do
  c="$(code -H 'content-type: application/json' -H "X-Forwarded-For: 10.$((RANDOM%250)).$((RANDOM%250)).$((RANDOM%250))" -d "{\"email\":\"nobody$i@example.com\",\"password\":\"salah-salah-1\"}" "$BASE/api/v1/auth/login")"
  [ "$c" = 429 ] && n429=$((n429+1)); sleep 0.25; done
[ "$n429" -ge 1 ] && ok "throttling login per-IP tetap berlaku walau X-Forwarded-For dipalsukan ($n429 dari 24 ditolak 429)" || bad "X-Forwarded-For palsu menghindari throttling login (0 dari 24 ditolak)"

echo "== Permukaan jaringan"
ss -ltn | awk '{print $4}' | grep -E ":($AP|$WP)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]):' && bad "API/pekerja mendengarkan bukan di loopback" || ok "API ($AP) dan pekerja ($WP) hanya di loopback"
chk "health pekerja siap" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$WP/health/ready")" 200
# SPA fallback menjawab 200 untuk path apa pun, jadi periksa ISI: tidak boleh JSON health pekerja (engine_id/sessions_running).
for p in /worker/health/ready /health/ready:8101 /engine/health/ready; do
  "${C[@]}" "$BASE${p%%:*}" | grep -q 'sessions_running\|engine_id' && { bad "health pekerja terekspos lewat Nginx di $p"; WL=1; }; done
[ "${WL:-0}" = 0 ] && ok "health pekerja tidak terekspos lewat Nginx"

[ $fail = 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"; exit $fail
