# Test Plan

## Test layers

-   Unit: services, state transitions, validators, scheduling.
-   Integration: PostgreSQL transactions, RLS, queue claim, lease.
-   Contract: OpenAPI, REST schemas, Socket.IO and webhook payloads.
-   E2E: registration through session connection and message job
    lifecycle.
-   Security: tenant isolation, auth, API scopes, SSRF, secret leakage.
-   Resilience: engine crash, worker crash, DB interruption, network
    disconnect.
-   Load: concurrent API submissions, active sessions, queue throughput,
    DB pool.

## Test environment

Use test tenant, test numbers/accounts, isolated database and explicit
cleanup. Never run destructive or load tests against production WhatsApp
accounts without approval.

## Required evidence

Record test command, environment, result, logs (sanitized), and commit
hash.

## Status pengujian (Fase G, 2026-11-19)

-   `npm test`: 193 tes (unit + integrasi DB + realtime + e2e), stabil 2 kali berturut-turut. `npm run test:perf`: 6 validasi
    EXPLAIN + throughput dasar pada ~1,3 juta baris (di luar `npm test`).
-   Uji manual dengan WhatsApp nyata (lolos): pairing QR, kirim teks/media/bulk, receipt DELIVERED/READ, pesan masuk, webhook
    (tanda tangan), restart tanpa QR, unlink, nomor tidak terdaftar, idempotensi.
-   **Belum ada:** uji beban multi-koneksi/multi-sesi, uji ketahanan (chaos: kill engine saat kirim di lingkungan nyata),
    SAST/DAST, uji penetrasi, uji frontend end-to-end, uji pemisahan role DB.

## Pembaruan (Fase H, 2026-11-19)

`npm test`: 212 tes (193 + Team 10 + Usage 9), stabil 2 kali berturut-turut. `npm run test:perf`: 8 validasi (termasuk kueri usage/filter tanggal dan latensi layanan usage).
Tes Team mencakup matriks peran, OWNER terakhir, balapan dua OWNER, undangan end-to-end, keamanan token, penegakan RLS di tingkat SQL, ditangguhkan/dihapus kehilangan akses,
`switch-tenant`. Tes Usage mencakup batas rentang inklusif-eksklusif, zona waktu Asia/Jakarta (tepat tengah malam lokal), bucket kosong, filter sesi, validasi, otorisasi, isolasi tenant.

## Pembaruan (Fase H2, 2026-11-19; `npm test` kini 230 tes termasuk `config.test.ts`)

`npm test`: 227 tes (212 + Audit 8 + Settings 7), stabil 2 kali. `npm run test:perf`: 9 validasi (audit 100 ribu baris memakai indeks). Tes audit mencakup kelengkapan aksi/pelaku/ip/request_id, tidak ada jejak untuk penolakan/no-op,
tidak ada rahasia di jejak, append-only dan isolasi di tingkat SQL, pemalsuan pencatatan, retensi. Tes settings mencakup izin, rentang/ceiling, di bawah pemakaian, berlaku seketika pada penegakan kuota, audit, kontrol ceiling lewat env.

## Pembaruan (code-review, 2026-11-20)

`npm test`: 238 tes (230 + `review-fixes.test.ts` 8), stabil 2 kali. Regresi mencakup: filter rahasia audit (batas kata), kuota pada reissue, pencabutan undangan (ditangguhkan/diturunkan/dihapus/keluar; promosi dan
undangan lain tidak tersentuh), pencabutan API key saat dihapus (ditangguhkan tidak), zona waktu offset ditolak dan konsisten dengan PostgreSQL, satu definisi kunci tim, dan ceiling yang diturunkan.

## Fase H3 --- permintaan bergabung (`backend/test/join.test.ts`, 10 tes)

Normalisasi kode; kode tampil sekali dan hanya hash di DB; alur penuh (daftar -> `JOIN_PENDING` -> setujui -> login); kode salah/diputar/dinonaktifkan seragam 404 tanpa membuat akun; email terdaftar wajib kata sandi;
matriks wewenang (ADMIN tidak dapat memberi ADMIN/OWNER, MEMBER ditolak); tolak dan kedaluwarsa; kuota anggota saat persetujuan; validasi; serangan RLS langsung (setuju sendiri, membuat membership, permintaan tanpa kode/email palsu/user_id orang lain).

