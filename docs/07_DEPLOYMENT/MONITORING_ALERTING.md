# Rancangan pemantauan dan alarm

Status: **tahap 1 diimplementasikan** (`deploy/ops/notify.sh`, `deploy/ops/monitor-check.sh`; kanal Telegram; belum terpasang di server). Tahap 2-3 masih rancangan. Ambang A4, A6, A16 final dari uji lama 6 jam; A11, A12, A17, A23 tetap *(sementara)* sampai ada data beban (lihat bagian 8). Kanal pengiriman alarm belum diputuskan, rancangan ini netral terhadap kanal.

## 1. Prinsip
1. **Alarm = ada tindakan manusia yang harus diambil.** Metrik tanpa tindakan masuk dasbor, bukan alarm.
2. **Setiap alarm menunjuk satu playbook** di `RUNBOOK.md` (P1..P15). Alarm tanpa playbook tidak boleh dibuat.
3. **Pemeriksa harus independen dari yang diperiksa.** Pemantau berjalan sebagai proses/cron terpisah dengan kredensial baca-saja; bila API dan worker mati, pemantau tetap bisa memberi tahu.
4. **Pemantau tidak boleh menjadi tenant-aware.** Sinyal operasional memakai agregat lintas tenant lewat role pemantauan (lihat bagian 6), tanpa membaca isi pesan, nomor, atau rahasia.
5. **Kegagalan pemantau sendiri harus terdeteksi** (heartbeat luar, bagian 5).

## 2. Sumber sinyal (semua sudah ada, tanpa perubahan kode untuk tahap 1)
| Sumber | Sinyal |
|---|---|
| `GET /health/live`, `/health/ready` (API 127.0.0.1) | proses hidup; DB OK dan tidak shutdown |
| `engine_nodes` | `status` (STARTING/HEALTHY/SUSPECT/UNHEALTHY/DRAINING/STOPPED), `heartbeat_at`, `resource_snapshot` |
| `session_leases` | `lease_expires_at`, `fencing_token` |
| `sessions` | status per sesi (CONNECTED, LOGGED_OUT, dst.) |
| `outbox_events` | `status` PENDING/DISPATCHED, `created_at` (umur PENDING tertua = lag relay) |
| `webhook_deliveries` | `status` PENDING/DELIVERED/DEAD, `next_attempt_at`, `attempts` |
| `webhook_endpoints` | `disabled_at`, `consecutive_failures` |
| antrean pesan keluar | umur baris terbuka tertua, status `UNKNOWN`/`RECONCILIATION_REQUIRED` |
| `audit_logs` | aksi `data.exported` (outcome, rows, bytes) |
| `pg_stat_activity` | jumlah koneksi aplikasi, `idle in transaction` |
| PM2 (`pm2 jlist`) | `restart_time`, `status`, `unstable_restarts`, memori |
| berkas log PM2 | baris level error/fatal |
| `backup.sh` | kode keluar, umur berkas cadangan terbaru, hasil sha256 |
| sertifikat TLS | `openssl s_client` tanggal kedaluwarsa |
| CI GitHub | status workflow pada `main` |

Catatan jujur: tidak ada endpoint `/metrics` Prometheus. Tahap 1 sengaja memakai kueri SQL, PM2, dan `curl` agar bisa dipasang tanpa menyentuh kode terkunci; endpoint metrik dipertimbangkan di tahap 3.

## 3. Aturan alarm
Keparahan: **PAGE** = bangunkan orang (layanan terhenti atau data berisiko); **WARN** = kerjakan jam kerja; **INFO** = hanya catat di dasbor.

