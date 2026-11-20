# Serah-terima Backend untuk Frontend (kontrak API v1)

Tanggal: 2026-11-19 (diperbarui: Team, Usage, filter tanggal, switch-tenant, audit log, kuota tenant, undangan tanpa email). Status backend: Fase A--H2 selesai (REVIEW), 227 tes lulus.
Sumber kebenaran: `docs/02_BACKEND/API_CONTRACT.md` (daftar lengkap) + dokumen ini (peta migrasi dan
contoh respons NYATA dari backend yang berjalan). Bila ada selisih, kode backend dan API_CONTRACT menang;
laporkan selisihnya, jangan menebak (`DOCUMENTATION_RULES.md`: jangan mengarang endpoint/field).

## 0. Mengapa login frontend sekarang gagal, dan apa yang harus diubah

Frontend (`frontend/src/services/api.ts`) masih memakai kontrak prototipe. Bukti (dipanggil ke backend):
`POST /api/v1/auth/login {"username","password"}` -> `400 VALIDATION_ERROR` ("email wajib", "key username tidak dikenal").

Prioritas perbaikan:

1.  **Login/Register/Refresh** (bagian 2). Body memakai **email**, respons ada di `data.access_token`.
2.  **Hapus fallback mock di `register`**: saat gagal ia mengembalikan token palsu `mock-reg-token-...`, sehingga
    pendaftaran tampak sukses lalu semua halaman 401. Galat register harus ditampilkan apa adanya.
3.  **Penanganan 401 + refresh token** (bagian 2.3): access token hanya hidup 15 menit.
4.  **Peta endpoint dan body** (bagian 3): nama field backend adalah `snake_case`; endpoint API key, riwayat pesan,
    dan test webhook berbeda.
5.  **Team, Usage, Audit log, dan Pengaturan/kuota tenant kini TERSEDIA** (bagian 4.6--4.9): hapus mock `getTeamMembers`/`getUsageSummary` dan pakai endpoint nyata. Daftar yang masih belum ada: bagian 6.
6.  Status sesi/pesan lebih banyak daripada yang diketahui UI sekarang (bagian 4).

## 1. Konvensi umum

-   **Base URL:** selalu path relatif `/api/v1/...` lewat proxy Vite (`/api` -> `127.0.0.1:3000`). Jangan memanggil
    `127.0.0.1:3000` langsung dari browser: CORS backend tertutup (`CORS_ORIGINS` kosong), proxy same-origin yang membuat cookie refresh bekerja.
-   **Envelope sukses:** `{ "success": true, "data": ..., "meta"?: {...} }`. Daftar: `data` = array, `meta` = `{page, page_size, total}`.
    `GET /messages` dan `GET /chats`: bila `meta.total_capped === true`, tampilkan "10.000+" (total dibatasi 10000).
-   **Envelope galat:** `{ "success": false, "error": { "code", "message", "details": [] }, "request_id" }`.
    Tampilkan `error.message` ke pengguna; `details[]` (`{path, message}`) untuk galat per-field (`VALIDATION_ERROR`); simpan `request_id` untuk laporan.
    Klien sekarang membaca `body.error || body.message` --- itu salah: `error` adalah objek, pakai `body.error.message`.
-   **Paginasi:** `?page=1&page_size=20` (maks 100). Jangan memuat semua data.
-   **Waktu:** string ISO-8601 UTC. **Nama field:** `snake_case` (jangan kirim `sessionName`, `sessionId`; kirim `session_name`, `session_id`).
-   **Kode galat penting:** `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `INVALID_CREDENTIALS` 401, `FORBIDDEN` 403,
    `NO_ACTIVE_TENANT` 403, `NOT_FOUND` 404 (juga untuk sumber milik tenant lain), `EMAIL_TAKEN` 409, `QUOTA_EXCEEDED` 409,
    `INVALID_STATE` 409, `SESSION_UNAVAILABLE` 409, `QR_NOT_AVAILABLE` 409, `CONFIRMATION_REQUIRED` 409, `CONTENT_PURGED` 409,
    `IDEMPOTENCY_CONFLICT` 422, `INVALID_WEBHOOK_URL` 422, `INVALID_MEDIA_URL` 422, `DUPLICATE_ITEM` 422,
    `INVALID_RANGE` 400, `LIMIT_BELOW_USAGE` 409, `CANNOT_MODIFY_SELF` 403, `LAST_OWNER` 409, `ALREADY_MEMBER` 409, `INVITATION_EXISTS` 409, `INVALID_INVITATION` 404,
    `QUEUE_FULL` 429, `RATE_LIMITED` 429 (+ header `Retry-After` detik), `NOT_CONFIGURED` 503, `INTERNAL_ERROR` 500.
-   **Rate limit:** 600 permintaan/menit per IP dan 1200/menit per tenant. Saat `429` hormati `Retry-After`; jangan retry buta.
    Khusus auth: login 20/5 menit per IP dan 8/15 menit per email; register 5/jam per IP (penting untuk tes otomatis).

## 2. Autentikasi

### 2.1 Kontrak

```
POST /api/v1/auth/register   { "email", "password" (>=10 karakter), "tenant_name" (2-100) }   -> 201
POST /api/v1/auth/login      { "email", "password", "tenant_id"? }                            -> 200
POST /api/v1/auth/refresh    (tanpa body; memakai cookie)                                      -> 200 (bentuk sama dengan login)
POST /api/v1/auth/logout     (tanpa body; memakai cookie)                                      -> 204
GET  /api/v1/auth/me         (Bearer)                                                          -> 200
```

Body strict: field yang tidak dikenal (`username`, `tenant_id` pada register, dll.) ditolak 400.

Respons login/register/refresh (nyata; token dipersingkat):

```json
{ "success": true,
  "data": { "access_token": "<jwt-like>", "token_type": "Bearer", "expires_in": 900,
            "user":   { "id": "ab90d7d2-...", "email": "owner@contoh.id" },
            "tenant": { "id": "70d536dd-...", "name": "Toko Contoh", "slug": "toko-contoh-6c544351" },
            "role": "OWNER" } }
```

Header respons juga membawa `Set-Cookie: wzp_rt=<refresh_token>; Max-Age=2592000; Path=/api/v1/auth; HttpOnly; SameSite=Strict`
(`Secure` di production). Refresh token **tidak pernah ada di body** dan tidak terbaca JavaScript.

Galat login: `401 INVALID_CREDENTIALS` ("Email atau password salah" --- sengaja tidak membedakan email/password),
`403 NO_ACTIVE_TENANT`, `429 RATE_LIMITED`. Galat register: `409 EMAIL_TAKEN`, `400` (password pendek), `429`.

`GET /auth/me`:

```json
{ "success": true, "data": { "user": { "id": "...", "email": "owner@contoh.id", "created_at": "..." },
  "active_tenant_id": "70d536dd-...", "role": "OWNER",
  "memberships": [ { "tenant_id": "...", "name": "Toko Contoh", "slug": "...", "role": "OWNER", "status": "ACTIVE" } ] } }
