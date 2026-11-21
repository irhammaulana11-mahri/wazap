# FRONTEND AI AGENT PROMPT --- Konsol platform admin, kuota hanya-baca, dan peran tanpa ADMIN

Backend sudah selesai dan terkunci (ADR-053 peran tanpa ADMIN, ADR-054 platform admin). Tugas Anda: **frontend**. Semua aturan di `FRONTEND_AGENT_PROMPT.md` tetap berlaku: backend terkunci (jangan mengubahnya; bila kontrak tampak salah, hentikan dan laporkan), tanpa mock, **jangan `git commit`/`git push`**. Baca dulu: `docs/02_BACKEND/PLATFORM_ADMIN_DESIGN.md`, `docs/02_BACKEND/API_CONTRACT.md` (bagian "Konsol platform" dan "Penangguhan workspace"), `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` (bagian 4.9, "Workspace ditangguhkan"), `docs/02_BACKEND/openapi.json` (sumber kebenaran; tag `Platform`).

Pekerjaan terdiri dari tiga bagian. Kerjakan berurutan; tiap bagian punya kriteria sendiri di bagian akhir.

## Bagian A --- Peran tanpa ADMIN
Ikuti `docs/08_AI_AGENTS/FRONTEND_ROLES_AGENT_PROMPT.md` sepenuhnya (peta berkas, matriks peran, uji penerimaan `frontend-roles.test.ts`).

## Bagian B --- Perubahan di aplikasi PELANGGAN
1.  **Kuota hanya-baca** (`SettingsPage.tsx`, tab/kartu kuota, dan `api.ts`): respons `GET /tenant/settings` memuat `editable:false` dan `managed_by:"platform"`. Tampilkan kuota dan pemakaian sebagai **bilah pemakaian hanya-baca** (sesi, kunci API, anggota, pesan per menit) dengan teks "Kuota diatur oleh pemilik platform. Hubungi pemilik platform untuk menambah atau mengubahnya." **Hapus form ubah kuota** dan fungsi klien yang memanggil `PATCH /tenant/settings` (rute itu `deprecated`; OWNER menerima `403 QUOTA_MANAGED_BY_PLATFORM`).
2.  **Login workspace ditangguhkan**: `POST /auth/login` dapat menjawab `403 WORKSPACE_SUSPENDED` ("Workspace ditangguhkan. Hubungi pemilik platform."). Tampilkan pesan itu apa adanya di halaman masuk (bukan "kata sandi salah" dan bukan "tidak ada workspace aktif"). Saat workspace ditangguhkan, semua permintaan terautentikasi menjadi `401`: perilaku 401 yang ada (kembali ke halaman masuk) sudah benar, jangan diubah.
3.  **Audit log** (`AuditLogsPage.tsx`): entri dengan `actor.email === "platform"` (aksi `tenant.quota_changed`, `tenant.suspended`, `tenant.reactivated`) ditampilkan sebagai **"Pemilik platform"** (bukan alamat surel), dengan label aksi dalam bahasa Indonesia ("Kuota diubah oleh pemilik platform", "Workspace ditangguhkan", "Workspace diaktifkan kembali"). Rincian `details.changes` ditampilkan sebagai sebelum -> sesudah.

## Bagian C --- Konsol platform (aplikasi terpisah di dalam SPA yang sama)
Dilayani di rute `/platform/*` pada host dashboard yang sama. Konsol adalah **dunia terpisah** dari aplikasi pelanggan: layout sendiri (tanpa sidebar/menu pelanggan; penanda jelas "Konsol Platform" di header), sesi sendiri, klien API sendiri. **Tidak ada tautan ke konsol dari menu/sidebar pelanggan.** Pemilik platform membuka `/platform` langsung.

