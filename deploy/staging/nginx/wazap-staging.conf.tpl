# Vhost staging WAZAP (TLS di depan API). Templat: render dengan bin/render-nginx.sh (tidak diedit tangan di /etc).
# Placeholder: @LISTEN_PORT@ @SERVER_NAME@ @CERT_DIR@ @WEB_ROOT@ @API_PORT@
#
# ATURAN TRUST_PROXY: aplikasi memakai X-Forwarded-For untuk batas laju per IP, throttling login, dan audit.
# Dengan TRUST_PROXY=true Fastify mempercayai header itu; nilai TERKIRI dianggap IP klien. Karena itu Nginx WAJIB MENIMPA
# header (X-Forwarded-For $remote_addr), bukan menambahkan ($proxy_add_x_forwarded_for): klien yang mengirim
# "X-Forwarded-For: 1.2.3.4" kalau tidak bisa memalsukan IP-nya dan menghindari throttling login. API juga WAJIB
# hanya mendengarkan 127.0.0.1 (HOST=127.0.0.1), kalau tidak port API dapat dipanggil langsung dengan header palsu.

limit_req_zone $binary_remote_addr zone=wazap_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=wazap_auth:10m rate=5r/s;

map $http_upgrade $wazap_connection_upgrade { default upgrade; '' close; }

upstream wazap_api { server 127.0.0.1:@API_PORT@; keepalive 16; }

server {
    listen @LISTEN_PORT@ ssl;
    listen [::]:@LISTEN_PORT@ ssl;
    http2 on;
    server_name @SERVER_NAME@;

    ssl_certificate     @CERT_DIR@/fullchain.pem;
    ssl_certificate_key @CERT_DIR@/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:wazap_tls:10m;
    ssl_session_tickets off;

    server_tokens off;
    add_header Strict-Transport-Security "max-age=300" always;   # staging: pendek; produksi 31536000 setelah yakin
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    # Header proxy seragam. X-Forwarded-For DITIMPA (lihat catatan di atas); header turunan lain dari klien dibuang.
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  "";
    proxy_set_header Forwarded         "";

    # Socket.IO (WebSocket). Lokasi lebih panjang menang atas /api/.
    location /api/v1/realtime/ {
        proxy_pass http://wazap_api;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $wazap_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # Titik masuk kredensial: lebih ketat daripada API umum (batas aplikasi tetap berlaku).
    location ~ ^/api/v1/auth/(login|register|reset-password|join-requests|deleted-workspaces|restore-workspace)$ {
        limit_req zone=wazap_auth burst=10 nodelay;
        limit_req_status 429;
        client_max_body_size 64k;
        proxy_pass http://wazap_api;
    }

    location /api/ {
        limit_req zone=wazap_api burst=60 nodelay;
        limit_req_status 429;
        client_max_body_size 1m;
        proxy_read_timeout 60s;
        proxy_pass http://wazap_api;
    }

    location /health/ {
        proxy_pass http://wazap_api;
    }

    # Dashboard (berkas statis hasil build, SPA). Rute klien jatuh ke index.html.
    location /assets/ {
        root @WEB_ROOT@;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location / {
        root @WEB_ROOT@;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        try_files $uri /index.html;
    }
}
