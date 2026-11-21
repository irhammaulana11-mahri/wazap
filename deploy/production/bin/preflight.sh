#!/usr/bin/env bash
# Pemeriksaan SEBELUM memasang WAZAP di server yang sudah dipakai aplikasi lain. HANYA MEMBACA: tidak mengubah file, tidak memasang apa pun, tidak mencetak
# rahasia (tidak membaca berkas env/kunci). Satu-satunya lalu lintas keluar: permintaan HEAD ke 5 host (npm, GitHub, Telegram, WhatsApp, Let's Encrypt).
# Jalankan DI SERVER sebagai pengguna yang akan menjalankan aplikasi (bukan root):   deploy/production/bin/preflight.sh | tee preflight.txt
# Mendeteksi (heuristik rentang IP) bila DNS lewat Cloudflare, yang mengubah cara IP pengunjung dibaca.
# Env: DASH_HOST API_HOST API_PORT(3000) WORKER_HEALTH_PORT(8101)  SERVER_IP (IP publik server yang Anda ketahui; untuk dibandingkan dengan DNS)
# Keluaran: LULUS / PERINGATAN / GAGAL / INFO. Kode keluar 1 bila ada GAGAL. Tempel preflight.txt ke percakapan (tinjau dulu bila ada nama aplikasi yang tak ingin dibagikan).
DASH="${DASH_HOST:-wazap.bolinggo.org}"; API="${API_HOST:-api-wazap.bolinggo.org}"; AP="${API_PORT:-3000}"; WP="${WORKER_HEALTH_PORT:-8101}"
nf=0; nw=0
ok(){ printf '  LULUS       %s\n' "$*"; }; wn(){ printf '  PERINGATAN  %s\n' "$*"; nw=$((nw+1)); }; ng(){ printf '  GAGAL       %s\n' "$*"; nf=$((nf+1)); }; inf(){ printf '  INFO        %s\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
S=""; if [ "$(id -u)" != 0 ] && have sudo && sudo -n true 2>/dev/null; then S="sudo -n"; fi
sec(){ printf '\n== %s\n' "$*"; }

sec "1. Sistem dan pengguna"
inf "OS: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}") | kernel $(uname -r) | arsitektur $(uname -m)"
inf "pengguna: $(id -un) (uid $(id -u)); grup: $(id -Gn | tr ' ' ',')"
[ "$(id -u)" = 0 ] && ng "dijalankan sebagai root: jalankan aplikasi sebagai pengguna biasa khusus" || ok "bukan root"
[ -n "$S" ] && ok "sudo tanpa kata sandi tersedia (pemeriksaan Nginx/PostgreSQL lebih lengkap)" || inf "sudo tanpa kata sandi TIDAK tersedia: beberapa pemeriksaan (nginx -T, sertifikat) dibatasi; langkah pemasangan tetap butuh sudo"
ts="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"; [ "$ts" = yes ] && ok "jam tersinkron NTP (penting untuk token, TOTP, sertifikat)" || wn "jam tidak terbukti tersinkron NTP (timedatectl: ${ts:-tidak ada})"
inf "zona waktu: $(timedatectl show -p Timezone --value 2>/dev/null || echo ?) | waktu server $(date '+%F %T %z')"

sec "2. Sumber daya"
mem="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)"; tot="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"; sw="$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)"
inf "RAM total ${tot} MB, tersedia ${mem} MB, swap ${sw} MB, CPU $(nproc) inti, beban $(cut -d' ' -f1-3 /proc/loadavg)"
[ "$mem" -ge 1500 ] && ok "RAM tersedia >= 1,5 GB (API + worker + 1 sesi sekitar 0,25 GB; tiap sesi WhatsApp menambah ~50-100 MB)" || wn "RAM tersedia ${mem} MB: sempit untuk API + worker + PostgreSQL"
for p in / /var/lib /var/www /var/backups /tmp; do [ -d "$p" ] || continue; a="$(df -Pm "$p" | awk 'NR==2{print $4}')"; pc="$(df -P "$p" | awk 'NR==2{print $5}')"; inf "disk $p: bebas ${a} MB (terpakai $pc) di $(df -P "$p" | awk 'NR==2{print $1}')"; done
a="$(df -Pm / | awk 'NR==2{print $4}')"; [ "$a" -ge 5000 ] && ok "ruang bebas di / >= 5 GB" || wn "ruang bebas di / hanya ${a} MB"

