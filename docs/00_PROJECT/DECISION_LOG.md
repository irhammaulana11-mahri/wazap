# Architecture Decision Log

## ADR-001 --- Multi-tenant self-service

**Status:** Accepted\
Setiap pendaftar memperoleh tenant/workspace sendiri. Sistem mendukung
tenant membership untuk ekspansi.

## ADR-002 --- Dynamic sessions

**Status:** Accepted\
Tenant dapat membuat beberapa WhatsApp session. Batas aktual
dikendalikan konfigurasi, kebijakan platform, dan kapasitas.

## ADR-003 --- Dashboard dan API

**Status:** Accepted\
Semua fitur inti tersedia melalui dashboard dan REST API sesuai
permission/scope.

## ADR-004 --- PostgreSQL existing

**Status:** Accepted\
Gunakan instance PostgreSQL yang telah tersedia, tetapi database dan
role aplikasi khusus. Jangan mencampur tabel aplikasi lain.

## ADR-005 --- Modular runtime

**Status:** Accepted\
Satu repository dengan API, engine, worker, scheduler dan frontend
sebagai runtime boundaries terpisah.

## ADR-006 --- Baileys adapter

**Status:** Accepted with risk\
Baileys adalah adapter awal, bukan coupling seluruh domain. Sediakan
interface agar adapter resmi dapat ditambahkan.

## ADR-007 --- PostgreSQL queue first

**Status:** Accepted for phase 1\
Gunakan PostgreSQL queue dengan `SKIP LOCKED`, fair scheduling dan
recovery. Redis hanya setelah kebutuhan terukur.

## ADR-008 --- Session single ownership

**Status:** Accepted\
Satu session hanya boleh memiliki satu engine owner aktif. Gunakan
lease, heartbeat dan fencing token.

## ADR-009 --- Delivery semantics

**Status:** Accepted\
Tidak menjanjikan exactly-once. Gunakan idempotent submission, durable
job, attempt history, status UNKNOWN dan reconciliation.

## Proses perubahan keputusan

Proposal harus mencantumkan konteks, opsi, dampak
database/API/security/operasional, rencana migrasi, dan persetujuan.
Jangan mengubah ADR berstatus Accepted secara diam-diam.

## ADR-010 --- Auth dashboard: access token + refresh cookie HttpOnly

**Status:** Accepted (disetujui pengguna 2026-11-19)\
Access token pendek (15 menit) di body; refresh token dirotasi dan hanya di
cookie HttpOnly `SameSite=Strict`. Reuse refresh token mencabut family.

## ADR-011 --- Kuota tenant awal

**Status:** Accepted (disetujui pengguna 2026-11-19)\
Default `tenant_settings`: 3 session, 20 API key, 60 pesan/menit. Dapat
diubah per tenant; bukan angka kapasitas sistem.

## ADR-012 --- Penonaktifan autentikasi prototipe (legacy)

**Status:** Accepted (disetujui pengguna 2026-11-19; efektif akhir Fase C)\
`LEGACY_AUTH_ENABLED` default `false`. Login admin env, route prototipe
(`public.*`) dan pemulihan sesi dari disk tidak aktif kecuali diaktifkan
eksplisit. Kode legacy dihapus pada Fase D saat adapter/engine baru ada.

## ADR-013 --- Penghapusan kode legacy; sesi prototipe di-pair ulang

**Status:** Accepted (disetujui pengguna 2026-11-19)\
Kode prototipe dihapus di awal Fase D: login admin env, route
`/legacy/*`, `session.manager` (Baileys file-based), messaging/webhook
prototipe, `database/legacy`, env `ADMIN_*`, `TOKEN_TTL_SECONDS`,
`DEFAULT_TENANT_ID`, `SESSION_DATA_PATH`, `LEGACY_AUTH_ENABLED`. Dua sesi
WhatsApp prototipe **tidak diimpor**: pengguna memasangkan ulang lewat QR di
sistem baru (lebih sederhana dan aman; tidak ada jalur impor plaintext).
Tabel `public.*` prototipe dan `backend/data/sessions` TIDAK dihapus otomatis
(lihat BACKEND_PROGRESS).