| # | Alarm | Kondisi | Tahan | Sev | Playbook |
|---|---|---|---|---|---|
| A1 | API mati | `/health/live` gagal | 2 pemeriksaan berturut (2 mnt) | PAGE | P1 |
| A2 | API tidak siap | `/health/ready` ≠ 200 | 3 mnt | PAGE | P1 |
| A3 | Worker crash loop | `worker.restart_time` naik ≥ 3 dalam 10 mnt, atau status `errored` | langsung | PAGE | P2 |
| A4 | Heartbeat engine basi | `now() - heartbeat_at` > 30 dtk *(final)* | 2 mnt | PAGE | P4 |
| A5 | Tidak ada engine HEALTHY | 0 baris `engine_nodes` HEALTHY dengan heartbeat segar | 2 mnt | PAGE | P4 |
| A6 | Lease hampir habis berulang | `lease_expires_at - now()` < 10 dtk pada ≥ 3 sampel dalam 10 mnt *(final)* | 10 mnt | WARN | P5 |
| A7 | Failover tak terduga | `fencing_token` naik tanpa restart/deploy tercatat | langsung | WARN | P5 |
| A8 | Sesi LOGGED_OUT | sesi aktif berubah ke LOGGED_OUT | langsung | WARN | P3 |
| A9 | Sesi tidak kembali CONNECTED | status ≠ CONNECTED setelah restart/deploy | 10 mnt | PAGE | P4 |
| A10 | Pesan UNKNOWN / perlu rekonsiliasi | baris status itu ada | 30 mnt | WARN | P6 |
| A11 | Antrean macet | umur baris antrean terbuka tertua > 10 mnt *(sementara)* sementara sesi CONNECTED | 10 mnt | WARN | P6 |
| A12 | Outbox menumpuk | umur `outbox_events` PENDING tertua > 2 mnt *(sementara)* | 5 mnt | WARN | P7 |
| A13 | Webhook DEAD naik | baris DEAD baru > 0 per jam per endpoint, atau endpoint `disabled_at` terisi | langsung | WARN | P7 |
| A14 | Koneksi DB tinggi | koneksi aplikasi ≥ 80% dari (pool maks × proses) | 5 mnt | WARN | P12 |
| A15 | `idle in transaction` | ada koneksi aplikasi idle in transaction > 60 dtk | 2 mnt | WARN | P12 |
| A16 | Tren memori | RSS naik monoton > 30% dalam 6 jam *(final)* | 6 jam | WARN | P2 |
| A17 | Lonjakan galat log | baris error/fatal > 20 dalam 5 mnt *(sementara; nol selama uji lama)* | 5 mnt | WARN | P1 |
| A18 | Cadangan gagal | `backup.sh` keluar ≠ 0 | langsung | PAGE | P14 |
| A19 | Cadangan basi | berkas cadangan terbaru > 26 jam (jadwal harian) | langsung | PAGE | P14 |
| A20 | Verifikasi cadangan | sha256 tidak cocok, atau latihan pemulihan bulanan gagal | langsung | PAGE | P14 |
| A21 | Disk | pakai > 80% (WARN) / > 90% (PAGE) pada volume data dan cadangan | 10 mnt | WARN/PAGE | P12 |
| A22 | Sertifikat TLS | kedaluwarsa < 21 hari (WARN) / < 7 hari (PAGE) | harian | WARN/PAGE | P13 |
| A23 | Ekspor mencurigakan | `data.exported` oleh satu pengguna > 3 dalam 1 jam, atau byte total > 500 MB/hari/workspace *(sementara)*, atau outcome `failed` ≥ 3 dalam 1 jam | langsung | WARN | P15 |
| A24 | Login brute force | 429 `RATE_LIMITED` pada login > 50 per 10 mnt dari satu IP | 10 mnt | INFO→WARN bila berlanjut 1 jam | P8 |
| A25 | CI merah di `main` | workflow gagal | langsung | WARN | (lihat bagian 7) |
| A26 | Pemantau sendiri diam | heartbeat luar tidak diterima | 5 mnt | PAGE | bagian 5 |

Aturan pengurangan bising: satu alarm yang sama tidak dikirim ulang lebih sering dari tiap 30 mnt (PAGE: tiap 15 mnt); kirim pesan "pulih" saat kondisi bersih; A24 mengelompokkan per IP.

## 4. Dasbor (untuk mata manusia, bukan alarm)
Satu halaman: status API/worker, daftar sesi dan statusnya, sisa lease, umur outbox dan antrean tertua, webhook PENDING/DEAD, koneksi DB, RSS API/worker, ekspor 24 jam terakhir, umur cadangan terbaru, hari tersisa sertifikat. Sumber sama dengan bagian 2.

