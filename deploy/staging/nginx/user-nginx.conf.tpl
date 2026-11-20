# Nginx sementara tanpa root (untuk menguji vhost sebelum dipasang ke Nginx sistem). Placeholder: @RUN_DIR@ @VHOST@
pid @RUN_DIR@/nginx.pid;
error_log @RUN_DIR@/error.log notice;
worker_processes 1;
events { worker_connections 256; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log @RUN_DIR@/access.log;
    client_body_temp_path @RUN_DIR@/tmp/body;
    proxy_temp_path       @RUN_DIR@/tmp/proxy;
    fastcgi_temp_path     @RUN_DIR@/tmp/fcgi;
    uwsgi_temp_path       @RUN_DIR@/tmp/uwsgi;
    scgi_temp_path        @RUN_DIR@/tmp/scgi;
    include @VHOST@;
}
