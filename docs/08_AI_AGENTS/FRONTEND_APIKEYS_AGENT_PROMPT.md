# FRONTEND AI AGENT PROMPT --- API key yang dicabut, jejak audit, dan filter audit yang rusak

Anda melanjutkan frontend WAZAP (React/Vite). Backend sudah berubah (ADR-055) dan **terkunci**: jangan mengubah `backend/`, `docs/`, atau berkas tes. Semua aturan di `FRONTEND_AGENT_PROMPT.md` tetap berlaku (tanpa data tiruan, **jangan `git commit` atau `git push`**, jangan menyentuh berkas di luar tugas ini).

## Konteks (apa yang berubah di backend)

1.  **API key yang dicabut disembunyikan.** `GET /api/v1/api-keys` kini hanya mengembalikan kunci yang masih berlaku; `meta.total` hanya menghitung kunci itu. Parameter `include_revoked=true` menampilkan yang dicabut: **jangan dipakai** oleh UI pelanggan.
2.  **Kunci yang dicabut dihapus permanen setelah 1 hari** dan tidak dapat dipulihkan (penggantinya adalah kunci baru). Akibatnya `DELETE /api/v1/api-keys/:id` pada kunci yang sudah terhapus (atau sudah dicabut dari tab/perangkat lain lalu dibersihkan) menjawab **404 `NOT_FOUND`**, bukan 200.
3.  **Audit baru:** pembuatan dan pencabutan kunci dicatat sebagai `api_key.created` dan `api_key.revoked` (detail: nama, scope; tanpa nilai kunci). Nama aksi lain yang sudah ada: `api_key.updated`, `member.role_changed`, `member.removed`, `invitation.created|revoked|reissued|accepted`, `tenant.quota_changed`, `tenant.suspended`, `tenant.reactivated`, dan seterusnya (daftar lengkap: tipe `AuditAction` di `backend/src/modules/audit/audit.ts`; kontrak: `docs/02_BACKEND/API_CONTRACT.md`).
4.  Daftar kunci dipaginasi (`page`, `page_size` bawaan 20, maksimum 100) dan memuat `meta {page, page_size, total}`.

## Temuan pada frontend sekarang (sudah diverifikasi dengan membaca kode)

| # | Temuan | Dampak |
|---|---|---|
| A | `ApiKeysPage.tsx` tidak pernah memakai `revoked_at`. Sebelum perubahan backend, kunci yang dicabut tetap muncul di daftar seolah aktif (tombol Edit dan Cabut tetap ada; Edit menghasilkan 409 `INVALID_STATE`). | Pengguna mengira pencabutan gagal. Backend kini menyembunyikannya, tetapi UI harus tahan terhadap data apa pun. |
| B | Pencabutan tidak menangani 404. Kunci yang sudah dibersihkan atau dicabut di tab lain menghasilkan galat umum. | Galat membingungkan; daftar tidak disegarkan. |
| C | `api.getApiKeys` memanggil `/api/v1/api-keys` tanpa parameter dan membuang `meta`. Hanya 20 kunci pertama yang tampil, tanpa penanda. | Tenant dengan kuota kunci > 20 kehilangan kunci dari tampilan. |
| D | **Filter aksi audit memakai nama yang tidak pernah dicatat backend** (`MEMBER_INVITED`, `MEMBER_JOINED`, `ROLE_CHANGED`, `MEMBER_REMOVED`, `QUOTA_UPDATED`, `INVITATION_REVOKED`). | Memilih filter itu selalu menghasilkan daftar kosong. Ini bug yang sudah ada, bukan akibat perubahan ini. |
| E | Label ramah di tabel audit hanya untuk tiga aksi platform. | Aksi baru tampil sebagai teks mentah `api_key.revoked`. |
| F | Kartu sesi (`SessionsPage.tsx`, sekitar baris 456) hanya menampilkan `session.id.slice(0, 8)...` tanpa cara menyalin ID lengkap. Integrasi (mis. Distriva) membutuhkan `session_id` penuh (UUID) pada `POST /messages/send`. | Pengguna tidak dapat menemukan ID sesi dari UI dan terpaksa membuka DevTools. |

## Kriteria penerimaan