## 5. Arsitektur pemantau (tahap 1, tanpa dependensi baru)
- Skrip `deploy/ops/monitor-check.sh` dijalankan cron/systemd timer tiap menit: mengumpulkan sinyal, mengevaluasi aturan bagian 3 dengan status kecil di berkas (untuk "tahan", "pulih", dan pengurangan bising), memanggil `deploy/ops/notify.sh <sev> <judul> <rincian>`.
- `notify.sh` satu-satunya titik yang tahu kanal (webhook HTTP generik, Telegram, Slack, atau berkas log). Mengganti kanal = mengganti satu skrip. Rahasia kanal di berkas env mode 0600, tidak di repo.
- **Heartbeat luar:** tiap menit pemantau memanggil URL pemantau luar (dead-man's switch, mis. layanan cek-in gratis) agar A26 terdeteksi dari luar host. Tanpa ini, host mati total = tidak ada alarm.
- **Jangan** mengirim alarm lewat sesi WhatsApp milik gateway sendiri sebagai satu-satunya kanal: saat gateway bermasalah, kanalnya ikut mati. Boleh sebagai kanal tambahan.
- Isi alarm tidak boleh memuat rahasia, nomor telepon pelanggan, atau isi pesan; hanya id internal, nama sesi, angka, dan tautan playbook.

## 6. Akses data pemantau
Sinyal SQL lintas tenant butuh melewati RLS FORCE. Pilihan, urut preferensi:
1. **Role `wazap_monitor` baca-saja dengan view agregat** (`SECURITY DEFINER` atau view milik role khusus) yang hanya mengembalikan angka dan id (tanpa kolom isi). Memerlukan migrasi baru (0020) dan tinjauan; tidak boleh BYPASSRLS penuh.
2. Memakai role `wazap_backup` (BYPASSRLS) yang sudah ada: tercepat tetapi **ditolak**: kredensial pembaca semua tenant tidak boleh dipakai cron sering-jalan.
3. Hanya sinyal non-DB (health, PM2, log, disk, cadangan, TLS): tanpa A8, A10-A13, A23. Cukup untuk hari pertama produksi.

Rekomendasi: mulai dengan opsi 3 (nol perubahan skema), tambah opsi 1 sebagai pekerjaan terpisah dengan ADR dan tes RLS-nya.

## 7. CI dan rantai pasok
A25 dibaca dari GitHub (`gh run list --branch main --limit 1`) oleh pemantau atau notifikasi bawaan GitHub. Catatan: saat ini CI GitHub terblokir masalah penagihan akun, bukan kode; selama itu `ci-test.sh` dijalankan lokal sebelum push.

## 8. Penetapan ambang final (setelah uji lama)
Ambang bertanda *(sementara)* ditetapkan ulang dari data `samples.csv` uji lama 6 jam: sebaran sisa lease, umur heartbeat, jumlah koneksi, laju kenaikan RSS, jumlah baris galat. Aturan: ambang WARN diletakkan di luar maksimum teramati dengan margin, lalu diuji dengan **injeksi kegagalan nyata** (hentikan worker, putus DB, penuhi disk kecil, ubah lease) untuk membuktikan tiap alarm menyala dan pulih. Alarm yang belum pernah terbukti menyala dianggap belum ada.

### Hasil uji lama (selesai, 2026-11-20 18:21-00:21 WIB, 358 sampel per menit, sesi CONNECTED di semua sampel, tanpa lalu lintas kirim)
| Metrik | Min | p50 | p99 | Maks | Awal -> Akhir |
|---|---|---|---|---|---|
| Sisa lease (dtk) | 20 | 25 | 30 | 30 | 24 -> 23 |
| Umur heartbeat (dtk) | 0 | 5 | 10 | 10 | 8 -> 9 |
| Koneksi DB | 5 | 6 | 8 | 11 | 6 -> 5 |
| Transaksi idle | 0 | 0 | 0 | 0 | 0 -> 0 |
| RSS worker (KB) | 76.460 | 103.004 | 129.224 | 129.236 | 124.920 -> 106.708 |
| RSS API (KB) | 75.012 | 80.784 | 141.276 | 141.280 | 125.656 -> 80.796 |
| Waktu /ready API (ms) | 3 | 8 | 22 | 30 | 9 -> 8 |

Fencing token tetap 6, jumlah restart PM2 tidak berubah (API 7, worker 5), baris galat log 0 pada API dan worker, antrean terbuka 0. RSS tidak naik monoton: akhir uji lebih rendah daripada awal (tidak ada tanda bocor memori pada beban diam).

Keputusan ambang:
-   **Final:** A4 (heartbeat > 30 dtk; maksimum teramati 10, margin 3x), A6 (sisa lease < 10 dtk pada >= 3 sampel; minimum teramati 20), A16 (RSS naik monoton > 30% dalam 6 jam; kenaikan teramati 0%).
-   **Tetap sementara:** A11, A12, A17, A23. Uji ini berjalan tanpa lalu lintas (`kirim_aktif=tidak`), sehingga umur antrean/outbox dan laju galat di bawah beban belum teramati. Tetapkan ulang setelah ada uji beban atau beberapa hari pemakaian nyata.
-   **Belum terbukti menyala:** seluruh alarm menunggu uji injeksi kegagalan (bagian 11); sampai itu selesai tetap dianggap belum ada.

## 9. Tahapan implementasi
1. **Tahap 1 (± setengah hari):** `monitor-check.sh` + `notify.sh` dengan sinyal non-DB (A1-A5 via PM2 dan health, A17-A22, A25, A26) dan kanal berkas log; uji injeksi kegagalan; dokumentasi di RUNBOOK.
2. **Tahap 2:** role `wazap_monitor` dan view agregat (ADR + migrasi 0020 + tes RLS), menambah A6-A16, A23, A24.
3. **Tahap 3 (opsional):** endpoint `/metrics` internal (terikat 127.0.0.1) dan dasbor; dipertimbangkan bila lebih dari satu host.

## 10. Keputusan yang dibutuhkan dari pemilik
- Kanal alarm utama (webhook generik / Telegram / Slack / surel) dan siapa penerima PAGE di luar jam kerja.
- Layanan heartbeat luar (dead-man's switch).
- Setuju opsi 3 untuk tahap 1 dan opsi 1 untuk tahap 2 (bagian 6).
- Jam hening dan eskalasi bila PAGE tidak diakui.

## 11. Pemasangan tahap 1 (Telegram)
1. Telegram: chat dengan @BotFather, `/newbot`, simpan token. Kirim satu pesan ke bot Anda, lalu buka `https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin `chat.id`.
2. Berkas rahasia (mode **600**, di luar repo; `notify.sh` menolak mode lain):
   ```bash
   mkdir -p ~/.config/wazap-monitor && install -m 600 /dev/null ~/.config/wazap-monitor/monitor.env
   # isi: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... MON_API_URL=http://127.0.0.1:3100 MON_PM2_API=wazap-stg-api MON_PM2_WORKER=wazap-stg-engine
   #      MON_WORKER_URL=http://127.0.0.1:8101 MON_BACKUP_DIR=/var/backups/wazap MON_DISK_PATHS="/ /var/backups/wazap" MON_LOG_FILES="<log error PM2>" MON_HEARTBEAT_URL=<URL ping>
   ```
3. Uji kanal: `deploy/ops/notify.sh WARN "uji" "pesan percobaan"` harus tiba di Telegram.
4. Jadwal tiap menit: `* * * * * /path/ke/deploy/ops/monitor-check.sh` (crontab pemilik proses).
5. **Uji injeksi kegagalan sebelum dianggap terpasang** (alarm yang belum terbukti menyala = belum ada): hentikan API (A1 menyala setelah 2 mnt, pulih saat dijalankan), matikan worker (A3/A4), tulis baris `{"level":50}` > 20 ke log (A17), ubah umur berkas cadangan (A19/A20).

Yang diverifikasi pada tahap ini (dry-run terhadap staging nyata): sehat tidak mengirim apa pun; API mati menyala hanya setelah tahan 120 dtk; pulih mengirim OK; lonjakan log; cadangan basi/checksum salah; tidak mengirim ulang di bawah jeda; berkas env bermode selain 600 ditolak; kegagalan Telegram (HTTP 401) dilaporkan dan token tidak masuk log. **Belum** diuji: pengiriman Telegram sungguhan (menunggu token), kegagalan worker/PM2 nyata dan disk (menunggu uji lama selesai agar tidak mengganggu), heartbeat luar.

Terpasang di staging (2026-11-21): cron tiap menit, `MON_BACKUP_DIR` dikosongkan sementara (A19/A20 dilewati sampai `backup.sh` berjalan di server). **Uji injeksi kegagalan nyata, hasil:**
| Alarm | Kondisi yang dibuat | Hasil |
|---|---|---|
| A3 | `pm2 stop wazap-stg-engine` | PAGE menyala ±1 mnt, pesan OK saat dijalankan lagi |
| A4 | worker mati (health tidak terjangkau) | PAGE menyala setelah tahan 120 dtk (05:10 setelah henti 05:07), OK saat pulih |
| A19 | folder cadangan kosong; dump berumur 30 jam (batas 26) | PAGE menyala keduanya, OK saat dump baru |
| A20 | dump diubah sehingga `.sha256` tidak cocok | PAGE menyala, OK saat diperbaiki |
| A17 | 25 baris `{"level":50}` ke log | WARN menyala (25 > 20), jumlah dalam jendela 5 mnt |
Uji A19/A20/A17 memakai konfigurasi dan folder sementara (tanpa Telegram); A3/A4 memakai cron dan Telegram sungguhan. **Belum diuji:** A1 (API mati), A21 (disk), A22 (TLS), heartbeat luar (A26), dan alarm tahap 2.
