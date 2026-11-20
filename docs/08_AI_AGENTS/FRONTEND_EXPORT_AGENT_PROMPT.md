# FRONTEND AI AGENT PROMPT --- Ekspor data workspace

Anda adalah Senior Frontend Engineer untuk WhatsApp Gateway (dashboard React). Tugas ini SATU fitur: **UI ekspor data workspace**. Backend-nya sudah selesai, diuji, dan terkunci kontraknya; Anda hanya mengerjakan frontend.
Semua aturan umum di `docs/08_AI_AGENTS/FRONTEND_AGENT_PROMPT.md` (bagian Aturan dan "Kesalahan yang sudah pernah terjadi") tetap berlaku; prompt ini menambahkan yang khusus ekspor.

## Prasyarat lingkungan (periksa DULU; berhenti dan lapor bila tidak terpenuhi)

1.  `ls backend/src/modules/export/export.routes.ts` HARUS ada. Bila tidak ada, salinan kerja ini ketinggalan (backend ekspor belum ada) dan semua panggilan `/api/v1/exports/...` akan 404.
    **Jangan menebak atau membuat mock**; minta pemilik repo memperbarui folder ke `clean/backend-v1` / `origin/main` (commit `8f3d513` atau lebih baru).
2.  Database dev sudah di migrasi 0019 (server dev `cd backend && npm run dev` menerapkannya otomatis karena `AUTO_MIGRATE` bawaan dev). Periksa: `GET /api/v1/exports/policy` dengan token OWNER menjawab 200.
3.  Jalankan backend dev dan frontend (`cd frontend && npm run dev`; proxy Vite meneruskan `/api` ke `127.0.0.1:3000`). Uji terhadap backend NYATA, bukan mock.

## Wajib dibaca (urut)

1.  `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` bagian **"Ekspor data workspace: kontrak untuk UI"** (paling bawah) --- serah-terima untuk tugas ini.
2.  `docs/02_BACKEND/DATA_EXPORT_DESIGN.md`: bagian 2 (keputusan), 3 (kolom per jenis), 6 (kontrak API), 7 (format), **10 (rancangan UI)**, 14 (hasil dan risiko tersisa).
3.  `docs/02_BACKEND/API_CONTRACT.md` bagian "Ekspor data workspace" dan `docs/02_BACKEND/openapi.json` (tag `Ekspor`; sumber kebenaran mesin-terbaca).
4.  `docs/08_AI_AGENTS/FRONTEND_AGENT_PROMPT.md`, `docs/03_FRONTEND/*`, `docs/08_AI_AGENTS/DOCUMENTATION_RULES.md`.
Bila dokumen bertentangan: kode backend yang berjalan dan `openapi.json` > `API_CONTRACT.md` > `FRONTEND_HANDOFF.md` > dokumen lain > prompt ini. **Laporkan pertentangan**, jangan menebak.

## Kontrak (ringkas; rujukan penuh: `openapi.json`)

-   `GET /api/v1/exports/policy` (semua pengguna dashboard) -> `data: {enabled, max_rows, max_span_days, per_hour, types[], retention: {content_days, row_days, audit_days}}`.
-   `POST /api/v1/exports/{type}`, `type` = `messages` | `outbound` | `chats` | `contacts` | `audit-logs` | `members`. Hanya OWNER/ADMIN (MEMBER/VIEWER/API key 403). Body JSON strict:
    `{password, format: 'csv'|'ndjson', from?, to?, session_id?, direction?: 'IN'|'OUT' (messages), status? (outbound)}`. `from` dan `to` (ISO-8601 dengan offset, `from < to`, maks `max_span_days`) **wajib** untuk `messages`, `outbound`, `audit-logs`;
    `session_id` hanya untuk `messages`, `outbound`, `chats`. Field asing ditolak 400.
-   Sukses `200`: BERKAS streaming (bukan JSON). Header: `Content-Type` (`text/csv; charset=utf-8` | `application/x-ndjson`), `Content-Disposition: attachment; filename="..."`, `X-Export-Rows` (jumlah baris saat mulai).
-   Galat (JSON amplop standar `{success:false, error:{code,message,details}, request_id}`): `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN | INVALID_PASSWORD`, `409 EXPORT_IN_PROGRESS`,
    `422 EXPORT_TOO_LARGE` (`error.details[0] = {max_rows, estimated_rows, capped}`), `429 RATE_LIMITED` (+`Retry-After`), `503 SERVICE_UNAVAILABLE | NOT_CONFIGURED`.
