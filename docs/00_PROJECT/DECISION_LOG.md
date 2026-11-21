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

## ADR-037 --- Manajemen akun, kode pemulihan, ganti nama, dan hapus workspace (Fase H4)

**Status:** Accepted (pemilik proyek, 2026-11-20: "bisa dikerjakan"; hapus akun sendiri TIDAK diperbolehkan)\
**Lupa kata sandi tanpa email:** rancangan awal (OWNER/ADMIN menerbitkan tautan reset) DITINGGALKAN. Kata sandi bersifat global per pengguna, sedangkan admin satu workspace tidak dapat melihat keanggotaan pengguna di workspace lain
(RLS), sehingga tautan reset dari admin tenant A dapat mengambil alih akun yang juga anggota tenant B. Gantinya: **kode pemulihan** milik pengguna sendiri (`RC-XXXXX-XXXXX-XXXXX-XXXXX`, 100 bit, hanya SHA-256 disimpan,
sekali pakai, tampil sekali saat mendaftar dan dapat diterbitkan ulang dengan kata sandi). `POST /auth/reset-password` (publik, jawaban kegagalan seragam, CAS pada hash kode) memakai kode lalu menerbitkan kode baru dan mencabut semua sesi.
Bagi yang kehilangan kode: alat operator `npm run admin:recovery-code -- --email ...` (butuh akses server; operator wajib memastikan peminta adalah pemilik akun).\
**Pencabutan token seketika:** `users.token_version` dinaikkan saat ganti kata sandi/reset/keluar dari semua perangkat; access token membawa `tv` dan ditolak bila berbeda (deterministik, tanpa bergantung jam). Token lama tanpa `tv` dianggap versi 0.
**Kata sandi salah pada endpoint terautentikasi dijawab `403 INVALID_PASSWORD`, bukan 401**, agar klien tidak memicu refresh dan masuk lingkaran.\
**Ganti email:** butuh kata sandi, email TIDAK diverifikasi (konsisten dengan keputusan tanpa email; email hanyalah label login). `member_email` di semua keanggotaan disinkronkan; kebijakan `memberships_sync_email` + trigger `tenant_memberships_guard` memastikan di luar tenant aktif hanya `member_email` (= email akun) yang bisa berubah, tidak peran/status.\
**Hapus workspace:** hanya OWNER, butuh kata sandi + ketik nama workspace. Status `DELETED` (lunak): login/refresh/API key/socket menolak; sesi diturunkan lewat jalur penghapusan biasa (DELETING, kredensial dihapus control-plane); webhook dihapus; API key dicabut; undangan/kode/permintaan dibatalkan.
Retensi menghapus baris tenant (FK cascade) setelah `RETENTION_TENANT_DAYS` (30); kebijakan platform hanya mengizinkan DELETE bila status DELETED. **Tidak dapat dipulihkan lewat API** (pemulihan dalam masa tunggu hanya lewat operator/SQL).\
**Ganti nama sesi** (`PATCH /sessions/:id`, OWNER/ADMIN/MEMBER, tercatat sebagai event sesi), **edit API key** (`PATCH /api-keys/:id`: nama dan scope, OWNER/ADMIN, diaudit, berlaku seketika), **ganti nama workspace** (`PATCH /tenant`, OWNER; nama pada kode workspace ikut). **Hapus akun sendiri sengaja tidak disediakan.**\
**Risiko tersisa:** kode pemulihan yang hilang bergantung pada operator; email tidak terverifikasi (siapa pun dapat memasang email orang lain pada akunnya, tidak memberi akses ke akun orang itu); reset kata sandi tidak diaudit (tanpa konteks tenant); workspace terhapus belum bisa dipulihkan sendiri oleh OWNER.

### Addendum ADR-037 (2026-11-20): kode cadangan, audit reset, dan pemulihan workspace --- migrasi 0017

-   **8 kode pemulihan** sekali pakai per pengguna (tabel `user_recovery_codes`, hanya hash, RLS pemilik, tanpa akses platform) menggantikan satu kode: kehilangan satu kode tidak lagi fatal; memakai satu kode tidak menghanguskan yang lain; himpunan baru menghanguskan semua yang lama.
    Penanda `recovery_confirmed_at` + `GET /auth/me.recovery` untuk banner. Kode tunggal lama dimigrasikan sebagai salah satu kode. Alat operator menerbitkan himpunan baru. Frontend: wajib centang "sudah saya simpan", anjuran minimal 2 OWNER.
-   **Audit tanpa konteks tenant:** `account.password_reset` dicatat ke SETIAP workspace tempat pengguna menjadi anggota (admin melihat dugaan pengambilalihan), `join_request.created` ke workspace tujuan; kebijakan insert sempit yang dibuktikan kepemilikan akun/kode workspace (pola `audit_insert_accept`).
-   **Pemulihan workspace terhapus** (`POST /auth/deleted-workspaces`, `POST /auth/restore-workspace`, publik dengan email + kata sandi karena setelah hapus tidak ada workspace aktif untuk login): hanya OWNER, dalam `RETENTION_TENANT_DAYS` sejak `tenants.deleted_at`. Kembali: workspace, anggota, riwayat, pengaturan, audit.
    TIDAK kembali (sudah dihapus saat hapus): koneksi WhatsApp (kredensial dihapus; pairing ulang), webhook, API key, undangan. Alternatif "penghapusan terjadwal 7 hari" ditolak: butuh job lintas tenant yang menurunkan sesi dan mencabut integrasi.
-   **Risiko tersisa (menggantikan daftar ADR-037):** semua kode hilang tetap bergantung operator (SOP: pastikan peminta pemilik akun); email tidak terverifikasi; pemulihan tidak mengembalikan koneksi WhatsApp.

## ADR-038 --- Ketahanan terhadap gangguan database dan proses (uji ketahanan, 2026-11-20)

**Temuan (terbukti dengan probe, bukan dugaan):** `pg.Pool` tanpa listener `error` membuat koneksi idle yang diputus server
(restart/failover PostgreSQL, jaringan putus, `pg_terminate_backend`) memicu `uncaughtException`: proses API dan engine mati.
Klien yang sedang dipegang (leader control-plane) berperilaku sama. Selain itu leader control-plane yang koneksinya mati diam-diam
tidak menyadarinya (rekonsiliasi memakai koneksi lain) sehingga dua instans dapat memimpin bersamaan, dan permintaan menggantung
tanpa batas bila DB hang karena pool tidak punya batas waktu koneksi.

**Keputusan:**
-   `guardPool` (database/gateway.ts) memasang listener `error` pada pool dan setiap klien baru: hanya mencatat pesan galat
    (tanpa teks query/parameter); klien rusak dibuang pool, query berikutnya memakai koneksi baru.
-   Leader control-plane memeriksa koneksinya (`SELECT 1`) sebelum tiap rekonsiliasi dan melepas peran + membuang koneksi bila putus;
    kunci advisory dibatasi per schema (`wazap:control-plane:<schema>`).
-   `DB_CONNECT_TIMEOUT_MS` (default 5000) dan TCP keep-alive pada pool.
-   Galat ketersediaan DB dipetakan ke `503 SERVICE_UNAVAILABLE` + `Retry-After` (bukan 500 `INTERNAL_ERROR`); `/health/live` tetap 200
    (proses sehat; jangan restart karena DB mati), `/health/ready` 503.

**Dampak/risiko tersisa:** pemetaan 503 berbasis kode/pesan galat driver (daftar di `http/errors.ts`) dan perlu ditinjau bila driver
berganti versi mayor. Ketahanan terhadap kegagalan jaringan ke WhatsApp (Baileys) belum diuji di luar adapter palsu.

## ADR-039 --- Entrypoint proses pekerja terpisah dan kunci singleton engine (2026-11-20)

**Konteks:** engine, control-plane, webhook, dan retensi hanya bisa berjalan embedded di proses API. Menyatukan beban jaringan WhatsApp
dengan API membuat restart/deploy API memutus semua sesi, dan kegagalan satu sisi menjatuhkan sisi lain.

**Keputusan:**
-   `src/worker.ts` menjalankan peran terpilih (`WORKER_ROLES`) tanpa HTTP bisnis; komposisi dipakai bersama dengan mode embedded lewat `runtime/workers.ts`
    (tidak ada dua jalur kode). Pekerja tidak pernah migrasi, menolak start bila schema belum dimigrasi / role DB tidak aman / DB mati (kode 1).