Tambahan (batas antrean dan retensi): antrean penuh 409 tanpa membuat akun, tempat bebas setelah ditolak, tenant lain terpisah, pengajuan ganda spesifik, kedaluwarsa tidak dihitung, 6 pengajuan serentak dengan batas 3 (tepat 3), cakupan kebijakan RLS antrean, dan retensi (hapus yang lama, simpan yang baru/menunggu, idempoten, keanggotaan tidak ikut terhapus). Total 252 tes.

## Fase H4 --- akun, pemulihan, ganti nama, hapus workspace (`backend/test/account.test.ts`, 15 tes)

Kode pemulihan sekali tampil; ganti kata sandi (sesi lain mati, sesi ini lanjut, 403 bukan 401); API key tidak dapat memakai endpoint akun; reset dengan kode (seragam, sekali pakai, serentak hanya satu menang, sesi dicabut); pemohon bergabung dan alat operator;
ganti email lintas tenant dan penjaga RLS/trigger keanggotaan; keluar dari semua perangkat; edit API key (scope berlaku seketika); ganti nama sesi dan workspace; hapus workspace (konfirmasi, akses berhenti, integrasi mati, retensi menghapus permanen, tenant lain utuh); platform tidak dapat menghapus tenant ACTIVE. Total 267 tes.

Tambahan H4 lanjutan (`account.test.ts` kini 18 tes): 8 kode pemulihan (tiap kode sekali pakai, sisa tetap berlaku, himpunan baru menghanguskan yang lama, status `me.recovery`, konfirmasi), audit reset ke semua workspace anggota dan audit `join_request.created` dengan pemalsuan SQL ditolak,
RLS `user_recovery_codes`, dan pemulihan workspace terhapus (hanya OWNER, masa tunggu, yang kembali dan tidak kembali). Total 270 tes.

## Uji ketahanan (`backend/test/resilience.test.ts`, 12 tes; 2026-11-20)

Gangguan yang disimulasikan dan yang ditegaskan (data tidak rusak DAN sistem pulih tanpa restart):

| Gangguan | Yang dibuktikan |
|---|---|
| Koneksi idle diputus server (`pg_terminate_backend`) | proses tidak crash; query berikutnya memakai koneksi baru |
| Koneksi putus di tengah transaksi | tx menolak; konteks RLS tidak bocor ke koneksi berikutnya; tanpa konteks data tenant tidak terlihat |
| DB tidak terjangkau (port tertutup) | `503 SERVICE_UNAVAILABLE` < 3 dtk, `Retry-After`, tanpa bocor host/port/stack; `/health/live` 200, `/health/ready` 503 |
| Engine kehilangan seluruh koneksi DB | tick berikutnya pulih, sesi tetap CONNECTED, pesan terkirim tepat sekali (tanpa ganda/hilang) |
| Engine di-stop saat pesan sedang dikirim | pesan selesai SENT (bukan UNKNOWN); sesi kembali PENDING_ASSIGNMENT; lease lepas |
| Leader control-plane diputus | tepat satu leader sepanjang waktu (sampel `pg_locks`); leader baru terpilih; rekonsiliasi lanjut |
| Tiga control-plane merekonsiliasi paralel | 12 sesi ditempatkan tepat sekali (fencing token = 1), kapasitas tidak terlampaui |
| Relay outbox mati sebelum commit | event tetap PENDING, tanpa delivery setengah jadi dan tanpa NOTIFY; relay berikutnya mengirim tepat sekali |
| Pengirim webhook mati setelah kirim, sebelum catat hasil | dikirim ulang setelah klaim habis; `event_id` dan `delivery_id` stabil (penerima dapat dedup) |
| Koneksi LISTEN realtime diputus | sambung ulang, klien menerima `realtime.resync`, event berikutnya sampai |
| Poller menemui galat | loop lanjut; `stop()` menunggu iterasi berjalan |

Uji mutasi: mematikan tiap perbaikan (listener error pool, pengecekan koneksi leader, pemetaan 503) membuat tes terkait GAGAL
(termasuk `uncaughtException` nyata pada pool tanpa listener). `npm test`: 282 lulus.