## ADR-014 --- Auth state Baileys terenkripsi di PostgreSQL

**Status:** Accepted (implementasi Fase D)\
Auth state disimpan per item di `session_auth_state` (creds, pre-key,
session, sender-key, app-state-sync-key) sebagai blob AES-256-GCM dengan
keyring bervensi (`CREDENTIAL_ENCRYPTION_KEYS`, `versi:base64(32B)`).
AAD = `sessionId|jenis|itemId` mencegah blob ditukar antar item/sesi. Master
key hanya di environment. Penulisan wajib melalui `withFence` (lease +
fencing token). Rotasi: tambah versi baru; blob lama tetap terbaca; re-enkripsi
massal belum ada. **Kehilangan master key = semua sesi harus pair ulang.**

## ADR-015 --- Adapter abstrak + SessionRunner per sesi

**Status:** Accepted (implementasi Fase D)\
Engine hanya bergantung pada `SessionAdapter` (`connect`, `disconnect`,
`logout`) dengan event `onQr/onOpen/onClose` yang dinormalisasi
(`DisconnectKind`). `SessionRunner` memiliki lifecycle satu sesi di bawah satu
lease; semua penulisan berfencing dan berurutan (antrean). Kehilangan lease =>
berhenti lokal tanpa menulis. Auth state memakai format Baileys
(`AuthenticationState`) sehingga mengganti library memerlukan adapter state
baru, bukan perubahan engine.

## ADR-016 --- Antrean pesan: PostgreSQL, dikonsumsi engine pemilik sesi

**Status:** Accepted (implementasi Fase E)\
Job disimpan di `message_queue`; yang meng-klaim dan mengirim adalah
`SessionRunner` engine pemilik lease sesi (satu lane serial per sesi, klaim
`FOR UPDATE SKIP LOCKED` + `withFence`), bukan worker terpisah: socket hanya
ada di engine pemilik. Hasil ambigu (error saat/ setelah pesan diserahkan ke
socket, atau engine mati saat PROCESSING) TIDAK di-retry otomatis:
`UNKNOWN` / `RECONCILIATION_REQUIRED`; retry manual wajib
`confirm_duplicate_risk`. `SENT` berarti diterima socket/server WhatsApp, bukan
delivered/read. Tidak ada klaim exactly-once. Idempotensi submit lewat
`Idempotency-Key` per tenant (+ hash permintaan). Batas pesan/menit tenant
(`tenant_settings.messages_per_minute`) ditegakkan saat klaim (job ditunda,
bukan ditolak). Redis/BullMQ hanya bila kontensi PostgreSQL terukur.

## ADR-017 --- Transactional outbox berbasis trigger + relay

**Status:** Accepted (implementasi Fase F1)\
Event integrasi (`session.status`, `message.sent|delivered|read|failed|unknown|
cancelled|incoming`) ditulis ke `outbox_events` oleh TRIGGER database dalam
transaksi yang sama dengan perubahan status. Tidak ada jalur kode yang bisa
"lupa" mengirim event, dan rollback membatalkan event. `OutboxRelay`
(`FOR UPDATE SKIP LOCKED`, aman multi-instans) membuat `webhook_deliveries`
per endpoint yang berlangganan dan menandai `DISPATCHED` dalam satu transaksi,
lalu `pg_notify` untuk realtime. Semantik **at-least-once**; urutan antar
event TIDAK dijamin; penerima wajib dedup berdasarkan `event_id`. Isi pesan
keluar tidak ikut event; teks pesan MASUK ikut (klien memerlukannya) dan
dibersihkan oleh retensi (ADR-022).

## ADR-018 --- Keamanan webhook