-   **Kunci singleton per `ENGINE_NODE_NAME`** (advisory lock sesi). Alasan: `engines.register` meng-upsert berdasarkan nama; dua proses bernama sama
    berbagi `engine_id` dan fencing token sehingga fencing tidak membedakannya dan satu sesi dapat dipegang dua socket. Proses kedua ditolak start.
    Kunci hilang dan tak dapat direbut kembali => shutdown rapi dengan kode 1 (fail-stop, lebih baik daripada dua pemilik).
-   Health HTTP minimal (loopback) untuk PM2/monitoring. Shutdown LIFO; `createShutdown.run(reason, fatal)` memberi kode 1 untuk kegagalan fatal.
-   Mode embedded dipertahankan (dev/single-node, default `true`); produksi mematikannya.

**Risiko tersisa:** jendela singkat (hingga ~5 dtk) saat kunci hilang dan belum terdeteksi dapat memuat dua proses bernama sama bila proses kedua
sengaja dijalankan tepat di celah itu; fencing lease tetap melindungi tulis persisten tetapi bukan socket. Satu host: pekerja belum diuji lintas host.
Pemisahan penuh API-engine belum diuji dengan WhatsApp sungguhan (hanya adapter palsu dan proses nyata tanpa sesi).

## ADR-040 --- Staging berlapis TLS: Nginx, TRUST_PROXY, dan pemisahan API-worker (2026-11-20)

**Konteks:** semua uji sebelumnya berjalan tanpa proxy dan TLS. Staging lokal (PostgreSQL `wazap_staging`, role `wazap_app`/`wazap_migrator`,
`NODE_ENV=production`, `DB_ROLE_CHECK=enforce`) kini dilayani lewat Nginx TLS dengan API dan worker sebagai dua proses PM2.

**Temuan (dibuktikan dengan uji mutasi):**
1.  Snippet Nginx di panduan memakai `$proxy_add_x_forwarded_for`. Dengan `TRUST_PROXY=true` klien dapat memalsukan IP-nya lewat header itu:
    throttling login per-IP tidak berlaku (0/24 ditolak) dan IP di audit dapat dipalsukan. Perbaikan: Nginx menimpa (`$remote_addr`), API hanya di loopback.
2.  Contoh PM2 memakai `env_file`, yang tidak ada di PM2 6.0.14 (diabaikan diam-diam, proses start tanpa rahasia). Diganti peluncur `run.sh`.

**Keputusan:** vhost sebagai templat terversi (`deploy/staging/nginx/`), dirender oleh skrip yang sama untuk Nginx sistem dan uji tanpa-root; rahasia
(JWT, kunci master BARU, kredensial DB) dibuat acak oleh `make-env.sh` ke `~/.config/wazap-staging` (0600, di luar repo, tidak dicetak); sertifikat
self-signed hanya untuk staging; `limit_req` lebih ketat pada rute kredensial; health pekerja tidak diproksikan; `verify.sh` menjadi gerbang staging.

**Terbukti (verify.sh):** TLS 1.2/1.3 saja, HSTS/nosniff, versi Nginx tidak bocor, cookie refresh Secure+HttpOnly+SameSite, Socket.IO via WebSocket
lewat TLS, XFF palsu tidak menghindari throttling, API/worker hanya di loopback; restart API tidak menyentuh worker; restart worker berhenti rapi.

**Risiko tersisa:** Nginx sistem sudah dipasang lewat `install-nginx.sh` dan `verify.sh` lulus penuh terhadapnya (2026-11-20; situs lain tidak terpengaruh); Let's Encrypt/domain
publik belum diuji; belum ada CSP untuk dashboard (menunggu frontend); kunci master staging belum dicadangkan (wajib sebelum produksi); uji WhatsApp
sungguhan dengan topologi ini belum dilakukan; pemantauan/alarm belum ada.

## ADR-041 --- Satu chat per kontak: identitas JID nomor vs LID (2026-11-20)

**Temuan (uji WhatsApp sungguhan di staging):** WhatsApp (Baileys 7) menyebut satu kontak dengan dua JID: nomor (`@s.whatsapp.net`) dan LID (`@lid`).
Pesan keluar dicatat trigger DB dengan JID nomor; balasan masuk datang dengan LID (nomor dari `remoteJidAlt`) dan inbox membuat chat kedua. Dashboard menampilkan satu kontak sebagai dua obrolan.
Adapter palsu pada tes lama selalu memakai JID nomor, sehingga tidak pernah mereproduksinya.
**Keputusan:** satu fungsi SQL `resolve_chat` (0018) untuk SEMUA penulis chat (trigger keluar dan `inbox.record`): kecocokan lewat `remote_jid`, `lid_jid`, atau nomor yang sama;
kanonik = chat ber-JID nomor lalu yang tertua; chat lain dari kontak yang sama digabung (pesan dipindah); `lid_jid` disimpan agar pesan LID tanpa nomor tetap dikenali.
Kunci advisory (JID lalu nomor, urutan tetap) mencegah duplikat dari penulis paralel. Duplikat yang sudah ada diperbaiki oleh migrasi.
**Dampak kontrak:** `jid` pada `/chats` kini JID nomor bila nomor diketahui; `id` chat yang digabung hilang (klien tidak boleh menyimpan `id` chat jangka panjang di luar sesi UI). Tidak ada perubahan bentuk respons.
**Risiko tersisa:** kontak yang hanya pernah muncul sebagai LID tanpa nomor tetap chat tersendiri sampai nomornya diketahui (lalu digabung otomatis); grup dan status tidak ditangani (diabaikan sejak awal).

## ADR-042 --- Body JSON kosong diterima; uji staging tidak boleh memakai IP browser (2026-11-20)

**Temuan (uji WhatsApp sungguhan):** (1) Fastify menjawab 400 untuk `content-type: application/json` dengan body kosong. Helper `request` frontend memasang header itu pada SEMUA permintaan, jadi setiap POST tanpa body
(konfirmasi kode pemulihan, logout, `connect`/`disconnect`/`reconnect` sesi) gagal 400 dari browser. Banner "kode pemulihan belum dikonfirmasi" tidak pernah hilang, dan sesi `LOGGED_OUT` tidak dapat dihubungkan ulang dari dashboard.
Tes memakai `inject` tanpa header itu, sehingga tidak terlihat. (2) `verify.sh` mengirim puluhan login salah dari `127.0.0.1`, IP yang sama dengan browser pengguna di loopback, dan menghabiskan kuota login per-IP ("Terlalu banyak percobaan").
**Keputusan:** parser JSON kustom menerima body kosong/spasi sebagai "tanpa body" dan mendelegasikan sisanya ke parser bawaan Fastify (JSON rusak 400, prototype poisoning ditolak, batas ukuran 413 tetap). Rute yang butuh body tetap 400 `VALIDATION_ERROR` lewat skema.
`verify.sh` memakai sumber `127.0.0.2` (`VERIFY_SOURCE_IP`) agar tidak memakai kuota IP browser. **Risiko tersisa:** `verify.sh` membuat akun uji dan dibatasi register 5/jam/IP; pembatas laju masih in-memory (restart API mereset).

## ADR-043 --- CI dengan pagar yang menutup tiga cara pipeline "hijau palsu" (2026-11-20)

