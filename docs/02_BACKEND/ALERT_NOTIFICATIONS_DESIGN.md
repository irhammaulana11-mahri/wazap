# Rancangan: notifikasi alarm per workspace

> **STATUS (2026-11-20): BACKEND DIIMPLEMENTASIKAN dan diuji (bagian 12); frontend dan uji nyata (bot Telegram, sesi WhatsApp staging) belum.** ADR-049. Keputusan bagian 11: memakai semua usulan bawaan.
> Bukan alarm operator server (itu `docs/07_DEPLOYMENT/MONITORING_ALERTING.md`, dikelola lewat berkas env di host, sengaja di luar aplikasi).

## 1. Tujuan
OWNER/ADMIN workspace memilih **kejadian apa** yang diberitahukan dan **ke mana** (Telegram atau Slack/Discord), supaya masalah pada sesi WhatsApp mereka sendiri diketahui tanpa membuka dashboard. Contoh: sesi LOGGED_OUT, sesi terputus lama, webhook dinonaktifkan otomatis, pesan keluar gagal berkelompok.
**Tidak termasuk (v1):** surel, SMS, WhatsApp (kanal sendiri bisa mati bersama masalahnya), alarm untuk MEMBER/VIEWER, eskalasi/penjadwalan jam hening, alarm lintas workspace, ambang kustom selain yang tercantum.

## 2. Ringkasan keputusan
| Aspek | Keputusan | Alasan |
|---|---|---|
| Siapa mengelola | OWNER/ADMIN, **hanya pengguna dashboard** (API key ditolak), kata sandi untuk membuat/mengubah kanal | kanal menyimpan rahasia dan mengirim data keluar |
| Kanal v1 | **Telegram** (bot milik pelanggan) dan **Slack-compatible webhook** (Slack, Discord `/slack`) | dua kanal yang paling umum; satu pola HTTP |
| Rahasia | token bot / URL webhook dienkripsi dengan keyring yang sama dengan rahasia webhook (AES-256-GCM, versi kunci), **tidak pernah dikembalikan** API (hanya petunjuk 4 karakter) | pola sudah ada; ikut rotasi kunci |
| Anti-SSRF | Telegram: host dikunci `api.telegram.org`. Slack-compatible: `parseWebhookUrl` + `createSafeLookup` yang sama dengan webhook, ditambah daftar host yang diizinkan (hooks.slack.com, discord.com) | pelanggan tidak boleh memakai fitur ini untuk memindai jaringan internal |
| Isi pesan | hanya jenis kejadian, nama sesi, status, jumlah, waktu, tautan dashboard. **Tanpa nomor telepon pelanggan akhir dan tanpa isi pesan** | pesan notifikasi melewati pihak ketiga |
| Pemicu | (a) berbasis kejadian dari outbox yang sudah ada; (b) berbasis waktu oleh worker (lihat bagian 4) | tidak menambah pembacaan di jalur kirim pesan |
| Pengiriman | antrean sendiri `alert_deliveries` (retry terbatas, jeda eksponensial), dikerjakan worker | tidak memblokir API; tahan restart |
| Pengurangan bising | jeda ulang per (aturan, objek) dan ringkasan, serta batas kirim per kanal per jam | satu sesi yang flapping tidak membanjiri chat |
| Kanal gagal | otomatis nonaktif setelah N kegagalan beruntun (pola breaker webhook) dan tercatat di audit | tidak mengirim terus ke kanal yang sudah dicabut |
| Isolasi | semua tabel RLS ENABLE+FORCE, konteks tenant | aturan proyek |
| Kill switch | `ALERTS_ENABLED=false` | seperti `EXPORT_ENABLED` |

## 3. Kejadian dan aturan (v1)
Aturan per jenis kejadian, tiap aturan: aktif/nonaktif, kanal tujuan (satu atau lebih), dan satu ambang bila relevan.
| Kode aturan | Memicu bila | Ambang (nilai bawaan) | Sumber |
|---|---|---|---|
| `session.logged_out` | sesi menjadi LOGGED_OUT | langsung | kejadian `session.status` |
| `session.disconnected_long` | sesi tidak CONNECTED melebihi N menit | 10 mnt (1-1440) | waktu |
| `session.reconnect_loop` | >= M perubahan status dalam 10 mnt | 6 (3-50) | kejadian |
| `webhook.endpoint_disabled` | endpoint dinonaktifkan otomatis | langsung | `webhook_endpoints.disabled_at` |
| `webhook.dead_burst` | >= M pengiriman DEAD dalam 1 jam | 5 (1-1000) | waktu |
| `message.failed_burst` | >= M pesan keluar FAILED dalam 10 mnt | 10 (1-1000) | waktu |
| `message.unknown` | pesan berstatus UNKNOWN/perlu rekonsiliasi | langsung | kejadian `message.unknown` |
| `export.completed` | ekspor data selesai (kewaspadaan penyalahgunaan) | langsung | audit `data.exported` |
Daftar tetap di kode (bukan bebas diisi pelanggan); menambah aturan = perubahan kode, tes, dan dokumen.