Belum diuji: pemutusan jaringan ke server WhatsApp pada Baileys sungguhan (hanya adapter palsu), penuhnya disk/WAL, kegagalan
PostgreSQL berkepanjangan melebihi TTL lease (perilaku lease sudah diuji terpisah di engine.test.ts), dan beban tinggi (lihat LOAD_TEST_PLAN).

## Proses pekerja terpisah (`backend/test/worker.test.ts`, 10 tes; ADR-039)

`parseRoles`; shutdown fatal (kode 1) vs biasa (0); health server (live/ready/405/404); kunci singleton (nama sama ditolak, pulih setelah koneksi putus,
`onFatal` bila pihak lain merebut kunci, deterministik dengan gerbang koneksi); `assertSchemaMigrated`; komposisi in-process (API hanya menulis DB,
pekerja menempatkan sesi, menyambungkan, mengirim pesan, shutdown rapi mengembalikan sesi ke antrean dan melepas kunci; salah-start kedua ditolak);
PROSES SUNGGUHAN `src/worker.ts` (siap lewat HTTP, proses kedua nama sama keluar kode 1, SIGTERM => kode 0 + engine STOPPED + log bersih; schema belum
dimigrasi dan peran salah ketik => kode 1). Uji mutasi: tanpa kunci singleton, 3 tes gagal (satu menggantung karena proses kedua tak pernah keluar).

## Gerbang staging (`deploy/staging/bin/verify.sh`; ADR-040)
Dijalankan dari luar lewat TLS Nginx terhadap `NODE_ENV=production`, role DB terpisah, API dan worker proses PM2 berbeda: TLS (1.1 ditolak, 1.3 ada, HSTS,
nosniff, versi Nginx tidak bocor), dashboard + fallback SPA, `/health/ready`, register/login/`/auth/me`, atribut cookie refresh, Socket.IO via WebSocket di balik TLS,
IP klien tidak dapat dipalsukan lewat `X-Forwarded-For` (24 percobaan login berkecepatan di bawah `limit_req` => throttling aplikasi menolak), API/worker hanya di loopback,
health worker tidak terekspos. Uji mutasi: `$proxy_add_x_forwarded_for` membuat pemeriksaan XFF GAGAL (0/24). Belum: Nginx sistem, domain publik, WhatsApp sungguhan.

## Identitas chat (`backend/test/chat-identity.test.ts`, 8 tes; ADR-041)
Keluar-lalu-LID, LID-lalu-keluar, LID tanpa nomor setelah pasangan dikenal, LID tanpa pasangan lalu digabung (pesan dipindah tanpa hilang), kontak/sesi berbeda tidak digabung,
penulis paralel tidak menduplikasi, duplikat lama pulih (bentuk data staging), dan E2E lewat engine+API (`/chats` total 1). Uji mutasi: `inbox.ts` lama membuat E2E GAGAL (`expected 1, actual 2`).
Bug ini hanya terlihat dengan WhatsApp sungguhan: adapter palsu tidak memakai LID. `npm test`: 300 lulus.

## Body JSON kosong (`backend/test/empty-body.test.ts`, 4 tes; ADR-042)
Konfirmasi kode pemulihan dan logout dengan `content-type: application/json` tanpa body => bukan 400; rute berbody tetap 400 `VALIDATION_ERROR`; JSON rusak, `__proto__`/`constructor` ditolak 400; batas ukuran 413 utuh.
Bug hanya muncul dari browser asli (header selalu ada), tidak dari `inject`. `npm test`: 304 lulus.

## Uji WhatsApp sungguhan di staging (2026-11-20)
Manual terpandu dengan nomor nyata, diverifikasi lewat DB (konteks platform, hanya baca), log worker, dan penerima webhook nyata (`deploy/staging/tools/webhook-receiver.mjs`).
| Area | Hasil |
|---|---|
| Pairing, restart API, restart engine | lulus (pulih 11 dtk tanpa QR) |
| Putus perangkat dari ponsel | lulus (LOGGED_OUT, kredensial terhapus, riwayat utuh, pairing ulang) |
| Teks, gambar, dokumen keluar; teks, gambar, video, dokumen masuk | lulus (receipt READ) |
| SSRF media (8 variasi) | lulus (semua 422) |
| Webhook: HMAC, retry, redirect, replay, pemulihan | lulus (event_id/delivery_id stabil) |
Bug nyata yang hanya terlihat di sini: chat ganda LID vs nomor (ADR-041), body JSON kosong dari browser (ADR-042). Tes otomatis lama tidak menangkapnya karena adapter palsu dan `inject` tidak meniru WhatsApp/browser.