**Konteks:** 304 tes hanya berjalan di mesin pengembang. Menambah CI sederhana (`npm test`) akan memberi rasa aman palsu karena tiga hal yang ditemukan saat menyusunnya:
1.  Tes memakai `skip` bila PostgreSQL tidak terjangkau: dengan DB salah konfigurasi `npm test` keluar 0 dengan 251 dari 304 tes DILEWATI.
2.  Superuser PostgreSQL mem-bypass RLS; role CI harus non-superuser tanpa `BYPASSRLS` seperti role dev, kalau tidak tes isolasi tidak bermakna.
3.  Repo dikembangkan di partisi NTFS (`core.fileMode=false`): git mencatat semua skrip sebagai 100644, sehingga clone di CI/server mendapat skrip yang tidak dapat dijalankan langsung ("Permission denied").
**Keputusan:** `.github/workflows/ci.yml` dengan job `backend` (typecheck, build, tes), `deploy-config`, `hygiene`, dan `audit` (informasi). Pagar: `backend/scripts/ci-test.sh` (tes dilewati/dibatalkan/kurang dari 280 = gagal);
`backend/scripts/check-migrations.sh` (migrasi terapan tidak boleh diubah/dihapus/diganti nama, nomor berurutan: mencegah insiden checksum 0014); bit executable skrip dicek di index git (`git update-index --chmod=+x`);
vhost Nginx dirender dan diuji `nginx -t` dengan aturan XFF ditimpa; tidak ada berkas env/kunci privat/nilai rahasia ter-commit. Semua action dipin ke SHA commit; hak `contents: read`; tanpa rahasia (database CI sekali pakai); Dependabot mingguan untuk npm dan actions.
**Terbukti secara lokal (env kosong tanpa `.env`):** 304 tes lulus lewat `ci-test.sh`; uji mutasi: DB tidak terjangkau => gagal; migrasi diubah/dihapus/diganti nama/melompat/duplikat => gagal; XFF ditambah atau diteruskan dari klien => gagal.
**Risiko tersisa:** workflow BELUM pernah berjalan di runner GitHub (hanya divalidasi sintaksnya dan tiap langkah dijalankan lokal; `actionlint` tidak dapat dijalankan); `postgres:18` dan Ubuntu 24.04 mungkin berbeda halus dari PostgreSQL lokal;
`npm audit` belum memblokir; frontend belum tercakup (belum di repo ini); tes beban/perf tidak dijalankan di CI.

## ADR-044 --- Penyimpanan auth state: kekhawatiran skala dibantah dengan pengukuran (2026-11-20)

**Konteks:** pada uji WhatsApp sungguhan satu sesi menyimpan 2.844 baris `session_auth_state` dalam beberapa menit, dan saya mencatatnya sebagai risiko skala ("waktu start pada puluhan sesi"). Dianalisis sebelum bertindak.
**Temuan:** (1) isinya bukan kunci yang menumpuk: 1.645 `lid-mapping` (49 B), 807 `pre-key` (tetap ~812 saat pairing), 362 `tctoken`, hanya 9 `session`; total 432 KB, tabel 1,5 MB. Pertumbuhan mengikuti JUMLAH KONTAK akun, bukan waktu.
(2) 2.675 baris ditulis dalam satu menit pairing (sinkronisasi awal), lalu 1-4 baris per menit. (3) `auth-store.ts` bersifat malas: `open()` hanya membaca baris `creds`, `keys.get` hanya id yang diminta, `keys.set` satu query `unnest` per batch; tidak ada pemuatan massal.
**Terukur (`test/perf/auth-store.perf.ts`, lokal, schema sementara):** akun 30 ribu baris: sinkron awal 0,7-0,9 dtk, `open` p95 2 ms (sama dengan 2,8 ribu baris), `get` 10 id p95 2 ms, `set` 1 item p95 4 ms, erase 14 ms, tabel 11 MB. 50 sesi bersamaan dengan pool 10 dijenuhkan: 6.900-8.900 op/dtk, p95 10-13 ms, 0 galat
(kebutuhan realistis ~1.250 op/dtk). Mutasi: `open()` yang memuat semua baris dibuat p95 menjadi 130 ms dan tes gagal.
**Keputusan:** tidak ada perubahan kode; kekhawatiran awal ditarik. Tes perf dijadikan pagar regresi (ambang ~10x longgar).
**Risiko tersisa (nyata, lebih kecil):** (a) pool DB worker (`DB_POOL_MAX` 10) dipakai bersama operasi lease/heartbeat dan auth state: terukur aman pada DB lokal, belum pada DB jarak jauh (tiap `get`/`set` = satu transaksi dengan beberapa pernyataan, latensi berlipat); pantau `lease_rem_s` dan ukur ulang di staging berjarak sebelum >20 sesi.
(b) penyimpanan ~11 MB per akun besar (30 ribu baris): 50 akun besar ~550 MB, tanpa pemangkasan `lid-mapping`/`tctoken`; pantau `pg_total_relation_size`. (c) benchmark sintetis (ukuran payload dari satu akun nyata), tanpa jaringan; pola tulis Baileys pada laju pesan tinggi belum diukur; blob `app-state-sync-version` hingga 91 KB ditulis ulang penuh tiap sinkron.

## ADR-045 --- OpenAPI dihasilkan dari kode, dengan kontrak yang diperiksa terhadap response asli (2026-11-20)

**Konteks:** kontrak API hanya ada sebagai prosa (API_CONTRACT.md) dan frontend sudah dua kali menabrak ketidakcocokan kontrak (body kosong 400, chat ganda). Spesifikasi tulisan tangan akan menyimpang dari kode.
**Keputusan (satu sumber kebenaran, tanpa dependensi baru):**
-   **Request:** tiap file route mengekspor `routeContracts` yang menunjuk skema Zod YANG SAMA dengan yang dipakai handler; JSON Schema dihasilkan oleh `z.toJSONSchema` (Zod 4, 2020-12, native di OpenAPI 3.1).
-   **Keamanan:** guard (`requireAccess/requireRole/requireScope/authenticate`) ditempeli metadata; generator membacanya dari opsi route nyata lewat hook `onRoute` (`x-roles`, `x-required-scope`, `x-user-only`, publik = `security: []`).
-   **Response:** skema Zod di `src/http/openapi/schemas.ts` (looseObject: field tambahan kompatibel, field hilang/berubah tipe terdeteksi) dan registri 75 operasi di `operations.ts`. Dihasilkan ke `docs/02_BACKEND/openapi.json` (`npm run openapi`).
-   **Penjaga:** `test/openapi.test.ts` (kelengkapan dua arah route <-> dokumen, struktur, keamanan turunan guard, berkas terbit mutakhir), `test/contract.test.ts` (operasi yang tidak disentuh tes lain), dan MODE KONTRAK (`WAZAP_CONTRACT_CHECK=1`, `npm run test:contract`, dipakai CI):
    hook `onSend` memvalidasi SETIAP response asli di seluruh suite, sehingga 313 tes ikut menjadi tes kontrak tanpa skenario tambahan.
**Terbukti:** 313/313 lulus dalam mode kontrak, nol pelanggaran. Uji mutasi: field wajib diganti nama, tipe diubah, dan dokumen satu route dihapus masing-masing menggagalkan tes dengan pesan yang menunjuk operasinya. Tes struktur menangkap satu bug generator (`$ref` komponen bersarang). Menjalankan mode kontrak di lingkungan BERSIH (env kosong, seperti CI) menemukan satu ketidakakuratan dokumen yang tersembunyi oleh `.env` lokal: `PUT /team/join-code` mengembalikan `join_url: null` bila `DASHBOARD_BASE_URL` belum dikonfigurasi (skema semula `string`).
**Risiko tersisa:** skema response diturunkan dari sampel nyata lalu dikurasi, bukan dari tipe layanan; field opsional yang jarang muncul bisa tidak teramati. Penambahan field tidak terdeteksi (disengaja). Galat didokumentasikan secara umum (status standar dari guard/skema + `errors` per operasi), bukan per kode galat domain.
Dokumen belum divalidasi validator OpenAPI eksternal (tidak ada di mesin ini; menjalankan alat pihak ketiga ditunda atas izin). `x-*` adalah ekstensi kami. Hook mode kontrak ikut terkirim ke produksi tetapi tidak aktif tanpa env.

## ADR-046 --- Operasi produksi: cadangan lewat role BYPASSRLS, runbook yang diperiksa tes (2026-11-20)

