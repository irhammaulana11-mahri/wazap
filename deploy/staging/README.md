# Staging WAZAP (TLS + API/worker terpisah)

Tanpa rahasia di berkas ini. Rahasia dibuat acak di `~/.config/wazap-staging/` (0600, di luar repo). Keputusan: ADR-040.

| Berkas | Fungsi |
|---|---|
| `bin/make-env.sh` | membuat `api.env` + `worker.env` (JWT baru, **kunci master baru**, kredensial DB disalin dari `backend/.env.staging`); tidak menimpa yang ada |
| `bin/make-cert.sh` | sertifikat self-signed (SAN `staging.wazap.test`) |
| `bin/run.sh` | peluncur PM2 (memuat env 0600, `exec node`); PM2 tidak punya `env_file` |
| `ecosystem.config.cjs` | `wazap-stg-api` (:3100, loopback) dan `wazap-stg-engine` (worker, health :8101 loopback) |
| `nginx/*.tpl`, `bin/render-nginx.sh` | vhost TLS (templat) dan penyaji |
| `bin/install-nginx.sh` | pasang ke Nginx sistem (**sudo**; hanya menambah satu berkas; `nginx -t` sebelum reload) |
| `bin/verify.sh` | gerbang staging dari luar lewat TLS (22+ pemeriksaan) |

## Urutan
```bash
deploy/staging/bin/make-env.sh        # lalu CADANGKAN CREDENTIAL_ENCRYPTION_KEYS (password manager + salinan offline)
deploy/staging/bin/make-cert.sh
(cd backend && npm run build && set -a && . ~/.config/wazap-staging/api.env && set +a && npm run migrate:prod)
pm2 start deploy/staging/ecosystem.config.cjs
sudo deploy/staging/bin/install-nginx.sh      # menambah vhost :8443 dan baris /etc/hosts; situs lain tidak diubah
deploy/staging/bin/verify.sh                  # harus "SEMUA LULUS"
```
Urutan deploy ulang: build -> `migrate:prod` -> `pm2 restart wazap-stg-engine` -> `pm2 restart wazap-stg-api`.

## Catatan
- Nginx WAJIB menimpa `X-Forwarded-For` dan API WAJIB `HOST=127.0.0.1` (ADR-040; `verify.sh` membuktikannya).
- Sertifikat self-signed: browser akan memperingatkan; untuk produksi pakai CA sungguhan (Let's Encrypt) dan naikkan HSTS.
- `verify.sh` membuat satu akun uji acak di DB staging; aman dibiarkan (staging).
- Tanpa sudo, vhost yang sama dapat diuji dengan `nginx -c` milik user biasa (lihat `nginx/user-nginx.conf.tpl`).
