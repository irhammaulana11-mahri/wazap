# FRONTEND AI AGENT PROMPT --- Persetujuan pendaftaran workspace oleh pemilik platform (ADR-056)

Anda melanjutkan frontend WAZAP (React/Vite). Backend sudah selesai dan **terkunci**: jangan mengubah `backend/`, `docs/`, atau berkas tes. Semua aturan di `FRONTEND_AGENT_PROMPT.md` dan `FRONTEND_PLATFORM_AGENT_PROMPT.md` tetap berlaku (tanpa data tiruan, **jangan `git commit` atau `git push`**, klien platform terpisah dari klien pelanggan, token platform hanya di memori, jangan menyentuh berkas di luar tugas ini).

## Konteks (apa yang berubah di backend)

Di produksi pendaftaran workspace baru kini **menunggu persetujuan pemilik platform** (`REGISTRATION_APPROVAL=required`). Kontrak lengkap: `docs/02_BACKEND/API_CONTRACT.md` bagian "Persetujuan pendaftaran workspace (ADR-056)" dan `docs/02_BACKEND/openapi.json`.

1.  `POST /api/v1/auth/register` menjawab **`202`** (bukan 201) `{success, data:{status:'PENDING_APPROVAL', user:{id,email}, tenant:{id,name,slug}, recovery_codes:[8]}}` **tanpa `access_token` dan tanpa cookie refresh**. Mode lama (`open`) tetap `201` dengan token, jadi klien harus menangani **kedua** bentuk.
2.  `POST /api/v1/auth/login` menjawab `403 REGISTRATION_PENDING` (menunggu) atau `403 REGISTRATION_REJECTED` (ditolak) setelah kata sandi benar. Kata sandi salah tetap `401 INVALID_CREDENTIALS`.
3.  Konsol platform: `GET /api/v1/platform/workspaces?status=PENDING|REJECTED|ACTIVE|SUSPENDED|DELETED|ALL` (bawaan tanpa parameter: ACTIVE+SUSPENDED; `ALL` kini memuat semua status). Item memuat `status` dan `decided_at`. `meta.total` memberi jumlah. `POST /platform/workspaces/:id/approve` body `{otp, reason?}` (PENDING atau REJECTED -> ACTIVE) dan `POST /platform/workspaces/:id/reject` body `{otp, reason}` (hanya PENDING; alasan 3 sampai 500 karakter). Respons `{id, status, decided_at}`. `409 INVALID_STATE` bila statusnya tidak sesuai.

## Temuan pada frontend sekarang (sudah diverifikasi dengan membaca kode)

| # | Temuan | Dampak |
|---|---|---|
| A | `api.register` (`services/api.ts`) selalu menjalankan `tokenStore.set(res.data.access_token)` lalu mengembalikan data seolah login berhasil. | Pada 202 token `undefined` tersimpan dan halaman daftar menganggap pendaftar sudah masuk. |
| B | `LoginPage.tsx` hanya mengenal `WORKSPACE_SUSPENDED` dan `JOIN_PENDING`. | `REGISTRATION_PENDING/REJECTED` tampil sebagai galat umum. |
| C | `platformApi.ts` dan halaman konsol hanya mengenal status `ACTIVE\|SUSPENDED\|DELETED`; tidak ada `approve`/`reject`. | Pemilik platform tidak dapat melihat atau memutuskan pendaftaran. |

## Kriteria penerimaan