**Status:** Accepted (Fase F1)\
Tanda tangan HMAC-SHA256 atas `timestamp.rawBody` (header
`X-Wazap-Timestamp`, `X-Wazap-Signature: v1=<hex>`); penerima menolak timestamp
> 5 menit. Secret `whsec_...` ditampilkan SEKALI (create/rotate), disimpan
terenkripsi AES-256-GCM dengan AAD `tenant|endpoint`; rotasi membatalkan secret
lama seketika. Perlindungan SSRF tiga lapis: validasi URL (https saja, tanpa
kredensial, tanpa host internal), resolusi DNS saat dibuat (SEMUA alamat harus
publik), dan `lookup` kustom saat koneksi (menutup DNS rebinding); redirect tidak
diikuti; body respons dibuang (hanya status code/durasi/kode galat yang disimpan).
Retry eksponensial + jitter (maks `WEBHOOK_MAX_ATTEMPTS`), lalu `DEAD` dengan
replay manual. Target internal/URL tak valid langsung `DEAD`. `http://` dan
alamat privat hanya lewat env eksplisit (`WEBHOOK_ALLOW_HTTP`,
`WEBHOOK_ALLOW_PRIVATE_TARGETS`, default `false`; jangan aktif di produksi).

## ADR-019 --- Realtime Socket.IO via PostgreSQL LISTEN/NOTIFY

**Status:** Accepted (Fase F2)\
Socket.IO server-ke-klien (klien tidak dapat mengirim event/memilih room).
Autentikasi saat handshake lewat `auth.token` (access token atau API key; BUKAN
query string). Room dibentuk server dari principal: `t:<tenant>:sessions|
messages|qr`; `qr` hanya untuk pengelola sesi (OWNER/ADMIN/MEMBER, atau scope
`sessions:write`). Fan-out lintas instans memakai `LISTEN/NOTIFY` (nama kanal
diturunkan dari schema) --- tanpa Redis. Kredensial divalidasi ulang berkala
(token kedaluwarsa/API key dicabut memutus socket; perubahan role menyesuaikan
room). **Penyimpangan dari kontrak awal:** `session.qr` hanya SINYAL (`{session_id,
expires_in}`); QR diambil lewat `GET /sessions/:id/qr` terautentikasi, sehingga QR
tidak pernah lewat NOTIFY/socket. `queue.updated` ditunda (gunakan
`message.status`). Event bisa terlewat bila koneksi putus: klien wajib memuat ulang
state setelah reconnect; server mengirim `realtime.resync` saat LISTEN pulih.

## ADR-020 --- Cakupan pesan masuk, receipt, kontak

**Status:** Accepted (Fase F3)\
Hanya chat 1:1 (`@s.whatsapp.net`, `@lid`); grup, status, broadcast, newsletter,
pesan sendiri, reaksi/protokol, dan sinkronisasi riwayat (`type != notify`)
diabaikan. Media masuk TIDAK diunduh (hanya tipe + caption). Idempoten per
`(session, arah, provider_message_id)`. Receipt DELIVERED/READ hanya maju
(SENT -> DELIVERED -> READ). Pesan keluar `SENT` dicerminkan ke `wa_messages`
oleh trigger. "Kontak" = lawan bicara 1:1 yang nomornya diketahui (turunan dari
`wa_chats`, tanpa tabel sendiri); JID `@lid` tanpa pasangan nomor tersimpan
dengan `phone = null`. Semua tulis lewat engine (berfencing); tenant hanya baca.

## ADR-021 --- Media keluar diunduh server; bulk atomik

**Status:** Accepted (Fase F4)\
`send-media` menerima URL (bukan unggahan). Engine mengunduh sendiri saat kirim
(Baileys akan mengikuti URL apa pun tanpa proteksi SSRF): lookup anti-SSRF, tanpa
redirect, batas `MEDIA_MAX_BYTES` (16 MiB), timeout, validasi Content-Type
(image/video/audio berdaftar putih; dokumen asal bukan HTML). Kegagalan unduh
terjadi SEBELUM pengiriman sehingga aman diulang (5xx/timeout) atau ditolak
permanen (4xx, terlalu besar, tipe salah). `bulk` (<= `BULK_MAX_MESSAGES`) atomik:
semua masuk atau tidak sama sekali; idempotensi per batch (kunci `<key>#<index>`);
urutan batch = urutan kirim; item ganda (nomor+isi sama) ditolak; batas
pesan/menit tenant tetap berlaku di sisi kirim.