sec "3. Perangkat lunak"
if have node; then v="$(node -p 'process.versions.node')"; mj="${v%%.*}"; inf "node $v"; [ "$mj" -ge 22 ] && ok "Node >= 22" || ng "Node $v: wajib >= 22 (pasang via nvm/NodeSource untuk pengguna ini; JANGAN mengubah Node sistem yang dipakai aplikasi lain)"; else ng "node tidak ada"; fi
have npm && inf "npm $(npm -v)" || ng "npm tidak ada"
have git && inf "$(git --version)" || ng "git tidak ada"
have openssl && inf "$(openssl version)" || ng "openssl tidak ada"
have curl && ok "curl ada" || ng "curl tidak ada"
have flock && ok "flock ada (pemantau)" || wn "flock tidak ada (dibutuhkan monitor-check.sh)"
have psql && inf "$(psql --version)" || wn "psql (klien) tidak ada di PATH"
if have pm2; then inf "pm2 $(pm2 -v 2>/dev/null | tail -n1)"; ok "pm2 ada"; else ng "pm2 tidak ada (npm i -g pm2 untuk pengguna ini)"; fi

sec "4. PM2: bentrok nama dan daftar proses milik pengguna ini"
if have pm2; then
  names="$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s.slice(s.indexOf("[")))).forEach(a=>console.log(a.name))}catch(e){}})' 2>/dev/null)"
  inf "proses PM2 yang sudah ada: ${names:+$(echo "$names" | tr '\n' ' ')}${names:-(tidak ada)}"
  for n in wazap-api wazap-engine; do echo "$names" | grep -qx "$n" && ng "proses PM2 bernama $n sudah ada: akan bentrok" || ok "nama PM2 $n bebas"; done
  [ -e "/etc/systemd/system/pm2-$(id -un).service" ] && inf "pm2 startup sudah terpasang untuk $(id -un) (pm2 save menyimpan SEMUA proses, termasuk aplikasi lain milik pengguna ini)" || inf "pm2 startup belum terpasang untuk $(id -un)"
fi

sec "5. Port"
listen="$(ss -ltnH 2>/dev/null)"
for pt in "$AP:API" "$WP:health worker" "80:HTTP" "443:HTTPS" "5432:PostgreSQL"; do p="${pt%%:*}"; lab="${pt#*:}"
  l="$(echo "$listen" | awk -v p=":$p" '$4 ~ p"$" {print $4}' | sort -u | tr '\n' ' ')"
  if [ "$p" = "$AP" ] || [ "$p" = "$WP" ]; then
    [ -z "$l" ] && ok "port $p ($lab) bebas" || ng "port $p ($lab) SUDAH dipakai ($l): pilih port lain lewat API_PORT/WORKER_HEALTH_PORT"
  elif [ "$p" = 80 ] || [ "$p" = 443 ]; then
    [ -n "$l" ] && ok "port $p ($lab) didengarkan: $l" || wn "tidak ada yang mendengarkan port $p di server ini"
  else
    if [ -n "$l" ]; then echo "$l" | grep -qE '(^| )(0\.0\.0\.0|\*|\[::\]):5432' && wn "PostgreSQL mendengarkan di SEMUA antarmuka ($l): batasi ke loopback atau firewall" || ok "PostgreSQL hanya di loopback ($l)"; else inf "port 5432 tidak didengarkan lokal (DB jarak jauh atau port lain)"; fi
  fi
done
who80="$($S ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -oE 'users:\(\("[^"]+"' | sort -u | tr '\n' ' ')"
[ -n "$who80" ] && inf "proses di 80/443: $who80" || inf "proses pemilik port 80/443 tidak terbaca (butuh sudo)"
echo "$who80" | grep -qiE 'apache|httpd|traefik|caddy|haproxy|docker-proxy' && wn "80/443 dipegang bukan-Nginx ($who80): README mengasumsikan Nginx; vhost harus disesuaikan"

sec "6. Nginx dan bentrok vhost"
if have nginx; then
  inf "$(nginx -v 2>&1)"
  if [ -n "$S" ]; then T="$($S nginx -T 2>/dev/null)"; else T="$(nginx -T 2>/dev/null)"; fi
  T="$(printf '%s\n' "$T" | sed -e 's/[[:space:]]*#.*$//')"   # baris komentar (mis. "# listen 443 ssl default_server;" di berkas default Ubuntu) tidak boleh dihitung
  if [ -n "$T" ]; then
    echo "$T" | grep -q 'sites-enabled' && ok "konfigurasi memuat /etc/nginx/sites-enabled (install-nginx.sh memakai tata letak ini)" || wn "konfigurasi TIDAK memuat sites-enabled: install-nginx.sh tidak akan aktif; sesuaikan (conf.d?)"
    for h in "$DASH" "$API"; do echo "$T" | grep -E '^[[:space:]]*server_name' | grep -qw "$h" && ng "server_name $h SUDAH ada di konfigurasi Nginx: akan bentrok" || ok "server_name $h belum dipakai"; done
    inf "server_name yang ada: $(echo "$T" | grep -E '^[[:space:]]*server_name' | sed 's/server_name//; s/;//' | tr -s ' \n' ' ' | cut -c1-300)"
    echo "$T" | grep -qE 'listen[^;]*default_server' && inf "ada default_server di Nginx (host tak dikenal diarahkan ke sana; vhost kita memakai server_name eksplisit sehingga aman)"
    echo "$T" | grep -E 'listen[^;]*443[^;]*default_server' | grep -q . && wn "sudah ada default_server di 443: pasang dengan CATCHALL_443=0 (penampung 443 kita akan duplikat)" || ok "tidak ada default_server di 443 (penampung SNI-tak-dikenal kita aman ditambahkan)"
    if echo "$T" | grep -qE 'listen[[:space:]]+127\.0\.0\.1:80[[:space:];]'; then inf "situs lain memakai 'listen 127.0.0.1:80' (pola tunnel): pasang vhost kita dengan bawaan TUNNEL_LISTEN=127.0.0.1:80. JANGAN memakai wildcard 'listen 80' untuk situs tunnel: namanya tidak akan pernah dijangkau (terbukti)"
    elif echo "$T" | grep -qE 'listen[[:space:]]+(\[::\]:)?80[[:space:];]'; then inf "situs lain memakai listen wildcard di port 80: pasang dengan TUNNEL_LISTEN=80"; fi
    for z in wazap_api wazap_auth wazap_tls; do echo "$T" | grep -qE "zone=$z[: ]|shared:$z:|upstream $z " && ng "nama '$z' sudah dipakai di Nginx" || ok "nama zona/upstream $z bebas"; done
    nv="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"; if [ -n "$nv" ] && [ "$(printf '%s\n1.25.1\n' "$nv" | sort -V | head -n1)" = 1.25.1 ]; then ok "Nginx >= 1.25.1 (direktif 'http2 on;' didukung)"; else wn "Nginx ${nv:-?} < 1.25.1: 'http2 on;' tidak dikenal, vhost harus disesuaikan (listen 443 ssl http2)"; fi
  else wn "isi konfigurasi Nginx tidak terbaca (butuh sudo tanpa kata sandi, atau jalankan manual: sudo nginx -T | grep -E 'server_name|listen')"; fi
  $S nginx -t >/dev/null 2>&1 && ok "nginx -t lulus pada konfigurasi sekarang (basis bersih sebelum kita menambah)" || wn "nginx -t belum lulus atau tidak bisa dijalankan tanpa sudo: perbaiki dulu sebelum menambah vhost"
  systemctl is-active nginx >/dev/null 2>&1 && ok "nginx aktif" || wn "nginx tidak aktif menurut systemd"
else ng "nginx tidak ditemukan di PATH"; fi
[ -e /etc/nginx/sites-available/wazap ] && ng "/etc/nginx/sites-available/wazap sudah ada" || ok "/etc/nginx/sites-available/wazap belum ada"

sec "7. PostgreSQL"
if have psql; then
  pv=""; if [ -n "$S" ] && id postgres >/dev/null 2>&1; then pv="$($S -u postgres psql -Atqc 'show server_version' 2>/dev/null)"; fi
  if [ -n "$pv" ]; then
    inf "server PostgreSQL $pv (via sudo -u postgres)"; mj="${pv%%.*}"
    if [ "$mj" -ge 18 ]; then ok "PostgreSQL >= 18 (versi yang diuji)"
    elif [ "$mj" -ge 14 ]; then wn "PostgreSQL $mj: kode diuji di 18; minimal teknis 14 (pg_read_all_data); belum diuji di versi ini, jalankan 'npm test' terhadapnya sebelum produksi"
    else ng "PostgreSQL $mj < 14 tidak didukung"; fi
    $S -u postgres psql -Atqc "select 'ada database: '||string_agg(datname,', ' order by datname) from pg_database where not datistemplate" 2>/dev/null | sed 's/^/  INFO        /'
    $S -u postgres psql -Atqc "select exists(select 1 from pg_database where datname='wazap_prod')" 2>/dev/null | grep -q t && wn "database 'wazap_prod' sudah ada" || ok "tidak ada database bernama wazap_prod"
    r="$($S -u postgres psql -Atqc "select string_agg(rolname,', ') from pg_roles where rolname like 'wazap_%'" 2>/dev/null)"; [ -n "$r" ] && wn "role wazap_* sudah ada: $r" || ok "role wazap_app/wazap_migrator/wazap_backup belum ada"
    h="$($S -u postgres psql -Atqc "show hba_file" 2>/dev/null)"; if [ -n "$h" ] && [ -r "$h" -o -n "$S" ]; then $S grep -E '^host[[:space:]]+(all|wazap)' "$h" 2>/dev/null | grep -E '127\.0\.0\.1|::1' | grep -qE 'scram-sha-256|md5' && ok "pg_hba mengizinkan TCP loopback dengan kata sandi (scram/md5)" || wn "pg_hba: tidak terlihat aturan TCP loopback dengan kata sandi untuk 127.0.0.1; aplikasi terhubung lewat TCP (periksa: sudo grep -v '^#' $h)"; fi
    inf "max_connections=$($S -u postgres psql -Atqc 'show max_connections' 2>/dev/null) (WAZAP memakai sampai ~20 koneksi per proses; hitung bersama aplikasi lain)"
  else inf "versi server tidak terbaca (butuh sudo -u postgres, atau DB di server lain): catat versi dan lokasi DB secara manual"; fi
else inf "psql tidak ada: lewati"; fi

sec "8. DNS dan jaringan masuk"
dig4(){ if have dig; then dig +short A "$1" | tail -n1; else getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'; fi; }
dig6(){ if have dig; then dig +short AAAA "$1" | tail -n1; else getent ahostsv6 "$1" 2>/dev/null | awk 'NR==1{print $1}'; fi; }
is_cf(){ case "$1" in 104.1[6-9].*|104.2[0-3].*|172.6[4-9].*|172.7[01].*|188.114.9[6-9].*|188.114.1[01][0-9].*|162.15[89].*|141.101.*|108.162.*|198.41.*|103.21.2[44]*|103.22.2*|103.31.*|173.245.*|190.93.2[45]*|197.234.2[45]*|131.0.7[2-5].*|2606:4700:*|2400:cb00:*|2405:b500:*|2405:8100:*|2a06:98c0:*|2c0f:f248:*) return 0 ;; *) return 1 ;; esac; }
loc4="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"; loc6="$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
inf "IPv4 lokal: ${loc4:-(tidak ada)} | IPv6 lokal: ${loc6:-(tidak ada)}${SERVER_IP:+ | SERVER_IP yang Anda berikan: $SERVER_IP}"
for h in "$DASH" "$API"; do a="$(dig4 "$h")"; b="$(dig6 "$h")"
  if [ -z "$a" ] && [ -z "$b" ]; then wn "DNS $h belum ada (buat rekaman A sebelum certbot)"
  else
    inf "DNS $h: A=${a:-none} AAAA=${b:-none}"
    if [ -n "$SERVER_IP" ]; then [ "$a" = "$SERVER_IP" ] && ok "A $h = SERVER_IP" || wn "A $h (${a:-none}) berbeda dari SERVER_IP ($SERVER_IP)"; fi
    if [ -n "$b" ] && [ -z "$loc6" ]; then
      if is_cf "$b"; then inf "AAAA $h ($b) milik Cloudflare: wajar, origin tidak perlu IPv6 (Cloudflare yang menghadap pengunjung IPv6)"
      else ng "$h punya AAAA ($b) tetapi server tidak punya IPv6 global: certbot dan pengunjung IPv6 gagal; hapus AAAA atau aktifkan IPv6"; fi
    fi
  fi
done
cf=0; for h in "$DASH" "$API"; do for ip in "$(dig4 "$h")" "$(dig6 "$h")"; do [ -n "$ip" ] && is_cf "$ip" && cf=1; done; done
tun=0; { have cloudflared || systemctl is-active cloudflared >/dev/null 2>&1; } && tun=1
if [ "$cf" = 1 ] && [ "$tun" = 1 ]; then
  ok "DNS lewat Cloudflare dan cloudflared terdeteksi: jalur TUNNEL (README bagian 'Jalur untuk server ini'). Tanpa port 443/sertifikat/mode SSL Cloudflare; pasang dengan: sudo deploy/production/bin/install-nginx.sh tunnel; Service tunnel: http://127.0.0.1:80"
  systemctl is-active cloudflared >/dev/null 2>&1 && ok "cloudflared aktif" || wn "cloudflared terpasang tetapi tidak aktif"
  inf "peringatan 443/Flexible/CLOUDFLARE=1 TIDAK berlaku di mode tunnel (hanya untuk proxy ke IP publik)"
elif [ "$cf" = 1 ]; then wn "DNS $DASH/$API menunjuk ke IP CLOUDFLARE tanpa cloudflared di server ini (proxy ke IP publik). Akibat: tanpa CLOUDFLARE=1 semua pengunjung terlihat satu IP (IP Cloudflare): throttling login, batas laju, dan audit per-IP SALAH. Pasang dengan CLOUDFLARE=1; JANGAN mengubah mode SSL SE-ZONA (situs lain bisa error); batas 100 dtk per permintaan"
  if ! echo "$listen" | awk '$4 ~ /:443$/' | grep -q .; then wn "origin tidak mendengarkan 443 padahal DNS lewat Cloudflare: situs yang ada kemungkinan memakai mode SSL 'Flexible'; pakai Configuration Rule per-hostname, bukan mode se-zona (README)"; fi
else inf "DNS tidak menunjuk ke Cloudflare (rentang IP yang dikenal)"; fi
[ "$tun" = 1 ] || inf "IP publik asli (di balik NAT/cloud) hanya Anda yang tahu; port 80/443 harus terbuka dari internet (uji dari jaringan lain setelah Nginx tahap http: curl -I http://$DASH)"
if have ufw; then $S ufw status 2>/dev/null | head -1 | sed 's/^/  INFO        ufw: /'; r="$($S ufw status 2>/dev/null | grep -E "(^| )(80|443|80,443|Nginx|WWW)" | tr -s " " | tr "\n" ";")"; [ -n "$r" ] && inf "ufw aturan 80/443: $r" || inf "ufw: tidak terlihat aturan untuk 80/443 (butuh sudo, atau belum ada: 443 harus dibuka sebelum certbot/Full)"; fi
inf "iptables/nftables dan firewall penyedia (security group) tidak dapat diperiksa dari sini: pastikan 80 dan 443 terbuka, 5432/$AP/$WP tertutup dari luar"

sec "9. Sertifikat (certbot)"
if have certbot; then
  inf "$(certbot --version 2>&1)"; c="$($S certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains' | tr -s ' ' | tr '\n' ' ')"
  [ -n "$c" ] && inf "sertifikat yang ada: $c" || inf "daftar sertifikat tidak terbaca atau kosong (butuh sudo)"
  echo "$c" | grep -qE "$DASH|$API" && wn "sudah ada sertifikat untuk $DASH/$API: README membuat sertifikat baru; pakai ulang atau gabungkan secara sadar"
  systemctl list-timers 2>/dev/null | grep -q certbot && ok "timer pembaruan certbot aktif" || wn "timer certbot tidak terlihat (periksa: systemctl list-timers | grep certbot, atau cron)"
else wn "certbot tidak ada: pasang (apt install certbot) sebelum langkah 5"; fi

sec "10. Jalur keluar (HEAD, batas 8 dtk)"
for u in "https://registry.npmjs.org/" "https://github.com/" "https://api.telegram.org/" "https://web.whatsapp.com/" "https://acme-v02.api.letsencrypt.org/directory"; do
  r="$(curl -sS -o /dev/null -m 8 -w '%{http_code} %{time_connect}s' -I "$u" 2>&1 | tail -n1)"; case "$r" in 2*|3*|4*) ok "$u -> $r" ;; *) ng "$u tidak terjangkau: $r" ;; esac