```bash
cd backend && FRONTEND_APIKEYS_CHECK=1 node --import tsx --test test/frontend-apikeys.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
Semuanya harus hijau. Tes `frontend-apikeys` (4 tes) saat ini **gagal semua** pada frontend yang ada. **Jangan mengedit berkas tes**; bila sebuah tes tampak salah, hentikan dan laporkan alasannya. Tes juga harus tetap lulus bila `frontend-roles` dan `frontend-platform-client` dijalankan (`FRONTEND_ROLES_CHECK=1 FRONTEND_PLATFORM_CHECK=1`).

## Perbaikan yang diminta

### 1. Filter dan label audit (temuan D dan E) --- prioritas tertinggi
Di `pages/AuditLogsPage.tsx`:
-   Ganti SEMUA nilai `<option>` agar sama dengan nama aksi backend. Pemetaan: `MEMBER_INVITED` -> `invitation.created`, `MEMBER_JOINED` -> `invitation.accepted`, `ROLE_CHANGED` -> `member.role_changed`, `MEMBER_REMOVED` -> `member.removed`, `QUOTA_UPDATED` -> `tenant.quota_changed` (sudah ada di daftar; hapus duplikatnya), `INVITATION_REVOKED` -> `invitation.revoked`. Pertahankan label teks yang sudah ramah.
-   Tambahkan opsi `api_key.created` ("API key dibuat") dan `api_key.revoked` ("API key dicabut"), dan `api_key.updated` ("API key diubah") bila belum ada.
-   Di pemetaan `actionLabel`, tambahkan label untuk `api_key.created`, `api_key.revoked`, `api_key.updated`. Aksi yang tidak dikenal tetap ditampilkan apa adanya (jangan disembunyikan).
-   Rincian baris (bila UI menampilkan `details`): untuk `api_key.*` tampilkan nama kunci; **jangan** menampilkan nilai kunci (backend memang tidak mengirimnya).

### 2. Halaman API key (temuan A dan B)
Di `pages/ApiKeysPage.tsx`:
-   Saring defensif: jangan render item dengan `revoked_at` terisi di daftar utama (tombol Edit/Cabut tidak boleh muncul untuk kunci yang dicabut).
-   Saat mencabut: bila respons `404`/`NOT_FOUND`, anggap kunci sudah tidak ada: tampilkan pesan informatif ("Kunci ini sudah dicabut atau dihapus"), segarkan daftar, dan **jangan** tampilkan galat merah. Keberhasilan tetap segarkan daftar.
-   Perbarui teks konfirmasi pencabutan agar jujur tentang konsekuensinya: kunci langsung berhenti berlaku, akan hilang dari daftar, **dihapus permanen dalam sekitar 1 hari dan tidak dapat dipulihkan**; bila ingin akses lagi, buat kunci baru. Jangan menjanjikan fitur "pulihkan".
-   Tidak ada tombol atau filter "tampilkan yang dicabut".

### 3. Klien daftar (temuan C)
Di `services/api.ts`, `getApiKeys`:
-   Minta `page_size=100` dan, bila `meta.total` lebih besar dari yang diterima, ambil halaman berikutnya sampai lengkap (atau tampilkan paginasi). Kembalikan tetap berupa `ApiKeyItem[]` agar pemanggil lama tidak rusak. Jangan pernah mengirim `include_revoked`.
-   Pengambilan ulang harus tetap memakai klien `request` yang sama (header otorisasi, penanganan 401/refresh yang sudah ada).

### 4. ID sesi dapat disalin (temuan F)
Di `pages/SessionsPage.tsx`, pada kartu sesi:
-   Pertahankan tampilan ringkas `id.slice(0, 8)...`, tetapi tambahkan tombol kecil "Salin ID" (ikon salin, `aria-label="Salin ID sesi"`) yang menyalin **ID lengkap** ke clipboard (`navigator.clipboard.writeText(session.id)`), lalu memberi umpan balik singkat ("ID disalin"). Atribut `title` pada teks ringkas berisi ID lengkap.
-   Bila `navigator.clipboard` tidak tersedia atau ditolak, tampilkan ID lengkap yang dapat dipilih (select) agar pengguna tetap bisa menyalin manual. Jangan menelan galat diam-diam.
-   ID sesi bukan rahasia (aman ditampilkan penuh kepada pengguna workspace yang sudah masuk), tetapi jangan mencatatnya ke `console`.
-   Ikuti pola tombol salin yang sudah ada di `ApiKeysPage.tsx` (`navigator.clipboard.writeText`) agar gaya konsisten.

## Yang TIDAK boleh dilakukan
-   Jangan menambahkan tombol pemulihan kunci, penyimpanan nilai kunci di browser, atau menampilkan nilai kunci setelah dialog pembuatan ditutup.
-   Jangan mengubah `ApiKeyScope`, alur pembuatan kunci, atau komponen lain di luar dua halaman dan satu klien di atas.
-   Jangan menyentuh konsol platform (`pages/platform/*`, `services/platformApi.ts`).

## Verifikasi manual yang dilaporkan (tanpa tangkapan layar rahasia)
Buat dua kunci, cabut satu: ia hilang dari daftar tanpa muat ulang. Buka dua tab, cabut kunci yang sama di keduanya: tab kedua menampilkan pesan informatif, bukan galat. Tombol "Salin ID" di kartu sesi menyalin UUID lengkap (tempel di editor untuk memastikan 36 karakter). Tabel audit menampilkan "API key dibuat/dicabut" dan filter masing-masing mengembalikan baris. Filter "Anggota Dikeluarkan" dan "Perubahan Peran" kini mengembalikan data bila ada. Laporkan berkas yang diubah dan hasil kedua perintah penerimaan.