## ADR-022 --- Retensi data pesan

**Status:** Accepted (Fase F5; angka disetujui pemilik produk 2026-11-19)\
Default (semua dapat diatur lewat env): isi pesan dihapus dan nomor penerima
dimasker (`*********7890`) **30 hari** setelah status akhir; baris dihapus
**180 hari** setelah status akhir; event outbox `DISPATCHED` dihapus **7 hari**;
delivery webhook selesai (DELIVERED/DEAD) dihapus **30 hari**; riwayat chat
(`wa_messages`) mengikuti 30/180 hari; chat tanpa pesan dihapus setelah 180 hari.
Hanya status akhir yang disentuh (PENDING/PROCESSING tidak pernah). Konsekuensi:
`retry` pesan yang isinya sudah dihapus ditolak (`CONTENT_PURGED`). Penyapu
idempoten, berbatch (`FOR UPDATE SKIP LOCKED`), aman multi-instans. Tidak
mencakup backup database, `wa_session_events`, maupun enkripsi isi pesan saat
istirahat (masih plaintext selama masa retensi).

## ADR-023 --- Pemisahan role DB + fail-fast bila RLS dilewati

**Status:** Accepted (Fase G; skrip role BELUM diuji, lihat DB_ROLES.md)\
Saat start, aplikasi memeriksa role runtime: superuser/`BYPASSRLS` => RLS tidak berlaku => **menolak start** bila
`DB_ROLE_CHECK=enforce` (default di production; `warn` di dev); pemilik schema/hak DDL => peringatan. Migrasi dapat
memakai kredensial terpisah (`DB_MIGRATE_*`), dapat dimatikan saat start (`AUTO_MIGRATE=false`) dan dijalankan
sebagai langkah deploy (`npm run migrate:prod`). Tes otomatis menegakkan: SEMUA tabel schema (kecuali
`schema_migrations`) RLS ENABLE+FORCE dengan kebijakan, setiap tabel ber-`tenant_id` terlindungi, tidak ada kebijakan
`USING (true)`, tidak ada fungsi SECURITY DEFINER --- tabel baru yang lupa RLS membuat tes gagal.

## ADR-024 --- Pembatasan laju API, header keamanan, batas waktu request

