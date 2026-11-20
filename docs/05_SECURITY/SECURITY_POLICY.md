# Security Policy

## Identity

-   Hash passwords with Argon2id or an approved modern password hashing
    scheme.
-   Rate limit registration/login and protect against brute force.
-   Use secure cookies, CSRF protection where cookie auth is used, and
    strict CORS.
-   Rotate/revoke API keys.

## Secrets

-   API key raw value shown once; persist only hash.
-   Encrypt Baileys auth state and webhook secrets at rest.
-   Keep encryption master key outside database and source control.
-   Never log QR payload, credentials, API key, access token, or webhook
    secret.

## Tenant isolation

-   Tenant derived from verified principal.
-   Service-level authorization plus PostgreSQL RLS.
-   Composite tenant foreign keys.
-   Cross-tenant negative tests for every resource.

## API and webhook

-   Input validation, request size limits, rate limiting.
-   SSRF protection for webhook destinations.
-   HMAC signatures and replay protection.
-   Do not expose internal engine endpoints publicly.

## Operations

-   Least privilege DB roles.
-   Private storage permissions.
-   TLS at reverse proxy.
-   Audit security-sensitive actions.
-   Encrypted backups and tested restore.
-   Retention and deletion policy for message/media/auth data.

## WhatsApp compliance

-   Follow applicable WhatsApp terms and policies.
-   Do not facilitate spam or unsolicited bulk messaging.
-   Apply tenant/session rate controls and consent-aware usage.
-   Evaluate official WhatsApp Business Platform for commercial-critical
    use.

## Implementasi (Fase D)

-   Auth state & QR terenkripsi AES-256-GCM; master key
    `CREDENTIAL_ENCRYPTION_KEYS` dari environment, bukan DB/repo; pesan error
    kripto tidak membocorkan kunci/konteks.
-   Logger Baileys dimatikan (`silent`); tes memindai source agar QR/creds tidak
    masuk log; payload event disanitasi.
-   **Risiko tersisa:** kehilangan/bocornya master key; belum ada re-enkripsi
    massal saat rotasi; satu role DB untuk migrate+runtime di dev; socket zombie
    dapat bertahan sampai tick berikutnya setelah kehilangan lease.

## Implementasi (Fase E)

-   Isi pesan dan nomor tujuan tersimpan di DB (plaintext) selama job ada dan
    tidak pernah dicatat di log (tes memindai source). **Risiko:** belum ada
    kebijakan retensi/penghapusan atau enkripsi isi pesan; tentukan sebelum produksi.
-   Mitigasi penyalahgunaan/ban: batas pesan/menit per tenant, jeda per
    sesi, batas antrean, validasi format nomor, pengecekan nomor terdaftar
    (`VERIFY_RECIPIENT`). Tidak menjamin WhatsApp tidak memblokir nomor.

## Implementasi (Fase F)

-   **Webhook:** HMAC-SHA256 + timestamp (anti-replay 5 menit), secret terenkripsi at-rest dan
    tampil sekali; SSRF dicegah di tiga lapis (URL, DNS saat dibuat, `lookup` saat koneksi) tanpa
    redirect; respons penerima tidak disimpan (mencegah kebocoran isi layanan internal);
    private/`http` hanya via env eksplisit. Tes: IPv4/IPv6 khusus (loopback, link-local,
    metadata 169.254.169.254, ULA, IPv4-mapped, NAT64, 6to4), DNS rebinding (satu alamat privat
    menolak), redirect tidak diikuti, tanda tangan tamper/replay.
-   **Realtime:** token via `auth.token` saja; room dibentuk server; QR tidak pernah lewat
    socket (sinyal saja); validasi ulang kredensial berkala; batas koneksi per tenant;
    buffer masuk 4 KB.
-   **Media:** URL klien diunduh server dengan perlindungan SSRF, batas ukuran/timeout, daftar putih
    tipe konten. **Risiko tersisa:** tipe konten dipercaya dari header (tanpa sniffing magic
    bytes/pemindaian malware); unduhan dibuffer di memori.
-   **Retensi (ADR-022):** isi pesan/nomor dihapus 30 hari, baris 180 hari; outbox 7 hari;
    delivery webhook 30 hari. **Risiko tersisa:** isi pesan masih plaintext di DB selama masa
    retensi; teks pesan masuk juga ada di `outbox_events` (<= 7 hari) dan `webhook_deliveries`
    (<= 30 hari); backup database tidak tercakup; `wa_session_events` tidak dipurge.
