# FRONTEND AI AGENT PROMPT --- Tab "Notifikasi" (alarm per workspace)

Anda adalah Senior Frontend Engineer untuk WhatsApp Gateway (dashboard React). Tugas ini SATU fitur: **tab Notifikasi di Pengaturan** untuk mengelola kanal dan aturan alarm workspace. Backend sudah selesai, diuji, dan terkunci kontraknya (ADR-049); Anda hanya mengerjakan frontend.
Semua aturan umum di `docs/08_AI_AGENTS/FRONTEND_AGENT_PROMPT.md` dan pelajaran dari tugas ekspor (`FRONTEND_EXPORT_AGENT_PROMPT.md`, `FRONTEND_EXPORT_FIXES_PROMPT.md`) tetap berlaku. Pelajaran terpenting dari ekspor: **jangan menampilkan angka/teks tebakan yang seharusnya datang dari server** dan **jangan memberi jaminan yang tidak benar**.

## Prasyarat lingkungan (periksa DULU; berhenti dan lapor bila tidak terpenuhi)

1.  `ls backend/src/modules/alerts/alerts.routes.ts` HARUS ada (commit `3cdbfcf` atau lebih baru). Bila tidak, salinan kerja ketinggalan; **jangan membuat mock**, minta pemilik repo memperbarui ke `clean/backend-v1`.
2.  Backend dev berjalan (`cd backend && npm run dev`, migrasi 0020 diterapkan otomatis). Periksa: `GET /api/v1/alerts/catalog` dengan token pengguna dashboard menjawab 200. Frontend: `cd frontend && npm run dev` (proxy Vite ke `127.0.0.1:3000`). Uji terhadap backend NYATA.
3.  Untuk uji kirim sungguhan butuh `CREDENTIAL_ENCRYPTION_KEYS` di `backend/.env` (tanpa itu, membuat kanal menjawab 503 `NOT_CONFIGURED`: tampilkan pesannya dan lapor). Dev memakai `WEBHOOK_ALLOW_PRIVATE_TARGETS` yang TIDAK berlaku untuk alarm: kanal Slack hanya host publik tertentu.

## Wajib dibaca (urut)

1.  `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` bagian **"Notifikasi alarm workspace: kontrak untuk UI"** (paling bawah).
2.  `docs/02_BACKEND/ALERT_NOTIFICATIONS_DESIGN.md` bagian 2, 3, 6, 7, 9, **12** (apa yang benar-benar dibangun dan penyimpangannya), dan `docs/02_BACKEND/openapi.json` (tag `Notifikasi`).
3.  `docs/08_AI_AGENTS/FRONTEND_AGENT_PROMPT.md`, `docs/03_FRONTEND/*`, `docs/08_AI_AGENTS/DOCUMENTATION_RULES.md`.
Bila dokumen bertentangan: kode backend dan `openapi.json` > `API_CONTRACT.md` > `FRONTEND_HANDOFF.md` > dokumen lain > prompt ini. **Laporkan pertentangan**, jangan menebak.

## Kriteria penerimaan (jangan mengubah berkas tes)

