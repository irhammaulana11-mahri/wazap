# Rancangan: ekspor data workspace

> **STATUS (2026-11-20): BACKEND DIIMPLEMENTASIKAN dan diuji (bagian 14); frontend belum.** ADR-048. Keputusan bagian 13 diputuskan pemilik produk: memakai semua usulan bawaan.

## 1. Tujuan dan ruang lingkup

OWNER/ADMIN dapat mengunduh data workspace miliknya sendiri dalam format yang dapat dibuka spreadsheet (CSV) atau diproses mesin (NDJSON), untuk arsip, laporan, perpindahan sistem, dan pemenuhan permintaan akses data pribadi.

**Termasuk:** riwayat pesan (masuk dan keluar), laporan pengiriman (antrean keluar), chat, kontak, log audit, anggota tim.
**Tidak termasuk (v1):** isi berkas media (backend tidak pernah menyimpannya; hanya tipe dan caption), ekspor terjadwal, ekspor lewat API key, pemulihan/impor data, ekspor lintas workspace, cadangan database (tugas operator, lihat BACKUP_RESTORE.md).

**Kebutuhan pendorong:** isi pesan dibersihkan otomatis setelah `RETENTION_CONTENT_DAYS` (30 hari) dan baris dihapus setelah `RETENTION_ROW_DAYS` (180 hari). Tanpa ekspor, pelanggan tidak punya cara menyimpan riwayatnya sendiri.

## 2. Ringkasan keputusan

| Aspek | Keputusan | Alasan singkat |
|---|---|---|
| Siapa | OWNER dan ADMIN, **hanya pengguna dashboard** (API key ditolak) | data massal berisi data pribadi pelanggan; sama dengan akses audit log |
| Pengaman tambahan | **konfirmasi kata sandi** pada setiap ekspor | sesi yang dibajak tidak dapat langsung menguras data |
| Mekanisme v1 | **unduhan streaming langsung dengan batas ketat** (tanpa penyimpanan berkas) | tidak ada berkas berisi data pribadi yang tertinggal di server; cukup untuk mayoritas ukuran |
| Batas | maks 200.000 baris dan 92 hari per ekspor; lebih besar ditolak **sebelum** byte pertama dikirim (422) | tidak pernah memotong diam-diam; satu instans API tidak boleh terbebani |
| Format | CSV (UTF-8 dengan BOM, aman dari injeksi formula) atau NDJSON (dengan baris manifest) | Excel/Sheets dan integrasi mesin |
| Isolasi | dijalankan dengan konteks RLS tenant (bukan platform) | isolasi tenant dijamin database, sama seperti endpoint lain |
| Jejak | audit `data.exported` untuk setiap ekspor (selesai, dibatalkan, atau gagal), berisi jenis, rentang, jumlah baris, ukuran | dapat ditelusuri dan dipantau |
| Fase berikutnya | ekspor asinkron (worker + penyimpanan), ekspor terjadwal sebelum pembersihan, akses API key dengan scope baru | hanya bila ada kebutuhan nyata |

## 3. Data per jenis ekspor

Semua waktu dalam ISO-8601 UTC. Kolom dalam urutan tetap (bagian dari kontrak; penambahan hanya di akhir).

| Jenis (`type`) | Sumber | Kolom | Filter |
|---|---|---|---|
| `messages` | `wa_messages` + `wa_chats` + `wa_sessions` | `occurred_at, direction, session_id, session_name, chat_id, contact_phone, contact_name, type, text, text_purged, status, provider_message_id, job_id` | `from`, `to` (wajib), `session_id?`, `direction?` |
| `outbound` (laporan pengiriman) | `message_queue` | `created_at, job_id, session_id, to, type, status, attempts, last_error_code, provider_message_id, scheduled_at, completed_at, content_purged` | `from`, `to` (wajib), `session_id?`, `status?` |
| `chats` | `wa_chats` | `chat_id, session_id, contact_phone, contact_name, jid, last_message_at, created_at` | `session_id?` |
| `contacts` | `wa_chats` (digabung per nomor, seperti `GET /contacts`) | `phone, name, chats, last_message_at` | - |
| `audit-logs` | `audit_logs` | `created_at, action, actor_email, actor_role, target_type, target_id, target_email, ip, request_id, details_json` | `from`, `to` (wajib) |
| `members` | `tenant_memberships` | `user_id, email, role, status, joined_at` | - |