### C1. Klien API: `frontend/src/services/platformApi.ts` (kontrak WAJIB; diuji perilakunya)
```ts
export const platformSession: { get(): string | null; set(t: string | null): void; clear(): void }   // token platform HANYA di memori modul (variabel), TIDAK di localStorage/sessionStorage/cookie/IndexedDB/URL
export function setPlatformUnauthorizedHandler(fn: () => void): void                                  // dipanggil SEKALI saat 401 pada permintaan terautentikasi
export const platformApi = {
  login(email: string, password: string),                         // POST /platform/auth/login            -> { mfa_token, expires_in }
  verify(mfaToken: string, code: string),                         // POST /platform/auth/verify           -> { access_token, expires_in, admin, recovery_remaining }; MENYIMPAN access_token ke platformSession
  me(),                                                           // GET  /platform/me
  listWorkspaces(q?: { q?, status?, page?, page_size? }),         // GET  /platform/workspaces?...        -> { data, meta }
  getWorkspace(id: string),                                       // GET  /platform/workspaces/:id        (id di-encodeURIComponent)
  updateQuotas(id, body: { max_sessions?, max_api_keys?, max_members?, messages_per_minute?, reason, otp }),   // PATCH .../quotas
  suspend(id, body: { reason, otp }), activate(id, body: { reason, otp }),                                       // POST .../suspend|activate
  getDefaults(), updateDefaults(body: { ...kuota, reason, otp }),                                                // GET|PATCH /platform/defaults
  listAudit(q?: { tenant_id?, action?, page?, page_size? }),      // GET  /platform/audit?...             -> { data, meta }
  backupStatus(),                                                 // GET  /platform/backup-status
}
```
Aturan klien (semuanya diuji oleh tes penerimaan):
-   Semua jalur `/api/v1/platform/...`. Header `Authorization: Bearer <token platform>` pada SEMUA metode **kecuali** `login` dan `verify` (tanpa Authorization walau token ada). **Tidak pernah** `X-API-Key`, tidak pernah token workspace (`tokenStore`), `credentials: 'omit'`, `cache: 'no-store'`.
-   Hanya field kontrak yang dikirim (buang field asing dan nilai `undefined`; jangan kirim `q=undefined`); body JSON strict.
-   `401` pada permintaan terautentikasi: `platformSession.clear()` lalu `setPlatformUnauthorizedHandler` dipanggil **sekali**; **tanpa** alur refresh, tanpa mengulang permintaan, tanpa menyentuh token/sesi pelanggan.
-   Galat non-2xx menjadi `ApiError` (impor dari `./api`) lengkap: `status`, `code`, `message`, `details`, `requestId`, dan `retryAfterSec` (dari header `Retry-After`, bilangan bulat detik) pada `429`.
-   Jaringan putus (`TypeError`) atau respons bukan JSON (mis. halaman login Cloudflare Access) menjadi `ApiError` dengan `code: 'NETWORK_OR_ACCESS'` dan pesan yang jelas ("Sesi Cloudflare Access berakhir atau jaringan terputus; muat ulang halaman").
-   Tidak ada `console.*` yang mencetak token, OTP, kata sandi, atau kode pemulihan.

### C2. Halaman (berkas di `frontend/src/pages/platform/`; komponen bersama di `frontend/src/components/platform/`)
Minimal lima halaman. Nama berkas bebas; harus ada di folder itu.
1.  **Masuk** (`/platform/login`): dua langkah. Langkah 1 email + kata sandi -> `login`. Langkah 2 kolom kode 6 digit (`inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength=6`) -> `verify`; tautan "Gunakan kode pemulihan" mengganti kolom menjadi kode pemulihan (`xxxx-xxxx-xxxx`). Token MFA hanya di state komponen (kedaluwarsa 5 menit: tampilkan "Sesi verifikasi berakhir, masuk ulang"). Setelah sukses: bila `recovery_remaining <= 3`, tampilkan peringatan kuning "Sisa kode pemulihan tinggal N; minta operator server menjalankan reset-mfa". Galat: `INVALID_CREDENTIALS` (satu pesan umum, jangan membedakan penyebab), `INVALID_OTP` ("Kode salah atau sudah dipakai"), `ACCOUNT_LOCKED`/`RATE_LIMITED` (hitung mundur dari `retryAfterSec`, tombol nonaktif sampai habis). Kolom kata sandi dan kode **dikosongkan di `finally`**.
2.  **Daftar workspace** (`/platform/workspaces`): tabel (nama, slug, status berlencana, surel OWNER, sesi `used/limit` dengan bilah, anggota, kunci API), pencarian `q` (debounce), filter status (Aktif+Ditangguhkan bawaan, Dihapus, Semua), paginasi dari `meta`. Baris membuka detail.
3.  **Detail workspace** (`/platform/workspaces/:id`): kartu kuota dan pemakaian (4 kuota; **anggota memakai `quota_used.members` yang menghitung undangan tertunda**, beri keterangan itu), akun OWNER (surel, status), jumlah anggota per peran, riwayat perubahan platform (`history`: waktu, admin, aksi, alasan, sebelum -> sesudah). Tombol **Ubah kuota** (modal: empat input angka dibatasi `minimums`/`ceilings` dari respons, nilai awal = kuota sekarang, kirim hanya yang berubah; **alasan wajib** min 3 karakter; **kode TOTP**) dan **Tangguhkan** / **Aktifkan** (dialog konfirmasi yang menjelaskan akibatnya: akses berhenti, sesi diputus, webhook dan alarm ditahan, data tidak dihapus, dapat dipulihkan; alasan wajib; kode TOTP). Tampilkan hasil (`sessions_affected`) dan segarkan data. Tombol sesuai status (Tangguhkan hanya untuk ACTIVE, Aktifkan hanya untuk SUSPENDED; DELETED tanpa tombol).
4.  **Kuota bawaan** (`/platform/defaults`): tampilkan dan ubah (modal sama: alasan + TOTP). Jelaskan "berlaku untuk workspace BARU saja".
5.  **Audit platform** (`/platform/audit`): tabel terbaru dulu, filter aksi dan `tenant_id`, paginasi, tampilkan alasan dan rincian `changes`.
6.  **Status cadangan** (kartu di halaman daftar atau halaman sendiri): dari `backupStatus()`: bila `configured=false` atau `available=false` tampilkan `reason` (abu-abu/merah); bila `available`: sukses terakhir (waktu dan umur jam), **merah bila `stale`**, ukuran dan nama berkas, kegagalan terakhir beserta alasannya, dan **lokasi** dengan penjelasan jujur: `offsite` = "Salinan di luar host", `separate_disk` = "Disk terpisah di server yang sama (melindungi dari kegagalan satu disk, bukan dari kehilangan server)", `same_disk` = "Satu disk dengan sistem (berisiko)". **Tanpa tombol jalankan/pulihkan.**