## 4. Mekanisme pemicu
- **Kejadian:** pemroses di worker membaca `outbox_events` yang sama dengan relay webhook (kursor sendiri, tidak mengubah relay), mencocokkan dengan aturan aktif tenant, lalu menulis baris `alert_deliveries` dalam transaksi tenant pendek.
- **Waktu:** poller worker (di bawah advisory lock tunggal seperti retensi) memeriksa kondisi tiap 60 dtk memakai kueri agregat terindeks per tenant yang punya aturan waktu aktif. Kondisi yang tetap benar tidak mengirim ulang sebelum jeda ulang (bawaan 60 mnt); pesan "pulih" dikirim sekali saat kondisi bersih.
- **Idempotensi:** kunci unik (aturan, objek, jendela waktu) pada `alert_deliveries` sehingga pengulangan poller/restart tidak menggandakan notifikasi.

## 5. Model data (migrasi 0020, semua RLS FORCE)
- `alert_channels(id, tenant_id, type TELEGRAM|SLACK, name, target_ciphertext, target_key_version, target_hint, active, consecutive_failures, disabled_at, disabled_reason, created_by, created_at, updated_at)` — `target` = token+chat id (Telegram) atau URL (Slack), dienkripsi.
- `alert_rules(tenant_id, rule_code, enabled, threshold, cooldown_minutes, channel_ids uuid[], updated_by, updated_at)` — PK (tenant_id, rule_code); `rule_code` dibatasi CHECK ke daftar bagian 3.
- `alert_deliveries(id, tenant_id, channel_id, rule_code, object_key, window_key, payload, status PENDING|SENT|DEAD, attempts, next_attempt_at, last_error_code, created_at)` — UNIQUE (tenant_id, rule_code, object_key, window_key); retensi 30 hari lewat pembersih yang ada.
- Audit baru: `alert_channel.created|updated|deleted|disabled`, `alert_rule.updated` (tanpa rahasia; pola filter audit yang ada).

## 6. API (`/api/v1/alerts`, OWNER/ADMIN, user-only)
`GET /alerts/rules` (daftar aturan lengkap dengan bawaan), `PUT /alerts/rules/{code}`, `GET/POST /alerts/channels`, `PATCH/DELETE /alerts/channels/{id}`, `POST /alerts/channels/{id}/test` (kirim pesan uji, hasilnya dikembalikan apa adanya), `GET /alerts/deliveries?limit` (riwayat terbaru, tanpa rahasia). Membuat/mengubah target kanal dan menghapus kanal meminta kata sandi. Kuota: maks 5 kanal per workspace; uji maks 10 per jam. Semua operasi dicatat di OpenAPI dan kontrak.

## 7. Frontend
Pengaturan → tab baru **"Notifikasi"** (OWNER/ADMIN; yang lain tidak melihat tab). Tiga bagian: Kanal (tambah, uji, nonaktif, hapus; rahasia tidak pernah ditampilkan ulang), Aturan (sakelar + ambang + pilih kanal), Riwayat pengiriman (status, galat). Dikerjakan agent frontend dengan prompt dan tes kontrak seperti ekspor, **setelah** backend selesai dan kontraknya stabil.

## 8. Keamanan (daftar yang harus dibuktikan tes)
1. Kanal tenant A tidak bisa dibaca/diubah/dipicu tenant B (RLS dan API).
2. API key dan MEMBER/VIEWER ditolak; kata sandi salah ditolak dan dibatasi laju.
3. Rahasia tidak pernah muncul di respons, log, audit, atau pesan galat.
4. SSRF: host privat/loopback/metadata, IP desimal/IPv6-mapped, redirect, DNS rebinding ditolak; hanya host yang diizinkan.
5. Pesan tidak memuat nomor telepon atau isi pesan (tes pada seluruh payload tiap aturan).
6. Satu kejadian = satu notifikasi (idempotensi) walau poller dijalankan ganda atau worker restart.
7. Kanal yang gagal berulang dinonaktifkan dan tidak menghambat kanal/tenant lain (pengiriman paralel terbatas, batas waktu 10 dtk).
8. Kill switch mematikan pemicu dan pengiriman tanpa menghapus konfigurasi.
9. Rotasi kunci master mengenkripsi ulang `target_ciphertext` (CLI rotasi ditambah, tesnya diperluas).