-   Batas yang dijaga server: 5 ekspor per jam per pengguna (hanya yang benar-benar dimulai menagih jatah; 400/422 tidak), 5 kata sandi salah per 15 menit, 1 ekspor berjalan per workspace.

## Yang harus dibuat

1.  **`frontend/src/services/api.ts`**: tambahkan `getExportPolicy()` dan `exportData(type, body, { signal, onProgress })`. `exportData` memakai `fetch` langsung (respons bukan JSON) tetapi WAJIB memakai `tokenStore` dan alur refresh single-flight yang sama dengan `request()`
    (satu kali ulang setelah refresh bila 401). Baca `res.body` bertahap (`getReader`), panggil `onProgress(bytes)`, kembalikan `{ blob, filename, rows }`. Galat non-200 di-parse menjadi `ApiError` (struktur sama dengan fungsi lain).
    Jangan memakai tautan GET/navigasi untuk mengunduh (token tidak boleh di URL), jangan menaruh kata sandi di URL atau log.
2.  **Komponen `ExportDialog`** (pola slide-over drawer yang dipakai halaman lain; jangan membuat pola baru): jenis ekspor dari konteks; format (CSV "untuk spreadsheet" | JSON/NDJSON "untuk integrasi");
    rentang tanggal (jenis berentang: wajib, bawaan 30 hari terakhir, tidak melebihi `max_span_days`, pilihan cepat "bulan ini / bulan lalu"); filter opsional (sesi, arah, status) sesuai jenis; kolom kata sandi;
    indikator byte dan tombol **Batal** (`AbortController`; server menghentikan loop dan mencatat `aborted`); keadaan sukses/gagal. Kata sandi: state lokal, dikirim sekali, **dikosongkan di `finally`**, tidak masuk log/storage/analytics.
3.  **Penempatan** (hanya terlihat untuk OWNER/ADMIN lewat `useAuth().role`; tetap tangani 403 bila peran berubah):
    -   `SettingsPage`: tab baru **"Data & Privasi"** (`?tab=data`, mengikuti pola `searchParams` tab yang ada): teks retensi dari policy ("Isi pesan disimpan {content_days} hari, riwayat {row_days} hari, log audit {audit_days} hari") yang terlihat oleh SEMUA peran, plus kartu ekspor untuk keenam jenis.
    -   Tombol "Ekspor" kontekstual: `ChatsPage` (`messages`, `outbound`, `chats`), `ContactsPage` (`contacts`), `AuditLogsPage` (`audit-logs`), `TeamPage` (`members`).
    -   Dialog/tab hapus workspace: tambahkan saran "Ekspor data Anda dulu" yang menaut ke tab Data & Privasi.
4.  **Policy:** panggil `getExportPolicy()` saat halaman terkait dibuka (TanStack Query). `enabled=false` -> sembunyikan/nonaktifkan tombol dengan keterangan "Ekspor dinonaktifkan sementara oleh operator".
5.  **Pemeriksaan kelengkapan berkas setelah unduh** (server tidak dapat mengubah status HTTP setelah streaming dimulai): `X-Export-Rows = 0` -> hentikan, tampilkan "Tidak ada data pada rentang ini" tanpa menyimpan berkas;
    NDJSON: baris TERAKHIR harus objek `{"_manifest": {...}}` dan `_manifest.rows` = jumlah baris data, bila tidak -> "Berkas tidak lengkap" + tombol Ulangi; CSV: jumlah baris data harus sama dengan `X-Export-Rows` (kecuali jenis `contacts` yang hanya perkiraan: toleransi dan label "perkiraan").
6.  **Penanganan galat** (pesan Indonesia, pola ErrorState/Toast yang ada):
    -   `422 EXPORT_TOO_LARGE`: "Data terlalu banyak (maksimal {max_rows} baris). Persempit rentang tanggal atau filter." dengan angka dari `error.details[0]`; tawarkan "Ekspor per bulan".
    -   `409 EXPORT_IN_PROGRESS`: "Ekspor lain untuk workspace ini masih berjalan." `429`: tampilkan waktu tunggu dari `Retry-After`.
    -   `403 INVALID_PASSWORD`: tetap di dialog, fokus ke kolom kata sandi. `403` lain: sembunyikan fitur. `503 NOT_CONFIGURED`: sama dengan `enabled=false`. `503 SERVICE_UNAVAILABLE`: coba lagi nanti.
    -   Jaringan putus di tengah unduhan: berkas tidak disimpan, tawarkan Ulangi. Simpan `request_id` untuk laporan.
