# FRONTEND AI AGENT PROMPT --- Peran workspace: ADMIN dihapus (OWNER, MEMBER, VIEWER)

Backend sudah mengubah model peran (ADR-053, migrasi 0021): **peran `ADMIN` tidak ada lagi**. Workspace hanya punya `OWNER`, `MEMBER` (agent), dan `VIEWER`. Server menolak nilai `ADMIN` dengan `400`.
Semua aturan di `FRONTEND_AGENT_PROMPT.md` tetap berlaku (backend terkunci, tanpa mock, **jangan `git commit`/`git push`**). Tugas ini hanya menyesuaikan frontend dengan kontrak baru. Kontrak resmi: `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` bagian 1 (matriks peran) dan `docs/02_BACKEND/openapi.json` (`x-roles`).

## Matriks baru
| Aksi | OWNER | MEMBER (agent) | VIEWER |
|---|---|---|---|
| Sesi, pesan, chat, kontak, pemakaian: lihat | ya | ya | ya |
| Sesi: buat/ubah/hapus/pairing; pesan: kirim | ya | ya | tidak (hanya lihat) |
| Webhook, API key (buat/cabut), alarm, ekspor, audit log, tim/undangan/kode workspace | ya | **tidak** | tidak |
| Kuota | hanya lihat (sementara masih dapat diubah OWNER; P1 mengubahnya menjadi hanya-baca) | lihat | lihat |
Semua hak ADMIN yang lama (kelola tim, webhook, API key, alarm, ekspor, audit) kini **OWNER saja**. Satu workspace boleh punya beberapa OWNER.

## Yang harus diubah (peta dari kode saat ini; cari juga `isOwnerOrAdmin`, `canExport`, `canManageAlerts`)
-   `src/types/index.ts`: `Role = 'OWNER' | 'MEMBER' | 'VIEWER'`.
-   Gating yang memakai `role === 'OWNER' || role === 'ADMIN'` menjadi `role === 'OWNER'`: `Sidebar.tsx`, `SecurityBanners.tsx` (dua tempat), `AuditLogsPage.tsx`, `ConnectionsPage.tsx`, `ContactsPage.tsx`, `TeamPage.tsx`, `SettingsPage.tsx` (`canExport`, `canManageAlerts`), `ChatsPage.tsx`. Ganti nama peubah `isOwnerOrAdmin` menjadi `isOwner`.
-   `TeamPage.tsx`: buang opsi `ADMIN` pada tiga `<select>` peran (ubah peran anggota, dialog undangan, persetujuan permintaan bergabung) dan cabang `m.role === 'ADMIN'` pada badge. Teks bantuan peran: OWNER = kelola workspace; MEMBER = agent (sesi dan pesan); VIEWER = hanya lihat.
-   `Header.tsx`, `ProfilePage.tsx`: buang entri badge `ADMIN`; pada ProfilePage buang kolom dan baris `ADMIN` di tabel matriks izin dan sesuaikan isinya dengan matriks di atas.
-   `AuditLogsPage.tsx`, `SettingsPage.tsx` (teks bantuan, komentar): ubah teks yang menyebut OWNER/ADMIN atau "administrator (ADMIN)" menjadi OWNER (pemilik workspace).
-   Dokumen frontend yang menyebut ADMIN (`docs/03_FRONTEND/*`): perbarui. Tambahkan bagian di ATAS `CHANGELOG.md` ("Frontend: peran ADMIN dihapus").

## Kriteria penerimaan
```bash
cd backend && FRONTEND_ROLES_CHECK=1 node --import tsx --test test/frontend-roles.test.ts test/frontend-contract.test.ts
cd frontend && npm run build
```
`frontend-roles.test.ts` memeriksa isi `frontend/src`: tidak boleh ada token `ADMIN` sama sekali, `Role` tepat tiga nilai, dan tidak ada peubah bernama `isOwnerOrAdmin`. Jangan mengedit berkas tes; bila tampak salah, hentikan dan laporkan. Uji manual terhadap backend nyata (akun OWNER, MEMBER, VIEWER): pilihan peran tanpa ADMIN; MEMBER tidak melihat menu/tab webhook, API key, alarm, ekspor, audit, tim; VIEWER tidak melihat tombol tulis; mengirim `ADMIN` (lewat konsol) menghasilkan galat yang ditampilkan wajar.

## Handoff
Berkas yang berubah, hasil dua perintah di atas (tempel ringkasan), hasil uji manual per butir, dan hal yang tidak sempat diuji.
