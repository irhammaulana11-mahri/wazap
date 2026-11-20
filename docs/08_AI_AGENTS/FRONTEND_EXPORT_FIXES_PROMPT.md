# FRONTEND AI AGENT PROMPT --- Perbaikan UI ekspor data workspace

Anda melanjutkan pekerjaan **UI ekspor data** (`docs/08_AI_AGENTS/FRONTEND_EXPORT_AGENT_PROMPT.md`) yang sudah dibuat tetapi belum lolos verifikasi. Hasil verifikasi: build dan tes kontrak statis lulus, penempatan dan pembatasan peran benar, klien jaringan (`api.ts`) benar;
namun ada temuan yang membuat UI memberi **jaminan keliru** kepada pengguna. Tugas ini hanya memperbaiki temuan itu. Semua aturan di `FRONTEND_AGENT_PROMPT.md` dan `FRONTEND_EXPORT_AGENT_PROMPT.md` tetap berlaku (backend terkunci, tanpa mock, **jangan `git commit`/`git push`**).

## Kriteria penerimaan = tiga tes backend (jangan diubah)

```bash
cd backend && node --import tsx --test test/frontend-export-client.test.ts test/frontend-export-integrity.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
Semuanya harus hijau. **Jangan mengedit berkas tes** agar lulus; bila sebuah tes tampak salah, hentikan dan laporkan alasannya. Tes `frontend-export-client` menjalankan `api.exportData` sungguhan dengan `fetch` palsu dan memeriksa body terhadap skema strict backend;
`frontend-export-integrity` menguji modul murni dengan data yang dibuat penulis CSV backend, ditambah penjaga statis atas kode komponen. Pesan galat tes menyebut persis apa yang kurang.

## Perbaikan yang diminta (urut prioritas)

### 1. Cek kelengkapan berkas tidak andal (menjamin keliru)
Kode sekarang (`ExportDrawer.tsx`, blok setelah `api.exportData`) memuat seluruh berkas dengan `blob.text()`, lalu CSV dihitung dengan `split('\r\n')`. Sel yang berisi CRLF (umum pada pesan dari integrasi Windows) membuat berkas lengkap 4 baris terhitung 7 dan berkas **terpotong di baris 3 terhitung 4 sehingga lolos**.
NDJSON hanya memeriksa manifest ada, bukan jumlahnya cocok.
-   Buat `frontend/src/utils/exportIntegrity.ts` (TANPA impor React/DOM; hanya API standar `Blob`, `TextDecoder`):
    ```ts
    export interface IntegrityResult { ok: boolean; rows: number; reason?: string }   // reason hanya bila ok=false
    export async function verifyExportBlob(blob: Blob, format: 'csv' | 'ndjson', expectedRows: number | undefined, opts?: { approximate?: boolean }): Promise<IntegrityResult>
    ```
-   CSV: hitung rekaman dengan pembaca sadar tanda kutip (CRLF/LF/koma/kutip di dalam sel adalah isi, bukan pemisah), buang BOM, baris pertama adalah header. Berkas yang berakhir di tengah baris atau di dalam kutipan = tidak lengkap. `ok` bila `expectedRows === undefined` atau `rows >= expectedRows`; dengan `approximate: true` (jenis `contacts`) selalu `ok` bila berkas utuh.
-   NDJSON: baris tak-kosong TERAKHIR harus `{"_manifest": {"rows": <angka>, ...}}`; `rows` harus sama dengan jumlah baris data; bila ada `expectedRows`, jumlah baris data >= itu. Manifest hilang, terpotong, tidak di akhir, atau jumlahnya beda = tidak lengkap.
-   Baca bertahap lewat `blob.stream()` (`getReader`, `TextDecoder` dengan `{stream: true}`); jangan membuat satu string raksasa. 100 ribu baris harus selesai dalam hitungan detik.
-   Pakai di `ExportDrawer`; tampilkan `reason` bila tidak lengkap dan tawarkan "Ulangi". Untuk `contacts` kirim `approximate: true` dan beri label "perkiraan" pada jumlah barisnya.

### 2. Angka cadangan kebijakan menyesatkan (transparansi privasi)
Sebelum kebijakan termuat, UI menampilkan angka tebakan: `row_days ?? 90` (server: 180), `max_span_days || 90` (server: 92), `content_days ?? 30`, `audit_days ?? 365`, `max_rows || 100000`, `per_hour ?? 5`, di `ExportDrawer.tsx` dan `SettingsPage.tsx`.
-   Hapus SEMUA angka cadangan untuk nilai kebijakan. Saat memuat tampilkan kerangka/`—`; saat galat tampilkan ErrorState dengan tombol coba lagi; nonaktifkan tombol Mulai Ekspor sampai kebijakan termuat.

### 3. Tanggal kosong menghasilkan `from: "NaN-NaN-NaNT..."`
Mengosongkan input tanggal lolos validasi lalu dikirim sebagai `NaN` (pasti 400 dengan pesan generik). Selain itu, di zona waktu ber-DST, "92 hari kalender" bisa melebihi 92 x 24 jam dan ditolak backend.
-   Buat `frontend/src/utils/exportRange.ts` (murni, tanpa React/DOM):
    ```ts
    export type RangeResult =
      | { ok: true; from: string; to: string; spanDays: number }
      | { ok: false; reason: 'kosong' | 'tidak-valid' | 'urutan' | 'terlalu-panjang' }
    export function buildExportRange(startStr: string, endStr: string, maxSpanDays: number): RangeResult
    ```
    Masukan `YYYY-MM-DD` (nilai `<input type="date">`). `from` = awal hari awal (lokal) dan `to` = awal hari SESUDAH tanggal akhir (eksklusif), keduanya ISO-8601 dengan offset lokal (`+07:00`, `-03:00`, `+05:30`). `spanDays` = jumlah hari kalender terpilih.
    Tolak: kosong, format/tanggal tidak valid (mis. `2026-02-30`), akhir sebelum awal, dan rentang yang melebihi `maxSpanDays x 86400000` ms (hitung dalam milidetik, sama dengan backend).
-   Pakai di `ExportDrawer` untuk validasi, pesan galat, dan nilai yang dikirim; ganti `fromLocalDateInput`/`formatIsoWithOffset`.

### 4. Kata sandi harus dikosongkan di `finally`
Sekarang dikosongkan hanya saat sukses atau drawer dibuka ulang; setelah galat atau batal kata sandi tetap di state. Pindahkan `setPassword('')` ke blok `finally` pada `handleSubmit` (sukses, galat, dan batal), dan fokuskan kembali kolom kata sandi untuk `INVALID_PASSWORD`.

### 5. `Retry-After` dan `request_id` tidak ditampilkan
-   Tambahkan parameter ke-6 opsional pada `ApiError`: `retryAfterSec?: number` (detik, dari header `Retry-After` berupa angka bulat) dan isi di `exportData` untuk respons non-200. Tampilkan di UI untuk 429: "Coba lagi dalam {n} detik" (hitung mundur ringan boleh). Hapus angka "5 ekspor per jam" yang ditulis keras; pakai `policy.per_hour`.
-   Tampilkan `request_id` kecil di kotak galat ("Kode laporan: ...") dengan tombol salin.
-   `403` selain `INVALID_PASSWORD`: tampilkan "Anda tidak berwenang mengekspor data" dan sembunyikan tombol ekspor sampai peran berubah.

### 6. Aksesibilitas drawer
-   Setiap `<label>` terhubung ke kontrolnya (`htmlFor` + `id`); hapus `tabIndex={-1}` pada tombol tampilkan kata sandi (beri `aria-label` dan `aria-pressed`).
-   Fokus terjebak di dalam drawer (Tab/Shift+Tab berputar) dan kembali ke tombol pemicu saat ditutup (simpan `document.activeElement` saat dibuka). Escape tetap menutup bila tidak sedang mengekspor.

### 7. Kebersihan kecil
-   Hapus komentar `/* method: 'POST' */` di `api.ts` (kontrak kini diperiksa tes perilaku, bukan komentar).
-   Tambahkan `Retry-After` ke `ApiError` memakai urutan argumen di atas tanpa mengubah pemanggil lain.
-   `URL.revokeObjectURL` dipanggil setelah jeda singkat (mis. `setTimeout(..., 1000)`), bukan langsung setelah `click()`: beberapa peramban membatalkan unduhan bila di-revoke sinkron.

## Cara memverifikasi (laporkan hasil)
1.  Dua perintah di bagian "Kriteria penerimaan" (tempel ringkasan keluaran).
2.  Uji manual terhadap backend nyata (backend dev berjalan; pakai akun OWNER) dan laporkan per butir: ekspor tiap jenis CSV dan NDJSON; CSV dibuka di spreadsheet; kata sandi salah; 6 salah berturut-turut -> 429 dengan hitung mundur; batal di tengah unduhan; rentang tanpa data;
    kosongkan input tanggal (tombol nonaktif, tidak ada kiriman); rentang > 92 hari; `EXPORT_MAX_ROWS=50` di `backend/.env` untuk 422; `EXPORT_ENABLED=false`; MEMBER/VIEWER tidak melihat tombol; kebijakan lambat/gagal dimuat (tidak ada angka tebakan); navigasi hanya dengan keyboard (Tab/Shift+Tab/Escape, fokus kembali);
    unduhan di Firefox dan Chrome.
3.  Perbarui `docs/03_FRONTEND/*` dan tambahkan bagian di ATAS `CHANGELOG.md` ("Frontend perbaikan ekspor data"), tanpa menulis ulang isi berkas bersama itu.

## Handoff
Berkas yang berubah, hasil tes (tempel), hasil uji manual per butir, hal yang tidak sempat/ tidak bisa diuji beserta alasannya, dan keraguan pada tes (bila ada). Selesai bila tiga tes backend dan build hijau, uji manual dilaporkan, dan tidak ada angka tebakan kebijakan tersisa.