**Tidak pernah diekspor:** auth state dan kredensial WhatsApp, QR, hash kata sandi, kode pemulihan, refresh token, nilai/hash API key, secret webhook, hash kode workspace, data tenant lain, isi `outbox_events`/`webhook_deliveries` (internal). Kolom yang diekspor adalah daftar putih eksplisit di kode, bukan `SELECT *`.

**Data yang sudah dibersihkan retensi** tetap diekspor dengan penandanya: `text` kosong dan `text_purged = true`; nomor tujuan antrean yang sudah ditutup retensi tampil termasker (`*********7890`). Manifest dan UI menjelaskannya.

## 4. Hak akses dan pengaman

1.  Guard: `authenticate` + `requireRole('OWNER', 'ADMIN')` (API key mendapat 403, seperti endpoint tim). Untuk `audit-logs` dan `members` tetap OWNER/ADMIN (sama dengan aksesnya sekarang).
2.  Konfirmasi kata sandi di body (`password`), diverifikasi dengan `verifyPassword` yang sudah ada; gagal menghasilkan `403 INVALID_PASSWORD`, dihitung pembatas laju yang sama dengan percobaan kata sandi lain.
3.  Pembatas laju: 5 ekspor per jam per pengguna (ditagih SETELAH pra-hitung lolos, jadi 400/422 tidak menghabiskan jatah); percobaan kata sandi SALAH dibatasi 5 per 15 menit dan penguncian dicek SEBELUM verifikasi (ekspor sah berturut-turut tidak terkunci); maksimal 1 ekspor berjalan per workspace dan 2 per proses API (409 `EXPORT_IN_PROGRESS` / 429 `RATE_LIMITED` dengan `Retry-After`). Di memori, seperti pembatas lain (catatan: berlaku per instans; API memang satu instans).
4.  Audit `data.exported` ditulis di blok `finally` dengan `outcome` (`completed`, `aborted`, `failed`), jenis, format, rentang, `rows`, `bytes`, `duration_ms`. Tanpa isi data dan tanpa kata sandi.
5.  Header respons: `Content-Disposition: attachment; filename="wazap-<slug>-<type>-<YYYYMMDD>.<csv|ndjson>"` (slug disanitasi ASCII), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
6.  Pemantauan (masuk rancangan #4): alarm bila `data.exported` per workspace melonjak atau ekspor terjadi di luar kebiasaan.

## 5. Mekanisme v1: streaming dengan batas

```
POST /api/v1/exports/messages  -> verifikasi kata sandi -> kunci workspace (1 berjalan)
  -> PRA-HITUNG: SELECT count(*) FROM (... LIMIT max+1)   (indeks; <1 dtk)
       melebihi batas? -> 422 EXPORT_TOO_LARGE {estimated_rows, max_rows}  (belum ada byte terkirim)
  -> batas atas dikunci: to_effective = min(to, waktu mulai)  (hasil deterministik walau data terus masuk)
  -> loop batch keyset: WHERE (occurred_at, id) > (last) AND occurred_at < to_effective ORDER BY occurred_at, id LIMIT 1000
       tiap batch = transaksi pendek sendiri dengan konteks RLS tenant + SET LOCAL statement_timeout = '15s'
       koneksi DB dilepas di antara batch (klien lambat tidak menahan pool)
       tulis ke aliran respons dengan backpressure (tunggu 'drain')
  -> klien menutup koneksi (batal)? -> hentikan loop, audit outcome=aborted
  -> batas durasi 300 dtk / ukuran 100 MB tercapai (seharusnya tidak, karena pra-hitung) -> hentikan, audit outcome=failed
  -> audit outcome=completed {rows, bytes, duration_ms}
```

Mengapa bukan asinkron sejak awal: asinkron butuh tabel tugas, penyimpanan berkas berisi data pribadi (enkripsi, retensi berkas, penghapusan aman), dan host bersama atau object storage. Streaming dengan batas tidak meninggalkan apa pun di server, dan batas 200 ribu baris (~50 MB CSV) mencakup ekspor bulanan hampir semua workspace. Ekspor lebih besar dilakukan per rentang (UI menawarkan "per bulan").

## 6. Kontrak API

| Endpoint | Body (strict) |
|---|---|
| `POST /api/v1/exports/messages` | `{ password, format: 'csv' \| 'ndjson' = 'csv', from, to, session_id?, direction?: 'IN' \| 'OUT' }` |
| `POST /api/v1/exports/outbound` | `{ password, format, from, to, session_id?, status? }` |
| `POST /api/v1/exports/chats` | `{ password, format, session_id? }` |
| `POST /api/v1/exports/contacts` | `{ password, format }` |
| `POST /api/v1/exports/audit-logs` | `{ password, format, from, to }` |
| `POST /api/v1/exports/members` | `{ password, format }` |
| `GET /api/v1/exports/policy` | - (mengembalikan `{max_rows, max_span_days, per_hour, retention: {content_days, row_days, audit_days}}` untuk UI) |

-   `from`/`to`: ISO-8601 dengan offset; `from < to`; rentang <= `EXPORT_MAX_SPAN_DAYS`; `to` di masa depan dipotong ke waktu mulai.
-   Sukses: `200` dengan `Content-Type: text/csv; charset=utf-8` atau `application/x-ndjson`, body streaming.
-   Galat (amplop standar JSON): `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN | INVALID_PASSWORD`, `409 EXPORT_IN_PROGRESS`, `422 EXPORT_TOO_LARGE` (`details: [{estimated_rows, max_rows}]`), `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE`.
-   Galat setelah streaming dimulai tidak dapat menjadi status HTTP: CSV berakhir tanpa baris penutup dan koneksi diputus; NDJSON tidak memiliki baris manifest akhir. Karena itu **pra-hitung wajib** dan klien memeriksa kelengkapan (bagian 7).

Dampak pada spesifikasi OpenAPI (ADR-045): `Operation` perlu mendukung respons non-JSON (`stream: { contentTypes }`); generator menulis `content: {text/csv: {schema: {type: string}}, application/x-ndjson: ...}`; mode kontrak memeriksa `Content-Type` dan header (bukan isi) untuk operasi streaming. `test/frontend-contract.test.ts` otomatis mencakup endpoint baru setelah frontend memakainya.

## 7. Format

**CSV:** UTF-8 dengan BOM (Excel di Windows membaca aksara dengan benar), pemisah koma, akhir baris CRLF, baris pertama nama kolom, kutip ganda pada setiap sel yang memuat koma/kutip/baris baru (kutip digandakan).
**Injeksi formula (wajib):** isi pesan berasal dari pihak luar. Sel yang diawali `=`, `+`, `-`, `@`, tab, atau carriage return diberi awalan `'` agar spreadsheet tidak mengeksekusinya (`=HYPERLINK(...)`, `@SUM(...)`, `-2+3`). Nomor telepon tidak terpengaruh (diawali angka).
**NDJSON:** satu objek JSON per baris dengan kunci sama dengan kolom CSV; baris TERAKHIR adalah manifest `{"_manifest": {"type", "format", "workspace", "from", "to_effective", "rows", "exported_at", "schema_version": 1, "notes": ["isi pesan lebih tua dari 30 hari sudah dibersihkan"]}}`. Tidak adanya manifest = ekspor terpotong.
**Kelengkapan CSV:** jumlah baris tercantum di header respons awal `X-Export-Rows` (dari pra-hitung, batas atas sudah dikunci); klien membandingkan.

## 8. Perubahan database (migrasi 0019)

1.  Indeks `idx_wa_messages_tenant_time ON wa_messages (tenant_id, occurred_at, id)` dan `idx_message_queue_tenant_time ON message_queue (tenant_id, created_at, id)` (indeks antrean yang ada berurutan `created_at DESC` sehingga tidak cocok untuk keyset ascending) untuk ekspor `messages` dan `outbound` lintas chat (saat ini hanya ada indeks per chat dan per `created_at` global). Divalidasi dengan `npm run test:perf` (EXPLAIN tanpa Seq Scan pada data besar).
2.  `audit_logs`: tipe target `export` ditambahkan ke `CHECK target_type`. Aksi `data.exported` TIDAK perlu perubahan (CHECK aksi hanya pola umum `^[a-z_]+\.[a-z_]+$`); kebijakan INSERT yang ada dipakai.
3.  Tanpa tabel baru di v1.

## 9. Konfigurasi baru

| Variabel | Bawaan | Arti |
|---|---|---|
| `EXPORT_ENABLED` | true | saklar mati operator: false => semua ekspor 503 `NOT_CONFIGURED` (respons insiden) |
| `EXPORT_MAX_ROWS` | 200000 | batas baris per ekspor (pra-hitung) |
| `EXPORT_MAX_SPAN_DAYS` | 92 | rentang waktu maksimal |
| `EXPORT_BATCH_ROWS` | 1000 | baris per batch keyset |
| `EXPORT_MAX_SECONDS` | 300 | batas durasi satu ekspor |
| `EXPORT_PER_USER_PER_HOUR` | 5 | pembatas laju per pengguna |
| `EXPORT_MAX_CONCURRENT` | 2 | ekspor bersamaan per proses API |

## 10. Frontend

-   **Pengaturan → "Data & Privasi"** (pusat): keterangan retensi dari `GET /exports/policy` ("Isi pesan disimpan 30 hari, riwayat 180 hari"), dan tombol ekspor untuk semua jenis.
-   Tombol **"Ekspor"** kontekstual di halaman Pesan dan Obrolan (`messages`, `outbound`, `chats`), Kontak, Audit, Tim (`members`).
-   Alur: pilih jenis, rentang (bawaan 30 hari terakhir; pemilih "per bulan"), format (CSV/JSON); dialog konfirmasi kata sandi; unduh lewat `fetch` + `AbortController` dengan indikator byte dan tombol Batal; simpan sebagai berkas dari `Content-Disposition`. Kata sandi tidak disimpan di state setelah permintaan.
-   Galat: 422 menyarankan mempersempit rentang dengan angka dari `details`; 409 "ekspor lain sedang berjalan"; 429 menampilkan waktu tunggu dari `Retry-After`; 403 `INVALID_PASSWORD` tetap di dialog.
-   Dialog hapus workspace menyarankan ekspor sebelum menghapus.

## 11. Rencana uji

-   **Unit CSV:** koma, kutip, baris baru, Unicode/emoji, BOM, CRLF; vektor injeksi formula (`=1+1`, `+cmd`, `-2+3`, `@SUM(A1)`, tab, `\r`) dinetralkan; NDJSON valid per baris dan manifest terakhir.
-   **Integrasi (DB):** isolasi tenant (A tidak pernah menerima baris B, termasuk dengan filter `session_id` milik B); VIEWER/MEMBER/API key 403; kata sandi salah 403 dan terhitung pembatas; rentang wajib dan maks; melebihi batas 422 **tanpa byte data**; batas atas terkunci (baris yang masuk selama ekspor tidak ikut); pesan yang dibersihkan tampil `text_purged=true`; kolom rahasia tidak pernah muncul (pindai keluaran untuk hash/kunci); audit tertulis untuk completed/aborted/failed dengan jumlah baris benar; klien membatalkan di tengah => loop berhenti (tidak ada batch berikutnya) dan audit aborted; satu ekspor per workspace (409); pembatas laju (429).
-   **Kontrak:** OpenAPI memuat endpoint baru; mode kontrak memeriksa header/Content-Type streaming; galat memakai amplop standar.
-   **Perf (`test/perf`):** 200 ribu baris: memori proses stabil (tanpa memuat semua baris), koneksi DB tidak tertahan saat klien lambat, EXPLAIN memakai indeks baru.
-   **Uji mutasi** seperti biasa: netralisasi formula dimatikan, konteks RLS diganti platform, pra-hitung dilewati: masing-masing harus menggagalkan tes.

## 12. Tahapan

1.  **Backend v1:** migrasi 0019, `export.service.ts` + penulis CSV/NDJSON, rute, konfigurasi, dukungan streaming di OpenAPI, tes (bagian 11), dokumen (API_CONTRACT, RUNBOOK: playbook "lonjakan ekspor", ADR-048 diperbarui).
2.  **Frontend:** bagian 10, dengan tes kontrak frontend yang sudah ada.
3.  **Opsional (bila dibutuhkan):** ekspor asinkron untuk data >200 ribu baris (tugas di worker, berkas terenkripsi berumur pendek), ekspor terjadwal sebelum pembersihan 30 hari, akses API key dengan scope `data:export`.

## 13. Keputusan terbuka (pemilik produk)

| # | Pertanyaan | Usulan bawaan |
|---|---|---|
| 1 | Apakah MEMBER boleh mengekspor? | Tidak (hanya OWNER/ADMIN) |
| 2 | Apakah ekspor lewat API key dibutuhkan sekarang? | Tidak (fase 3, scope terpisah) |
| 3 | Batas 200 ribu baris / 92 hari / 5 per jam memadai? | Ya, dapat diubah via env |
| 4 | Apakah retensi isi pesan 30 hari tetap, atau diperpanjang per paket? | Tetap; UI menjelaskan dan menawarkan ekspor |
| 5 | Apakah anggota lain (OWNER lain) perlu diberi tahu saat ada ekspor? | Cukup audit log dan pemantauan di v1 |

Catatan kepatuhan (bukan nasihat hukum): dalam layanan ini workspace (pelanggan) umumnya bertindak sebagai pengendali data pribadi kontaknya dan platform sebagai pemroses; fitur ini memberi pengendali alat untuk memenuhi permintaan akses data menurut UU PDP. Kewajiban pastinya perlu dikonfirmasi penasihat hukum.

## 14. Hasil implementasi backend (2026-11-20)

**Dibuat:** migrasi `0019_data_export.sql`; `src/modules/export/{csv.ts, definitions.ts, export.service.ts, export.routes.ts}`; `identity.confirmPassword`; `RateLimiter.blocked`; dukungan respons streaming di generator OpenAPI dan mode kontrak; tujuh operasi baru di `openapi.json` (82 total); konfigurasi `EXPORT_*`.
**Endpoint:** `POST /api/v1/exports/{messages|outbound|chats|contacts|audit-logs|members}` dan `GET /api/v1/exports/policy`.

**Bukti:** `test/export.test.ts` (18 tes), `test/perf/export.perf.ts` (3 tes), tes OpenAPI/kontrak otomatis mencakup endpoint baru.
-   *Terbukti oleh tes:* injeksi formula dinetralkan; isolasi tenant (A tidak menerima B, juga dengan `session_id` milik B); hanya OWNER/ADMIN pengguna dashboard (MEMBER, VIEWER, API key, tanpa kredensial ditolak); kata sandi salah 403 dan terkunci 429; jatah 5 per jam; 422 `EXPORT_TOO_LARGE` sebelum byte data dan tanpa menghabiskan jatah; validasi rentang; batas atas terkunci; audit completed/aborted tanpa isi data; pembatalan klien (layanan dan **koneksi HTTP sungguhan**) menghentikan loop; satu ekspor per workspace (409) dan batas bersamaan (429); saklar mati 503.
-   *Performa (30 ribu baris, PostgreSQL lokal):* sekitar 50 ribu baris/dtk, puncak memori +30 MB, nol koneksi `idle in transaction` saat klien lambat; EXPLAIN memakai indeks 0019 tanpa Sort/Seq Scan.
-   *Uji mutasi:* netralisasi formula dimatikan, pra-hitung dilewati, batas atas tidak dikunci, audit tidak ditulis, guard dicabut, kata sandi tidak diverifikasi, slot tidak dikunci, jatah dihapus, dan indeks dihapus masing-masing menggagalkan tes. **Pertahanan berlapis terbukti:** tanpa filter `tenant_id` di SQL, RLS tetap menahan kebocoran; kebocoran baru terdeteksi bila filter DAN konteks tenant sama-sama dicabut.

**Temuan selama implementasi:** (1) pembatas kata sandi awalnya menghitung SETIAP ekspor sehingga pengguna sah yang mengekspor beberapa jenis berturut-turut terkunci setelah 5 kali (ditemukan tes jatah); kini hanya percobaan salah yang dihitung dan penguncian dicek sebelum verifikasi. (2) Aturan CHECK aksi audit ternyata generik: hanya `target_type` yang perlu migrasi.

**Risiko tersisa:** batas dan konkurensi berlaku per proses API (satu instans; sama dengan pembatas lain); ekspor jenis `contacts` tanpa batas waktu sehingga `X-Export-Rows` perkiraan; baris berstempel waktu lampau yang tiba SELAMA ekspor (riwayat sinkron) dapat tidak ikut atau, bila melampaui batas, membuat ekspor gagal (`failed`, koneksi diputus; CSV tidak punya penanda akhir, NDJSON tanpa manifest = terpotong); sel CSV berawalan `= + - @` tampil dengan awalan `'` (disengaja); ukuran dan waktu diuji pada 30 ribu baris lokal, bukan 200 ribu pada DB berjarak; Nginx menyangga respons (klien lambat tidak menahan API, tetapi pembatalan klien merambat setelah buffer Nginx); frontend dan ekspor asinkron/terjadwal belum ada.