## CI (`.github/workflows/ci.yml`; ADR-043)
Job `backend` (PostgreSQL 18, role non-superuser): migrasi, typecheck, build, tes lewat `scripts/ci-test.sh`. Job `deploy-config`: sintaks skrip dan `nginx -t` vhost. Job `hygiene`: bit executable, tanpa berkas env/rahasia. Job `audit`: `npm audit` informatif.
Cara menjalankan lokal seperti CI: `env -i PATH=$PATH HOME=$HOME DB_HOST=... DB_DATABASE=... DB_USERNAME=... DB_PASSWORD=... JWT_SECRET=... backend/scripts/ci-test.sh` (tanpa `.env`).
Pagar: tes dilewati/dibatalkan/kurang dari `MIN_TESTS` (280) = gagal. Naikkan `MIN_TESTS` bila jumlah tes bertambah banyak. Pagar migrasi: `backend/scripts/check-migrations.sh <base>`.

## Perf auth state (`backend/test/perf/auth-store.perf.ts`, 2 tes; ADR-044)
Bukan bagian `npm test` (jalankan lewat `npm run test:perf` atau langsung). Menegaskan `open()` konstan pada 30 ribu baris, `get`/`set`/erase cepat, dan 50 sesi bersamaan >1.000 op/dtk tanpa galat. Uji mutasi: `open()` yang memuat semua baris membuat tes gagal (p95 130 ms).

## Kontrak OpenAPI (`test/openapi.test.ts` 6 tes, `test/contract.test.ts` 2 tes, mode kontrak; ADR-045)
-   `npm run test:contract` (dipakai CI): seluruh suite dengan `WAZAP_CONTRACT_CHECK=1`; tiap response asli divalidasi terhadap skema terbit, pelanggaran membuat proses keluar kode 1. 313 tes, 0 pelanggaran.
-   `openapi.test.ts`: route <-> dokumen lengkap dua arah, `$ref` terselesaikan, parameter path cocok, keamanan turunan guard, skema request strict, dan `openapi.json` mutakhir (`npm run openapi` bila gagal).
-   `contract.test.ts`: siklus webhook penuh (9 operasi), logout/logout-all, health, dan galat standar.
-   Uji mutasi: field wajib diganti nama, tipe diubah (`attempts` string), `secret` diganti nama, dokumen satu route dihapus: semuanya gagal dengan pesan yang menunjuk operasinya.

## Operasi produksi (ADR-046)
-   `test/rotate-cli.test.ts` (3 tes): CLI `keys:rotate` sebagai proses terpisah; dry-run tidak mengubah, rotasi nyata, kunci lama lalu dapat dipensiunkan, idempoten; pensiun dini => exit 2 tanpa membocorkan rahasia/kunci; konfigurasi salah => exit 1.
-   `test/runbook-docs.test.ts` (6 tes): perintah `npm run`, berkas, nama env, teks log/kode galat, angka batas laju/retensi di RUNBOOK dan BACKUP_RESTORE sama dengan kode; pagar skrip cadangan tetap ada.
-   Skrip cadangan (uji manual lokal, hasil di BACKUP_RESTORE.md "Bukti"): pagar role, dump gagal tanpa berkas sisa, cadangan utuh + checksum, hitung baris, retensi, kegagalan rapi bukan superuser. Latihan pemulihan penuh pada staging nyata (2026-11-20) LULUS: 27 tabel, 3.213 baris sama persis, RLS ENABLE+FORCE, 75 kebijakan, migrasi 0018 (rincian di BACKUP_RESTORE.md "Bukti").

## Frontend (ADR-047)
-   CI job `frontend`: `npm ci`, `tsc --noEmit`, `vite build`. Belum ada tes unit/komponen/E2E peramban (celah yang diketahui).
-   `test/frontend-contract.test.ts` (2 tes): semua panggilan `/api/v1/...` di `frontend/src` ada di `openapi.json` (path dan method; path Socket.IO `/api/v1/realtime` dikecualikan eksplisit), dan tidak ada rahasia/berkas `.env` di frontend. Mutasi: klien lama dipulihkan atau endpoint diganti nama => gagal.
