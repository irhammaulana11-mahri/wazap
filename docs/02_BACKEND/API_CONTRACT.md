# REST API Contract --- v1

Base path: `/api/v1`

## Authentication

-   Dashboard: secure HTTP-only cookie or short-lived access token with
    refresh strategy.
-   External clients: `Authorization: Bearer <api_key>`.
-   API key scopes and tenant identity are resolved server-side.
-   Never accept tenant_id as authority from request body.

## Common response

Success:

``` json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Error:

``` json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  },
  "request_id": "uuid"
}
```

## Authentication routes

-   POST `/auth/register`
-   POST `/auth/login`
-   POST `/auth/logout`
-   POST `/auth/refresh`
-   GET `/auth/me`

## Session routes

-   POST `/sessions`
-   GET `/sessions`
-   GET `/sessions/:sessionId`
-   POST `/sessions/:sessionId/connect`
-   POST `/sessions/:sessionId/disconnect`
-   POST `/sessions/:sessionId/reconnect`
-   DELETE `/sessions/:sessionId`
-   GET `/sessions/:sessionId/status`
-   GET `/sessions/:sessionId/events`

## Messaging routes

-   POST `/messages/send`
-   POST `/messages/send-media`
-   POST `/messages/bulk`
-   GET `/messages`
-   GET `/messages/:messageId`
-   GET `/messages/:messageId/status`
-   POST `/messages/:messageId/cancel`

## Contacts/chats

-   GET `/contacts`
-   GET `/chats`
-   GET `/chats/:chatId/messages`

## API keys

-   GET `/api-keys`
-   POST `/api-keys`
-   DELETE `/api-keys/:keyId`

## Webhooks

-   GET `/webhooks`
-   POST `/webhooks`
-   PATCH `/webhooks/:webhookId`
-   DELETE `/webhooks/:webhookId`
-   GET `/webhooks/:webhookId/deliveries`

## Usage

-   GET `/usage/summary`
-   GET `/usage/sessions`
-   GET `/usage/messages`

## Send message example

Request:

``` http
POST /api/v1/messages/send
Authorization: Bearer <API_KEY>
Idempotency-Key: client-generated-unique-key
Content-Type: application/json
```

``` json
{
  "session_id": "uuid",
  "to": "6281234567890",
  "type": "text",
  "message": "Example message"
}
```

Response: HTTP 202

``` json
{
  "success": true,
  "data": {
    "job_id": "uuid",
    "status": "PENDING"
  }
}
```

## Status model

`PENDING`, `PROCESSING`, `SENT`, `DELIVERED`, `READ`, `FAILED`,
`CANCELLED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`.

Definitions must reflect what the adapter can actually confirm. `SENT`
must not be described as delivered/read.

## Contract rules

-   All list routes paginate.
-   All tenant routes enforce tenant ownership.
-   Mutating routes require appropriate scopes/roles.
-   Send routes require idempotency support.
-   Error codes are stable and documented.
-   Breaking changes require a new API version or migration plan.

## Implementasi Fase B (berlaku sejak 2026-11-19)

### Autentikasi
-   Dashboard: `access_token` (Bearer, TTL 15 menit, env
    `ACCESS_TOKEN_TTL_SECONDS`) di body; **refresh token hanya di cookie
    HttpOnly** `wzp_rt` (`SameSite=Strict`, `Path=/api/v1/auth`,
    `Secure` di production, TTL 30 hari). Refresh token dirotasi setiap
    refresh; pemakaian ulang token lama mencabut seluruh family.
-   Server memverifikasi ulang membership/role/status tenant pada setiap
    request, sehingga perubahan berlaku segera.
-   Klien harus mengirim `credentials: 'include'` agar cookie dikirim
    (frontend memakai proxy same-origin).
-   API key: `Authorization: Bearer gwk_...` atau header `x-api-key`.
    Format `gwk_` + 43 karakter base64url. API key **tidak** dapat
    mengelola API key atau memanggil `/auth/me`.
-   Body dengan `tenant_id` pada register / create API key **ditolak 400**
    (schema strict).

### Endpoint siap
| Method | Path | Auth | Keterangan |
|---|---|---|---|
| POST | `/auth/register` | publik | body `{email, password(>=10), tenant_name}` -> 201 `{access_token, token_type, expires_in, user, tenant, role}` + cookie. Rate limit 5/jam/IP |
| POST | `/auth/login` | publik | body `{email, password, tenant_id?}` -> 200 sama seperti register. `tenant_id` hanya memilih dari membership milik user. Limit 20/5 menit/IP, 8/15 menit/email |
| POST | `/auth/refresh` | cookie | 200 token baru + cookie baru; 401 `INVALID_REFRESH_TOKEN` |
| POST | `/auth/logout` | cookie | 204, idempoten |
| GET | `/auth/me` | user | `{user, active_tenant_id, memberships[], role}` |
| GET | `/api-keys` | user (semua role) | paginated `?page=1&page_size=20(max 100)&include_revoked=false`; `meta {page,page_size,total}`; tanpa hash. **Kunci yang sudah dicabut disembunyikan secara bawaan** (dan tidak dihitung di `total`); `include_revoked=true` menampilkannya dengan `revoked_at` |
| POST | `/api-keys` | user OWNER | body `{name, scopes[], expires_at?}` -> 201 termasuk `key` (**hanya sekali**) |
| DELETE | `/api-keys/:keyId` | user OWNER | revoke idempoten (baris tetap ada untuk audit, kunci langsung tidak berlaku, tidak menghabiskan kuota, tidak dapat dipulihkan: buat kunci baru); 404 bila bukan milik tenant |

Scopes yang valid: `sessions:read`, `sessions:write`, `messages:send`,
`messages:read`, `contacts:read`, `webhooks:manage`, `usage:read`.
Wildcard `*` tidak diterima untuk key baru.

Contoh:
```http
POST /api/v1/auth/register
{"email":"owner@example.com","password":"correct-horse-battery","tenant_name":"Acme"}
```
```json
{"success":true,"data":{"access_token":"...","token_type":"Bearer","expires_in":900,
 "user":{"id":"uuid","email":"owner@example.com"},
 "tenant":{"id":"uuid","name":"Acme","slug":"acme-1a2b3c4d"},"role":"OWNER"}}