**Status:** Accepted (Fase G)\
Dua lapis: per IP SEBELUM autentikasi (`API_RATE_LIMIT_IP_PER_MINUTE`, default 600) dan per tenant SETELAH
autentikasi (`API_RATE_LIMIT_TENANT_PER_MINUTE`, default 1200; semua pengguna/API key tenant berbagi anggaran, kredensial
tidak valid tidak menghabiskan anggaran tenant). 429 `RATE_LIMITED` + `Retry-After`. **Penyimpan in-memory per proses**:
dengan N instans batas efektif N kali lipat; pindahkan ke penyimpan bersama bila skala horizontal. `TRUST_PROXY` harus
`true` hanya di belakang reverse proxy tepercaya (jika tidak, semua klien tampak berasal dari IP proxy). Semua respons
membawa `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP `default-src 'none'`, dan `Cache-Control:
no-store` (kecuali ditetapkan lain). `requestTimeout` 30 dtk menutup request yang mengalir terlalu lambat.

## ADR-025 --- Circuit breaker webhook

**Status:** Accepted (Fase G)\
Endpoint dinonaktifkan otomatis (`active=false`, `disabled_reason=AUTO_CONSECUTIVE_FAILURES`) setelah N delivery
`DEAD` berturut-turut (`WEBHOOK_AUTO_DISABLE_AFTER`, default 10; 0 = mati). Hanya kegagalan total yang dihitung:
percobaan RETRY, DEAD semu (endpoint nonaktif/terhapus/secret tak terbaca) dan uji `webhook.test` tidak. Satu delivery
sukses mereset hitungan. Event baru tidak lagi di-fan-out ke endpoint nonaktif; delivery tertunda menjadi DEAD
`ENDPOINT_INACTIVE` (dapat di-replay setelah diaktifkan). Aktifkan ulang: `PATCH /webhooks/:id {"active":true}` (mereset penanda).

## ADR-026 --- Rotasi kunci enkripsi

**Status:** Accepted (Fase G)\
`npm run keys:rotate [-- --dry-run]` mengenkripsi ulang `session_auth_state` dan secret webhook ke kunci AKTIF.
Prasyarat: `CREDENTIAL_ENCRYPTION_KEYS` memuat kunci lama dan baru, `CREDENTIAL_ACTIVE_KEY_VERSION` = versi baru. Aman
saat engine hidup (compare-and-swap per baris; tulisan engine menang), idempoten, tidak mengubah baris yang gagal
didekripsi. Laporan memuat jumlah baris per versi kunci dan `retireReady` (true hanya bila semua baris memakai kunci
aktif dan tanpa kegagalan); exit code 2 bila ada kegagalan atau belum siap pensiun. QR tidak dirotasi (hidup <= TTL).
Pensiunkan kunci lama dari env HANYA setelah `retireReady=true` dan semua engine/instans memakai env baru.

## ADR-027 --- Hitungan daftar berbatas

**Status:** Accepted (Fase G; hasil validasi EXPLAIN)\
`meta.total` pada `GET /messages` dan `GET /chats` dibatasi `LIST_COUNT_CAP` (default 10000); di atas batas `total` =
batas dan `meta.total_capped=true`. Alasan terukur: `count(*)` eksak untuk tenant ~50 ribu pesan = 84 ms dan tumbuh linear.
Paginasi tetap benar di seluruh data. Daftar lain (kontak, delivery, riwayat chat per chat) belum dibatasi.

## ADR-028 --- Validasi indeks pada data realistis

**Status:** Accepted (Fase G)\
`npm run test:perf` (di luar `npm test`) menyemai ~1,3 juta baris, `ANALYZE`, lalu `EXPLAIN` kueri jalur panas dan GAGAL bila
ada Seq Scan pada tabel besar. Temuan pertama: penyapu outbox memakai Seq Scan + Sort (~100 ms) dengan indeks parsial lama;
diganti indeks komposit `(status, dispatched_at)` (~0,6 ms), migrasi 0010. Ini bukan benchmark produksi.

## ADR-029 --- Keputusan pasca-Fase G: topologi, rahasia, housekeeping

**Status:** Accepted (pemilik proyek, 2026-11-19)\
1.  **Satu instans API untuk saat ini; tanpa Redis.** Beban berat ada di engine, bukan API; host dipakai bersama layanan lain dan
    prinsip proyek menunda Redis sampai terukur. **Dilarang menjalankan API dalam mode cluster PM2** (batas laju in-memory akan
    berlipat N kali). Perisai tambahan di tepi: `limit_req` Nginx. Tinjau ulang bila butuh lebih dari satu instans API.
2.  **Kunci master: berkas rahasia di luar repo, tanpa Vault/KMS cloud** (lihat DEPLOYMENT_GUIDE). Salinan di password manager +
    satu salinan offline, TERPISAH dari cadangan database. Rotasi dilatih sekali di staging. Peningkatan nanti: `systemd-creds` atau SOPS+age.
3.  **Pemisahan role DB** diverifikasi di staging sebelum produksi pertama memakai `backend/scripts/verify-db-roles.sh`.
4.  **Housekeeping (dilaksanakan 2026-11-19):** variabel `ADMIN_*` dihapus dari `.env` dev (tidak dibaca kode apa pun); folder
    `backend/data/sessions` (auth state plaintext 2 akun prototipe) dihapus; schema `public` prototipe (hampir kosong) DICADANGKAN
    (`pg_dump`, di luar repo, izin 0600) dan baru di-DROP setelah ~30 hari tanpa masalah; tenant uji dev dibiarkan (produksi = database baru).
    **Tindakan pemilik proyek:** keluarkan (unlink) perangkat tertaut lama di kedua akun WhatsApp prototipe --- inilah yang benar-benar
    mematikan kredensial lama (menghapus berkas di SSD tidak menjamin datanya hilang).
5.  **Urutan berikutnya:** staging di server target -> integrasi frontend (dibangun ulang oleh agent frontend) -> uji beban/ketahanan
    di staging sebelum tenant sungguhan masuk.

## ADR-030 --- Tim: undangan bertoken, email anggota disalin, pemisahan wewenang

**Status:** Accepted (pemilik proyek menyetujui Team API, 2026-11-19; Fase H)\
Anggota bergabung HANYA lewat undangan: token acak 256-bit sekali pakai (hanya hash disimpan, berlaku 7 hari), terikat pada email dan peran. Dipilih daripada "tambah
pengguna langsung berdasarkan email" karena tidak membocorkan apakah sebuah email terdaftar dan memerlukan persetujuan penerima. Tanpa layanan email: pengundang
menyampaikan token sendiri (frontend membuat tautan). Penerima login dengan akunnya sendiri (workspace pribadinya tetap ada), menerima, lalu `POST /auth/switch-tenant`.
Wewenang: OWNER mengelola semua; ADMIN hanya MEMBER/VIEWER; tidak ada eskalasi (peran yang boleh diberikan = peran yang boleh dikelola); tidak dapat mengubah akun sendiri;
tenant selalu memiliki >= 1 OWNER aktif. Peran aktor dibaca ulang di dalam advisory lock per tenant. Email anggota disalin ke `tenant_memberships.member_email` agar kebijakan
RLS `users` (yang melindungi `password_hash`) tidak dilonggarkan. Semua kegagalan token dijawab seragam. API key tidak dapat mengelola tim. Belum ada: audit log perubahan tim,
email undangan otomatis, transfer kepemilikan khusus (dilakukan dengan mempromosikan OWNER lain lalu menurunkan yang lama).

## ADR-031 --- Semantik metrik penggunaan

**Status:** Accepted (Fase H)\
Pesan keluar dihitung menurut `created_at` (saat diantrekan) dengan status SAAT INI (bukan riwayat status); pesan masuk menurut `created_at` (saat diterima gateway); rentang
`[from, to)`, maks 92 hari, default 24 jam. Sesi/antrean/kuota adalah snapshot, bukan untuk rentang. Deret waktu per jam/hari pada zona waktu IANA yang diminta klien, bucket kosong
diisi nol, `bucket` = instan UTC awal periode lokal. Data di luar masa retensi (180 hari) tidak ada, sehingga laporan jangka panjang butuh ekspor/agregat terpisah (belum ada).
Filter `from`/`to` pada `GET /messages` memakai semantik rentang yang sama.

## ADR-032 --- Audit log perubahan tim dan pengaturan

**Status:** Accepted (pemilik proyek, 2026-11-19; Fase H2)\
Tabel `audit_logs` append-only, dibaca OWNER/ADMIN, ditulis di dalam transaksi perubahan (atomik). Hanya perubahan yang berhasil dan benar-benar mengubah sesuatu yang dicatat
(bukan penolakan/no-op). Menyimpan: aksi, pelaku (id + email + peran saat kejadian), sasaran, detail sebelum/sesudah, IP koneksi, `request_id`. Tidak menyimpan token/rahasia. IP adalah
data pribadi: dipertahankan `RETENTION_AUDIT_DAYS` (365 hari) lalu dihapus. Pelaku tidak bisa menghapus/mengubah jejak (tenant maupun platform lewat jalur aplikasi); satu-satunya penghapusan
adalah retensi oleh konteks platform. **Belum dicakup:** aksi sesi/pesan/webhook/API key (kerangka `recordAudit` dapat dipakai ulang), audit login/akses, jaminan anti-manipulasi terhadap
operator database (pemilik tabel/superuser dapat mengubah baris; tanpa rantai hash atau penyimpanan eksternal).

## ADR-033 --- Kuota tenant dapat diubah OWNER dalam batas atas global (ceiling)

**Status:** Accepted, DIKONFIRMASI pemilik proyek 2026-11-19 ("baiknya seperti itu dulu": OWNER mengubah dalam ceiling env; ceiling bawaan 10/50/50/120; nilai ceiling produksi ditinjau sebelum produksi)\
`PATCH /tenant/settings` hanya untuk OWNER dan hanya dalam [minimum, ceiling] dengan ceiling dari env operator (`LIMIT_CEIL_*`). Alasan: kuota juga berfungsi sebagai perlindungan
anti-ban/anti-penyalahgunaan (khususnya `messages_per_minute`); tenant yang dapat menaikkan tanpa batas menghapus perlindungan itu, sedangkan API operator terpisah (kredensial admin) akan
menambah permukaan serangan baru dan belum ada peran platform-admin. Konsekuensi: operator memperketat dengan menyamakan ceiling dengan nilai bawaan (kuota efektif tidak bisa dinaikkan tenant)
atau melonggarkan dengan menaikkan ceiling; mengubah satu tenant di luar ceiling hanya lewat basis data/skrip operator. Tidak boleh di bawah pemakaian saat ini (sesi, API key, anggota + undangan).
Perubahan berlaku seketika dan diaudit (`settings.updated`).

## ADR-034 --- Undangan tanpa email: tautan, terbit ulang, dan jalur bagikan di klien

**Status:** Accepted (pemilik proyek: "tidak usah email undangan, gunakan metode lain"; Fase H2)\
Server tidak mengirim email. Pengundang mendapat `token` + `invite_url` sekali tampil dan membagikannya lewat salah satu: (1) salin tautan, (2) QR dari tautan (dibuat di klien), (3) kirim lewat WhatsApp
melalui sesi tenant sendiri (`POST /messages/send`; token di payload antrean ikut dihapus retensi 30 hari dan token kedaluwarsa 7 hari), atau (4) tautan `wa.me` pada perangkat pengundang. Tautan
hilang diatasi `POST /team/invitations/:id/reissue` (token lama hangus). `invite_url` dibangun dari `DASHBOARD_BASE_URL` (config), bukan dari header klien, dan membawa token di FRAGMEN (`#token=`) agar tidak dikirim ke server dashboard (tidak masuk access log Nginx/Referer; frontend menghapusnya dari address bar setelah dibaca) (mencegah tautan beracun lewat `Host`/`Origin` palsu).
Risiko: siapa pun yang memegang tautan dan akun dengan email yang diundang dapat bergabung; tautan yang dikirim lewat kanal tidak aman dapat disadap (terbatas oleh pengikatan email dan kedaluwarsa).

