
# Penampung 443: SNI/host yang tidak dikenal DITOLAK saat handshake. Tanpa ini, server 443 pertama (dashboard WAZAP) menjadi default untuk NAMA APA PUN
# yang masuk ke 443 di server bersama ini (mis. situs lain yang kelak dialihkan ke HTTPS tanpa vhost 443-nya akan menampilkan dashboard WAZAP).
# Dimatikan dengan CATCHALL_443=0 bila vhost lain sudah punya default_server di 443 (nginx menolak duplikat; install-nginx.sh membatalkan otomatis).
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