**Temuan (dibuktikan di staging, PostgreSQL 18):** semua tabel `FORCE ROW LEVEL SECURITY`, sehingga `pg_dump` oleh role biasa (bahkan pemilik tabel `wazap_migrator`) GAGAL (`query would be affected by row-level security policy`) dan MENINGGALKAN berkas parsial 165 KB di disk;
`--enable-row-security` juga gagal (`function ctx_text(unknown) does not exist`: pg_dump memakai `search_path` kosong, kebijakan memanggil fungsi tanpa nama schema). Skrip cadangan yang tidak memeriksa kode keluar akan menyimpan cadangan rusak atau kosong tanpa ada yang tahu.
**Keputusan:** (1) cadangan hanya lewat superuser atau role khusus `wazap_backup` (`BYPASSRLS`, `pg_read_all_data`, baca-saja; `deploy/ops/setup-backup-role.sql`), BUKAN dengan mematikan RLS. (2) `deploy/ops/backup.sh`: menolak role tanpa BYPASSRLS, dump ke berkas sementara, verifikasi daftar isi dan entri data tiap tabel, pindah atomik, checksum, retensi yang tidak pernah menyisakan <3 berkas, kode keluar 1 pada kegagalan.
(3) `deploy/ops/restore-drill.sh`: pulihkan ke database sementara, buktikan jumlah baris tiap tabel sama persis dengan isi dump, RLS ENABLE+FORCE, migrasi berurutan, hak role; selalu hapus database sementara. (4) `RUNBOOK.md` (14 playbook, deploy/rollback, indikator) dan `BACKUP_RESTORE.md`; `test/runbook-docs.test.ts` memeriksa perintah, berkas, nama env, teks log/kode galat, dan angka batas laju yang dikutip terhadap kode.
(5) Latihan rotasi kunci memakai CLI sungguhan (`test/rotate-cli.test.ts`).
**Terbukti:** pagar role, kegagalan `pg_dump` nyata tanpa sisa berkas, cadangan utuh + checksum, jumlah baris dari dump = sumber, retensi, kegagalan rapi bukan superuser; CLI rotasi (dry-run tidak mengubah, pensiun dini exit 2 tanpa bocor rahasia, konfigurasi salah exit 1); mutasi pada dokumen (env/perintah salah) ditangkap tes. Rotasi dini dan pagar cadangan juga ditegakkan oleh mutasi pada CLI.
**Terbukti (tambahan, 2026-11-20):** latihan pemulihan PENUH pada data staging nyata lulus: 27 tabel, 3.213 baris sama persis, RLS ENABLE+FORCE pada semua tabel, 75 kebijakan, migrasi berurutan sampai 0018, database sementara terhapus otomatis.
**Risiko tersisa:** pembuatan role `wazap_backup` di server dan uji `verify-db-roles.sh` pada hasil pemulihan belum dijalankan (latihan memakai superuser); WAL archiving/PITR belum disiapkan (RPO saat ini = interval dump); cadangan belum dienkripsi/disalin di luar host secara otomatis (opsi GPG ada, penyalinan belum); runbook belum diuji di produksi dan kontak on-call/ambang alarm masih harus diisi tim; cadangan tanpa kunci master tidak membuka sesi WhatsApp (dua aset harus selalu dicadangkan terpisah).

## ADR-047 --- Frontend dalam repo yang sama, dengan kontrak dan pagar CI (2026-11-20)

**Konteks:** frontend hanya ada sebagai snapshot di `feat/backend-gateway-v1` (riwayat terpisah dari `clean/backend-v1`, tanpa leluhur bersama), bercampur dengan arsip alat (`whatsapp-gateway-agent-kit-v1.0.zip`) dan hasil build (`frontend/dist`), sehingga tidak ikut `git push origin clean/backend-v1:main`.
**Keputusan:** frontend (45 berkas, tanpa `dist`/`node_modules`/zip) dibawa ke `clean/backend-v1` sebagai satu commit berpenulis pemilik repo tanpa trailer kontributor; `.gitignore` mengabaikan `frontend/dist/` dan arsip agent kit. CI mendapat job `frontend` (`npm ci`, `tsc --noEmit`, `vite build`) dan pagar hygiene baru (arsip, `dist/`, symlink, `node_modules` tidak boleh ter-commit).
**Kontrak:** `backend/test/frontend-contract.test.ts` memeriksa SEMUA alamat `/api/v1/...` yang dipanggil di `frontend/src` terhadap `openapi.json` (path dan method). Hasil awal: `services/api.ts` 66 dari 66 pemanggilan cocok persis; tetapi `src/api.ts` (klien prototipe lama, 110 baris, tidak diimpor siapa pun) memuat endpoint yang sudah tidak ada (`/messages/history`, `/webhooks/test`, `/auth/api-keys`).
File mati itu dihapus (commit tersendiri; dapat dipulihkan dari `ffcfec8`) dan tes dijaga agar klien lama tidak kembali. Mutasi (memulihkan `api.ts` lama; mengganti nama endpoint) membuat tes gagal dengan menyebut endpoint yang salah.
**Terbukti:** typecheck dan build frontend lulus (`npm ci --dry-run` sinkron), tes kontrak lulus, tanpa data pribadi/rahasia di `frontend/src` (hanya nomor contoh dan URL placeholder).
**Risiko tersisa:** frontend tidak punya tes unit/komponen dan belum diuji di peramban otomatis (hanya typecheck, build, dan kontrak API); parser tes kontrak berbasis pola teks (tidak menangkap URL yang dirakit dinamis sepenuhnya); build menghasilkan chunk >500 kB (peringatan Vite; belum dipecah); komponen `MockNotice.tsx` tampaknya tidak dipakai; `feat/backend-gateway-v1` masih berisi snapshot lama (berikut zip dan `dist`) dan perlu dihapus oleh pemilik repo agar tidak dipush tak sengaja.

## ADR-048 --- Ekspor data workspace (DITERIMA dan backend diimplementasikan, 2026-11-20)

**Status:** DITERIMA oleh pemilik produk (semua usulan bawaan dipakai); backend diimplementasikan dan diuji, frontend belum. Rancangan dan hasil: `docs/02_BACKEND/DATA_EXPORT_DESIGN.md`.
**Konteks:** isi pesan dibersihkan setelah 30 hari dan baris setelah 180 hari; pelanggan tidak punya cara menyimpan riwayatnya sendiri. Menu "cadangan database" untuk pelanggan ditolak: cadangan butuh role BYPASSRLS yang membaca semua tenant (ADR-046) dan tidak boleh dipegang API.
**Keputusan yang diusulkan:** ekspor per workspace untuk OWNER/ADMIN (hanya pengguna dashboard) dengan konfirmasi kata sandi; unduhan streaming langsung (CSV aman dari injeksi formula, atau NDJSON dengan manifest) dalam konteks RLS tenant; batas 200 ribu baris / 92 hari dicek dengan pra-hitung sehingga melebihi batas ditolak 422 sebelum byte pertama (tidak pernah memotong diam-diam); batch keyset dengan transaksi pendek dan batas atas waktu terkunci; audit `data.exported` untuk setiap hasil; migrasi 0019 (indeks `wa_messages (tenant_id, occurred_at, id)` dan aksi audit). Asinkron, terjadwal, dan akses API key ditunda ke fase berikut.
**Keputusan pemilik produk:** MEMBER tidak boleh; tanpa API key; batas 200 ribu baris / 92 hari / 5 per jam; retensi isi pesan 30 hari tetap (UI menjelaskan); tanpa pemberitahuan ke OWNER lain (cukup audit).
**Hasil implementasi (2026-11-20):** `POST /exports/{messages|outbound|chats|contacts|audit-logs|members}` dan `GET /exports/policy`; migrasi 0019 (dua indeks keyset dan `target_type` audit `export`); saklar mati `EXPORT_ENABLED`. 18 tes fungsional, 3 tes perf, uji mutasi pada tiap pengaman. Pertahanan berlapis terbukti: tanpa filter `tenant_id` di SQL, RLS tetap menahan kebocoran.
**Temuan:** pembatas kata sandi yang menghitung setiap ekspor mengunci pengguna sah (ditemukan tes jatah, diperbaiki: hanya percobaan SALAH dihitung, penguncian dicek sebelum verifikasi); CHECK aksi audit ternyata generik sehingga hanya `target_type` yang perlu migrasi.
**Risiko tersisa:** lihat DATA_EXPORT_DESIGN.md bagian 14 (batas per proses API, `X-Export-Rows` perkiraan untuk contacts, baris lampau yang tiba selama ekspor, awalan `'` pada sel formula, diuji 30 ribu baris lokal, frontend belum ada).

## ADR-049 --- Notifikasi alarm per workspace (DITERIMA dan backend diimplementasikan, 2026-11-20)