## 9. Risiko dan batasan yang diakui
- **Notifikasi bukan jaminan:** Telegram/Slack bisa lambat atau turun; ini bantuan, bukan pengganti memantau status sesi.
- Token bot milik pelanggan tersimpan di server kita (terenkripsi). Kebocoran kunci master membuka token itu; ini sudah menjadi risiko kelas yang sama dengan rahasia webhook dan sesi WhatsApp.
- Ambang berbasis waktu bergantung pada kesehatan worker; bila worker mati, **tidak ada notifikasi berbasis waktu** (alarm operator `MONITORING_ALERTING.md` yang menangkap ini, bukan fitur ini).
- Pesan "pulih" dan jeda ulang membuat jumlah pesan tidak selalu sama dengan jumlah kejadian mentah.

## 10. Urutan kerja dan bukti selesai
1. ADR-049 + migrasi 0020 + tes RLS/skema. 2. Service kanal (enkripsi, SSRF, uji kirim) + tes. 3. Pemicu kejadian dan waktu + idempotensi + tes. 4. Pengirim + retry + breaker. 5. API + OpenAPI + kontrak + tes peran/kata sandi. 6. Rotasi kunci diperluas. 7. Uji nyata: bot Telegram sungguhan dan sesi WhatsApp staging (putuskan perangkat -> notifikasi tiba). 8. Dokumen (API_CONTRACT, SECURITY_POLICY, RUNBOOK playbook baru P16, SOCKET/WEBHOOK bila perlu). 9. Prompt agent frontend + tes kontrak perilaku.

## 11. Keputusan yang dibutuhkan dari pemilik
1. Kanal v1: Telegram + Slack-compatible (usulan), atau Telegram saja?
2. Daftar aturan bagian 3 cukup? (usulan: ya; `export.completed` bisa dibuang bila dianggap berlebihan)
3. Jeda ulang bawaan 60 mnt dan batas 5 kanal per workspace, setuju?
4. Ketersediaan: fitur ini hanya di dashboard, tanpa akses API key (usulan), atau perlu API key juga?

## 12. Hasil implementasi (2026-11-20) dan penyimpangan dari rancangan
- Migrasi 0020; modul `modules/alerts/` (rules, service, routes), `modules/engine/alert-evaluator.ts` dan `alert-sender.ts` (konteks platform harus di engine/), `security/alert-target.ts`; poller `alert-evaluator` dan `alert-sender` di worker peran webhook; rotasi kunci dan retensi diperluas; tes `test/alerts.test.ts` (24).
- **Penyimpangan 1 (bagian 4):** tidak ada kursor outbox; semua aturan (termasuk berbasis kejadian) dievaluasi seragam dari tabel sumbernya dalam jendela waktu terakhir (`ALERTS_LOOKBACK_MINUTES`, bawaan 15). Konsekuensi: kejadian saat worker mati lebih lama dari jendela itu tidak dikirim. Keuntungan: satu jalur kode, idempotensi dibuktikan tes (evaluator ganda bersamaan).
- **Penyimpangan 2:** pesan "pulih" tidak dikirim pada v1.
- **Penyimpangan 3:** `session.disconnected_long` memakai `wa_sessions.updated_at` sebagai penanda mulai terputus (perkiraan; perubahan baris lain pada sesi menggesernya).
- Jeda ulang (`cooldown_minutes`) hanya berlaku untuk aturan berulang (terputus lama, putus-sambung, webhook DEAD berkelompok, pesan gagal berkelompok); aturan lain satu notifikasi per kejadian.
- Pengiriman per kanal berurutan dalam satu batch agar batas kirim per jam tepat (ditemukan tes: paralel melewati batas).
- **Belum:** UI (prompt agent frontend menyusul), uji dengan bot Telegram dan Slack sungguhan, uji sesi WhatsApp staging (putuskan perangkat -> notifikasi tiba), dan kolom `created_by` pada aturan diaudit tetapi belum ditampilkan.