-   **Penyalahgunaan:** bulk dibatasi (`BULK_MAX_MESSAGES`), batas pesan/menit tenant dan jeda
    per sesi berlaku sama untuk bulk; item ganda ditolak. Tidak menjamin nomor tidak diblokir WhatsApp.
-   **Risiko tersisa:** endpoint webhook yang terus gagal tetap menerima delivery baru (tanpa
    circuit breaker/auto-disable); tidak ada rate limit per endpoint.

## Implementasi (Fase G)

-   **RLS ditegakkan tes:** semua tabel RLS ENABLE+FORCE+kebijakan, semua tabel ber-`tenant_id` terlindungi, tanpa kebijakan
    terbuka, tanpa SECURITY DEFINER. **Role DB:** start ditolak bila superuser/BYPASSRLS (`DB_ROLE_CHECK=enforce`, default produksi);
    peringatan bila role runtime pemilik schema. Pemisahan migrator/app didukung kode (`DB_MIGRATE_*`, `AUTO_MIGRATE`,
    `migrate:prod`); skrip role di DB_ROLES.md **belum diuji** (tidak ada akses admin DB saat Fase G).
-   **Pembatasan laju** per IP (pra-autentikasi) dan per tenant; header keamanan; `requestTimeout`. Batas in-memory per proses.
-   **Rotasi kunci:** `npm run keys:rotate` (ADR-026) --- menutup risiko "tidak ada re-enkripsi massal" dari Fase D.
-   **Circuit breaker webhook** (ADR-025) --- menutup risiko endpoint gagal terus-menerus dari Fase F.
-   **Dependensi:** `npm audit --omit=dev` => 0 kerentanan (2026-11-19). Ulangi sebelum rilis.
-   **Tidak membocorkan galat internal:** tes memastikan 500 generik (tanpa stack/pesan asli) dan galat parser tidak bocor.
-   **Risiko tersisa:** (1) skrip pemisahan role belum diuji; (2) batas laju tidak terbagi antar instans; (3) isi pesan plaintext
    selama masa retensi (ADR-022); (4) kunci enkripsi master hanya di environment (kehilangan = semua sesi pair ulang;
    belum ada integrasi KMS/secret manager); (5) tipe konten media dipercaya dari header; (6) belum ada pemindaian
    SAST/DAST, uji penetrasi, maupun uji beban multi-koneksi; (7) `schema_migrations` tidak berRLS (hanya metadata).

## Implementasi (Fase H)

-   **Tim:** keanggotaan lintas-tenant hanya lewat undangan yang dijaga kebijakan RLS (token + email akun + peran harus cocok; diuji langsung di SQL: penyusup tanpa token,
    token milik orang lain, eskalasi peran, dan pendaftaran pengguna lain semuanya ditolak). Token undangan 256-bit, hanya hash disimpan, sekali pakai, kedaluwarsa 7 hari, dibatasi
    10 percobaan/15 menit/pengguna; kegagalan dijawab seragam (tidak ada oracle). Wewenang ADMIN dibatasi; OWNER terakhir terlindungi; perubahan diserialkan per tenant dan peran aktor dibaca ulang
    di dalam lock. Anggota ditangguhkan/dihapus kehilangan akses seketika (access token diverifikasi ulang tiap permintaan; socket dalam <= 30 detik).
-   **Isolasi kredensial:** daftar tim tidak membaca tabel `users` (email disalin ke keanggotaan) sehingga `password_hash` anggota lain tetap tidak terjangkau dari konteks tenant.
-   **`switch-tenant`:** hanya ke keanggotaan AKTIF milik sendiri; family refresh lama dicabut; API key tidak dapat memakainya.
-   **Risiko tersisa:** belum ada audit log perubahan tim; token undangan yang bocor sebelum dipakai (terikat pada email, jadi hanya pemilik email itu yang bisa memakainya, tetapi siapa pun
    yang menguasai akun email itu dapat); tidak ada email undangan sehingga penyampaian token adalah tanggung jawab pengundang; `member_email` adalah salinan (tidak ada fitur ganti email saat ini).

## Implementasi (Fase H2)

-   **Audit log:** append-only, atomik dengan perubahan, tanpa rahasia (tes memeriksa token mentah dan hash tidak pernah muncul), hanya OWNER/ADMIN dashboard yang dapat membaca; pencatatan "undangan diterima"
    dijaga RLS (token + email akun harus cocok; pemalsuan oleh pemegang token ditolak di SQL). Penghapusan hanya retensi platform (`RETENTION_AUDIT_DAYS`). IP pelaku disimpan (data pribadi, dibatasi retensi).
    **Risiko tersisa:** operator database/pemilik tabel dapat mengubah jejak (tanpa rantai hash/penyimpanan eksternal); belum mencakup aksi sesi/pesan/webhook/API key dan login.