**Status:** DITERIMA oleh pemilik produk (semua usulan bawaan dipakai); backend diimplementasikan dan diuji, frontend belum. Rancangan: `docs/02_BACKEND/ALERT_NOTIFICATIONS_DESIGN.md`.
**Konteks:** pelanggan hanya tahu sesinya putus bila membuka dashboard. Alarm operator server (`MONITORING_ALERTING.md`) sengaja di luar aplikasi dan tidak melihat per workspace.
**Keputusan:** OWNER/ADMIN (hanya pengguna dashboard) mengelola kanal (Telegram atau Slack-compatible) dan 8 aturan tetap di kode; kata sandi untuk membuat kanal, mengganti target, dan menghapus. Target dienkripsi dengan keyring yang sama dengan rahasia webhook (AAD tenant+kanal), tidak pernah dikembalikan. Telegram: host dikunci `api.telegram.org`; Slack: daftar host (hooks.slack.com, discord.com, discordapp.com), https, port 443, host publik, tanpa redirect. Pesan hanya memuat fakta tersanitasi (nama sesi, angka, host), tanpa nomor telepon pelanggan akhir, isi pesan, atau URL penuh.
**Mekanisme (menyimpang dari rancangan awal, lebih sederhana dan lebih mudah dibuktikan):** satu evaluator seragam membaca sumber tiap aturan dalam jendela waktu terakhir dan menulis antrean `alert_deliveries`; idempotensi lewat UNIQUE (tenant, kanal, aturan, objek, jendela) + ON CONFLICT DO NOTHING, jadi evaluator ganda aman. Tidak ada kursor outbox terpisah dan tidak ada pesan "pulih" pada v1. Pengirim: klaim SKIP LOCKED, retry terbatas, 400/401/403/404 permanen, batas kirim per kanal per jam (RATE_CAPPED, bukan kegagalan kanal), breaker (DEAD beruntun menonaktifkan kanal dan diaudit).
**Hasil:** migrasi 0020 (3 tabel RLS FORCE, indeks evaluator, `target_type` audit baru); `GET /alerts/catalog|channels|rules|deliveries`, `POST|PATCH|DELETE /alerts/channels`, `POST /alerts/channels/{id}/test`, `PUT /alerts/rules/{code}`; worker: poller `alert-evaluator` dan `alert-sender` (peran webhook); rotasi kunci dan retensi diperluas; saklar `ALERTS_ENABLED`. 24 tes baru (`test/alerts.test.ts`).
**Temuan saat implementasi:** (1) batas kirim per kanal dilewati bila batch dikirim paralel (cek sebelum pencatatan) → pengiriman per kanal dibuat berurutan; (2) modul yang memakai konteks platform harus di `modules/engine/` (tes pagar arsitektur menangkapnya) → evaluator dan pengirim ada di sana; (3) env tes harus diatur sebelum `helpers.ts` memuat config.
**Risiko tersisa:** notifikasi bukan jaminan (Telegram/Slack dapat lambat atau turun); kejadian saat worker mati lebih lama dari `ALERTS_LOOKBACK_MINUTES` tidak dikirim; token bot pelanggan tersimpan terenkripsi di server (risiko kelas sama dengan rahasia webhook); `session.disconnected_long` memakai `wa_sessions.updated_at` sebagai penanda mulai terputus (perkiraan); belum diuji dengan bot Telegram sungguhan dan sesi WhatsApp staging (menunggu token), dan belum ada UI.

## ADR-050 --- Topologi produksi: wazap.bolinggo.org dan api-wazap.bolinggo.org (DITERIMA, 2026-11-21)

**Status:** DITERIMA oleh pemilik produk (domain ditetapkan); paket penyiapan dibuat dan diuji lokal, belum dipasang di server. Paket: `deploy/production/`; kesiapan: `docs/07_DEPLOYMENT/PRODUCTION_READINESS.md`.
**Konteks:** pemilik menetapkan dashboard di `wazap.bolinggo.org` dan backend di `api-wazap.bolinggo.org`. Frontend memanggil API dengan path relatif (`/api/v1/...`, satu origin, tanpa `VITE_API_URL`), cookie refresh `SameSite=Strict`, dan `CORS_ORIGINS` kosong. Bila dashboard memanggil host API lintas origin, perlu CORS, `credentials: include` pada semua panggilan, alamat Socket.IO terpisah, dan perubahan frontend yang belum diuji.
**Keputusan:** (1) dashboard melayani berkas statis DAN memproksikan `/api` dan Socket.IO ke upstream yang sama di host yang sama, sehingga peramban tetap satu origin (tanpa CORS, tanpa perubahan frontend, cookie host-only); (2) `api-wazap.bolinggo.org` melayani API yang sama untuk integrasi (API key, Socket.IO) tanpa dashboard, `CORS_ORIGINS` tetap kosong; (3) satu sertifikat Let's Encrypt untuk kedua nama; (4) HSTS bertahap (300 dtk, lalu 31536000 setelah `verify.sh` lulus) tanpa `includeSubDomains`/`preload` karena `bolinggo.org` dapat memuat layanan lain; (5) env di `/var/lib/wazap/env` (0600) dimuat `bin/run.sh`; PM2 satu instans `wazap-api` dan `wazap-engine`; (6) rilis lewat `release.sh` dengan urutan build, cadangan segar, migrasi, worker, API, frontend.
**Alternatif ditolak:** dashboard memanggil `api-wazap` langsung (CORS dan perubahan frontend lalu perlu uji ulang penuh, tanpa manfaat keamanan; cookie `Strict` antar-subdomain tetap same-site tetapi permukaan CORS bertambah).
**Bukti:** templat dirender dan diuji dengan `nginx -t` serta Nginx sungguhan terhadap backend dev (dashboard 200, SPA fallback, `/api` terproksi 401, host API `/` = 404 JSON, `/health/ready` 200 di kedua host, HTTP dialihkan 301, HSTS ada, versi Nginx tidak bocor); `make-env.sh` menghasilkan env 0600 yang lolos validasi konfigurasi production (API dan worker) dan `DASHBOARD_BASE_URL` http ditolak.
**Risiko tersisa:** belum dipasang di server nyata (DNS, certbot, firewall, `verify.sh` dari luar belum dijalankan); satu host adalah satu titik gagal; peramban yang kelak memanggil host API lintas origin akan diblokir CORS (disengaja).

**Tambahan ADR-050 (2026-11-21, dari hasil `preflight.sh` di server nyata):** server adalah host bersama (Nginx 1.28 dengan `bimbel.bolinggo.org`, `api-bimbel.bolinggo.org`, `antrian-ku.bolinggo.com`; PostgreSQL 18 lokal dengan database lain; port 443 belum didengarkan; DNS lewat Cloudflare). Keputusan: (7) mode `CLOUDFLARE=1`: IP pengunjung dibaca dari `CF-Connecting-IP` HANYA dari rentang IP resmi Cloudflare (`set_real_ip_from`), karena tanpa itu `X-Forwarded-For` berisi IP Cloudflare dan throttling/batas laju/audit per-IP salah (terbukti: proxy tepercaya memberi IP pengunjung, sumber tak tepercaya yang memalsukan header diabaikan); (8) mode SSL Cloudflare TIDAK diubah se-zona (situs lain bermode Flexible akan error); Full (strict) hanya lewat Configuration Rule per-hostname setelah origin terbukti benar; (9) penampung 443 `ssl_reject_handshake` agar server 443 pertama (dashboard) tidak menjadi default untuk nama lain di host bersama (terbukti: SNI tak dikenal dan akses tanpa SNI ditolak handshake, kode curl 35). Temuan skrip: pemeriksa menganggap AAAA milik Cloudflare sebagai kegagalan (positif palsu pada server tanpa IPv6); diperbaiki.

**Tambahan ADR-050 (2026-11-21, setelah data server kedua): server memakai Cloudflare TUNNEL** (`cloudflared` aktif; origin situs lain hanya HTTP:80; `ufw` membuka 80/443 untuk publik). Keputusan: (10) jalur utama server ini adalah tunnel, bukan sertifikat origin: vhost `wazap-tunnel.conf.tpl` memakai `listen 80` biasa dengan `server_name` eksplisit seperti situs lain (BUKAN `listen 127.0.0.1:80`: itu mengambil semua permintaan loopback termasuk milik situs lain), tanpa 443/certbot, dan mode SSL Cloudflare tidak berlaku; (11) karena port 80 server terbuka untuk publik, vhost hanya melayani koneksi dari loopback (`$realip_remote_addr`), jadi permintaan langsung ke IP server dengan `Host: wazap...` ditolak 403 dan Cloudflare tidak dapat dilewati; IP pengunjung dari `CF-Connecting-IP` hanya dari loopback; (12) alarm baru A27 (`MON_PUBLIC_URL`): memeriksa jalur publik ujung ke ujung, karena A1 memeriksa lewat loopback dan tidak melihat `cloudflared` mati. **Bukti:** Nginx sungguhan berdampingan dengan situs lain di port yang sama (situs lain tetap dilayani, host tak dikenal ke default situs lain, 403 dari sumber non-loopback walau memalsukan header, IP pengunjung terbaca, token di query tidak masuk log); A27 diuji (tidak palsu saat sehat, menyala setelah tertahan 3 mnt, pulih); langkah CI memagari `listen 127.0.0.1:80`. **Risiko tersisa:** `cloudflared` menjadi titik gagal tambahan (A27 dan notifikasi Tunnel Health menutupnya); belum dipasang di server nyata; konfirmasi bahwa cloudflared meneruskan `CF-Connecting-IP` baru terbukti di server (diperiksa `verify.sh` lewat log akses).

