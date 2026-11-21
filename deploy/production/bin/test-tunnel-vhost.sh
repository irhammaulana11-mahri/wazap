#!/usr/bin/env bash
# Uji PERILAKU vhost tunnel dengan Nginx sungguhan (tanpa root, port tinggi, tanpa menyentuh Nginx sistem). Dipakai manual dan oleh CI.
# Membuktikan: (1) WAZAP dijangkau lewat 127.0.0.1 berdampingan dengan situs lain yang memakai `listen 127.0.0.1:80` (pola server nyata) dan tidak merebut
# situs itu; (2) varian wildcard (TUNNEL_LISTEN=80) benar bila situs lain wildcard; (3) KONTROL NEGATIF: kombinasi salah (wildcard di samping situs spesifik)
# memang gagal, sehingga uji ini sensitif terhadap bug yang pernah hampir ter-deploy (Host wazap dijawab situs lain); (4) IP pengunjung dari CF-Connecting-IP
# hanya dari loopback; (5) sumber non-loopback ditolak walau memalsukan header; (6) token di query string tidak masuk log; (7) X-Forwarded-For ditimpa.
# Pemakaian: deploy/production/bin/test-tunnel-vhost.sh    Kode keluar 0 = semua lulus.
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"
command -v nginx >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || { echo "butuh nginx, node, curl" >&2; exit 2; }
T="$(mktemp -d)"; PORT=18081; UP=13995
trap 'nginx -c "$T/nginx.conf" -s stop >/dev/null 2>&1; [ -f "$T/node.pid" ] && kill "$(cat "$T/node.pid")" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/web" "$T/other"; echo '<div id="root"></div>' > "$T/web/index.html"; echo 'SITUS-LAIN' > "$T/other/index.html"
node -e "require('http').createServer((q,r)=>r.end('XFF='+q.headers['x-forwarded-for'])).listen($UP,'127.0.0.1')" & echo $! > "$T/node.pid"
fail=0; ok(){ printf '  LULUS   %s\n' "$1"; }; bad(){ printf '  GAGAL   %s\n' "$1"; fail=1; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (didapat: '$2', diharapkan: '$3')"; fi; }
body(){ curl -s -m 5 "$@" | head -c 60 | tr -d '\n'; }

# $1 = nama skenario, $2 = TUNNEL_LISTEN, $3 = gaya situs lain: specific|wildcard
setup(){
  rm -rf "$T/out"; mkdir -p "$T/out"
  TUNNEL=1 TUNNEL_LISTEN="$2" WEB_ROOT="$T/web" API_PORT=$UP ACCESS_LOG="$T/acc.log" "$D/bin/render-nginx.sh" "$T/out" 300 || return 1
  sed -i -e "s/listen 127.0.0.1:80;/listen 127.0.0.1:$PORT;/" -e "s/listen 80;/listen $PORT;/" -e "s/listen \[::\]:80;/listen [::1]:$PORT;/" "$T/out/wazap.conf"
  if [ "$3" = specific ]; then
    printf 'server { listen %s default_server; server_name _; root %s; }\nserver { listen 127.0.0.1:%s; server_name bimbel.bolinggo.org; root %s; }\n' "$PORT" "$T/other" "$PORT" "$T/other" > "$T/other.conf"
  else
    printf 'server { listen %s default_server; server_name _; root %s; }\nserver { listen %s; server_name bimbel.bolinggo.org; root %s; }\n' "$PORT" "$T/other" "$PORT" "$T/other" > "$T/other.conf"
  fi
  printf 'pid %s/n.pid;\nerror_log %s/e.log;\nevents {}\nhttp { access_log off; client_body_temp_path %s/b; proxy_temp_path %s/p; fastcgi_temp_path %s/f; uwsgi_temp_path %s/u; scgi_temp_path %s/s; include %s/other.conf; include %s/out/wazap.conf; }\n' "$T" "$T" "$T" "$T" "$T" "$T" "$T" "$T" "$T" > "$T/nginx.conf"
  nginx -t -c "$T/nginx.conf" >/dev/null 2>&1 || { bad "$1: nginx -t gagal"; return 1; }
  nginx -c "$T/nginx.conf"; sleep 1
}
stop(){ nginx -c "$T/nginx.conf" -s stop >/dev/null 2>&1; sleep 1; }
H="Host: wazap.bolinggo.org"; B="Host: bimbel.bolinggo.org"; U="http://127.0.0.1:$PORT"

echo "== 1. Bawaan (127.0.0.1:80) berdampingan dengan situs lain pada 127.0.0.1:80 (pola server nyata)"
setup bawaan 127.0.0.1:80 specific && {
  chk "WAZAP dijangkau lewat 127.0.0.1" "$(body -H "$H" $U/)" '<div id="root"></div>'
  chk "situs lain tetap dilayani" "$(body -H "$B" $U/)" 'SITUS-LAIN'
  chk "host API: / = 404 JSON" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: api-wazap.bolinggo.org' $U/)" 404
  chk "IP pengunjung dari CF-Connecting-IP (koneksi loopback)" "$(body -H "$H" -H 'CF-Connecting-IP: 9.9.9.9' $U/api/v1/x)" 'XFF=9.9.9.9'
  chk "tanpa header: XFF = 127.0.0.1" "$(body -H "$H" $U/api/v1/x)" 'XFF=127.0.0.1'
  chk "X-Forwarded-For palsu dari klien ditimpa" "$(body -H "$H" -H 'CF-Connecting-IP: 9.9.9.9' -H 'X-Forwarded-For: 8.8.8.8' $U/api/v1/x)" 'XFF=9.9.9.9'
  chk "sumber non-loopback (127.0.0.2) memalsukan header: 403" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' --interface 127.0.0.2 -H "$H" -H 'CF-Connecting-IP: 9.9.9.9' $U/)" 403
  curl -s -o /dev/null -H "$H" -H 'CF-Connecting-IP: 9.9.9.9' "$U/api/v1/x?token=RAHASIA123"
  chk "token di query tidak masuk log akses" "$(grep -c RAHASIA123 "$T/acc.log")" 0
  grep -q 'remote=9.9.9.9 conn=127.0.0.1' "$T/acc.log" && ok "log akses mencatat IP pengunjung dan alamat koneksi asli" || bad "log akses tidak memuat remote=9.9.9.9 conn=127.0.0.1"
  stop; }

echo "== 2. Varian wildcard (TUNNEL_LISTEN=80) di samping situs lain yang juga wildcard"
setup wildcard 80 wildcard && {
  chk "WAZAP dijangkau" "$(body -H "$H" $U/)" '<div id="root"></div>'
  chk "situs lain tetap dilayani" "$(body -H "$B" $U/)" 'SITUS-LAIN'
  stop; }

echo "== 3. Kontrol negatif: wildcard di samping situs spesifik HARUS gagal (membuktikan uji ini sensitif)"
setup negatif 80 specific && {
  r="$(body -H "$H" $U/)"; [ "$r" = 'SITUS-LAIN' ] && ok "kombinasi salah terdeteksi: Host wazap dijawab situs lain (bug yang dicegah rancangan ini)" || bad "kombinasi salah TIDAK terdeteksi (uji tidak sensitif): '$r'"
  stop; }

[ $fail = 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"; exit $fail