## ADR-035 --- Offboarding anggota: pencabutan undangan dan API key

**Status:** Accepted (pemilik proyek, 2026-11-20; hasil code-review)\
(1) **Undangan tertunda** yang dibuat anggota dicabut otomatis bila ia dihapus, ditangguhkan, atau diturunkan perannya (promosi tidak mencabut; mengaktifkan ulang tidak menghidupkan kembali): undangan tidak boleh hidup lebih lama
daripada wewenang pembuatnya. Pemeriksaan wewenang saat penerimaan tidak mungkin karena penerima belum anggota dan RLS menutup pembacaan keanggotaan tenant, sehingga pencabutan dilakukan saat perubahan terjadi.
(2) **API key** yang dibuat anggota dicabut saat ia DIHAPUS atau KELUAR; saat hanya DITANGGUHKAN key tetap hidup (penangguhan dapat bersifat sementara) dan daftar API key menampilkan pembuatnya agar dapat dicabut manual.
Pencabutan key harus dilakukan sebelum keanggotaan dihapus (FK `ON DELETE SET NULL` mengosongkan pembuat; ditemukan oleh tes). Semuanya dicatat di audit. **Belum dicakup:** key buatan anggota yang ditangguhkan tidak dicabut
otomatis; key tidak punya pemilik setelah pembuatnya dihapus sehingga tidak dapat ditelusuri dari daftar (hanya dari audit).