**Koreksi ADR-050 (2026-11-21, dari konfigurasi Nginx server nyata):** keputusan (10) di atas SALAH untuk server ini. Situs `bimbel` memakai `listen 127.0.0.1:80`; vhost WAZAP bergaya wildcard (`listen 80`) tidak pernah menerima lalu lintas tunnel (koneksi cloudflared ke 127.0.0.1:80 hanya dicocokkan dengan server milik alamat itu) dan permintaan `Host: wazap...` dijawab situs bimbel. Terbukti dengan Nginx sungguhan sebelum ter-deploy. Keputusan yang berlaku: **alamat listen vhost tunnel harus sama dengan situs lain di tunnel** (`TUNNEL_LISTEN`, bawaan `127.0.0.1:80`; `80` hanya bila semua situs lain wildcard); Service tunnel memakai `http://127.0.0.1:80` eksplisit; larangan `listen 127.0.0.1:80` di CI dicabut dan diganti uji perilaku permanen `bin/test-tunnel-vhost.sh` (berdampingan dengan situs spesifik dan wildcard, plus kontrol negatif yang membuktikan uji sensitif terhadap bug ini). Pengaman 403 non-loopback tetap sebagai lapis kedua; pada `127.0.0.1:80` permintaan dari internet bahkan tidak sampai ke vhost. Pelajaran: asumsi tentang konfigurasi server lain harus diuji dengan konfigurasi nyata sebelum dijadikan aturan.

## ADR-051 --- Role cadangan terbatas pada schema WAZAP di klaster PostgreSQL bersama (DITERIMA, 2026-11-21)

**Konteks:** `deploy/ops/setup-backup-role.sql` memberi role cadangan `pg_read_all_data` (peran bawaan SELURUH klaster) plus `BYPASSRLS`. Di server produksi yang berbagi klaster dengan aplikasi lain (`antrian_db`, `bimbel_kraksaan_db`), PostgreSQL mengizinkan `CONNECT` ke semua database secara bawaan (PUBLIC), sehingga bocornya kredensial cadangan WAZAP membuka data aplikasi lain.
**Keputusan:** di server bersama, role `wazap_backup` dibuat oleh `deploy/production/bin/backup-setup.sh` dengan: `LOGIN NOSUPERUSER BYPASSRLS`, `default_transaction_read_only=on`, `CONNECT` ke `wazap_prod`, dan HANYA `USAGE` + `SELECT` pada schema `gateway` (termasuk hak default untuk objek yang dibuat migrator di masa depan). Tanpa `pg_read_all_data`. `BYPASSRLS` tetap perlu agar `pg_dump` tidak disaring RLS. Kata sandi acak ke pgpass 0600. Pekerjaan harian `backup-run.sh`: `backup.sh` (pagar bawaan), salinan di luar host (rsync/ssh, rclone, atau path yang di-mount), dan PAGE Telegram bila gagal.
**Bukti (gladi pada PostgreSQL 18 sementara, data nyata dari API production):** pendekatan lama membaca tabel di database lain (`DATA-APLIKASI-LAIN`); role baru ditolak (`permission denied for table`, 0 hak di database lain) tetapi tetap membaca `wazap_prod` melewati RLS; menulis ditolak (read-only); cadangan 30 entri data untuk 30 tabel, salinan luar host ber-checksum cocok; kata sandi tidak bocor di keluaran; kata sandi salah menghasilkan kode 1 dan PAGE; `restore-drill.sh` lulus penuh (30 tabel, 33 baris sama persis, 78 kebijakan RLS, migrasi sampai 0020, `verify-db-roles.sh` pada hasil pemulihan). Latihan pemulihan juga menangkap kelalaian gladi sendiri (hak `schema_migrations` yang belum dicabut ikut terbawa), yang membuktikan latihan itu sensitif.
**Risiko tersisa:** RPO 24 jam (tanpa WAL/PITR); salinan luar host bergantung pada konfigurasi pengguna dan belum dipantau terpisah (hanya log dan PAGE saat gagal); rsync/rclone belum diuji ke tujuan nyata (hanya cabang path lokal yang diuji); kunci master di luar cadangan DB (sengaja) harus disimpan terpisah; `deploy/ops/setup-backup-role.sql` tetap ada untuk server khusus (satu klaster satu aplikasi).

**Tambahan ADR-051 (2026-11-21, drive terpisah):** pemilik menyediakan disk/NFS lain di server yang sama sebagai tujuan cadangan. `backup-setup.sh` menerima `BACKUP_MOUNTPOINT`; `backup-run.sh` membatalkan cadangan dan mengirim PAGE bila drive tidak ter-mount (agar tidak menumpuk di disk OS), BACKUP_DIR di luar titik mount, atau ruang bebas < `BACKUP_MIN_FREE_MB` (500); `preflight.sh` bagian 12 memeriksa drive (perangkat berbeda dari `/` dan data PostgreSQL, tulis, ruang, `nofail`/UUID di fstab). Terbukti pada klaster sementara dengan drive nyata (`/tmp` tmpfs): drive lepas tidak membuat folder di disk OS, tiga kegagalan menghasilkan kode 1 dan PAGE, cadangan di perangkat terpisah dicatat INFO, satu perangkat dengan OS dicatat PERINGATAN. **Batas yang diakui:** drive terpisah di server yang sama bukan salinan luar host.

## ADR-052 --- Cadangan server tidak diekspos di dashboard tenant (DITERIMA, 2026-11-21)

**Konteks:** pertanyaan pemilik: apakah cadangan perlu tampilan frontend dan role apa yang boleh mengaturnya.
**Keputusan:** TIDAK ada UI cadangan di dashboard tenant, dan tidak ada role tenant (OWNER/ADMIN/MEMBER/VIEWER) yang mengaturnya. Alasan: (1) cadangan mencakup SEMUA tenant dan membutuhkan role DB `BYPASSRLS`; isolasi tenant bertumpu pada proses aplikasi yang tidak pernah boleh punya kuasa itu (`DB_ROLE_CHECK=enforce` menolak start), jadi tombol cadangan di API berarti API memegang kuasa lintas tenant atau mengeksekusi skrip berhak tinggi; (2) OWNER/ADMIN hanyalah peran di dalam satu workspace, bukan operator platform; (3) pemulihan adalah prosedur operator (seluruh schema, `restore-drill.sh`), bukan per tenant. Pengaturan cadangan adalah tanggung jawab operator server (SSH, `backup.env`), dipantau lewat alarm Telegram (A19/A20, PAGE gagal). Padanan untuk pelanggan: **ekspor data workspace** (ADR-048, OWNER/ADMIN, sudah ada).
**Bila kelak dibutuhkan:** halaman status cadangan hanya-baca untuk "operator platform" harus berupa konsep peran baru di luar dashboard tenant (tidak dapat memakai OWNER/ADMIN), dengan keputusan terpisah tentang autentikasi operator. Pemulihan satu tenant dari cadangan belum didukung.


## ADR-053 --- Peran workspace disederhanakan: OWNER, MEMBER (agent), VIEWER (DITERIMA dan diimplementasikan, 2026-11-21)