done
t6="$(curl -6 -sS -o /dev/null -m 6 -w '%{http_code}' -I https://api.telegram.org/ 2>/dev/null)"; [ -n "$t6" ] && inf "IPv6 ke Telegram: $t6" || inf "IPv6 ke Telegram tidak terjangkau (aman: pengirim memakai IPv4; ini penyebab CONNECTION_FAILED acak sebelum diperbaiki)"

sec "11. Direktori yang akan dipakai"
if [ -d /var/www/wazap ]; then n="$(ls -A /var/www/wazap 2>/dev/null | wc -l)"; if [ "$n" = 0 ]; then inf "/var/www/wazap ada tetapi KOSONG (aman dipakai; ambil alih dengan: sudo chown $(id -un):$(id -gn) /var/www/wazap)"; else wn "/var/www/wazap berisi $n entri ($(ls -A /var/www/wazap | head -5 | tr '\n' ' ')): jangan tumpuk di atasnya; pakai direktori lain atau periksa dulu"; fi; fi
for d in /var/www/wazap-web /var/www/certbot /var/lib/wazap /var/backups/wazap /etc/nginx/wazap; do [ -e "$d" ] && wn "$d sudah ada ($(stat -c '%U:%G %a' "$d" 2>/dev/null))" || ok "$d belum ada"; done
inf "siapkan dengan: sudo install -d -o $(id -un) -g $(id -gn) /var/www/wazap /var/lib/wazap /var/backups/wazap"

printf '\n== RINGKASAN: %d GAGAL, %d PERINGATAN\n' "$nf" "$nw"
if [ "$nf" = 0 ]; then echo "Tidak ada penghalang. Tinjau PERINGATAN, lalu lanjut ke README langkah 0."; exit 0; else echo "Perbaiki semua GAGAL sebelum memasang."; exit 1; fi