```

### 2.2 Penyimpanan token (wajib)

-   `access_token`: **di memori** (variabel modul / state), bukan `localStorage`. (Kode sekarang memakai `sessionStorage`; ganti ke memori
    karena refresh lewat cookie membuat penyimpanan permanen tidak perlu.)
-   Refresh token: hanya cookie HttpOnly --- semua `fetch` ke `/api/v1/auth/*` harus memakai `credentials: 'include'`.
-   Saat aplikasi dimuat: panggil `POST /auth/refresh`; bila 200 simpan `access_token` dan tampilkan app, bila 401 tampilkan halaman login.

### 2.3 Penanganan 401 (access token kedaluwarsa)

Pada respons `401` dari endpoint non-auth: panggil `/auth/refresh` **satu kali** (single-flight: banyak permintaan yang gagal bersamaan menunggu
satu refresh yang sama), ulangi permintaan asli satu kali dengan token baru; bila refresh gagal (401 `INVALID_REFRESH_TOKEN`) bersihkan state
dan arahkan ke login. Refresh token **dirotasi tiap refresh** dan pemakaian ulang token lama mencabut seluruh sesi login, jadi jangan menembak
refresh paralel. Jangan me-refresh untuk `/auth/login`, `/auth/register`, `/auth/refresh` itu sendiri.

### 2.4 Multi-tenant dan peran

-   Login tanpa `tenant_id` memilih workspace tertua pengguna. **Pindah workspace:** `POST /auth/switch-tenant {tenant_id}` (tanpa kata sandi; `tenant_id` dari
    `memberships` pada `/auth/me`) -> respons sama dengan login + cookie refresh baru (family lama dicabut). Bukan anggota/ditangguhkan = `404`. Refresh mempertahankan
    tenant yang sedang aktif. Setelah pindah, muat ulang SEMUA data (query cache dikosongkan) dan sambung ulang Socket.IO dengan token baru.
-   Peran: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`. Server memverifikasi ulang peran pada setiap permintaan (perubahan berlaku segera). Sembunyikan/nonaktifkan
    kontrol sesuai peran, tetapi tetap tangani `403 FORBIDDEN`:

| Aksi | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| Lihat sesi, pesan, chat, kontak, daftar API key | ya | ya | ya | ya |
| Buat/connect/disconnect/reconnect/hapus sesi, ambil QR | ya | ya | ya | tidak |
| Kirim/batalkan/kirim ulang pesan, media, bulk | ya | ya | ya | tidak |
| Kelola webhook (semua endpoint `/webhooks*`) | ya | ya | tidak | tidak |
| Buat/cabut API key | ya | ya | tidak | tidak |
| Lihat anggota & undangan; undang; ubah peran/status; hapus anggota (`/team/*`) | ya | ya (hanya MEMBER/VIEWER) | tidak | tidak |
| Keluar dari workspace sendiri (`DELETE /team/members/{id-sendiri}`) | ya (kecuali OWNER terakhir) | ya | ya | ya |
| Terima undangan (`POST /team/invitations/accept`), pindah workspace | ya | ya | ya | ya |
| Baca audit log (`GET /audit-logs`) | ya | ya | tidak | tidak |
| Lihat kuota (`GET /tenant/settings`) | ya | ya | ya | ya |
| Ubah kuota (`PATCH /tenant/settings`) | ya | tidak | tidak | tidak |
| Lihat metrik penggunaan (`/usage/*`) | ya | ya | ya | ya |

-   API key (`gwk_...`) untuk integrasi pihak ketiga, **bukan** untuk dashboard: tidak bisa memanggil `/auth/me` atau mengelola API key.

## 3. Peta migrasi per method `apiClient`

| `apiClient` sekarang | Backend yang benar |
|---|---|
| `login(username, password)` -> `{token, expiresIn}` | `POST /auth/login {email, password}` -> `data.access_token`, `data.expires_in` |
| `register(email, password)` (+ fallback mock) | `POST /auth/register {email, password, tenant_name}`; **hapus fallback mock**; tambah isian "Nama workspace" |
| `health()` -> `/health`, membaca `{status, database}` | `/health` adalah alias `GET /health/ready`; bentuknya `{status:"READY", checks:{database:"UP", shutting_down:false}, timestamp}` (field `database` di level atas **tidak ada**; baca `checks.database`). Tidak berstatus 200 saat tidak siap: 503. `/health/live` untuk liveness |
| `getSessions()` -> `res.data` | `GET /sessions` -> `data[]` + `meta` |
| `createSession(sessionName)` body `{sessionName}` | `POST /sessions {session_name (2-50: huruf/angka/spasi/. _ -), auto_connect?: true}` -> 201 sesi |
| `getSessionQr(id)` | `GET /sessions/:id/qr` -> `{qr, qr_data_url, expires_at}` (hanya OWNER/ADMIN/MEMBER; pakai **hanya** `qr_data_url`) |
| `deleteSession(id)` | `DELETE /sessions/:id` -> **202** (asinkron; sesi hilang dari daftar setelah dibersihkan, lalu 404) |
| (belum ada) | `POST /sessions/:id/connect`, `/disconnect`, `/reconnect` -> 202; `GET /sessions/:id/status`; `GET /sessions/:id/events` |
| `sendMessage(sessionId, to, text)` body `{sessionId,to,text}` | `POST /messages/send {session_id, to, type:"text", message, priority?, scheduled_at?}` + header `Idempotency-Key` -> **202** `{job_id, status:"PENDING"}` |
| `getMessageHistory(sessionId?)` -> `/messages/history` | `GET /messages?page&page_size&status=&session_id=&from=&to=` (riwayat antrean/kirim; `from` inklusif, `to` eksklusif, ISO dengan offset, mis. `2026-11-19T00:00:00+07:00`) dan `GET /chats/:chatId/messages` (percakapan IN/OUT) |
| `getWebhooks()` | `GET /webhooks` -> `data[]` + `meta` |
| `createWebhook(url, events, secret?)` | `POST /webhooks {url (https), description?, events: ["*"] atau daftar}` --- **tidak ada parameter secret** (server membuatnya; field `secret` ditolak 400) |
| `deleteWebhook(id)` | `DELETE /webhooks/:id` |
| `testWebhookPing()` -> `/webhooks/test` | `POST /webhooks/:id/test` -> 202 (butuh id endpoint) |
| `getApiKeys()` -> `/auth/api-keys` | `GET /api-keys` |
| `createApiKey(name, scopes=['*'])` -> `/auth/api-keys` | `POST /api-keys {name, scopes: [...], expires_at?}`; scope `'*'` **ditolak** (lihat daftar scope di 4.5) |
| `revokeApiKey(id)` -> `/auth/api-keys/:id` | `DELETE /api-keys/:id` |
| `getContacts()` | `GET /contacts` (nyata, bukan mock lagi) |
| `getChats()` | `GET /chats` (nyata) + `GET /chats/:id/messages` |
| `getUsageSummary()` (mock) | `GET /usage/summary?from&to` (bagian 4.7); deret grafik: `GET /usage/messages`; per sesi: `GET /usage/sessions` |
| `getTeamMembers()` (mock) | `GET /team/members` (bagian 4.6); undang/ubah/hapus: `/team/invitations`, `PATCH|DELETE /team/members/:userId` |
| (belum ada) pindah workspace | `POST /auth/switch-tenant {tenant_id}` (bagian 2.4) |
| (belum ada) pengaturan/kuota tenant | `GET /tenant/settings`, `PATCH /tenant/settings` (bagian 4.9) |
| (belum ada) audit log | `GET /audit-logs` (bagian 4.8) |

## 4. Referensi resource dengan contoh nyata

### 4.1 Sesi WhatsApp

Objek sesi (`GET /sessions`, `POST /sessions`):

```json
{ "id": "e65a9e8d-...", "session_name": "utama", "phone_number": null, "status": "PENDING_ASSIGNMENT",
  "status_reason": "create_auto_connect", "desired_state": "CONNECTED", "adapter": "BAILEYS",
  "created_at": "...", "updated_at": "..." }
```

`GET /sessions/:id/status` -> `{id, status, status_reason, desired_state, updated_at}` (ringan, untuk polling).
Filter daftar: `?status=CONNECTED`. Kuota: maks 3 sesi per tenant (`409 QUOTA_EXCEEDED`); nama ganda `409 SESSION_NAME_TAKEN`; nomor sudah dipakai sesi lain => status `ERROR` + `duplicate_phone_number`.

**13 status** (jangan memakai enum 3-nilai yang sekarang di `api.ts`):

| Status | Arti untuk pengguna | Aksi yang masuk akal |
|---|---|---|
| `CREATED`, `PENDING_ASSIGNMENT`, `INITIALIZING` | menyiapkan / menunggu engine | tunggu (spinner) |
| `QR_REQUIRED` | menunggu pemindaian QR | tampilkan QR (4.1.1) |
| `CONNECTING`, `RECONNECTING` | menyambung / sambung ulang otomatis | tunggu |
| `CONNECTED` | tersambung (`phone_number` terisi) | kirim pesan, disconnect, reconnect |
| `DISCONNECTING` | sedang diputus | tunggu |
| `DISCONNECTED` | diputus pengguna (kredensial tetap) | **Connect** |
| `LOGGED_OUT` | perangkat di-unlink dari HP; kredensial dihapus | **Connect** lalu pindai QR lagi |
| `ERROR` | gagal; lihat `status_reason` (`qr_timeout`, `duplicate_phone_number`, `max_reconnect_attempts`, `connection_replaced`, `bad_session`, `auth_state_unavailable`) | **Connect** untuk mencoba lagi |
| `DELETING`, `DELETED` | sedang/telah dihapus | `DELETED` => 404 |

Tombol dinonaktifkan menurut status, tetapi backend yang memutuskan: aksi yang tidak sah dijawab `409 INVALID_STATE` (tampilkan pesannya).
Kirim pesan hanya diterima untuk sesi `PENDING_ASSIGNMENT/INITIALIZING/CONNECTING/CONNECTED/RECONNECTING` (selain itu `409 SESSION_UNAVAILABLE`).

#### 4.1.1 Alur QR (kunci)

1.  `POST /sessions` (atau `connect`) lalu poll `GET /sessions/:id/status` tiap 2--3 detik (atau dengarkan Socket.IO, bagian 5).
2.  Saat `QR_REQUIRED`: `GET /sessions/:id/qr` -> `{qr, qr_data_url, expires_at}`. Render **`qr_data_url`** di `<img>`. Jika `409 QR_NOT_AVAILABLE`
    ("belum tersedia"), coba lagi sesaat. QR berotasi sekitar tiap 20 detik dan kedaluwarsa `expires_at`: ambil ulang saat rotasi/kedaluwarsa.
3.  Berhenti dan **bersihkan QR dari memori/DOM** saat `CONNECTED`, `ERROR`, `LOGGED_OUT`, modal ditutup, atau komponen di-unmount.
4.  **Jangan** menyimpan QR di `localStorage`/`sessionStorage`/log, jangan pakai nilai `qr` mentah (rahasia login WhatsApp), jangan di-cache.

### 4.2 Pesan

Kirim teks: `POST /messages/send` dengan **header `Idempotency-Key`** (buat `crypto.randomUUID()` per pesan logis; pakai ulang kunci yang sama bila
mengulang karena timeout jaringan, jangan kunci baru). Respons `202 {"job_id","status":"PENDING"}` --- pengiriman asinkron; pantau
`GET /messages/:job_id/status` atau Socket.IO.

Nomor `to`: format internasional 8--15 digit tanpa `0` di depan (contoh `6281234567890`); `+`, spasi, `-`, titik, kurung diabaikan. **Tidak ada kode negara
implisit**: bila pengguna mengetik `0812...`, sarankan ubah ke `62812...` (minta konfirmasi), jangan mengubah diam-diam. Panjang pesan maks 4096.

Objek pesan (`GET /messages`, detail memuat `attempt_history`):

```json
{ "id": "b06f8050-...", "session_id": "e65a9e8d-...", "to": "6281234567890", "type": "text", "message": "Halo!", "media": null,
  "status": "PENDING", "priority": 5, "attempts": 0, "max_attempts": 3, "provider_message_id": null, "last_error_code": null,
  "scheduled_at": "...", "completed_at": null, "content_purged": false, "created_at": "...", "updated_at": "..." }
```

`GET /messages/:id/status` -> `{id, status, attempts, last_error_code, provider_message_id, updated_at}`.

| `status` | Tampilkan sebagai | Catatan |
|---|---|---|
| `PENDING` | Antre | termasuk menunggu jadwal/retry; boleh **Batalkan** (`POST /messages/:id/cancel`) |
| `PROCESSING` | Mengirim | tidak bisa dibatalkan |
| `SENT` | **Terkirim ke WhatsApp** | BUKAN "diterima/dibaca" |
| `DELIVERED` | Diterima penerima | dari receipt WhatsApp |
| `READ` | Dibaca | hanya bila penerima mengaktifkan read receipt |
| `FAILED` | Gagal | lihat `last_error_code` (`RECIPIENT_NOT_ON_WHATSAPP`, `MAX_ATTEMPTS_REACHED`, `EXPIRED`, `MEDIA_*`) |
| `UNKNOWN`, `RECONCILIATION_REQUIRED` | Hasil tidak pasti | MUNGKIN sudah terkirim; tawarkan "Kirim ulang" dengan peringatan duplikat -> `POST /messages/:id/retry {"confirm_duplicate_risk": true}` |
| `CANCELLED` | Dibatalkan | `CANCELLED_BY_CLIENT` / `SESSION_DELETED` |

`retry` dari `FAILED` tidak perlu konfirmasi. Setelah 30 hari isi pesan dihapus oleh kebijakan retensi: `message` = `null`, `content_purged: true`, nomor
`to` dimasker (`*********7890`), dan retry => `409 CONTENT_PURGED`. Tampilkan sebagai "Isi dihapus sesuai kebijakan retensi".

Fitur lain (opsional untuk UI): `POST /messages/send-media` (`type: image|video|audio|document`, `url` https publik, `caption?`, `filename?` untuk dokumen),
`POST /messages/bulk` (`messages: [{to, message}]` maks 100, atomik, `Idempotency-Key` per batch). Detail di API_CONTRACT.

### 4.3 Chat dan kontak (baca saja)

`GET /chats` -> `{id, session_id, jid, phone, name, last_message_at, created_at}` (urut aktivitas terbaru; filter `?session_id=`; tidak ada
pratinjau pesan terakhir --- ambil dari `/chats/:id/messages?page_size=1` bila perlu).
`GET /chats/:id/messages` (terbaru dulu) -> `{id, direction: "IN"|"OUT", type, text, text_purged, status, provider_message_id, job_id, occurred_at}`;
`meta.chat` memuat chat-nya. Status `RECEIVED` (masuk) / `SENT|DELIVERED|READ` (keluar). Pesan media masuk hanya bertipe + caption (`text`); media tidak diunduh.
`GET /contacts` -> `{phone, name, last_message_at, chats}`. `phone` bisa `null` pada chat berbasis `@lid` (privasi WhatsApp). Hanya chat 1:1 (tanpa grup).

### 4.4 Webhook (OWNER/ADMIN)

`POST /webhooks {url, events}` -> 201 dengan `secret` (**hanya sekali**; header `Cache-Control: no-store`):

```json
{ "id": "13ef840c-...", "url": "https://contoh.id/hook", "description": null, "events": ["message.sent","message.incoming"],
  "secret_hint": "V6ig", "active": true, "consecutive_failures": 0, "disabled_at": null, "disabled_reason": null,
  "created_at": "...", "updated_at": "...", "secret": "whsec_..." }
```

UI: tampilkan `secret` di dialog "Salin sekarang --- tidak akan ditampilkan lagi", jangan simpan di storage, tampilkan hanya `secret_hint` sesudahnya.
`events` valid: `*`, `session.status`, `message.sent|delivered|read|failed|unknown|cancelled|incoming`. URL harus `https` ke alamat publik
(`422 INVALID_WEBHOOK_URL`). Maks 10 endpoint. `PATCH /webhooks/:id {url?, description?, events?, active?}`.
Endpoint dinonaktifkan otomatis setelah 10 delivery gagal berturut-turut: tampilkan `disabled_reason: "AUTO_CONSECUTIVE_FAILURES"` dan tombol
aktifkan (`PATCH {"active": true}`). Lainnya: `POST /webhooks/:id/rotate-secret`, `POST /webhooks/:id/test` (202),
`GET /webhooks/:id/deliveries?status=PENDING|DELIVERED|DEAD`, `POST /webhooks/:id/deliveries/:deliveryId/replay`. Format payload/tanda tangan:
`WEBHOOK_SPECIFICATION.md` (untuk penerima webhook, bukan untuk dashboard).

### 4.5 API key (daftar: semua peran; buat/cabut: OWNER/ADMIN)

`POST /api-keys {name (2-100), scopes: [...], expires_at?}` -> 201 dengan **`key` hanya sekali**:

```json
{ "id": "062807f0-...", "name": "integrasi", "key_prefix": "gwk_HWBratRM", "scopes": ["messages:send","messages:read"],
  "expires_at": null, "created_at": "...", "key": "gwk_..." }
```

Scope valid (tidak ada `*`): `sessions:read`, `sessions:write`, `messages:send`, `messages:read`, `contacts:read`, `webhooks:manage`, `usage:read`.
`GET /api-keys` -> `{id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at, created_by}` (tanpa `key`); `created_by` = `{user_id, email}` pembuat (untuk offboarding manual),
`null` bila dibuat lewat API key atau pembuatnya sudah dihapus (basis data mengosongkannya; key yang dibuatnya sudah dicabut). Maks 20 key (`409 QUOTA_EXCEEDED`).
Tampilkan `key` di dialog "salin sekarang", jangan simpan.

### 4.6 Tim (anggota dan undangan) --- hanya pengguna dashboard, OWNER/ADMIN kecuali disebut lain

**Daftar anggota** `GET /team/members?page&page_size` (urut peran: OWNER, ADMIN, MEMBER, VIEWER):

```json
{ "success": true, "data": [
  { "user_id": "72c6c682-...", "email": "owner@contoh.id", "role": "OWNER",  "status": "ACTIVE", "joined_at": "...", "is_me": true },
  { "user_id": "14c240b8-...", "email": "staf@contoh.id",  "role": "MEMBER", "status": "ACTIVE", "joined_at": "...", "is_me": false } ],
  "meta": { "page": 1, "page_size": 20, "total": 2 } }
```

`email` bisa `null` untuk keanggotaan lama yang belum terisi (tampilkan "-"). Gunakan `is_me` untuk menandai/menonaktifkan aksi pada diri sendiri.

**Ubah peran/status** `PATCH /team/members/:userId` body strict `{role?: OWNER|ADMIN|MEMBER|VIEWER, status?: ACTIVE|SUSPENDED}` (minimal satu) -> objek anggota.
`DELETE /team/members/:userId` -> `{user_id, removed: true}` (404 bila sudah tidak ada). Menghapus **diri sendiri** = keluar dari workspace (boleh untuk semua peran).

Aturan izin (server menegakkan; UI menyembunyikan kontrol yang pasti ditolak):

| Aktor | Boleh mengelola (ubah peran/status, hapus) | Boleh memberi peran |
|---|---|---|
| OWNER | semua anggota | semua peran (termasuk OWNER) |
| ADMIN | hanya anggota ber-peran MEMBER/VIEWER | hanya MEMBER/VIEWER |
| MEMBER, VIEWER | tidak ada (hanya keluar sendiri) | -- |

Galat: `403 CANNOT_MODIFY_SELF` (ubah peran/status akun sendiri; untuk keluar pakai `DELETE`), `403 FORBIDDEN` (di luar wewenang), `409 LAST_OWNER`
("Tenant harus memiliki minimal satu OWNER aktif": tidak bisa menurunkan/menangguhkan/menghapus/keluar sebagai OWNER terakhir; promosikan OWNER lain dulu),
`404 NOT_FOUND`. Anggota `SUSPENDED` atau yang dihapus **kehilangan akses seketika** (token yang sama menjadi `401`); sampaikan ini di dialog konfirmasi.
**Efek samping yang harus diberitahukan di dialog konfirmasi:** (1) **dihapus/keluar** => API key yang dibuat anggota itu ikut DICABUT seketika; ditangguhkan TIDAK mencabut key (cabut manual
lewat daftar API key, yang menampilkan pembuatnya); (2) **dihapus, ditangguhkan, atau diturunkan perannya** => undangan tertunda yang ia buat otomatis DICABUT (status `REVOKED`; mengaktifkan ulang/menaikkan peran
tidak menghidupkannya kembali, OWNER membuat undangan baru bila perlu). Keduanya tercatat di audit log (`invitation.revoked` dengan `details.reason` = `inviter_suspended|inviter_demoted|inviter_removed|inviter_left`;
`member.removed|left` dengan `details.revoked_api_keys` berisi id key dan `details.revoked_invitations` berisi jumlah).

**Undangan** (tanpa email otomatis: server hanya membuat token, **pengundang menyampaikannya sendiri**, mis. menyalin tautan):

-   `POST /team/invitations {email, role="MEMBER"}` -> `201` dengan **`token` hanya sekali** (header `Cache-Control: no-store`):
    `{ "id", "email", "role", "status": "PENDING", "expires_at", "created_at", "accepted_at": null, "token": "inv_..." }`. Berlaku 7 hari. Tampilkan dialog
    "Salin tautan undangan --- tidak akan ditampilkan lagi"; **jangan simpan token** di storage/log. Respons juga memuat **`invite_url`**
    (`<DASHBOARD_BASE_URL>/invite#token=...`; bernilai `null` bila server belum dikonfigurasi: bangun sendiri dari `window.location.origin + '/invite#token=' + token`).
    Token sengaja di **fragmen** (`#`), bukan query: browser tidak mengirim fragmen ke server, jadi token tidak masuk access log Nginx maupun header `Referer`.
    Halaman penerima (`/invite`) dibuat frontend dan **wajib**: (1) baca token dari `location.hash` (`new URLSearchParams(location.hash.slice(1)).get('token')`),
    (2) **segera hapus dari address bar** dengan `history.replaceState(null, '', location.pathname)` sebelum memuat apa pun dari pihak ketiga, (3) simpan token hanya di memori
    selama proses login/daftar lalu terima undangan, (4) jangan menaruhnya di query string, localStorage, log, atau analytics. Pengguna yang belum login diarahkan ke login/daftar
    **tanpa kehilangan token** (simpan di state memori router, bukan di URL/storage); bila halaman dimuat ulang sebelum diterima, tautan harus dibuka lagi.
-   **Tanpa email (keputusan produk).** Server tidak mengirim email; sediakan beberapa cara membagikan `invite_url` di dialog yang sama: (1) tombol **Salin tautan**,
    (2) **QR** dari tautan (dibuat di klien), (3) **Kirim lewat WhatsApp**: buka `https://wa.me/?text=<teks undangan + tautan, di-encode>` pada perangkat pengundang, atau (bila ada sesi
    `CONNECTED` dan nomor penerima) kirim langsung lewat `POST /messages/send` dari sesi tenant dengan teks undangan berisi tautan. Jangan menaruh token di log/analytics.
-   `POST /team/invitations/:id/reissue` -> `200` dengan `token` + `invite_url` BARU (sekali tampil); token lama langsung hangus dan masa berlaku dihitung ulang. Tampilkan sebagai
    "Buat ulang tautan" pada undangan PENDING/EXPIRED (untuk tautan yang hilang atau kedaluwarsa); `409 INVALID_STATE` bila sudah diterima/dicabut; ADMIN hanya untuk undangan MEMBER/VIEWER.
-   `GET /team/invitations?status=PENDING|ACCEPTED|REVOKED|EXPIRED` (tanpa filter = semua; `EXPIRED` dihitung server dari `expires_at`). Tanpa `token`.
-   `DELETE /team/invitations/:id` -> mencabut undangan PENDING (idempoten; `409 INVALID_STATE` bila sudah diterima).
-   Galat undang: `409 INVITATION_EXISTS` (masih ada undangan tertunda untuk email itu: cabut dulu), `409 ALREADY_MEMBER`, `409 QUOTA_EXCEEDED`
    (anggota + undangan tertunda <= 10 per workspace), `403` (ADMIN tidak boleh mengundang ADMIN/OWNER).

**Menerima undangan** (halaman penerima): pengguna harus **login dengan email yang sama** dengan yang diundang (belum punya akun: `POST /auth/register` dulu;
ia mendapat workspace pribadi sendiri, itu normal). Lalu `POST /team/invitations/accept {token}` ->
`{ "tenant": {id,name,slug}, "role": "MEMBER" }`, kemudian panggil `POST /auth/switch-tenant {tenant_id}` untuk masuk ke workspace baru.
Semua kegagalan token (salah, kedaluwarsa, dicabut, sudah dipakai, email berbeda) dijawab **sama**: `404 INVALID_INVITATION`
("Undangan tidak valid atau sudah tidak berlaku") --- jangan membedakan penyebabnya di UI. `409 ALREADY_MEMBER` bila sudah anggota. Dibatasi 10 percobaan/15 menit
per pengguna (`429`).

### 4.7 Penggunaan (usage) --- semua peran; API key butuh scope `usage:read`

Semantik (penting untuk label UI): pesan **keluar** dihitung menurut waktu **diantrekan** (`created_at`) dan status **saat ini**; pesan **masuk** menurut waktu
**diterima** gateway. Rentang `[from, to)`: `from` inklusif, `to` eksklusif, ISO-8601 dengan offset. Default tanpa parameter: **24 jam terakhir**.
Maksimal 92 hari (`400 INVALID_RANGE`). Data lebih tua dari masa retensi (180 hari) sudah dihapus. Untuk "hari ini" kirim awal hari **lokal** pengguna, mis.
`from=2026-11-19T00:00:00%2B07:00&to=<sekarang>` (`+` pada query WAJIB di-encode `%2B`).

`GET /usage/summary?from&to`:

```json
{ "success": true, "data": {
  "period":   { "from": "2026-11-09T17:00:00.000Z", "to": "2026-11-10T17:00:00.000Z" },
  "sessions": { "total": 2, "connected": 1, "by_status": { "CONNECTED": 1, "DISCONNECTED": 1 } },
  "messages": { "total": 7, "by_status": { "SENT": 1, "DELIVERED": 1, "READ": 1, "FAILED": 1, "PENDING": 1, "UNKNOWN": 1, "CANCELLED": 1 },
                "sent": 3, "delivered": 2, "read": 1, "failed": 1, "unknown": 1, "cancelled": 1 },
  "incoming": { "total": 3 },
  "queue":    { "pending": 1, "processing": 0 },
  "quotas":   { "sessions": {"used": 2, "max": 3}, "api_keys": {"used": 1, "max": 20}, "members": {"used": 1, "max": 10},
                "webhooks": {"used": 0, "max": 10}, "messages_per_minute": 60 } } }
```

`sessions` dan `queue` adalah **snapshot saat ini** (bukan untuk rentang). `sent` = SENT+DELIVERED+READ, `delivered` = DELIVERED+READ, `unknown` = UNKNOWN+RECONCILIATION_REQUIRED.
`by_status` hanya memuat status yang punya data (bisa `{}`). `quotas.members.used` menghitung anggota + undangan tertunda.

`GET /usage/messages?from&to&group_by=hour|day&tz=Asia/Jakarta&session_id=` (deret waktu untuk grafik; `tz` = **nama IANA** seperti `Asia/Jakarta` (ambil dari `Intl.DateTimeFormat().resolvedOptions().timeZone`), default `UTC`; **bentuk offset seperti `+07:00`/`UTC+7` ditolak `400`** karena tanda offset ditafsirkan terbalik oleh basis data; `group_by=hour` maks 7 hari):

```json
{ "success": true,
  "data": [ { "bucket": "2026-11-09T17:00:00.000Z", "total": 2, "sent": 2, "delivered": 1, "read": 0, "failed": 0, "incoming": 1 },
            { "bucket": "2026-11-10T17:00:00.000Z", "total": 3, "sent": 1, "delivered": 0, "read": 1, "failed": 1, "incoming": 1 } ],
  "meta": { "from": "...", "to": "...", "group_by": "day", "tz": "Asia/Jakarta" } }
```

`bucket` = **instan UTC** awal hari/jam menurut `tz` (untuk `Asia/Jakarta`, `2026-11-09T17:00:00.000Z` = 10 Nov 00:00 WIB); render label dengan zona waktu yang sama.
Bucket kosong **sudah diisi nol** (tidak perlu mengisi celah). Rentang `from`/`to` bisa dibulatkan ke bucket penuh pertama/terakhir.
`GET /usage/sessions?from&to` (tanpa paginasi) -> `[{session_id, session_name, status, outgoing, failed, incoming}]` (sesi yang dihapus tidak muncul).
Galat: `400 INVALID_RANGE`, `400 VALIDATION_ERROR` (zona waktu tidak dikenal / `group_by` salah / UUID salah), `401`, `403` (API key tanpa `usage:read`).

### 4.8 Audit log (OWNER/ADMIN dashboard)

`GET /audit-logs?page&page_size&action=&actor_user_id=&target_id=&from=&to=` (terbaru dulu; `from` inklusif, `to` eksklusif, ISO dengan offset; `meta.total_capped` seperti daftar lain):

```json
{ "success": true, "data": [
  { "id": "42", "action": "member.role_changed",
    "actor":  { "user_id": "72c6c682-...", "email": "owner@contoh.id", "role": "OWNER" },
    "target": { "type": "member", "id": "14c240b8-...", "email": "staf@contoh.id" },
    "details": { "from": "MEMBER", "to": "ADMIN" }, "ip": "203.0.113.7", "request_id": "e8fe2390-...", "created_at": "2026-11-19T16:21:52.637Z" } ],
  "meta": { "page": 1, "page_size": 20, "total": 1 } }
```

Aksi dan `details`: `member.role_changed` / `member.status_changed` (`{from,to}`), `member.removed` / `member.left` (`{role,status}`), `invitation.created` / `invitation.reissued` (`{role,expires_at}`),
`invitation.revoked` (`{role}`), `invitation.accepted` (`{role}`; pelaku = penerima), `settings.updated` (`{changes: {max_sessions: {from, to}, ...}}`). Gunakan filter `action` sebagai pilihan dropdown.
`actor.email`/`target.email` adalah salinan saat kejadian (bisa `null`). `ip` bisa `null`; tampilkan dengan hati-hati (data pribadi). Hanya perubahan yang BERHASIL dan benar-benar mengubah sesuatu yang dicatat. Tidak ada
ekspor/penghapusan; jejak disimpan 365 hari. API key tidak dapat membaca audit (403).

### 4.9 Pengaturan dan kuota tenant

`GET /tenant/settings` (semua peran dashboard; API key `usage:read`):

```json
{ "success": true, "data": {
  "limits":   { "max_sessions": 3, "max_api_keys": 20, "max_members": 10, "messages_per_minute": 60 },
  "ceilings": { "max_sessions": 10, "max_api_keys": 50, "max_members": 50, "messages_per_minute": 120 },
  "minimums": { "max_sessions": 1, "max_api_keys": 0, "max_members": 1, "messages_per_minute": 1 },
  "used":     { "sessions": 2, "api_keys": 1, "members": 3 },
  "updated_at": "2026-11-19T16:21:52.637Z" } }
```

`PATCH /tenant/settings` (hanya **OWNER** dashboard) body strict, minimal satu kunci, bilangan bulat: `{max_sessions?, max_api_keys?, max_members?, messages_per_minute?}` -> objek seperti GET.
UI: form dengan input angka yang dibatasi `minimums` dan `ceilings` dari respons GET (jangan hardcode), tampilkan `used` di samping batas, dan nonaktifkan form untuk peran selain OWNER (ADMIN/MEMBER/VIEWER hanya baca).
Galat: `400 VALIDATION_ERROR` (di luar [minimum, ceiling] atau bukan bilangan bulat; `details[].path` = nama kunci), `409 LIMIT_BELOW_USAGE` (batas tidak boleh di bawah pemakaian saat ini: kurangi pemakaian dulu),
`403` (bukan OWNER). Berlaku seketika; mengirim nilai yang sama dengan yang tersimpan = tidak ada perubahan (tetap sah walau operator menurunkan `ceilings` sesudahnya, sehingga formulir yang mengirim semua field tidak gagal). `ceilings` ditentukan operator server (tenant tidak dapat melampauinya); untuk batas lebih tinggi hubungi operator.
`messages_per_minute` adalah perlindungan anti-ban: jelaskan di UI bahwa menaikkannya meningkatkan risiko nomor dibatasi WhatsApp. Perubahan tercatat di audit log (`settings.updated`).

### 4.10 Permintaan bergabung dengan kode workspace (ADR-036)

Alur tambahan di samping undangan: calon anggota mendaftar sendiri dengan **kode workspace** dan **kata sandi pilihannya**; akun baru aktif di workspace setelah OWNER/ADMIN menyetujui.

**Halaman publik `/join`** (kode di fragmen `#code=WJ-XXXXX-XXXXX-XXXXX-XXXXX`; baca dari `location.hash`, hapus dengan `history.replaceState`, simpan di memori; kolom kode tetap dapat diketik manual):
`POST /auth/join-requests` body `{join_code, email, password(>=10)}` (strict; tanpa cookie/token) -> `201`:
```json
{ "success": true, "data": { "request_id": "…", "status": "PENDING", "tenant_name": "Nama Workspace", "expires_at": "…", "existing_account": false } }
```
Galat: `404 INVALID_JOIN_CODE` (kode salah/diputar/dinonaktifkan: pesan seragam), `401 INVALID_CREDENTIALS` (email sudah terdaftar tetapi kata sandi salah; bila benar, permintaan dibuat untuk akun yang sama, `existing_account: true`),
`409 JOIN_REQUEST_EXISTS`, `409 JOIN_QUEUE_FULL` (antrean workspace penuh; minta pemohon menghubungi admin), `409 ALREADY_MEMBER`, `429` (10/jam per IP), `400` validasi. Tampilkan "Menunggu persetujuan admin"; pemohon belum memiliki sesi.

**Login pemohon** sebelum disetujui: `403 JOIN_PENDING` (menunggu) atau `403 JOIN_REJECTED` (ditolak/kedaluwarsa; tawarkan ajukan ulang). Kata sandi salah tetap `401`. Setelah disetujui, login biasa dengan kata sandi yang sama.

**Kelola (OWNER/ADMIN, dashboard):**
| Method | Path | Catatan |
|---|---|---|
| GET | `/team/join-code` | `{enabled, created_at, created_by}`; kode TIDAK dikembalikan lagi |
| PUT | `/team/join-code` | buat/putar: `{enabled, created_at, join_code, join_url}` SEKALI (`no-store`); kode lama hangus; `join_url` null bila `DASHBOARD_BASE_URL` kosong (bangun `/join#code=…` dari origin sendiri) |
| DELETE | `/team/join-code` | nonaktifkan |
| GET | `/team/join-requests?status=PENDING\|APPROVED\|REJECTED\|EXPIRED&page&page_size` | `{id, email, user_id, status, role, requested_at, expires_at, decided_at, decided_by}` |
| POST | `/team/join-requests/:id/approve` | body `{role=MEMBER}` (ADMIN hanya MEMBER/VIEWER; selebihnya `403`); `409 QUOTA_EXCEEDED`, `409 REQUEST_EXPIRED`, `409 INVALID_STATE` |
| POST | `/team/join-requests/:id/reject` | `409 INVALID_STATE` bila sudah diputuskan |

UI: dialog kode sekali tampil (salin, QR, WhatsApp) seperti undangan; daftar permintaan dengan tombol setujui (pilih peran)/tolak; badge jumlah PENDING. Aksi audit baru: `join_code.rotated|disabled`, `join_request.approved|rejected` (target `join_request`/`join_code`).

### 4.11 Akun, kode pemulihan, ganti nama, dan hapus workspace (ADR-037)

**Kode pemulihan (pengganti "lupa kata sandi" tanpa email).** `POST /auth/register` dan (akun baru) `POST /auth/join-requests` mengembalikan `recovery_codes` (8 kode `RC-XXXXX-XXXXX-XXXXX-XXXXX`) SEKALI.
Tampilkan di dialog "simpan sekarang" (salin/unduh/cetak; tombol tutup baru aktif setelah "sudah saya simpan" dicentang, lalu panggil `POST /auth/recovery-codes/confirm`), jangan simpan di storage/log. Tiap kode sekali pakai; simpan di beberapa tempat.
`GET /auth/me` memuat `recovery: {codes_remaining, confirmed}`: tampilkan **banner** bila `confirmed=false` atau `codes_remaining <= 2` ("buat kode baru"). Pengguna lama membuat himpunan baru lewat Pengaturan Akun (`POST /auth/recovery-codes` dengan kata sandi; semua kode lama hangus; `confirmed` kembali false).
**Halaman publik `/forgot-password`:** `POST /auth/reset-password` `{email, recovery_code, new_password}` -> `{remaining_recovery_codes}`; semua sesi dicabut, arahkan ke login. Bila sisa kode <= 2, sarankan membuat himpunan baru setelah login. Galat seragam `400 INVALID_RECOVERY` (jangan membedakan email/kode). Bila semua kode hilang: hubungi operator (`npm run admin:recovery-code`).
**Anjurkan minimal 2 OWNER:** tampilkan banner bila workspace hanya punya satu OWNER (satu OWNER yang terkunci tidak membuat workspace kehilangan pengelola).

**Pengaturan Akun (semua peran dashboard):**
| Aksi | Endpoint | Catatan UI |
|---|---|---|
| Ganti kata sandi | `POST /auth/change-password` `{current_password,new_password}` | respons = authBody baru: ganti access token di memori (cookie refresh otomatis diganti); perangkat lain keluar |
| Ganti email | `POST /auth/change-email` `{password,new_email}` | `409 EMAIL_TAKEN`; email tidak diverifikasi: beri peringatan |
| Kode pemulihan baru (8) | `POST /auth/recovery-codes` `{password}` | tampil sekali; menghanguskan kode lama |
| Keluar dari semua perangkat | `POST /auth/logout-all` (204) | setelahnya SEMUA token (termasuk milik tab ini) mati: kembali ke login |

**PENTING:** kata sandi salah pada endpoint-endpoint ini dijawab `403 INVALID_PASSWORD` (bukan 401). Jangan memicu refresh pada 403.
**Workspace (OWNER):** `PATCH /tenant` `{name}`; `DELETE /tenant` `{password, confirm_name}` (ketik nama workspace persis; dialog bahaya, tidak dapat dibatalkan lewat API, data dihapus permanen setelah `purge_after_days`). Setelah berhasil: kosongkan cache, ke workspace lain atau login.
**Sesi:** `PATCH /sessions/:id` `{session_name}`. **API key:** `PATCH /api-keys/:id` `{name?, scopes?}` (berlaku seketika; scope `*` tidak ada).
Hapus akun sendiri sengaja tidak ada.

**Pemulihan workspace terhapus (publik, 30 hari):** setelah menghapus, login gagal `403 NO_ACTIVE_TENANT` bila tidak punya workspace lain. Pada galat itu (atau lewat tautan "pulihkan workspace" di layar login) panggil `POST /auth/deleted-workspaces` `{email,password}` untuk daftar, lalu
`POST /auth/restore-workspace` `{email,password,tenant_id}`. Tampilkan peringatan sebelum memulihkan: koneksi WhatsApp harus dipasangkan ulang, webhook, API key, dan undangan dibuat ulang (`must_recreate`). Hanya OWNER; setelah masa tunggu data hilang permanen.

## 5. Realtime (Socket.IO)

```ts
import { io } from 'socket.io-client';
const socket = io('/', { path: '/api/v1/realtime', auth: { token: accessToken }, transports: ['websocket'] });
```

Token hanya lewat `auth.token` (bukan query string). Setelah terhubung server mengirim `ready` `{tenant_id, rooms}`. Event: `session.status`,
`session.created|connected|disconnected|reconnecting`, `session.qr` (**hanya sinyal** `{session_id, expires_in}` --- ambil gambar lewat `GET /sessions/:id/qr`),
`message.status`, `message.failed`, `message.incoming`, `realtime.resync`, `auth.expired`. Envelope: `{v, event_id, event, occurred_at, tenant_id, data}`.
Detail dan payload: `SOCKET_EVENTS.md`.

Aturan wajib: (1) realtime BUKAN satu-satunya sumber kebenaran --- **muat ulang data (refetch) setelah (re)connect** dan saat `realtime.resync`;
(2) saat `auth.expired` atau `connect_error` dengan `err.data.code === 'UNAUTHENTICATED'`: refresh token (2.3) lalu sambung ulang dengan token baru;
(3) token access berumur 15 menit dan server memvalidasi ulang tiap 30 detik: perbarui `socket.auth.token` sebelum reconnect;
(4) dedup event per `(event_id, event)`; (5) polling `GET /status` tetap sebagai cadangan.

## 6. Yang BELUM tersedia di backend

Jangan mengarang endpoint. Untuk yang di bawah, pakai typed mock **berlabel jelas** (seperti `isMock`) atau tampilkan "Segera hadir"; jangan menganggap 404 sebagai data
kosong yang sukses. (Team dan Usage **sudah ada**: bagian 4.6 dan 4.7. Filter tanggal pesan **sudah ada**: `GET /messages?from&to`.)

| Kebutuhan UI | Status backend | Alternatif sementara |
|---|---|---|
| Riwayat pesan gabungan lintas sesi (`/messages/history`) | tidak ada (endpoint itu) | `GET /messages` (antrean/kirim keluar, ada filter tanggal) + `GET /chats/:id/messages` (percakapan) |
| Mengubah kuota MELEBIHI ceiling server | tidak ada (disengaja: ceiling dari operator) | OWNER dapat mengubah sampai ceiling (4.9); di atasnya hubungi operator |
| Pencarian teks pesan, ekspor (CSV) | tidak ada | -- |
| Filter tanggal pada `/chats` dan `/chats/:id/messages` | tidak ada | paginasi saja |
| Kirim email undangan otomatis | tidak ada (keputusan produk: tanpa email) | salin tautan / QR / kirim lewat WhatsApp (4.6); "Buat ulang tautan" bila hilang |
| Audit log untuk aksi selain tim dan pengaturan (login, sesi, pesan, webhook, API key) | tidak ada | -- |
| Hapus akun sendiri | tidak ada (sengaja tidak disediakan) | -- |
| Verifikasi kepemilikan email, tautan reset lewat email | tidak ada (keputusan produk: tanpa email) | kode pemulihan (4.11) |

Bila produk membutuhkan salah satu di atas, ajukan lewat `INTEGRATION_CONTRACT.md` ("gap"), lalu tim backend menyusun kontraknya terlebih dahulu.

## 7. Aturan keamanan UI

-   Jangan simpan QR, API key, secret webhook, atau token di `localStorage`/`sessionStorage`/log konsol/URL. Access token hanya di memori.
-   Tampilkan QR hanya untuk peran berwenang dan bersihkan saat kedaluwarsa. Sembunyikan fitur sesuai peran (2.4) **dan** tangani 403.
-   Jangan menaruh data pengguna (nomor/isi pesan) di analytics, log klien, atau pesan galat yang dikirim ke pihak ketiga.
-   Semua halaman: state loading, kosong, galat, sukses, dan tidak berwenang (401/403). Pesan galat dari server berbahasa Indonesia dan aman ditampilkan.
-   `request_id` pada galat boleh ditampilkan ("kode laporan") untuk memudahkan dukungan.

## 8. Lingkungan dev dan cara uji

-   Backend: `cd backend && npm run dev` (port 3000). Frontend: `npm run dev` (port 5173) dengan proxy `/api` dan `/health`.
-   Buat akun uji lewat halaman Register (email + password >= 10 + nama workspace) atau `POST /auth/register`. Akun lama di database dev
    memakai email (mis. admin dengan alamat email), bukan username. **Jangan** menulis kredensial ke berkas yang di-commit.
-   Kuota dev per tenant: 3 sesi, 20 API key, 10 webhook, 60 pesan/menit. Untuk mengisi data (sesi `CONNECTED`, pesan masuk) di dev, pasangkan nomor WhatsApp
    lewat alur QR; tidak ada data demo bawaan.
-   Untuk tes otomatis frontend: batasan rate limit login/register (bagian 1) dapat memblokir tes beruntun; pakai satu akun dan simpan token di memori tes.

## 9. Kriteria selesai (usulan checklist serah-terima)

1.  Register (email + nama workspace) dan login berhasil; galat (`INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `RATE_LIMITED`) tampil jelas; tanpa fallback mock.
2.  Muat ulang halaman tetap login (lewat `/auth/refresh`); token kedaluwarsa dipulihkan tanpa logout; logout memanggil `/auth/logout`.
3.  Sesi: buat, QR tampil dan bersih setelah tersambung/kedaluwarsa, status 13 nilai terpetakan, connect/disconnect/reconnect/hapus dengan penanganan 409.
4.  Kirim pesan memakai `Idempotency-Key`; status `PENDING -> SENT -> DELIVERED -> READ` tampil (polling atau Socket.IO); `FAILED`/`UNKNOWN` punya aksi yang benar.
5.  Chat dan kontak nyata; paginasi; `total_capped` ditangani.
6.  Webhook dan API key: secret/key hanya tampil sekali; scope valid; `disabled_reason` webhook ditangani.
7.  Realtime: refetch setelah reconnect/resync, `auth.expired` ditangani.
8.  Halaman Team (daftar, undang + salin tautan sekali tampil, ubah peran/status, hapus/keluar, terima undangan, pindah workspace) dan Usage (KPI, grafik per hari/jam dengan `tz`, per sesi, kuota)
    memakai endpoint NYATA, tanpa mock. Tambahkan: dialog undangan (salin/QR/WhatsApp, buat ulang tautan), halaman Audit log (OWNER/ADMIN, filter aksi dan tanggal), dan form Pengaturan kuota (OWNER;
    batas dari `minimums`/`ceilings`). Gap yang tersisa (bagian 6) tercatat di `INTEGRATION_CONTRACT.md`.
9.  Tes dan hasilnya dicatat di `FRONTEND_PROGRESS.md`; endpoint/event yang dipakai dan asumsi terdaftar (aturan serah-terima `FRONTEND_AGENT_PROMPT.md`).

## Perilaku baru: 503 `SERVICE_UNAVAILABLE` (2026-11-20, ADR-038)

Bila database sementara tidak tersedia, API menjawab `503` dengan `error.code = "SERVICE_UNAVAILABLE"` dan header `Retry-After: 2` (sebelumnya `500 INTERNAL_ERROR`).
Klien: tampilkan "Layanan sedang sibuk, mencoba lagi...", ulangi permintaan GET dengan backoff (1-2-4 dtk, maksimal ~3 kali); untuk `POST /messages/send`
ulangi dengan `Idempotency-Key` yang SAMA agar tidak terkirim ganda. Jangan menganggapnya sesi berakhir (bukan 401) dan jangan logout pengguna.