```bash
cd backend && node --import tsx --test test/frontend-alerts-client.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
Keduanya hijau. `frontend-alerts-client.test.ts` menjalankan fungsi `api` sungguhan dengan `fetch` palsu dan memeriksa method, path, header, dan BODY terhadap skema strict backend; **jangan mengedit tes agar lulus**, bila tampak salah hentikan dan laporkan.
Nama fungsi dan bentuk keluaran WAJIB persis seperti di bagian berikut.

## Yang harus dibuat

1.  **`frontend/src/services/api.ts`** (pola `request()` yang ada, token, refresh single-flight; setiap fungsi mengembalikan isi `data`, galat menjadi `ApiError` dengan `retryAfterSec` untuk 429):
    `getAlertCatalog()`, `listAlertChannels()`, `createAlertChannel(body)`, `updateAlertChannel(id, body)`, `deleteAlertChannel(id, password)`, `testAlertChannel(id)`, `listAlertRules()`, `putAlertRule(code, body)`, `listAlertDeliveries(limit?)`.
    Body dikirim apa adanya sesuai skema strict (field asing = 400): `createAlertChannel` menerima `{type:'TELEGRAM',name,token,chat_id,password}` atau `{type:'SLACK',name,url,password}`; `deleteAlertChannel` mengirim `DELETE` dengan body JSON `{password}`; `listAlertDeliveries(limit)` memakai query `?limit=n` hanya bila diberikan.
    **Kata sandi, token, dan URL kanal tidak boleh ada di URL, log, localStorage, atau cache TanStack Query** (mutasi saja; jangan menaruh nilai itu di key/data query).
2.  **Tab baru "Notifikasi"** di `SettingsPage` (`?tab=notifications`, pola `searchParams` yang ada), terlihat hanya untuk OWNER/ADMIN (`useAuth().role`); peran lain tidak melihat tab dan, bila membuka URL-nya, melihat keadaan "tidak berwenang". Tangani 403 bila peran berubah.
    Komponen di `frontend/src/components/alerts/` (jangan menumpuk di berkas halaman). Tiga bagian:
    -   **Kanal:** daftar (nama, tipe Telegram/Slack, `target_hint` sebagai "berakhiran ••••abcd", status Aktif/Nonaktif, bila `disabled_reason === 'AUTO_CONSECUTIVE_FAILURES'` tampilkan "Dinonaktifkan otomatis karena gagal berturut-turut" dan tombol Aktifkan ulang). Aksi: Tambah, Uji kirim, Nonaktifkan/Aktifkan, Ganti target, Hapus.
        Tambah/Ganti target/Hapus meminta kata sandi (drawer atau dialog dengan pola yang dipakai ExportDrawer: label terhubung, fokus terjebak lalu kembali ke pemicu, kata sandi dikosongkan di `finally`, fokus kembali ke kolom kata sandi untuk `INVALID_PASSWORD`). Rahasia (token/URL) hanya ada di state form lokal dan dikosongkan setelah kirim; **jangan menampilkan ulang** dan jangan mengisi ulang form ganti-target dengan nilai lama.
        Form Telegram: token dan chat_id (teks bantuan cara mendapatkannya, ringkas, dari handoff); form Slack: URL (jelaskan "Slack atau Discord (tambahkan /slack di ujung URL Discord)"). Tampilkan galat `422 INVALID_ALERT_TARGET` dengan pesan dari server. Tampilkan sisa kuota ("{n} dari {max_channels} kanal", `max_channels` dari katalog); tombol Tambah nonaktif bila penuh.
        **Uji kirim:** tampilkan hasil apa adanya: `ok` -> "Pesan uji terkirim; periksa chat Anda"; `ok:false` -> "Gagal ({error_code atau status_code})" dengan penjelasan umum (401/403/404 = token dicabut atau chat tidak ditemukan; TIMEOUT/DNS_FAILED/TLS_ERROR = jaringan). 429: waktu tunggu dari `retryAfterSec`. Jangan menyebut "berhasil" hanya karena HTTP 200.
    -   **Aturan:** satu baris per aturan dari **katalog** (label, deskripsi dari server): sakelar aktif, ambang (hanya bila `threshold` ada: input angka dalam min..max dengan satuan dari server, nilai bawaan dari server), jeda ulang (hanya bila `repeats`: 5..1440 menit, bawaan dari `cooldown.default`), pilihan kanal (multi, maks 5). Simpan per baris (`putAlertRule`); aktifkan tanpa kanal ditolak di UI (dan server 400: tampilkan). Bila belum ada kanal aktif, ajak membuat kanal dulu.
        Tampilkan peringatan jujur di bagian ini: "Notifikasi adalah bantuan, bukan jaminan: Telegram/Slack dapat lambat atau tidak tersedia. Kejadian yang terjadi saat layanan kami berhenti lama mungkin tidak dikirim."
    -   **Riwayat pengiriman:** tabel `listAlertDeliveries(50)` (waktu, aturan [label dari katalog], kanal, status; untuk DEAD tampilkan penjelasan dari `last_error_code`: `HTTP_401/403/404` token/chat bermasalah, `RATE_CAPPED` "dibatasi: terlalu banyak pesan dalam 1 jam", `CHANNEL_INACTIVE` "kanal nonaktif", lainnya kode apa adanya). Muat ulang tanpa auto-poll agresif (tombol "Muat ulang", dan saat tab dibuka).
3.  **Keadaan fitur:** `catalog.enabled=false` -> banner "Notifikasi dinonaktifkan sementara oleh operator", kontrol tulis nonaktif, data tetap tampil. 503 `NOT_CONFIGURED` pada tulis -> pesan yang sama. Katalog gagal dimuat -> ErrorState dengan Coba lagi; **tanpa angka/daftar cadangan di klien** (daftar aturan, batas, bawaan, label semuanya dari katalog).
4.  Semua keadaan: loading (skeleton/`—`), kosong ("Belum ada kanal"), galat, sukses, tidak berwenang. Teks Indonesia. Aksesibilitas: label form, sakelar dengan `aria-checked`, `aria-live` untuk hasil uji, dapat dioperasikan keyboard.
5.  Tampilkan `request_id` kecil di kotak galat dengan tombol salin (pola yang sama dengan ekspor).

## Aturan khusus tugas ini

-   Jangan mengubah backend, `openapi.json`, migrasi, atau berkas tes. Kontrak kurang -> laporkan gap, jangan menyiasati. Jangan mengarang endpoint/field/kode galat; tanpa fallback mock; 404/500 bukan "data kosong yang sukses".
-   Rahasia: lihat butir 1 dan 2; satu-satunya tempat token/URL berada adalah state form lokal sementara.
-   **Jangan `git commit` / `git push`.** Pemilik repo yang memeriksa dan meng-commit.
-   Perbarui `docs/03_FRONTEND/*` dan tambahkan bagian di ATAS `CHANGELOG.md` ("Frontend tab Notifikasi"), tanpa menulis ulang isi berkas bersama itu.

## Cara memverifikasi (laporkan hasil)

1.  Dua perintah di "Kriteria penerimaan" (tempel ringkasan keluaran).
2.  Uji manual terhadap backend nyata, laporkan per butir: OWNER membuka tab; MEMBER/VIEWER tidak melihat tab dan tidak dapat memuat data lewat URL; buat kanal Telegram (token bot sungguhan bila ada, bila tidak: bentuk token salah -> pesan 422) dan Slack; kata sandi salah; 6 salah berturut-turut -> 429 dengan hitung mundur;
    uji kirim sukses dan gagal (token palsu -> `ok:false`); ganti target; nonaktif/aktif; hapus; kuota penuh; aturan: aktif tanpa kanal, ambang di luar rentang, jeda ulang pada aturan yang tidak mendukung (tombol/input tidak muncul); simpan aturan lalu muat ulang halaman (nilai bertahan);
    riwayat setelah pemicu nyata (putuskan perangkat pada sesi uji dengan aturan `session.logged_out` aktif); `ALERTS_ENABLED=false` di `backend/.env` (banner, tulis nonaktif); katalog gagal dimuat (tidak ada angka tebakan); navigasi hanya dengan keyboard; periksa tab Network: tidak ada token/URL/kata sandi di URL atau di respons mana pun.
3.  Periksa bahwa tidak ada rahasia di `localStorage`/`sessionStorage`/devtools React Query setelah membuat kanal.

## Handoff
Berkas yang berubah, hasil tes (tempel), hasil uji manual per butir, hal yang tidak sempat/tidak bisa diuji beserta alasannya, dan keraguan pada kontrak atau tes. Selesai bila dua perintah hijau, uji manual dilaporkan, dan tidak ada nilai kebijakan/aturan tebakan tersisa di klien.
