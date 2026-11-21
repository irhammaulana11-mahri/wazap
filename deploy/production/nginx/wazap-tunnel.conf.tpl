# Vhost produksi WAZAP untuk Cloudflare TUNNEL. Dirender oleh bin/render-nginx.sh (TUNNEL=1); JANGAN diedit di /etc.
# Placeholder: @DASH_HOST@ @API_HOST@ @WEB_ROOT@ @API_PORT@ @LOC_FILE@ @ACCESS_LOG@ @HSTS_MAX_AGE@
#
# Lalu lintas: pengunjung -> Cloudflare (TLS berakhir di sana) -> tunnel keluar -> cloudflared di server ini -> http://localhost:80 (Nginx) -> API 127.0.0.1.
# Tidak ada port 443, sertifikat, certbot, dan mode SSL Cloudflare tidak berlaku. Vhost ini memakai `listen 80` biasa dengan server_name eksplisit,
# SAMA seperti vhost situs lain di server ini, sehingga tidak mengganggu situs lain (jangan memakai listen 127.0.0.1:80: itu akan mengambil
# SEMUA permintaan lewat loopback, termasuk milik situs lain).
#
# Dua pengaman:
#  1. Hanya koneksi dari loopback (cloudflared) yang dilayani. Port 80 server terbuka untuk publik; tanpa ini siapa pun yang mengirim
#     "Host: @DASH_HOST@" langsung ke IP server melewati Cloudflare. $realip_remote_addr = alamat koneksi ASLI (sebelum diganti realip).
#  2. IP pengunjung dibaca dari CF-Connecting-IP HANYA bila koneksi dari loopback; $remote_addr menjadi IP pengunjung, sehingga aturan
#     "X-Forwarded-For $remote_addr" (ADR-040) tetap benar untuk throttling login, batas laju, dan audit.

# Log akses khusus WAZAP tanpa query string (token tidak boleh masuk log). remote = IP pengunjung (setelah realip), conn = alamat koneksi asli (cloudflared).
log_format wazap_fmt '$time_iso8601 remote=$remote_addr conn=$realip_remote_addr cf=$http_cf_connecting_ip $request_method $uri $status $request_time';

limit_req_zone $binary_remote_addr zone=wazap_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=wazap_auth:10m rate=5r/s;

map $http_upgrade $wazap_connection_upgrade { default upgrade; '' close; }

upstream wazap_api { server 127.0.0.1:@API_PORT@; keepalive 16; }

# Dashboard
server {
    listen 80;
    listen [::]:80;
    server_name @DASH_HOST@;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from ::1;
    real_ip_header CF-Connecting-IP;
    real_ip_recursive off;
    if ($realip_remote_addr !~ "^(127\.0\.0\.1|::1)$") { return 403; }

    access_log @ACCESS_LOG@ wazap_fmt;
    server_tokens off;
    # HSTS dikirim lewat tunnel dan sampai ke peramban lewat HTTPS Cloudflare. Tanpa includeSubDomains/preload (bolinggo.org memuat situs lain).
    add_header Strict-Transport-Security "max-age=@HSTS_MAX_AGE@" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  "";
    proxy_set_header Forwarded         "";

    include @LOC_FILE@;

    location /assets/ {
        root @WEB_ROOT@;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location / {
        root @WEB_ROOT@;
        add_header Cache-Control "no-cache" always;
        add_header Strict-Transport-Security "max-age=@HSTS_MAX_AGE@" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        try_files $uri /index.html;
    }
}

# API (integrasi). Tidak ada dashboard di host ini.
server {
    listen 80;
    listen [::]:80;
    server_name @API_HOST@;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from ::1;
    real_ip_header CF-Connecting-IP;
    real_ip_recursive off;
    if ($realip_remote_addr !~ "^(127\.0\.0\.1|::1)$") { return 403; }

    access_log @ACCESS_LOG@ wazap_fmt;
    server_tokens off;
    add_header Strict-Transport-Security "max-age=@HSTS_MAX_AGE@" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  "";
    proxy_set_header Forwarded         "";

    include @LOC_FILE@;

    location / { default_type application/json; return 404 '{"success":false,"error":{"code":"NOT_FOUND","message":"Route not found","details":[]}}'; }
}