-   **Kuota:** OWNER dapat mengubah kuota hanya dalam [minimum, ceiling env]; peran dibaca ulang di dalam lock; ADMIN/MEMBER/VIEWER dan API key ditolak. **Risiko tersisa:** OWNER yang kredensialnya dibobol dapat menaikkan
    kuota sampai ceiling (terbatas dan tercatat di audit); ceiling bawaan (sesi 10, pesan/menit 120) adalah nilai awal, bukan hasil pengukuran risiko ban --- tinjau sebelum produksi.
-   **Undangan tanpa email:** `invite_url` dibangun dari konfigurasi server (bukan header klien); terbit ulang menghanguskan token lama.

## Hasil code-review (2026-11-20, tingkat `high`, target `backend/src`)

8 temuan, tidak ada yang kritis (tidak ada celah autentikasi atau kebocoran lintas tenant). Diperbaiki dan diberi tes regresi: zona waktu offset yang bergeser 14 jam diam-diam (#5), `reissue` melewati kuota anggota (#2),
undangan hidup lebih lama daripada wewenang pembuatnya (#3), API key anggota yang dihapus tetap berfungsi (#4), audit membuang kunci `max_api_keys` (#1), PATCH kuota menolak nilai lama yang tidak berubah setelah ceiling
diturunkan (#8), helper kunci tim terduplikasi (#7). **Diterima sebagai keterbatasan (#6):** `switch-tenant` tanpa cookie refresh tidak mencabut keluarga refresh lama (kasus sempit: refresh token hanya ada di cookie HttpOnly browser).
**Risiko tersisa baru dari review:** (a) menurunkan `LIMIT_CEIL_*` tidak menurunkan kuota efektif yang sudah tersimpan (hanya membatasi perubahan berikutnya); (b) API key buatan anggota yang ditangguhkan tetap hidup;
(c) code-review hanya mencari bug kebenaran: `/security-review` dan uji penetrasi masih perlu.

## Permintaan bergabung dengan kode workspace (Fase H3, ADR-036)

-   Kode workspace: 100 bit (alfabet 31 simbol, 20 karakter), hanya SHA-256 yang disimpan, tampil sekali, dapat diputar/dinonaktifkan oleh OWNER/ADMIN; pencarian kode lewat RLS (`app.join_hash`), tanpa akses platform. Kode salah/diputar/dinonaktifkan dijawab seragam dan tidak membuat akun.
-   Kata sandi dibuat pemohon SAAT mendaftar (bukan setelah disetujui): persetujuan hanya mengaktifkan keanggotaan, sehingga tidak ada pembajakan akun oleh pihak yang login pertama setelah persetujuan. Email terdaftar harus membuktikan kata sandi.
-   Pemohon tidak dapat menyetujui diri sendiri atau membuat keanggotaan (RLS; diuji dengan SQL langsung). Peran yang diberikan dibatasi wewenang penyetuju (ADMIN hanya MEMBER/VIEWER), kuota anggota diperiksa saat persetujuan, peran penyetuju dibaca ulang di dalam lock.
-   Login memberi `JOIN_PENDING/JOIN_REJECTED` hanya setelah kata sandi benar (tidak membuka enumerasi akun melebihi `EMAIL_TAKEN` pada register yang sudah ada).
-   Antrean dibatasi `JOIN_MAX_PENDING` (default 50) per tenant, diserialkan dengan lock tim (batas eksak), `409 JOIN_QUEUE_FULL` bila penuh tanpa membuat akun. Kebijakan RLS `join_requests_queue_count` membuka baris PENDING yang berlaku milik tenant pemilik kode KHUSUS untuk dihitung (lihat ADR-036 untuk konsekuensinya).
-   Retensi: permintaan diputuskan/kedaluwarsa dihapus setelah `RETENTION_JOIN_REQUEST_DAYS` (90); platform hanya SELECT/DELETE di tabel ini.
-   **Risiko tersisa:** akun yang tidak pernah disetujui tetap ada di `users` (tanpa keanggotaan; tidak ada pembersihan karena `users` tanpa akses platform); pembuatan permintaan tidak diaudit.

## Manajemen akun (Fase H4, ADR-037)

-   Ganti kata sandi/email dan terbitkan kode pemulihan butuh kata sandi saat ini (403 `INVALID_PASSWORD`; dibatasi 5 per 15 menit per pengguna). Ganti kata sandi, reset, dan keluar dari semua perangkat menaikkan `token_version`: access token yang beredar langsung ditolak, refresh token dicabut (sesi yang menjalankan penggantian dilanjutkan dengan token baru).
-   Reset tanpa email memakai satu dari 8 kode pemulihan 100 bit (tabel `user_recovery_codes`, hash saja, tiap kode sekali pakai lewat UPDATE bersyarat, himpunan baru menghanguskan yang lama), jawaban kegagalan seragam, hashing dilakukan sebelum pemeriksaan (waktu respons tidak membedakan email), 10/jam per IP dan 8/15 menit per email. Dirancang TANPA tautan reset dari admin: admin satu workspace tidak dapat mengetahui keanggotaan lintas tenant (RLS), sehingga tautan seperti itu berisiko mengambil alih akun multi-tenant.
-   Ganti email menyinkronkan `member_email` lintas tenant lewat kebijakan sempit + trigger penjaga (peran/status tidak dapat diubah di luar tenant aktif; diuji dengan SQL langsung).
-   Hapus workspace: OWNER + kata sandi + ketik nama; akses berhenti seketika (status DELETED ditolak di login, refresh, API key, dan socket), integrasi keluar (webhook) dimatikan, kredensial WhatsApp dihapus lewat jalur penghapusan sesi, data dihapus permanen setelah `RETENTION_TENANT_DAYS`.
-   Reset kata sandi dicatat di audit SETIAP workspace tempat pengguna menjadi anggota (kebijakan insert sempit, dibuktikan kepemilikan akun; diuji dengan pemalsuan SQL); pembuatan permintaan bergabung dicatat ke workspace tujuan.
-   Pemulihan workspace terhapus: hanya OWNER (email + kata sandi, publik, dibatasi seperti login) dalam `RETENTION_TENANT_DAYS`; non-OWNER dan di luar masa tunggu dijawab 404 sama; koneksi WhatsApp, webhook, API key, undangan tidak kembali.
-   **Risiko tersisa:** email tidak terverifikasi; bila SEMUA kode pemulihan hilang, pemulihan bergantung operator (`admin:recovery-code`, wajib memastikan peminta pemilik akun).

## Ekspor data workspace (ADR-048)

Ekspor massal berisi data pribadi pelanggan tenant sehingga dilindungi berlapis: hanya OWNER/ADMIN pengguna dashboard (API key ditolak, dijaga dua lapis di route dan handler), konfirmasi kata sandi (5 percobaan salah per 15 menit; penguncian dicek sebelum verifikasi), jatah 5 per jam, satu ekspor per workspace, dijalankan dalam konteks RLS tenant (terbukti menahan kebocoran bahkan tanpa filter SQL), kolom daftar putih (tanpa kredensial, hash, kunci, secret), CSV dinetralkan dari injeksi formula, batas ukuran dengan penolakan sebelum data (422), saklar mati `EXPORT_ENABLED`, dan audit `data.exported` untuk setiap hasil (jumlah baris dan byte, tanpa isi). Risiko tersisa: sesi pengguna yang dibajak masih dapat mengekspor setelah menebak kata sandi (dibatasi laju dan tercatat); pantau lonjakan `data.exported` (RUNBOOK P15).

## Notifikasi alarm per workspace (ADR-049)

Fitur ini mengirim data keluar ke pihak ketiga atas permintaan pelanggan, sehingga dilindungi berlapis: hanya OWNER/ADMIN pengguna dashboard (API key ditolak), kata sandi untuk membuat kanal, mengganti target, dan menghapus (5 salah per 15 menit; penguncian dicek sebelum verifikasi), target dienkripsi AES-256-GCM dengan AAD tenant+kanal dan ikut rotasi kunci master, tidak pernah dikembalikan API atau ditulis ke log/audit, anti-SSRF (Telegram: host dikunci; Slack-compatible: daftar host, https, port 443, host publik, tanpa redirect, timeout), isi pesan dibatasi pada fakta tersanitasi (tanpa nomor telepon pelanggan akhir, isi pesan, URL penuh webhook), RLS ENABLE+FORCE pada ketiga tabel, batas 5 kanal per workspace, 10 uji per jam, batas kirim per kanal per jam, breaker yang menonaktifkan kanal gagal, dan saklar `ALERTS_ENABLED`. Risiko tersisa: token bot pelanggan tersimpan terenkripsi di server; kebocoran kunci master membukanya (kelas risiko sama dengan rahasia webhook).