7.  Simpan berkas dengan `Blob` + `<a download>` memakai nama dari `Content-Disposition` (fallback `wazap-export.<csv|ndjson>`), lalu `URL.revokeObjectURL`. Jangan menyimpan blob/isi di state, localStorage, atau cache setelah disimpan.

## Aturan khusus tugas ini

-   Jangan mengubah kode backend, `openapi.json`, atau migrasi. Bila kontrak terasa kurang, **laporkan gap** (`INTEGRATION_CONTRACT.md`), jangan menyiasati.
-   Jangan mengarang endpoint, field, atau kode galat. Dilarang fallback mock; 404/500 bukan "data kosong yang sukses".
-   Waktu: `from`/`to` dikirim sebagai **JSON body** (bukan query string), jadi JANGAN meng-encode `+` pada offset; gunakan awal hari lokal dengan offset (mis. `2026-11-01T00:00:00+07:00`) dan `to` eksklusif (awal hari berikutnya).
-   Semua teks UI dalam bahasa Indonesia, konsisten dengan halaman lain. Semua keadaan ada: loading, kosong, galat, sukses, tidak berwenang. Aksesibilitas: label form, fokus terjebak di drawer dan kembali ke pemicu, `aria-live` untuk progres, dapat dioperasikan dengan keyboard.
-   Sel CSV berawalan `= + - @` sengaja diberi awalan `'` oleh server (anti injeksi formula): jelaskan singkat di teks bantuan, jangan "memperbaikinya" di klien.
-   Jangan menyentuh berkas/pekerjaan agent lain yang tidak terkait. `CHANGELOG.md` adalah berkas bersama: tambahkan bagian baru di ATAS, jangan menulis ulang isinya.
-   **Jangan `git commit`/`git push`.** Biarkan perubahan di working tree; pemilik repo yang meninjau dan meng-commit.

## Cara memverifikasi (wajib dijalankan dan dilaporkan hasilnya)

1.  `cd frontend && npm run build` (typecheck `tsc --noEmit` dan `vite build`) harus lulus. Ini sama dengan job CI `frontend`.
2.  `cd backend && node --import tsx --test test/frontend-contract.test.ts` harus lulus: tes ini memeriksa SEMUA alamat `/api/v1/...` di `frontend/src` terhadap `openapi.json` (path dan method). Jangan mengubah tes ini agar lulus; bila gagal, perbaiki frontend.
    Catatan: tes membaca string literal berawalan `/api/v1/`; tulis path ekspor sebagai literal biasa (mis. `` `/api/v1/exports/${type}` ``), bukan merakitnya dari potongan yang tersebar.
3.  Uji manual terhadap backend nyata (laporkan hasil tiap butir): ekspor tiap jenis dalam CSV dan NDJSON (buka CSV di spreadsheet: BOM/Unicode benar); kata sandi salah; 6 kali salah -> terkunci 429; batal di tengah unduhan;
    rentang tanpa data; rentang > `max_span_days` (ditolak klien sebelum dikirim); `EXPORT_MAX_ROWS` dikecilkan di `backend/.env` (mis. 50) untuk memicu 422; `EXPORT_ENABLED=false` untuk memicu keadaan nonaktif; akun MEMBER/VIEWER tidak melihat tombol.
4.  Tinjau di lebar ponsel, tablet, dan desktop.

## Dokumen wajib diperbarui

`docs/03_FRONTEND/FRONTEND_ARCHITECTURE.md`, `UI_UX_SPECIFICATION.md`, `PAGE_SPECIFICATION.md`, `FRONTEND_PROGRESS.md`, `INTEGRATION_CONTRACT.md` (hanya bila ada gap), dan `CHANGELOG.md` (bagian baru "Frontend ekspor data workspace" di atas).

## Handoff

Sertakan: berkas yang ditambah/diubah; endpoint yang dipakai; hasil tiga perintah verifikasi di atas (tempel keluaran ringkas); hasil uji manual per butir; asumsi; gap kontrak yang ditemukan; bagian yang belum selesai beserta alasannya;
dan tangkapan layar bila tersedia. Selesai bila semua butir "Yang harus dibuat" terpenuhi, build dan tes kontrak lulus, dan uji manual terhadap backend nyata tidak menemukan galat yang tidak tertangani.
