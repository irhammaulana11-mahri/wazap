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
| GET | `/api-keys` | user (semua role) | paginated `?page=1&page_size=20(max 100)`; `meta {page,page_size,total}`; tanpa hash |
| POST | `/api-keys` | user OWNER/ADMIN | body `{name, scopes[], expires_at?}` -> 201 termasuk `key` (**hanya sekali**) |
| DELETE | `/api-keys/:keyId` | user OWNER/ADMIN | revoke idempoten; 404 bila bukan milik tenant |

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
`NOT_IMPLEMENTED` 501, `INTERNAL_ERROR` 500. Setiap respons membawa header
`X-Request-Id` yang sama dengan `request_id` di body error.

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

Otorisasi: pengguna dashboard OWNER/ADMIN/MEMBER boleh menulis, semua role
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

Otorisasi sama dengan menulis sesi (OWNER/ADMIN/MEMBER atau scope
`sessions:write`): QR = kredensial login WhatsApp, VIEWER dan scope baca saja
tidak boleh. Sesi tenant lain => 404. QR berotasi sekitar 20 detik; klien
polling `GET /sessions/:id/qr` (atau `/status`) sampai `CONNECTED`.
Kode error baru: `QR_NOT_AVAILABLE` 409 (status bukan `QR_REQUIRED`, QR belum
ada/kedaluwarsa), `NOT_CONFIGURED` 503 (kunci enkripsi belum diset).
Status/alasan baru dari engine: lihat SESSION_LIFECYCLE (Fase D). QR tidak
pernah muncul di log, event, atau respons selain endpoint ini.

## Implementasi Fase E (messaging, 2026-11-19)

Otorisasi: kirim/cancel/retry = OWNER/ADMIN/MEMBER atau scope `messages:send`;
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

### Pesan media dan bulk (otorisasi sama dengan `send`: OWNER/ADMIN/MEMBER atau `messages:send`)

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

### Webhook (hanya OWNER/ADMIN atau scope `webhooks:manage`)

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