**Status:** DITERIMA oleh pemilik produk (fase P0 dari `docs/02_BACKEND/PLATFORM_ADMIN_DESIGN.md`); backend diimplementasikan dan diuji, frontend belum (prompt: `docs/08_AI_AGENTS/FRONTEND_ROLES_AGENT_PROMPT.md`).
**Konteks:** pemilik menetapkan bahwa di dalam workspace hanya ada OWNER dan di bawahnya member/agent dan viewer; pengelolaan lintas workspace menjadi tugas peran terpisah, platform admin (P1). Peran `ADMIN` menanggung hampir semua hak OWNER (webhook, API key, alarm, ekspor, audit, tim) dan menambah permukaan wewenang yang harus diuji di setiap fitur baru.
**Keputusan:** peran `ADMIN` dihapus. Semua hak ADMIN menjadi milik **OWNER**; satu workspace boleh punya beberapa OWNER (perlindungan OWNER terakhir tetap). MEMBER (agent): sesi (baca/tulis), pesan (baca/kirim), pemakaian. VIEWER: baca. Nilai `ADMIN` ditolak `400` pada undangan, ubah peran, dan persetujuan permintaan bergabung. **Migrasi 0021:** baris `ADMIN` di `tenant_memberships`, `tenant_invitations`, `tenant_join_requests` dikonversi ke **MEMBER** (hak turun, bukan naik); CHECK diganti dengan nama eksplisit. Karena tabel FORCE RLS dan keanggotaan punya trigger penjaga (0016), migrasi (satu transaksi, dijalankan pemilik tabel) mematikan FORCE dan trigger HANYA untuk konversi lalu menghidupkannya kembali sebelum COMMIT. Riwayat audit (`actor_role`, `details`) tidak diubah (append-only).
**Bukti:** tes migrasi khusus (`migrator.test.ts`): baris ADMIN pada ketiga tabel menjadi MEMBER, OWNER tidak tersentuh, RLS ENABLE+FORCE kembali aktif pada ketiganya, trigger penjaga kembali aktif (`tgenabled='O'`), dan CHECK menolak ADMIN di ketiga tabel; semua tes peran ditulis ulang (OWNER kedua menggantikan ADMIN sebagai pengelola delegasi; MEMBER sebagai aktor tanpa wewenang; `ADMIN` 400); OpenAPI dibangkitkan ulang (`x-roles` tiga peran). Seluruh suite hijau.
**Temuan saat implementasi:** (1) tes `0018: penulis paralel` ternyata tidak deterministik (gagal 2 dari 6 pada commit bersih sebelum perubahan ini): asersinya menuntut semua panggilan paralel mengembalikan ID chat yang sama, padahal rancangan ADR-041 menggabung chat setelah-kejadian dan panggilan awal dapat mengembalikan chat yang kemudian digabung. Itu aman di produksi karena `inbox.ts` memanggil `resolve_chat` dan menyisipkan pesan dalam SATU transaksi dengan kunci advisory yang ditahan sampai commit. Asersi diganti dengan invarian yang dijamin (tepat satu chat tersisa, resolve berikutnya menunjuk chat itu); 0 gagal dari 30 pengulangan. (2) Frontend memakai ADMIN di ±15 tempat (gating tombol ekspor/alarm, pilihan peran, matriks izin, badge).
**Risiko tersisa:** perubahan memutus kompatibilitas klien yang mengirim `ADMIN` (aman hanya karena belum ada pengguna produksi); hak yang terkonsentrasi pada OWNER berarti staf yang perlu mengelola webhook/alarm/ekspor harus menjadi OWNER (bisa lebih dari satu); frontend harus diperbarui (sampai itu, UI yang menawarkan peran ADMIN akan menerima 400).

## ADR-054 --- Platform admin: pemilik platform mengelola semua workspace (DITERIMA; P1a autentikasi diimplementasikan, 2026-11-21)

**Status:** DITERIMA oleh pemilik produk (rancangan `docs/02_BACKEND/PLATFORM_ADMIN_DESIGN.md`; paket keamanan 3A disetujui). **P1a selesai**: akun, MFA, token, CLI, kebijakan RLS sempit, audit platform, rotasi kunci. P1b (kuota per workspace, daftar/detail, tangguhkan, default, audit, status cadangan) dan P1c (penegakan penangguhan menyeluruh) belum.
**Keputusan (P1a):** (1) akun platform admin = pengguna biasa yang didaftarkan HANYA lewat CLI di server (`npm run admin:platform-admin -- create|reset-mfa|revoke|list`); tidak ada API/UI untuk membuat/mencabut; (2) MFA TOTP wajib (RFC 6238, tanpa dependensi baru; vektor RFC 6238 dan RFC 4226 lulus), pendaftaran perangkat hanya lewat CLI yang mencetak kunci setup dan 10 kode pemulihan SEKALI; rahasia TOTP terenkripsi (AES-256-GCM, AAD `wazap:totp:v1|user`) dan ikut rotasi kunci master; (3) login dua langkah terpisah dari login pelanggan: `/platform/auth/login` (kata sandi) -> token MFA 5 menit -> `/platform/auth/verify` (TOTP atau kode pemulihan) -> token platform 30 menit TANPA refresh; kunci dan klaim `typ` berbeda dari token workspace sehingga tidak saling sah (diuji silang, termasuk API key); (4) semua kegagalan langkah 1 sama (tidak membocorkan siapa admin); (5) kode TOTP sekali pakai (langkah waktu terakhir disimpan), kesalahan beruntun mengunci akun admin itu (`PLATFORM_MAX_FAILED_OTP`, `PLATFORM_LOCK_MINUTES`) dan kode benar saat terkunci tetap ditolak; (6) `PLATFORM_ENABLED=false` membuat seluruh `/platform/*` 404 (saklar mati); (7) migrasi 0022: `platform_admins`, `platform_defaults` (dibaca konteks terautentikasi, ditulis platform), `platform_audit_logs` (append-only), `tenants.suspended_at`, `wa_sessions.resume_connect`, dan kebijakan platform SEMPIT (tenants UPDATE, tenant_settings, keanggotaan dan API key hanya SELECT, audit workspace hanya INSERT); (8) tes penjaga konteks platform diperbarui secara sadar: `modules/platform/` ditambahkan ke daftar modul istimewa.
**Bukti:** `totp.test.ts` (vektor RFC 6238/4226, jendela, anti-pengulangan, kode pemulihan) dan `platform-auth.test.ts` (12 tes): alur masuk dan jejak audit; galat seragam untuk pengguna tidak ada/kata sandi salah/bukan admin/admin nonaktif; penguncian dan pemulihan setelah kunci berakhir; pengulangan kode; kode pemulihan sekali pakai; pemisahan token (token workspace, API key sebagai Bearer dan X-API-Key, token MFA, kedaluwarsa, rusak, tanpa skema, dan arah sebaliknya di lima rute workspace); ganti kata sandi mematikan token platform dan token MFA lama; saklar mati; pembatas laju; pengelolaan akun setara CLI (duplikat, reset-mfa mematikan perangkat lama, cabut menutup akses, daftar tanpa rahasia, rahasia terenkripsi di DB); audit append-only (UPDATE/DELETE tidak berdampak, TRUNCATE ditolak) dan tabel platform tak terlihat dari konteks tenant/pengguna; **rotasi kunci master** (rahasia TOTP dienkripsi ulang, admin tetap dapat masuk setelah kunci lama dipensiunkan, dan kontrol bahwa tanpa rotasi mereka terkunci).
**Temuan saat implementasi:** (1) rancangan menyebut penangguhan "belum ditegakkan": koreksi, token akses, API key, login, refresh, pindah workspace, dan undangan SUDAH menolak tenant yang bukan ACTIVE; yang belum adalah sesi yang sedang berjalan, webhook, antrean, alarm, dan koneksi realtime (P1c). (2) kebijakan RLS `USING (true)` pada `platform_defaults` ditolak tes keamanan yang ada; dipersempit menjadi konteks terautentikasi. (3) `UPDATE/DELETE` yang ditolak oleh `USING` RLS tidak melempar galat (0 baris), jadi trigger append-only adalah lapis cadangan, bukan penolak utama.
**Risiko tersisa:** perluasan kuasa proses API (konteks platform) dibatasi modul tunggal terkurasi, tetapi RLS tidak dapat membatasi kolom: tes pemindai sumber (P1b) menjaga agar modul platform tidak pernah membaca kolom sensitif; di host yang sama dengan dashboard pelanggan, kelemahan XSS pada dashboard tetap satu origin dengan konsol (pagar utama: MFA, kode segar per perubahan; peningkatan: host admin dan Cloudflare Access); tanpa MFA dari penyedia luar, hilangnya perangkat TOTP dan kode pemulihan butuh `reset-mfa` oleh operator server.

