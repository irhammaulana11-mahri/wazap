# Kesiapan produksi (dinilai 2026-11-21)

**Putusan: siap untuk PILOT TERBATAS (tenant yang dikenal, beban kecil) setelah enam gerbang di bawah lulus. BELUM siap untuk beban besar atau tenant anonim.** Kode dan fitur sudah terbukti; yang tersisa adalah infrastruktur yang hanya dapat dikerjakan di server sungguhan, ditambah tiga hal yang belum pernah diuji pada skala.
Paket penyiapan: `deploy/production/README.md`. Domain: dashboard `wazap.bolinggo.org`, API `api-wazap.bolinggo.org` (ADR-050).

## Yang sudah terbukti
| Area | Bukti |
|---|---|
| Fungsi dan isolasi | 387 tes backend lulus (0 dilewati), RLS ENABLE+FORCE pada semua tabel, uji lintas tenant, kontrak OpenAPI diperiksa tes |
| Daya tahan | uji lama 6 jam di staging: sesi CONNECTED terus, tanpa restart, tanpa baris error, memori tidak naik (`MONITORING_ALERTING.md` bagian 8) |
| Tepi jaringan | staging di belakang Nginx TLS: `verify.sh` 22+ pemeriksaan lulus, IP klien tidak dapat dipalsukan, API dan worker hanya loopback |
| WhatsApp nyata | pairing, kirim/terima, reconnect, logout terbukti di staging |
| Alarm | 5 alarm operator terbukti menyala dan pulih lewat kegagalan nyata, Telegram nyata; notifikasi workspace terbukti ujung ke ujung (perangkat diputus -> pesan tiba) |
| Cadangan | latihan pemulihan penuh pada data staging lulus (skrip dan pagar) |

## Gerbang (WAJIB lulus sebelum tenant sungguhan)
1.  **Server, DNS, TLS** (Anda): server berIP publik, A/AAAA untuk kedua nama, port 80/443 terbuka, sertifikat Let's Encrypt, `verify.sh` "SEMUA LULUS" dari luar.
2.  **Cadangan di server**: role `wazap_backup` dibuat dan diuji pada server ini, `backup.sh` terjadwal harian, **salinan di luar host**, `restore-drill.sh` lulus pada cadangan nyata. Tanpa salinan di luar host, kerusakan disk = kehilangan semua data. Catatan: tanpa WAL/PITR, RPO = interval cadangan (24 jam).
3.  **Kunci master tersimpan di dua tempat** (password manager + offline) dan sidik jarinya dicatat SEBELUM aplikasi dijalankan. Kehilangan = semua sesi WhatsApp harus dipair ulang.
4.  **Rilis lulus uji pada commit yang dirilis**: CI GitHub hijau (saat ini terblokir masalah penagihan akun, bukan kode, jadi CI belum pernah memeriksa kode terbaru) ATAU `ci-test.sh` lokal lulus dan hasilnya dicatat.
5.  **Pemantau terpasang di server produksi**: cron `monitor-check.sh`, kanal Telegram, **heartbeat dari luar host** (tanpa ini, host mati total tidak menghasilkan alarm apa pun), dan uji kegagalan diulang di server ini (termasuk A1 API mati dan disk, yang belum pernah diuji).
6.  **Uji nyata di produksi**: pairing WhatsApp, kirim/terima, webhook ke penerima nyata, kanal alarm, satu ekspor kecil.

## Belum pernah diuji (risiko diterima untuk pilot, tutup sebelum menaikkan beban)
-   **Beban**: tidak ada uji beban (`LOAD_TEST_PLAN.md` baru rencana); uji lama hanya 1 sesi tanpa lalu lintas kirim. Ambang A11/A12/A17/A23 masih sementara karena itu.
-   **Ekspor besar**: belum diuji pada 200 ribu baris atau DB jarak jauh.
-   **Latihan rotasi kunci** di staging belum dilakukan (prosedur dan CLI sudah ada dan bertes).
-   **Satu host = satu titik gagal** (API, worker, PostgreSQL, Nginx di satu mesin). Pulih lewat cadangan, bukan failover.
-   Pemantauan tahap 2 (metrik dari DB: antrean, outbox, RLS) belum ada; hanya sinyal luar DB.

## Risiko produk (bukan teknis)
WAZAP memakai WhatsApp Web tidak resmi (Baileys). Nomor dapat dibatasi atau diblokir WhatsApp, terutama pada pengiriman massal atau pola mirip spam; ini di luar kendali kode. Sampaikan ke pelanggan, dan jangan menjanjikan jaminan ketersediaan nomor.

## Disarankan segera setelah pilot berjalan
Dependabot (jangan gabungkan lompatan versi mayor sebelum CI hijau), peninjauan nilai `LIMIT_CEIL_*`, alamat `abuse`/kontak di halaman kebijakan, rencana WAL/PITR bila RPO 24 jam terlalu longgar, uji beban dan penyetelan ulang ambang alarm dari data nyata.
