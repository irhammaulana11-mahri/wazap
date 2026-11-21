# Lokasi API bersama (di-include oleh vhost dashboard DAN vhost API). Dirender oleh bin/render-nginx.sh. Placeholder: @API_PORT@
# ATURAN TRUST_PROXY (ADR-040): X-Forwarded-For WAJIB ditimpa ($remote_addr), bukan ditambah; API WAJIB HOST=127.0.0.1.

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

    # Ekspor data: unduhan streaming berkas besar; jangan di-buffer dan beri waktu panjang.
    location ~ ^/api/v1/exports/ {
        limit_req zone=wazap_api burst=10 nodelay;
        limit_req_status 429;
        client_max_body_size 64k;
        proxy_read_timeout 600s;
        proxy_buffering off;
        proxy_pass http://wazap_api;
    }

    location /api/ {
        limit_req zone=wazap_api burst=60 nodelay;
        limit_req_status 429;
        client_max_body_size 20m;   # unggah media pesan (batas aplikasi MEDIA_MAX_BYTES berlaku lebih dulu)
        proxy_read_timeout 60s;
        proxy_pass http://wazap_api;
    }

    location /health/ {
        proxy_pass http://wazap_api;
    }
