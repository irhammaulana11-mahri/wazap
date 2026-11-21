# Vhost produksi WAZAP: dashboard (@DASH_HOST@) dan API (@API_HOST@). Dirender oleh bin/render-nginx.sh; JANGAN diedit di /etc.
# Placeholder: @DASH_HOST@ @API_HOST@ @CERT_DIR@ @WEB_ROOT@ @API_PORT@ @HSTS_MAX_AGE@ @LOC_FILE@
# Rancangan (ADR-050): dashboard memproksikan /api dan Socket.IO di host YANG SAMA (satu origin; cookie refresh SameSite=Strict, tanpa CORS).
# Host API melayani API yang sama untuk integrasi (API key, webhook, Socket.IO); CORS_ORIGINS sengaja kosong, jadi origin lain tidak dapat memakai
# kredensial peramban ke sana.

limit_req_zone $binary_remote_addr zone=wazap_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=wazap_auth:10m rate=5r/s;

map $http_upgrade $wazap_connection_upgrade { default upgrade; '' close; }

upstream wazap_api { server 127.0.0.1:@API_PORT@; keepalive 16; }

# HTTP: hanya tantangan ACME dan pengalihan ke HTTPS.
server {
    listen 80;
    listen [::]:80;
    server_name @DASH_HOST@ @API_HOST@;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# Dashboard
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name @DASH_HOST@;

    ssl_certificate     @CERT_DIR@/fullchain.pem;
    ssl_certificate_key @CERT_DIR@/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:wazap_tls:10m;
    ssl_session_tickets off;

    server_tokens off;
    add_header Strict-Transport-Security "max-age=@HSTS_MAX_AGE@" always;   # tanpa includeSubDomains/preload: bolinggo.org mungkin memuat layanan lain
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
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
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name @API_HOST@;

    ssl_certificate     @CERT_DIR@/fullchain.pem;
    ssl_certificate_key @CERT_DIR@/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:wazap_tls:10m;
    ssl_session_tickets off;

    server_tokens off;
    add_header Strict-Transport-Security "max-age=@HSTS_MAX_AGE@" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  "";
    proxy_set_header Forwarded         "";

    include @LOC_FILE@;

    location / { default_type application/json; return 404 '{"success":false,"error":{"code":"NOT_FOUND","message":"Route not found","details":[]}}'; }
}