```

### Error codes (stabil)
`VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `INVALID_CREDENTIALS` 401,
`INVALID_REFRESH_TOKEN` 401, `FORBIDDEN` 403, `NO_ACTIVE_TENANT` 403,
`NOT_FOUND` 404, `EMAIL_TAKEN` 409, `QUOTA_EXCEEDED` 409,
`PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429 (+ `Retry-After`),
`NOT_IMPLEMENTED` 501, `INTERNAL_ERROR` 500, `SERVICE_UNAVAILABLE` 503 (+ `Retry-After: 2`). Setiap respons membawa header
`X-Request-Id` yang sama dengan `request_id` di body error.

`SERVICE_UNAVAILABLE` (503): database tidak terjangkau / koneksi terputus / pool habis melewati `DB_CONNECT_TIMEOUT_MS`.
Sementara dan aman diulang (klien: backoff, mis. 1-2-4 dtk). Isi galat tidak memuat host, port, atau detail internal.
Untuk `POST /messages/send` dan penulisan lain yang idempoten, ulangi dengan `Idempotency-Key` yang sama.

### Kompatibilitas prototipe (sementara, dihapus Fase C)
-   `POST /auth/login` dengan `{username, password}` tetap memakai admin
    env dan menghasilkan `{token, expiresIn}` (format lama).
-   Route `/sessions`, `/messages`, `/webhooks`, `/auth/api-keys` lama
    hanya dapat dipakai principal legacy; user/API key baru menerima
    `501 NOT_IMPLEMENTED` sampai Fase C-F.
-   `/health/live`, `/health/ready` ada di luar `/api/v1` (publik).

## Implementasi Fase C (sessions registry, 2026-11-19)

Perubahan: `LEGACY_AUTH_ENABLED` default `false`. Login `{username,password}`
dan route prototipe tidak aktif (route legacy dipindah ke
`/api/v1/legacy/*` bila diaktifkan). `/api/v1/sessions` kini milik registry baru.

Otorisasi: pengguna dashboard OWNER/MEMBER boleh menulis, semua role
membaca; API key memerlukan scope `sessions:write` (tulis) atau
`sessions:read` (baca) --- write tidak mencakup read. Sesi tenant lain => 404.

| Method | Path | Respons |
|---|---|---|
| POST | `/sessions` | 201 body `{session_name (2-50: huruf/angka/spasi/._-), auto_connect=true}`; `tenant_id`/field tak dikenal => 400 |
| GET | `/sessions` | 200 paginated `?page&page_size(<=100)&status=` |
| GET | `/sessions/:id` | 200 |
| GET | `/sessions/:id/status` | 200 `{id,status,status_reason,desired_state,updated_at}` |
| GET | `/sessions/:id/events` | 200 paginated, terbaru dulu: `{id,event_type,from_status,to_status,actor,payload,created_at}` |
| POST | `/sessions/:id/connect` / `disconnect` / `reconnect` | 202 sesi |
| DELETE | `/sessions/:id` | 202 status `DELETING` |

Objek sesi: `{id, session_name, phone_number, status, status_reason,
desired_state, adapter, created_at, updated_at}` (tanpa engine/lease/kredensial).

Contoh:
```http
POST /api/v1/sessions
Authorization: Bearer <access_token|api_key>
{"session_name":"Toko Utama"}
```
```json
{"success":true,"data":{"id":"uuid","session_name":"Toko Utama","phone_number":null,
 "status":"PENDING_ASSIGNMENT","status_reason":"create_auto_connect","desired_state":"CONNECTED",
 "adapter":"BAILEYS","created_at":"...","updated_at":"..."}}
```

Kode error baru: `SESSION_NAME_TAKEN` 409, `INVALID_STATE` 409, `QUOTA_EXCEEDED` 409
(session). Belum tersedia: `GET /sessions/:id/qr` dan transisi yang dipicu
koneksi nyata (Fase D); status akan tetap `PENDING_ASSIGNMENT` bila tidak
ada engine.

## Implementasi Fase D (QR & koneksi nyata, 2026-11-19)

Perubahan: kompatibilitas prototipe DIHAPUS. `{username,password}` pada login
=> 400; token/API key legacy (`wazap_`) => 401; `/api/v1/legacy/*` tidak ada.

| Method | Path | Respons |
|---|---|---|
| GET | `/sessions/:id/qr` | 200 `{qr, qr_data_url, expires_at}` saat status `QR_REQUIRED`; header `Cache-Control: no-store` |

Otorisasi sama dengan menulis sesi (OWNER/MEMBER atau scope
`sessions:write`): QR = kredensial login WhatsApp, VIEWER dan scope baca saja
tidak boleh. Sesi tenant lain => 404. QR berotasi sekitar 20 detik; klien
polling `GET /sessions/:id/qr` (atau `/status`) sampai `CONNECTED`.
Kode error baru: `QR_NOT_AVAILABLE` 409 (status bukan `QR_REQUIRED`, QR belum
ada/kedaluwarsa), `NOT_CONFIGURED` 503 (kunci enkripsi belum diset).
Status/alasan baru dari engine: lihat SESSION_LIFECYCLE (Fase D). QR tidak
pernah muncul di log, event, atau respons selain endpoint ini.

## Implementasi Fase E (messaging, 2026-11-19)

Otorisasi: kirim/cancel/retry = OWNER/MEMBER atau scope `messages:send`;
baca = semua role atau scope `messages:read` (send tidak mencakup read).
Respons memakai envelope standar; objek pesan:
`{id, session_id, to, type, message, status, priority, attempts, max_attempts,
provider_message_id, last_error_code, scheduled_at, completed_at, created_at,
updated_at}` (+ `attempt_history[{attempt_number,started_at,finished_at,outcome,
provider_message_id,error_code}]` pada GET detail). `message_id` = `job_id`.

| Method | Path | Respons |
|---|---|---|
| POST | `/messages/send` | 202 `{job_id,status:"PENDING"}`; header opsional `Idempotency-Key` (1-255 ASCII tanpa spasi) |
| GET | `/messages` | 200 paginated `?page&page_size&status=&session_id=` |
| GET | `/messages/:id` | 200 + `attempt_history` |
| GET | `/messages/:id/status` | 200 `{id,status,attempts,last_error_code,provider_message_id,updated_at}` |
| POST | `/messages/:id/cancel` | 200; hanya `PENDING` (selain itu 409; idempoten bila sudah CANCELLED) |
| POST | `/messages/:id/retry` | 202; dari `FAILED` (bebas) atau `UNKNOWN`/`RECONCILIATION_REQUIRED` (wajib `{"confirm_duplicate_risk":true}`) |

Body `send` (strict; field tak dikenal/`tenant_id` => 400):
`{session_id, to, type:"text", message, priority=5 (0-9), scheduled_at? (ISO, <=7 hari)}`.
`to`: internasional 8-15 digit tanpa 0 di depan; `+`, spasi, `-`, `.`, `()` diabaikan;
tidak ada kode negara implisit.

Kode error baru: `IDEMPOTENCY_CONFLICT` 422, `QUEUE_FULL` 429,
`SESSION_UNAVAILABLE` 409, `CONFIRMATION_REQUIRED` 409 (selain `NOT_FOUND`,
`INVALID_STATE`, `VALIDATION_ERROR`).

Semantik status: `PENDING` antre/menunggu jadwal atau retry; `PROCESSING` sedang
dikirim; `SENT` diterima socket/server WhatsApp (BUKAN delivered/read);
`FAILED` gagal pasti (lihat `last_error_code`: `RECIPIENT_NOT_ON_WHATSAPP`,
`MAX_ATTEMPTS_REACHED`, `EXPIRED`); `UNKNOWN` error saat kirim, mungkin sudah
terkirim; `RECONCILIATION_REQUIRED` engine mati saat kirim; `CANCELLED`
(`CANCELLED_BY_CLIENT`, `SESSION_DELETED`). `DELIVERED`/`READ` belum diisi.
Belum tersedia: `send-media`, `bulk`, `/contacts`, `/chats`.

## Implementasi Fase F (2026-11-19)

Semua respons memakai envelope standar. Validasi body strict (field tak dikenal
=> 400 `VALIDATION_ERROR`).

### Pesan media dan bulk (otorisasi sama dengan `send`: OWNER/MEMBER atau `messages:send`)

| Method | Path | Respons |
|---|---|---|
| POST | `/messages/send-media` | 202 `{job_id,status}`; header opsional `Idempotency-Key`; `Idempotent-Replayed: true` pada replay |
| POST | `/messages/bulk` | 202 `{count, jobs:[{index,to,job_id,status}]}`; atomik; `Idempotency-Key` per batch (maks 200 karakter) |

`send-media` body: `{session_id, to, type: image|video|audio|document, url,
caption? (<=1024; tidak untuk audio), filename? (hanya document), mimetype?
(hanya dipakai untuk document), priority=5, scheduled_at?}`. `url` harus
`https` ke alamat publik (422 `INVALID_MEDIA_URL` bila internal/tak valid).
Engine mengunduh saat kirim: batas `MEDIA_MAX_BYTES`, tanpa redirect, tipe
konten divalidasi. Kegagalan unduh: `last_error_code` = `MEDIA_HTTP_<status>`,
`MEDIA_TOO_LARGE`, `MEDIA_TYPE_INVALID`, `MEDIA_URL_BLOCKED`,
`MEDIA_REDIRECT_NOT_FOLLOWED`, `MEDIA_EMPTY` (permanen, FAILED 1 percobaan);
`MEDIA_FETCH_TIMEOUT` / `MEDIA_HTTP_5xx|408|429` / `MEDIA_FETCH_FAILED`
(sementara, di-retry sampai `max_attempts`). Objek pesan kini memuat
`media: {url, filename, mimetype} | null` dan `content_purged: boolean`.

`bulk` body: `{session_id, messages:[{to, message}] (1..BULK_MAX_MESSAGES),
priority=5, scheduled_at?}`. Satu item tidak valid menolak seluruh batch (400);
pasangan `(to,message)` ganda dalam batch => 422 `DUPLICATE_ITEM`. Urutan
kirim = urutan array. Kode baru: `INVALID_MEDIA_URL` 422, `DUPLICATE_ITEM` 422,
`CONTENT_PURGED` 409 (retry pesan yang isinya sudah dihapus retensi).

### Chat dan kontak (baca saja)

| Method | Path | Otorisasi | Respons |
|---|---|---|---|
| GET | `/chats` | semua role / `messages:read` | paginated `?page&page_size&session_id=`; `{id,session_id,jid,phone,name,last_message_at,created_at}` |
| GET | `/chats/:chatId/messages` | semua role / `messages:read` | paginated terbaru dulu; `{id,direction IN\|OUT,type,text,text_purged,status,provider_message_id,job_id,occurred_at}`; `meta.chat` |
| GET | `/contacts` | semua role / `contacts:read` | paginated; `{phone,name,last_message_at,chats}` |

Status pesan keluar kini dapat `DELIVERED` dan `READ` (dari receipt WhatsApp;
hanya maju, tidak pernah mundur). Pesan masuk bertipe `text|image|video|audio|
document|sticker|location|contact|other` (media tidak diunduh; `text` = caption).

### Webhook (hanya OWNER atau scope `webhooks:manage`)

| Method | Path | Respons |
|---|---|---|
| POST | `/webhooks` | 201 `{id,url,description,events,secret_hint,active,...,secret}` --- `secret` HANYA di respons ini (`Cache-Control: no-store`) |
| GET | `/webhooks` | 200 paginated (tanpa secret) |
| PATCH | `/webhooks/:id` | 200; `{url?,description?,events?,active?}` (minimal satu) |
| DELETE | `/webhooks/:id` | 200 (delivery ikut terhapus) |
| POST | `/webhooks/:id/rotate-secret` | 200 + secret baru (yang lama langsung tidak berlaku) |
| POST | `/webhooks/:id/test` | 202 delivery `webhook.test` (1 percobaan) |
| GET | `/webhooks/:id/deliveries` | paginated `?status=PENDING\|DELIVERED\|DEAD` |
| GET | `/webhooks/:id/deliveries/:deliveryId` | detail + `attempt_history[{attempt_number,started_at,duration_ms,status_code,error_code,outcome}]` |
| POST | `/webhooks/:id/deliveries/:deliveryId/replay` | 202; anggaran percobaan baru (409 bila masih PENDING / endpoint nonaktif) |

Body create: `{url, description?, events=["*"]}`; `events` dari: `*`,
`session.status`, `message.sent|delivered|read|failed|unknown|cancelled|incoming`.
Kode error: `INVALID_WEBHOOK_URL` 422, `QUOTA_EXCEEDED` 409 (maks
`WEBHOOK_MAX_ENDPOINTS`), `NOT_CONFIGURED` 503 (kunci enkripsi belum diset).
Spesifikasi payload/tanda tangan: WEBHOOK_SPECIFICATION. Socket.IO: SOCKET_EVENTS.

Sesi: `GET /sessions/:id/events` tetap; perubahan status kini juga menghasilkan
event webhook/realtime `session.status`.

## Pembaruan Fase G (2026-11-19)

-   **Pembatasan laju:** 429 `RATE_LIMITED` + header `Retry-After` (detik). Per IP sebelum autentikasi (default 600/menit) dan
    per tenant sesudahnya (default 1200/menit; dibagi semua pengguna & API key tenant). Klien wajib menghormati `Retry-After`.
-   **Header keamanan** pada semua respons: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cache-Control: no-store` (kecuali ditetapkan endpoint).
-   **`meta.total_capped`:** `GET /messages` dan `GET /chats` membatasi `meta.total` pada 10000; bila terlampaui `total=10000` dan
    `total_capped=true` (halaman tetap benar di seluruh data). Tanpa penanda = total eksak.
-   **Webhook:** objek endpoint kini memuat `consecutive_failures`, `disabled_at`, `disabled_reason`
    (`AUTO_CONSECUTIVE_FAILURES` bila dinonaktifkan otomatis setelah 10 delivery DEAD berturut-turut). Aktifkan ulang dengan
    `PATCH /webhooks/:id {"active":true}` (mereset penanda).

## Implementasi Fase H (2026-11-19): tim, penggunaan, filter tanggal, pindah workspace

Semua respons memakai envelope standar. Contoh respons nyata: `docs/04_INTEGRATION/FRONTEND_HANDOFF.md` bagian 4.6 dan 4.7.

### Tim (hanya pengguna dashboard; API key ditolak 403)

| Method | Path | Peran | Keterangan |
|---|---|---|---|
| GET | `/team/members` | OWNER | paginated; `{user_id, email, role, status, joined_at, is_me}` |
| PATCH | `/team/members/:userId` | OWNER | body strict `{role?, status?: ACTIVE\|SUSPENDED}` (minimal satu) |
| DELETE | `/team/members/:userId` | semua peran (batas izin di bawah) | hapus anggota; menghapus diri sendiri = keluar |
| GET | `/team/invitations` | OWNER | paginated; `?status=PENDING\|ACCEPTED\|REVOKED\|EXPIRED`; tanpa token |
| POST | `/team/invitations` | OWNER | body `{email, role=MEMBER}` -> 201 + `token` SEKALI (`Cache-Control: no-store`), berlaku 7 hari |
| DELETE | `/team/invitations/:id` | OWNER | cabut (idempoten); 409 bila sudah diterima |
| POST | `/team/invitations/accept` | semua pengguna dashboard | body `{token}` -> `{tenant:{id,name,slug}, role}`; email akun harus = email undangan |
| POST | `/auth/switch-tenant` | semua pengguna dashboard | body `{tenant_id}` -> sama seperti login + cookie refresh baru (family lama dicabut) |

Izin: OWNER mengelola semua anggota dan boleh memberi semua peran (OWNER, MEMBER, VIEWER; peran ADMIN dihapus, ADR-053, nilai `ADMIN` ditolak 400); MEMBER/VIEWER tidak
mengelola (hanya keluar sendiri). Tidak dapat mengubah peran/status akun sendiri (`CANNOT_MODIFY_SELF`). Tenant tidak boleh kehilangan OWNER aktif terakhir
(`LAST_OWNER`: menurunkan, menangguhkan, menghapus, atau keluar). Anggota SUSPENDED/dihapus kehilangan akses seketika. Peran aktor dibaca ulang di dalam lock
transaksi (bukan dari token) sehingga permintaan bersamaan tidak dapat melewati aturan. Kuota: anggota + undangan tertunda <= `tenant_settings.max_members` (default 10).
Terima undangan: semua kegagalan token dijawab sama (`404 INVALID_INVITATION`); 10 percobaan/15 menit per pengguna.

Kode galat baru: `INVALID_RANGE` 400, `CANNOT_MODIFY_SELF` 403, `INVALID_INVITATION` 404, `LAST_OWNER` 409, `ALREADY_MEMBER` 409, `INVITATION_EXISTS` 409.

### Penggunaan (`usage:read` untuk API key; semua peran dashboard)

| Method | Path | Respons |
|---|---|---|
| GET | `/usage/summary?from&to` | `{period, sessions, messages, incoming, queue, quotas}` |
| GET | `/usage/messages?from&to&group_by=hour\|day&tz=&session_id=` | deret `[{bucket, total, sent, delivered, read, failed, incoming}]` + `meta`; bucket kosong diisi nol |
| GET | `/usage/sessions?from&to` | `[{session_id, session_name, status, outgoing, failed, incoming}]` |

Rentang `[from, to)`: ISO-8601 dengan offset, default 24 jam terakhir, maks 92 hari (`group_by=hour` maks 7 hari). Pesan keluar menurut `created_at` dan status saat ini;
pesan masuk menurut `created_at` (saat diterima). `sessions`/`queue`/`quotas` adalah snapshot saat ini. `tz` = nama IANA (default `UTC`); `bucket` = instan UTC awal hari/jam menurut `tz`.
Data lebih tua dari retensi (180 hari) tidak tersedia.

### Filter tanggal pesan

`GET /messages?from=&to=`: rentang `created_at` (diantrekan); `from` inklusif, `to` eksklusif; ISO-8601 dengan offset; `from < to` (400 bila tidak); dapat digabung dengan `status` dan `session_id`.

## Implementasi Fase H2 (2026-11-19): audit log, kuota tenant, undangan tanpa email

### Undangan tanpa email (ADR-034)
Tidak ada email otomatis. Respons `POST /team/invitations` dan `POST /team/invitations/:id/reissue` memuat `token` (sekali tampil) dan `invite_url`
(`<DASHBOARD_BASE_URL>/invite#token=...` --- token di FRAGMEN agar tidak dikirim ke server dashboard/Nginx dan tidak masuk access log atau Referer; `null` bila `DASHBOARD_BASE_URL` belum diatur --- frontend lalu membangun tautan dari origin-nya sendiri; server TIDAK pernah
memakai header `Origin`/`Host` klien). Pengundang menyampaikan tautan sendiri (salin, QR, atau kirim lewat WhatsApp melalui `POST /messages/send` dari sesi tenant).

| Method | Path | Peran | Keterangan |
|---|---|---|---|
| POST | `/team/invitations/:id/reissue` | OWNER | token baru (sekali tampil, `Cache-Control: no-store`), token LAMA langsung hangus, masa berlaku dihitung ulang; hanya status PENDING (termasuk yang kedaluwarsa); selain itu `409 INVALID_STATE` |

### Audit log (hanya OWNER pengguna dashboard; API key ditolak 403)

`GET /audit-logs?page&page_size&action=&actor_user_id=&target_id=&from=&to=` (terbaru dulu; `from` inklusif, `to` eksklusif; `meta.total_capped` seperti daftar lain).
Item: `{id, action, actor:{user_id,email,role}, target:{type,id,email}, details, ip, request_id, created_at}`.
Aksi: `member.role_changed` (`details {from,to}`), `member.status_changed` (`{from,to}`), `member.removed` / `member.left` (`{role,status}`), `invitation.created` / `invitation.reissued`
(`{role,expires_at}`), `invitation.revoked` (`{role}`), `invitation.accepted` (pelaku = penerima; `{role}`), `settings.updated` (`details.changes {kunci:{from,to}}`).
Dicatat HANYA untuk perubahan yang berhasil dan benar-benar mengubah sesuatu (penolakan 403/409 dan no-op tidak dicatat), dalam transaksi yang sama dengan perubahannya.
`ip` = alamat koneksi (di belakang proxy: set `TRUST_PROXY`), `request_id` = header `X-Request-Id` respons aksi itu. Jejak tidak memuat token/rahasia. Append-only; dihapus hanya
oleh retensi (`RETENTION_AUDIT_DAYS`, default 365 hari).

### Kuota tenant

| Method | Path | Peran | Keterangan |
|---|---|---|---|
| GET | `/tenant/settings` | semua peran dashboard; API key `usage:read` | `{limits, ceilings, minimums, used, updated_at, editable: false, managed_by: "platform"}` |
| PATCH | `/tenant/settings` | **DIHENTIKAN** (deprecated) | OWNER selalu `403 QUOTA_MANAGED_BY_PLATFORM`: kuota diatur pemilik platform (ADR-054); body tetap divalidasi strict lebih dulu |

`limits` = nilai berlaku; `ceilings` = batas atas global dari env operator (`LIMIT_CEIL_SESSIONS` 10, `LIMIT_CEIL_API_KEYS` 50, `LIMIT_CEIL_MEMBERS` 50, `LIMIT_CEIL_MESSAGES_PER_MINUTE` 120);
`minimums` = `{max_sessions:1, max_api_keys:0, max_members:1, messages_per_minute:1}`; `used` = `{sessions, api_keys, members}` (anggota + undangan tertunda; definisi sama dengan penolakan `QUOTA_EXCEEDED`).
Nilai di luar [minimum, ceiling] => `400 VALIDATION_ERROR` (`details[].path` = nama kunci); di bawah pemakaian saat ini untuk sesi/API key/anggota => `409 LIMIT_BELOW_USAGE`.
Berlaku seketika; satu nilai tidak sah membatalkan seluruh permintaan; mengirim nilai yang sama = tidak ada perubahan dan tidak dicatat audit. Kode galat baru: `LIMIT_BELOW_USAGE` 409.

## Pembaruan hasil code-review (2026-11-20)

-   `GET /api-keys`: item kini memuat `created_by: {user_id, email} | null`.
-   **Hapus/keluar anggota** mencabut API key yang dibuat anggota itu (dicabut SEBELUM keanggotaan dihapus: FK `created_by_user_id` berstatus `ON DELETE SET NULL`); ditangguhkan tidak mencabut key.
    Audit `member.removed|left` memuat `details.revoked_api_keys` (id) dan `details.revoked_invitations` (jumlah).
-   Undangan tertunda milik anggota yang dihapus, ditangguhkan, atau diturunkan perannya otomatis dicabut (`invitation.revoked`, `details.reason` = `inviter_suspended|inviter_demoted|inviter_removed|inviter_left`).
-   `POST /team/invitations/:id/reissue` pada undangan KEDALUWARSA memeriksa kuota anggota seperti undangan baru (`409 QUOTA_EXCEEDED` bila penuh).
-   `GET /usage/messages?tz=`: hanya nama IANA (atau `UTC`); bentuk offset (`+07:00`, `UTC+7`) => `400`.
-   `PATCH /tenant/settings`: nilai yang sama dengan yang tersimpan diabaikan (tidak divalidasi terhadap ceiling) dan tidak tercatat di audit. Kunci `max_api_keys` kini tercatat di `details.changes` (sebelumnya terbuang oleh filter rahasia).

## Permintaan bergabung dengan kode workspace (Fase H3, ADR-036)

| Method | Path | Peran | Catatan |
|---|---|---|---|
| POST | `/auth/join-requests` | publik | body `{join_code, email, password}` strict -> 201 `{request_id, status:'PENDING', tenant_name, expires_at, existing_account}`; 10/jam per IP |
| GET | `/team/join-code` | OWNER | `{enabled, created_at, created_by}` |
| PUT | `/team/join-code` | OWNER | buat/putar; `join_code` (+`join_url`) SEKALI, `Cache-Control: no-store`; kode lama hangus |
| DELETE | `/team/join-code` | OWNER | nonaktifkan |
| GET | `/team/join-requests` | OWNER | paginated; `?status=PENDING\|APPROVED\|REJECTED\|EXPIRED` |
| POST | `/team/join-requests/:id/approve` | OWNER | body `{role=MEMBER}`; cek kuota anggota; tulis audit |
| POST | `/team/join-requests/:id/reject` | OWNER | tulis audit |

Login pemohon yang belum disetujui: `403 JOIN_PENDING`; ditolak/kedaluwarsa: `403 JOIN_REJECTED` (hanya setelah kata sandi benar). Kode galat baru: `INVALID_JOIN_CODE` 404, `JOIN_REQUEST_EXISTS` 409, `REQUEST_EXPIRED` 409,
`JOIN_PENDING` 403, `JOIN_REJECTED` 403 (selain yang sudah ada: `ALREADY_MEMBER`, `INVALID_STATE`, `QUOTA_EXCEEDED`, `INVALID_CREDENTIALS`).

Antrean permintaan bergabung dibatasi `JOIN_MAX_PENDING` (default 50 yang masih berlaku) per tenant: pengajuan di atas batas dijawab `409 JOIN_QUEUE_FULL` (akun tidak dibuat). Pengajuan ganda oleh pemohon yang sama tetap `409 JOIN_REQUEST_EXISTS`.
Permintaan yang sudah diputuskan atau kedaluwarsa dihapus retensi setelah `RETENTION_JOIN_REQUEST_DAYS` (90 hari).

## Manajemen akun, ganti nama, dan hapus workspace (Fase H4, ADR-037)

| Method | Path | Peran | Catatan |
|---|---|---|---|
| POST | `/auth/change-password` | pengguna dashboard | `{current_password, new_password(>=10)}` -> authBody baru + cookie; semua sesi lain dicabut; `403 INVALID_PASSWORD`, `400 PASSWORD_UNCHANGED`; 5/15 menit |
| POST | `/auth/recovery-codes` | pengguna dashboard | `{password}` -> `{recovery_codes:[8]}` SEKALI (`no-store`); seluruh kode lama hangus; penanda konfirmasi dikosongkan |
| POST | `/auth/recovery-codes/confirm` | pengguna dashboard | -> `{confirmed:true}` (pengguna menyatakan sudah menyimpan; menghilangkan banner) |
| POST | `/auth/reset-password` | publik | `{email, recovery_code, new_password}` (satu dari 8 kode) -> `{remaining_recovery_codes}`; kode itu terpakai, sisanya tetap berlaku; semua sesi dicabut; dicatat di audit semua workspace pengguna; kegagalan seragam `400 INVALID_RECOVERY`; 10/jam per IP, 8/15 menit per email |
| POST | `/auth/change-email` | pengguna dashboard | `{password, new_email}` -> `{user:{id,email}}`; `409 EMAIL_TAKEN`, `400 EMAIL_UNCHANGED`; email tidak diverifikasi |
| POST | `/auth/logout-all` | pengguna dashboard | 204; semua refresh dan access token mati (termasuk perangkat ini) |
| PATCH | `/api-keys/:id` | OWNER | `{name?, scopes?}` (minimal satu; `*` ditolak); `409 INVALID_STATE` bila dicabut; berlaku seketika; diaudit |
| PATCH | `/sessions/:id` | OWNER, MEMBER (atau scope `sessions:write`) | `{session_name}`; `409 SESSION_NAME_TAKEN`, `409 INVALID_STATE` (DELETING) |
| PATCH | `/tenant` | OWNER | `{name}` -> `{id,name,slug}`; diaudit |
| DELETE | `/tenant` | OWNER | `{password, confirm_name}` -> `{deleted:true, sessions_scheduled, purge_after_days}`; `403 INVALID_PASSWORD`, `400 CONFIRMATION_MISMATCH`; 3/jam |

Respons `POST /auth/register` memuat `recovery_codes` (8 kode, sekali tampil, `Cache-Control: no-store`); respons `POST /auth/join-requests` memuatnya hanya untuk akun BARU. `GET /auth/me` memuat `recovery: {codes_remaining, confirmed}` (tanpa nilai kode) untuk banner. Hapus akun sendiri sengaja tidak disediakan.
Aksi audit baru: `account.password_changed|email_changed|recovery_code_created|sessions_revoked`, `api_key.updated`, `session.renamed` (juga event sesi), `tenant.renamed|deleted`. Kode galat baru: `INVALID_PASSWORD` 403, `PASSWORD_UNCHANGED` 400, `INVALID_RECOVERY` 400, `EMAIL_UNCHANGED` 400, `CONFIRMATION_MISMATCH` 400.

**Pemulihan workspace terhapus (publik, dalam masa tunggu `RETENTION_TENANT_DAYS`=30 hari):** `POST /auth/deleted-workspaces` `{email,password}` -> daftar `{tenant_id,name,slug,deleted_at,restorable_until}` (hanya yang pengguna itu OWNER-nya);
`POST /auth/restore-workspace` `{email,password,tenant_id}` -> `{restored:true, tenant, must_recreate:['whatsapp_sessions','webhooks','api_keys','invitations']}` (diaudit `tenant.restored`). Kembali: workspace, anggota, riwayat, pengaturan, audit. Tidak kembali: koneksi WhatsApp, webhook, API key, undangan.
`401 INVALID_CREDENTIALS` (kredensial salah), `404 NOT_FOUND` (bukan OWNER/di luar masa tunggu/sudah aktif); dibatasi seperti login. Audit baru: `join_request.created` (tercatat ke workspace tujuan), `account.password_reset` (ke SETIAP workspace tempat pengguna menjadi anggota), `tenant.restored`.


## Spesifikasi OpenAPI (dihasilkan dari kode)

`docs/02_BACKEND/openapi.json` (OpenAPI 3.1, 75 operasi) adalah rujukan mesin-terbaca untuk kontrak ini; dihasilkan oleh `cd backend && npm run openapi` dan dijaga mutakhir oleh tes (ADR-045). Jangan diedit tangan.
Skema request berasal dari validasi yang sama dengan server; keamanan per operasi (`x-roles`, `x-required-scope`, `x-user-only`) dibaca dari guard nyata. Contoh membuat klien bertipe: `npx openapi-typescript docs/02_BACKEND/openapi.json -o client.d.ts`.
Bila prosa di atas dan `openapi.json` berbeda, `openapi.json` yang benar (ia diperiksa terhadap response asli oleh `npm run test:contract`).

## Ekspor data workspace (ADR-048; kontrak mesin-terbaca di `openapi.json`)

`POST /api/v1/exports/{type}` dengan `type` salah satu `messages`, `outbound`, `chats`, `contacts`, `audit-logs`, `members`. Hanya OWNER pengguna dashboard (API key 403), body strict dengan `password` (kata sandi akun) dan `format` (`csv` bawaan | `ndjson`).
-   Berentang waktu (`messages`, `outbound`, `audit-logs`): `from` dan `to` wajib (ISO-8601 dengan offset, `from < to`, maks `EXPORT_MAX_SPAN_DAYS`=92 hari); filter opsional `session_id`, `direction` (messages), `status` (outbound). `to` di masa depan dipotong ke waktu mulai.
-   Sukses `200`: berkas streaming (`text/csv; charset=utf-8` atau `application/x-ndjson`), header `Content-Disposition: attachment; filename="wazap-<slug>-<jenis>-<YYYYMMDD>.<csv|ndjson>"`, `X-Export-Rows`, `Cache-Control: no-store`. CSV: UTF-8 BOM, CRLF, sel teks berawalan `= + - @` tab/CR diberi awalan `'`. NDJSON: baris terakhir `{"_manifest": {...}}` (tanpa manifest = terpotong).
-   Galat (amplop standar): `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN | INVALID_PASSWORD`, `409 EXPORT_IN_PROGRESS`, `422 EXPORT_TOO_LARGE` (`details: [{max_rows, estimated_rows, capped}]`; ditolak SEBELUM data dikirim), `429 RATE_LIMITED` (+`Retry-After`), `503 SERVICE_UNAVAILABLE | NOT_CONFIGURED` (ekspor dinonaktifkan operator).
-   Kolom tiap jenis adalah bagian dari kontrak (penambahan hanya di akhir). Tidak pernah diekspor: kredensial/auth state WhatsApp, hash/kunci/secret, data tenant lain.
`GET /api/v1/exports/policy` (semua pengguna dashboard): `{enabled, max_rows, max_span_days, per_hour, types, retention: {content_days, row_days, audit_days}}`.
Batas: 5 ekspor per jam per pengguna (ditagih setelah pra-hitung lolos), 5 percobaan kata sandi salah per 15 menit, 1 ekspor per workspace, `EXPORT_MAX_CONCURRENT` per proses. Setiap ekspor tercatat audit `data.exported` (`outcome` = completed | aborted | failed, jumlah baris dan byte).

## Notifikasi alarm (ADR-049)

Hanya OWNER pengguna dashboard (API key 403); `GET /alerts/catalog` boleh semua pengguna dashboard. Target kanal (token bot / URL webhook) dienkripsi dan **tidak pernah dikembalikan** (hanya `target_hint` 4 karakter). Notifikasi tidak memuat nomor telepon pelanggan akhir maupun isi pesan.

| Endpoint | Keterangan |
|---|---|
| `GET /alerts/catalog` | `{enabled, max_channels, channel_types, cooldown, rules[]}` (daftar aturan tetap, ambang dan batasnya, untuk UI) |
| `GET /alerts/channels` | daftar kanal |
| `POST /alerts/channels` | body strict: `{type:'TELEGRAM', name, token, chat_id, password}` atau `{type:'SLACK', name, url, password}` → 201; 422 `INVALID_ALERT_TARGET`; 409 `QUOTA_EXCEEDED`; 403 `INVALID_PASSWORD`; 429 |
| `PATCH /alerts/channels/{id}` | `name`, `active` (tanpa kata sandi) atau target baru (`token`+`chat_id` / `url` + `password`); mengaktifkan ulang atau mengganti target mereset penghitung gagal |
| `DELETE /alerts/channels/{id}` | body `{password}`; kanal dilepas dari aturan |
| `POST /alerts/channels/{id}/test` | kirim pesan uji sinkron; `{ok, status_code, error_code, duration_ms}`; 10 per jam per workspace (429 + `Retry-After`) |
| `GET /alerts/rules` | 8 aturan dengan nilai tersimpan atau bawaan |
| `PUT /alerts/rules/{code}` | `{enabled, threshold?, cooldown_minutes?, channel_ids[]}`; aktif wajib minimal satu kanal; ambang dan jeda hanya untuk aturan yang mendukung |
| `GET /alerts/deliveries?limit` | riwayat terbaru (1-100): `status` PENDING/SENT/DEAD, `last_error_code` (mis. `HTTP_401`, `RATE_CAPPED`, `CHANNEL_INACTIVE`) |

`ALERTS_ENABLED=false` → semua operasi pengelolaan 503 `NOT_CONFIGURED` (kecuali baca); konfigurasi tetap tersimpan. Aturan: `session.logged_out`, `session.disconnected_long`, `session.reconnect_loop`, `webhook.endpoint_disabled`, `webhook.dead_burst`, `message.failed_burst`, `message.unknown`, `export.completed`.

## Konsol platform (ADR-054) --- BUKAN bagian API pelanggan

Seluruh `/api/v1/platform/*`. Token platform (`Authorization: Bearer`) BERBEDA dari token workspace dan API key (kunci dan klaim lain; tidak saling sah). MFA TOTP wajib; akun dibuat hanya lewat CLI server. `PLATFORM_ENABLED=false` membuat semuanya 404. Respons tidak pernah di-cache (`Cache-Control: no-store`). Platform admin hanya melihat metadata dan agregat (tanpa isi pesan, kontak, kredensial, target alarm, kunci API); dijaga tes pemindai sumber dan tes isi respons.

| Method | Path | Isi |
|---|---|---|
| POST | `/platform/auth/login` | `{email, password}` -> `{mfa_token, expires_in}` (galat seragam `401 INVALID_CREDENTIALS`; terkunci `429 ACCOUNT_LOCKED`) |
| POST | `/platform/auth/verify` | `{mfa_token, code}` (kode TOTP 6 digit atau kode pemulihan) -> `{access_token, expires_in, admin, recovery_remaining}`; `401 INVALID_OTP`, `401 INVALID_MFA_TOKEN`, `429` |
| GET | `/platform/me` | `{user_id, email}` |
| GET | `/platform/workspaces?q&status&page&page_size` | ringkasan: `{id,name,slug,status,created_at,suspended_at,limits,used:{sessions,sessions_connected,api_keys,members},owners[]}`; bawaan ACTIVE+SUSPENDED; `status=DELETED|ALL`; `q` = nama, slug, surel OWNER |
| GET | `/platform/workspaces/:id` | ringkasan + `members_by_role`, `pending_invitations`, `owner_accounts`, `quota_used` (anggota termasuk undangan tertunda), `minimums`, `ceilings`, `history` (20 perubahan platform terakhir) |
| PATCH | `/platform/workspaces/:id/quotas` | `{max_sessions?,max_api_keys?,max_members?,messages_per_minute?, reason(3..500), otp}` -> kuota baru. TOTP SEGAR (sekali pakai), alasan wajib. Urutan: pra-periksa input (kode TIDAK dikonsumsi bila salah), konsumsi kode, tulis. `400` di luar [minimum, batas mutlak `LIMIT_CEIL_*`], `409 LIMIT_BELOW_USAGE`, `409 NO_CHANGE`, `404` (tidak ada/terhapus), `401 INVALID_OTP`. Tercatat di audit platform (dengan alasan) dan di audit workspace (`tenant.quota_changed`, `actor.email=platform`, tanpa alasan) |
| GET | `/platform/defaults` | kuota bawaan workspace baru `{limits, minimums, ceilings, updated_at}` |
| PATCH | `/platform/defaults` | `{...kuota, reason, otp}`; tidak mengubah workspace yang ada |
| GET | `/platform/audit?tenant_id&action&page&page_size` | jejak audit platform, terbaru dulu |
| GET | `/platform/backup-status` | `{configured, available, status:{updated_at,last_success_at,last_failure_at,last_failure_reason,last_file,last_size_bytes,location,offsite_ok_at}, age_hours, stale, max_age_hours, reason}`; hanya-baca dari berkas yang ditulis `backup-run.sh` |
| POST | `/platform/workspaces/:id/suspend` | `{reason(3..500), otp}` -> `{id,status:SUSPENDED,suspended_at,sessions_affected}`. TOTP segar, alasan wajib, pra-periksa tanpa mengonsumsi kode. `409 INVALID_STATE` bila sudah ditangguhkan, `404` bila tidak ada/terhapus. Dapat dipulihkan, tidak menghapus data |
| POST | `/platform/workspaces/:id/activate` | `{reason, otp}` -> `{id,status:ACTIVE,suspended_at:null,sessions_affected}`; `409 INVALID_STATE` bila tidak ditangguhkan |

### Penangguhan workspace (ADR-054): perilaku yang dapat diamati

Workspace `SUSPENDED` (oleh platform): token akses, API key, refresh, pindah workspace, dan penerimaan undangan ke workspace itu ditolak seketika (`401`/`404`); `POST /auth/login` ke workspace itu menjawab `403 WORKSPACE_SUSPENDED` ("Workspace ditangguhkan. Hubungi pemilik platform.") HANYA setelah kata sandi benar (kata sandi salah tetap `401 INVALID_CREDENTIALS` seragam); pengguna yang punya workspace lain tetap dapat masuk ke yang lain. Koneksi Socket.IO diputus (`auth.expired`) pada penyapuan berikutnya (`REALTIME_REVALIDATE_SECONDS`, bawaan 30 dtk). Sesi WhatsApp diputus lewat jalur putus biasa (alasan `tenant_suspended`, kredensial utuh); pengiriman webhook dan notifikasi alarm ditahan, TIDAK dibuang. Saat diaktifkan: akses pulih seketika (token lama berfungsi lagi), sesi yang sebelumnya berniat tersambung disambungkan lagi otomatis (alasan `tenant_reactivated`; yang sengaja diputus pengguna tidak ikut), webhook dan alarm yang tertahan lanjut. Tercatat sebagai `tenant.suspended`/`tenant.reactivated` di audit workspace (`actor.email=platform`, tanpa alasan).