**Tambahan ADR-054 (2026-11-21): P1b selesai** (kuota per workspace, daftar/detail, kuota bawaan, audit, status cadangan; penangguhan = P1c). Keputusan dan temuan: (13) kuota diatur HANYA oleh platform: `PATCH /tenant/settings` oleh OWNER selalu `403 QUOTA_MANAGED_BY_PLATFORM` (rute dipertahankan agar klien lama tidak mendapat 404; ditandai `deprecated`), respons GET memuat `editable:false`; layanan OWNER lama dihapus; `LIMIT_CEIL_*` kini batas mutlak bagi platform admin pula; (14) kuota awal workspace baru dari `platform_defaults` (bukan konstanta); (15) urutan perubahan: pra-periksa tanpa mengonsumsi kode TOTP -> konsumsi -> tulis dengan pemeriksaan ulang di dalam kunci (input salah tidak menghabiskan kode admin; nilai yang tidak berubah tidak divalidasi ulang sehingga formulir yang mengirim semua kolom tidak gagal bila env diturunkan); (16) jejak transparansi ke audit workspace tanpa alasan internal dan tanpa identitas operator; (17) batas privasi dijaga DUA lapis: kueri terkurasi dengan daftar putih kolom, dan tes pemindai sumber `platform-privacy.test.ts` (tabel di luar daftar putih atau kolom/tabel sensitif menggagalkan tes; terbukti menangkap pelanggaran yang disisipkan sengaja) ditambah tes isi respons dengan data nyata (isi pesan yang benar-benar tercermin di `wa_messages`, nama sesi, kunci API, token undangan, URL webhook tidak muncul di satu pun respons); (18) status cadangan hanya-baca: `backup-run.sh` menulis JSON atomik (kegagalan mempertahankan sukses terakhir) dan alasan kegagalan DISAMARKAN di sumber (log, berkas status, pesan Telegram) karena berasal dari keluaran skrip lain; tes ujung ke ujung bash -> API membuktikannya.
**Temuan saat implementasi:** (1) bug nyata tertangkap tes: parameter `$1` dipakai untuk kolom `uuid` dan `varchar` pada sisipan audit workspace (500; diperbaiki dengan cast eksplisit); (2) kebijakan baca undangan untuk platform ditambahkan karena pemakaian kuota anggota menghitung undangan tertunda (tanpa itu angka konsol berbeda dari yang dilihat OWNER); (3) operasi yang selalu galat (`PATCH /tenant/settings`) butuh penanda OpenAPI `deprecated`, dan penjaga struktur dokumen kini hanya mengizinkan itu untuk operasi bertanda, bukan melonggarkan secara umum; (4) sebuah tes lama (`review-fixes #1` dan `#8`, `settings`) bergantung pada OWNER mengubah kuota: perilakunya dipindahkan ke `platform-workspaces.test.ts` (rentang, di bawah pemakaian, batas mutlak env, audit) agar tidak hilang.

**Tambahan ADR-054 (2026-11-21): P1c selesai** (tangguhkan/aktifkan, penegakan menyeluruh). Keputusan dan temuan: (19) penangguhan ditegakkan di semua jalur dan DAPAT DIPULIHKAN: jalur HTTP/API key/refresh/login/pindah/undangan sudah mensyaratkan tenant ACTIVE (terbukti tes); realtime memutus lewat penyapu validasi ulang yang sudah ada (terbukti tes); sesi diputus lewat mesin transisi resmi dengan `resume_connect` (kredensial utuh, sesi yang sengaja diputus pengguna tidak ikut menyambung); klaim webhook, evaluator alarm, dan pengirim alarm hanya memproses tenant ACTIVE (ditahan, tidak dibuang); (20) `login` memberi `403 WORKSPACE_SUSPENDED` HANYA setelah kata sandi benar (kata sandi salah tetap seragam); (21) pra-periksa tanpa mengonsumsi kode TOTP juga berlaku untuk tangguhkan/aktifkan.
**Temuan saat implementasi:** (1) balapan nyata: diaktifkan kembali saat sesi masih DISCONNECTING membuat sesi berakhir DISCONNECTED dengan niat CONNECTED (macet sampai pengguna menyambung manual). Perbaikan awal (di `finalize`) ternyata tidak cukup: ada TIGA jalur yang menuntaskan DISCONNECTING (control-plane, session-runner, pemulihan engine) dan pada skenario ini engine menuntaskannya langsung. Diganti dengan satu langkah pemulihan umum di control-plane (`resumeWanted`: DISCONNECTED + desired CONNECTED -> PENDING_ASSIGNMENT), aman karena alur pengguna tidak pernah menghasilkan keadaan itu; terbukti tes balapan dengan engine sungguhan. (2) tes pertama saya memakai undangan ke surel lain sehingga `404` saat penangguhan tidak membuktikan apa-apa (undangan terikat surel); diperbaiki agar penerima sama dengan surel undangan. (3) kejadian yang terjadi SELAMA penangguhan dan masih dalam jendela lookback (`ALERTS_LOOKBACK_MINUTES`) dievaluasi setelah diaktifkan (satu pemberitahuan per kejadian, idempoten): perilaku sengaja dipertahankan dan diuji.
**Risiko tersisa:** pemutusan realtime bergantung pada interval penyapu (bawaan 30 dtk), bukan seketika; pesan antrean tertunda tetap PENDING dan dikirim saat sesi tersambung lagi (kebijakan kedaluwarsa antrean yang ada berlaku); pengiriman webhook yang tertahan lama dapat berstatus kedaluwarsa menurut kebijakan retensi/percobaan yang ada.

**Tambahan ADR-054 (2026-11-21): P2 selesai** (gerbang jaringan). (22) `/api/v1/platform/` dijawab 404 di host API (kebocoran kredensial platform admin tidak dapat dipakai dari host integrasi) dan hanya hidup di host dashboard dengan zona batas laju khusus (`wazap_platform`, 2 r/s, burst 10, tubuh maks 64 KB); berlaku untuk templat mode proxy (443) maupun tunnel; (23) Cloudflare Access dengan cakupan path (`/platform*`, `/api/v1/platform/*`) adalah lapis luar yang disarankan (konfigurasi, bukan kode); `verify.sh` menerima 401 (tanpa Access) atau 302/403 (Access aktif) dan menolak status lain. **Bukti:** `test-tunnel-vhost.sh` dengan Nginx sungguhan: permintaan konsol di host dashboard sampai ke upstream, di host API 404 JSON dan TIDAK sampai ke upstream, 20 dari 30 permintaan beruntun ke konsol 429 sedangkan 30 permintaan ke rute API biasa 0 yang 429 (zona tidak bocor ke rute lain); langkah CI memeriksa dua templat. **Risiko tersisa:** Cloudflare Access belum dikonfigurasi (tindakan pemilik); di host dashboard yang sama, kelemahan XSS pada dashboard pelanggan tetap satu origin dengan konsol (pagar utama: TOTP, kode segar per perubahan); pemisahan ke host admin tetap peningkatan yang disarankan.

**Tambahan ADR-054 (2026-11-21): P3 disiapkan (frontend dikerjakan agen)**: `docs/08_AI_AGENTS/FRONTEND_PLATFORM_AGENT_PROMPT.md` (bagian A peran tanpa ADMIN, B kuota hanya-baca + `WORKSPACE_SUSPENDED` + audit "Pemilik platform", C konsol platform) dan uji penerimaan `frontend-platform-client.test.ts` (tidak aktif bawaan; aktif dengan `FRONTEND_PLATFORM_CHECK=1`). Keputusan: (24) konsol adalah dunia terpisah di dalam SPA yang sama (rute `/platform/*`, layout, sesi, dan klien API sendiri; tanpa tautan dari menu pelanggan); token platform hanya di memori modul (tidak pernah storage/cookie/URL), `credentials:'omit'`, tanpa refresh; (25) kontrak klien `platformApi.ts` dikunci oleh tes perilaku terhadap skema strict backend (pola yang sama dengan klien ekspor). **Bukti uji penerimaan:** kontrol positif (klien referensi benar: 5 dari 5 lulus) dan kontrol negatif (13 mutasi sengaja: 12 tertangkap; 1 lolos adalah mutan setara karena klien referensi menyaring `undefined` di dua tempat). Frontend sendiri BELUM dikerjakan.