```bash
cd backend && FRONTEND_REGAPPROVAL_CHECK=1 node --import tsx --test test/frontend-regapproval.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
Semuanya harus hijau. **Jangan mengedit berkas tes**; bila sebuah tes tampak salah, hentikan dan laporkan alasannya. Tes juga harus tetap lulus bila tes frontend lain dijalankan (`FRONTEND_ROLES_CHECK=1 FRONTEND_PLATFORM_CHECK=1 FRONTEND_APIKEYS_CHECK=1`).

## Perbaikan yang diminta

### 1. Klien dan halaman daftar (temuan A)
-   `api.register` (`services/api.ts`): kembalikan hasil yang membedakan dua kemungkinan, mis. `{ kind: 'pending', data }` bila `data.status === 'PENDING_APPROVAL'` dan `{ kind: 'session', data }` bila ada `access_token`. **Hanya** pada `session` panggil `tokenStore.set(...)`. Jangan pernah menyimpan token yang `undefined`.
-   `RegisterPage.tsx`: pada `pending`, JANGAN navigasi ke dashboard dan jangan memperlakukan pendaftar sebagai masuk. Tampilkan layar tersendiri: judul "Pendaftaran Diterima", teks "Workspace **{nama}** menunggu persetujuan pemilik platform. Anda dapat masuk setelah disetujui.", dan **kode pemulihan** dengan komponen/penyajian yang sama seperti jalur sukses (8 kode sekali tampil, tombol salin dengan penanganan gagal, konfirmasi "sudah saya simpan" bila alur lama punya), lalu tautan "Ke halaman masuk". Kode pemulihan tidak boleh disimpan di storage, URL, atau `console`.
-   Jalur `session` (mode terbuka) tetap berfungsi seperti sekarang.

### 2. Pesan login (temuan B)
Di `LoginPage.tsx`, tambahkan penanganan `err.code === 'REGISTRATION_PENDING'` (pesan informatif, bukan merah: "Pendaftaran Anda menunggu persetujuan pemilik platform. Anda dapat masuk setelah disetujui.") dan `'REGISTRATION_REJECTED'` ("Pendaftaran Anda ditolak oleh pemilik platform. Hubungi pemilik platform bila ini keliru."). Ikuti pola `WORKSPACE_SUSPENDED` yang ada (judul dan gaya kotak pesan). Kata sandi salah tetap pesan umum.

### 3. Konsol platform (temuan C)
Di `services/platformApi.ts` dan `pages/platform/*` (hanya berkas konsol platform):
-   **Tipe:** status menjadi `'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'REJECTED'`; tambahkan `decided_at: string | null` pada tipe workspace. Status yang tidak dikenal tetap ditampilkan apa adanya (jangan membuat halaman kosong).
-   **Klien:** `platformApi.approve(id, { otp, reason? })` -> `POST .../approve` dan `platformApi.reject(id, { otp, reason })` -> `POST .../reject`, memakai klien platform yang sama (token platform, tanpa refresh, penanganan 401/429 yang ada). Field `reason` kosong tidak dikirim pada approve.
-   **Daftar (`PlatformWorkspacesPage.tsx`):** tambahkan opsi filter "Menunggu persetujuan (PENDING)" dan "Ditolak (REJECTED)"; lencana status berwarna berbeda untuk keduanya (PENDING kuning/amber, REJECTED merah); tampilkan **lencana jumlah menunggu** di header halaman, diambil dari `GET .../workspaces?status=PENDING&page_size=1` (`meta.total`) dan dapat diklik untuk menyaring ke PENDING. Bila jumlah 0, jangan tampilkan lencana mencolok.
-   **Detail (`PlatformWorkspaceDetailPage.tsx`):** untuk status `PENDING` tampilkan tombol **Setujui** dan **Tolak**; untuk `REJECTED` hanya **Setujui** ("Setujui (kesempatan kedua)"). Gunakan pola modal TOTP yang sama seperti Tangguhkan/Aktifkan: kolom kode TOTP wajib; **Tolak** mewajibkan alasan (minimal 3 karakter, tombol nonaktif sebelum terisi); **Setujui** alasan opsional. Kosongkan kolom kode dan alasan di `finally`. Setelah berhasil, segarkan detail, daftar, dan lencana jumlah. `409 INVALID_STATE` (status sudah berubah di tab lain) tampilkan pesan informatif dan segarkan. Galat TOTP ditampilkan seperti pola yang ada.
-   Untuk `PENDING` dan `REJECTED` sembunyikan tombol Tangguhkan/Aktifkan (backend menjawab 409 di sana). Perubahan kuota tetap boleh untuk PENDING (agar kuota dapat diatur sebelum disetujui). Tampilkan `decided_at` bila ada.
-   Tampilkan daftar surel pemilik (`owners`) pada baris PENDING agar pemilik platform tahu siapa yang mendaftar.

## Yang TIDAK boleh dilakukan
-   Jangan menambahkan tautan konsol platform di area pelanggan (aturan prompt platform tetap).
-   Jangan menyimpan token platform atau kode pemulihan di storage/cookie/URL/console.
-   Jangan mengubah halaman pelanggan selain `RegisterPage.tsx`, `LoginPage.tsx`, dan `services/api.ts` (hanya fungsi `register`).
-   Jangan menambah fitur surel atau notifikasi (belum ada di backend).

## Verifikasi manual yang dilaporkan (tanpa tangkapan layar rahasia)
Dengan backend `REGISTRATION_APPROVAL=required`: daftar akun baru, layar "Pendaftaran Diterima" dengan kode pemulihan muncul dan Anda **tidak** masuk ke dashboard; login akun itu menampilkan pesan menunggu; di konsol platform lencana jumlah menunggu bertambah, filter PENDING menampilkan pendaftar dengan surelnya; **Setujui** dengan TOTP segar membuat login berhasil; pendaftar kedua **Ditolak** (alasan wajib) lalu login menampilkan pesan ditolak, dan ia dapat **Disetujui** kemudian. Pada backend mode terbuka, pendaftaran tetap langsung masuk. Laporkan berkas yang diubah dan hasil kedua perintah penerimaan.
