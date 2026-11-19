# SOP operator: pengguna kehilangan semua kode pemulihan

Berlaku bila pengguna lupa kata sandi DAN tidak punya kode pemulihan yang tersisa (tanpa email, tidak ada jalur mandiri lain). Operator adalah pintu terakhir, jadi tujuan utama SOP ini adalah mencegah pengambilalihan akun lewat rekayasa sosial.

## Sebelum menerbitkan kode

1.  **Verifikasi identitas lewat kanal yang sudah dikenal**, bukan kanal yang dipakai peminta untuk menghubungi Anda. Contoh: hubungi pengguna lewat nomor WhatsApp/telepon yang tercatat di workspace, atau minta OWNER workspace yang sama
    (orang lain) mengonfirmasi bahwa peminta memang anggotanya. Jangan percaya klaim "ini email saya" tanpa bukti kedua.
2.  **Cek jejak audit** workspace pengguna (`GET /audit-logs`): adakah `account.password_reset` atau `account.email_changed` yang mencurigakan baru-baru ini? Bila ya, tahan dan selidiki dahulu.
3.  Pastikan permintaan datang dari pengguna itu sendiri, bukan dari admin lain yang ingin masuk ke akun tersebut (admin tidak berhak mereset akun orang lain).
4.  Catat siapa yang meminta, kapan, dan bagaimana verifikasi dilakukan (di luar sistem ini).

## Menerbitkan

```bash
cd backend
npm run admin:recovery-code -- --email pengguna@contoh.id     # produksi: node dist/runtime/recovery-code-cli.js --email ...
```

Perintah mencetak 8 kode baru SEKALI (stdout) dan menghanguskan semua kode lama. Serahkan lewat kanal terverifikasi yang sama. Jangan menyimpan kode di tiket, chat grup, atau log. Hapus riwayat terminal bila kode tampil di sana.

## Setelah itu

-   Pengguna memakai satu kode di `/forgot-password`, mengatur kata sandi baru, lalu membuat himpunan kode baru dari Pengaturan Akun dan mengonfirmasi bahwa sudah menyimpannya.
-   Reset tercatat di audit setiap workspace pengguna (`account.password_reset`); OWNER/ADMIN dapat melihatnya.
-   Bila identitas tidak dapat diverifikasi, JANGAN menerbitkan kode. Akun yang terkunci lebih baik daripada akun yang diambil alih.