## ADR-036 --- Permintaan bergabung dengan kode workspace (kata sandi dibuat saat mendaftar)

**Status:** Accepted (pemilik proyek, 2026-11-20: "opsi 1, kata sandi dibuat saat mendaftar")\
Pelengkap undangan (ADR-034), bukan pengganti. OWNER/ADMIN membuat **kode workspace** (`PUT /team/join-code`, tampil sekali, hanya hash disimpan, 100 bit, dapat diputar/dinonaktifkan). Calon anggota memanggil
`POST /auth/join-requests` dengan kode, email, dan **kata sandi pilihannya sendiri**; akun dibuat tetapi tanpa keanggotaan sehingga belum dapat masuk ke workspace (login memberi `403 JOIN_PENDING`).
OWNER/ADMIN menyetujui (`approve`, memilih peran dalam batas wewenangnya, kuota anggota diperiksa) atau menolak; sesudah disetujui pemohon login dengan kata sandi yang sama.\
**Mengapa kata sandi dibuat di awal, bukan setelah disetujui:** backend tidak memverifikasi email (ADR-034). Bila kata sandi dibuat saat login pertama sesudah disetujui, siapa pun yang login lebih dulu dengan email itu menjadi pemilik akun
(penyerang mengajukan atas nama email korban, admin menyetujui, penyerang membuat kata sandi). Dengan kata sandi di awal, persetujuan hanya mengaktifkan keanggotaan bagi pemilik kata sandi, yaitu pengaju.\
**Email yang sudah terdaftar** harus membuktikan kata sandi akunnya (tanpa akun kedua; `401 INVALID_CREDENTIALS` bila salah). **Kode salah/diputar/dinonaktifkan** dijawab seragam `404 INVALID_JOIN_CODE` dan tidak membuat akun.
RLS (0014): `tenant_join_codes` dibaca pemohon hanya lewat hash kode (`app.join_hash`); `tenant_join_requests` dibuat pemohon hanya dengan kode valid + email = email akunnya; memutuskan hanya lewat konteks tenant; tanpa akses platform.\
**Batas antrean (diperbarui 2026-11-20, migrasi 0015):** permintaan tertunda yang masih berlaku dibatasi `JOIN_MAX_PENDING` (default 50) per tenant; di atasnya pemohon baru mendapat `409 JOIN_QUEUE_FULL` dan akun tidak dibuat.
Pemohon tidak dapat menghitung antrean di bawah RLS, jadi kebijakan `join_requests_queue_count` membuka KHUSUS baris PENDING yang berlaku milik tenant yang kodenya sedang dipakai (konteks `app.join_hash`); kode hanya menjalankan `count(*)`.
Konsekuensi yang diterima: pada level SQL, pemegang kode yang dapat menjalankan kueri bebas dapat membaca email permintaan tertunda tenant itu; aplikasi tidak menyediakan jalur seperti itu (kueri parameter tetap), dan tes menegaskan cakupan kebijakan (bukan yang diputuskan/kedaluwarsa/tenant lain).
Pengajuan diserialkan per tenant dengan `teamLock` sehingga batas eksak (tes: 6 pengajuan serentak, batas 3, tepat 3 berhasil). Pengajuan ganda dijawab `JOIN_REQUEST_EXISTS` sebelum antrean penuh.
**Retensi:** `RETENTION_JOIN_REQUEST_DAYS` (default 90) setelah diputuskan, atau setelah kedaluwarsa bila tidak pernah diputuskan; platform hanya mendapat SELECT/DELETE di tabel ini (seperti `audit_logs`).\
**Risiko tersisa:** (1) akun yang dibuat lewat permintaan tetapi tidak pernah disetujui tetap ada di `users` (tabel itu tanpa akses platform; baris kecil, tanpa keanggotaan, tidak dapat masuk ke workspace mana pun), dan pemilik email tidak bisa mendaftar baru dengan email yang sama (`EMAIL_TAKEN`) sampai ada alur pemulihan kata sandi.
(2) pembuatan permintaan tidak diaudit (pemohon belum punya konteks tenant); persetujuan, penolakan, dan perputaran kode diaudit. (3) admin dapat menyetujui email yang salah; dampaknya hanya pada pemilik kata sandi (pengaju).