### C3. Perilaku UI yang wajib
-   **Kode TOTP sekali pakai**: tiap perubahan meminta kode segar. Bila `INVALID_OTP`, tampilkan "Kode salah atau sudah dipakai. Tunggu kode berikutnya (maksimal 30 detik) lalu coba lagi" dan kosongkan kolom. Jangan mengulang otomatis. Kolom kode dikosongkan di `finally`.
-   Tampilkan galat bisnis dengan bahasa jelas: `409 LIMIT_BELOW_USAGE` (kuota tidak boleh di bawah pemakaian), `409 NO_CHANGE`, `409 INVALID_STATE`, `400 VALIDATION_ERROR` (tandai kolom lewat `details[].path`), `404`, `429` (hitung mundur).
-   Sesi konsol berumur ≤ 30 menit (tanpa refresh): saat 401 tampilkan "Sesi berakhir" lalu kembali ke `/platform/login` (jangan hilangkan halaman yang sedang dibuka tanpa memberi tahu).
-   Rute konsol dijaga oleh `platformSession.get()` (guard sendiri, **bukan** `ProtectedRoute` pelanggan). Tanpa token: ke `/platform/login`.
-   Tampilkan teks privasi di footer konsol: "Konsol ini hanya menampilkan metadata dan agregat. Isi pesan, kontak, dan kredensial pelanggan tidak pernah ditampilkan."
-   Tidak ada data tiruan. Tidak ada penyimpanan token/OTP/rahasia di storage, cookie, atau URL. Aksesibilitas: label terhubung (`htmlFor`/`id`), fokus terjebak di modal dan kembali ke pemicu saat ditutup, Escape menutup, kontras cukup, responsif.

## Kriteria penerimaan (jangan mengedit berkas tes; bila tampak salah, hentikan dan laporkan alasannya)
```bash
cd backend && FRONTEND_ROLES_CHECK=1 FRONTEND_PLATFORM_CHECK=1 node --import tsx --test test/frontend-roles.test.ts test/frontend-platform-client.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
Semuanya hijau. `frontend-platform-client.test.ts` menjalankan klien Anda yang sebenarnya dengan `fetch` palsu dan memeriksa tiap permintaan terhadap skema strict backend; juga memindai sumber (pemisahan modul platform dan pelanggan, larangan storage/cookie/`tokenStore`/`X-API-Key`, larangan `console` mencetak rahasia, rute `/platform` dijaga `platformSession`, tidak ada tautan konsol di `components/layout`). Pesan galat tes menyebut persis apa yang kurang.

## Uji manual (laporkan per butir; backend dev berjalan; buat platform admin dengan CLI `npm run admin:platform-admin -- create --email ...` pada akun uji)
Masuk dua langkah (kata sandi salah, kode salah, kode dipakai ulang, kode pemulihan, penguncian dengan hitung mundur); daftar workspace (cari, filter, paginasi); detail; ubah kuota (di bawah pemakaian 409, di luar batas 400, tanpa perubahan 409, kode salah, sukses dan terlihat di audit workspace sebagai "Pemilik platform"); tangguhkan lalu verifikasi di jendela pelanggan: permintaan menjadi 401, login menampilkan pesan `WORKSPACE_SUSPENDED`, Socket.IO terputus; aktifkan lalu pelanggan dapat masuk dan sesi WhatsApp menyambung sendiri; kuota bawaan; audit; status cadangan (tanpa berkas, berkas valid, basi); token platform TIDAK terlihat di localStorage/sessionStorage/cookie/URL/Network tab pelanggan; keyboard saja; sesi berakhir; tampilan di MEMBER/VIEWER/OWNER pelanggan tidak memuat tautan konsol.

## Handoff
Berkas yang berubah, hasil dua perintah di atas (tempel ringkasan), hasil uji manual per butir, hal yang tidak sempat atau tidak dapat diuji beserta alasannya, dan keraguan pada tes (bila ada). Perbarui `docs/03_FRONTEND/*` dan tambahkan bagian di ATAS `CHANGELOG.md` ("Frontend: konsol platform, kuota hanya-baca, peran tanpa ADMIN"), tanpa menulis ulang isi berkas bersama itu.
