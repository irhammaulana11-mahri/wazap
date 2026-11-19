# Socket.IO Event Contract

## Connection

Authenticate socket connection using the supported secure access token.
Server derives tenant and user permissions. Never accept arbitrary room
names from the client.

## Events to client

-   `session.created`
-   `session.qr`
-   `session.status`
-   `session.connected`
-   `session.disconnected`
-   `session.reconnecting`
-   `message.incoming`
-   `message.status`
-   `message.failed`
-   `queue.updated`

## Event envelope

``` json
{
  "event_id": "uuid",
  "event": "message.status",
  "occurred_at": "ISO-8601",
  "tenant_id": "uuid",
  "data": {}
}
```

Tenant ID is informational; authorization is enforced by server-side
room membership.

## Rules

-   QR payload is ephemeral and sent only to authorized session
    managers.
-   Do not broadcast secrets or auth state.
-   Client must refetch state after reconnect because events may be
    missed.
-   Include event ID for deduplication.
-   Document payload schema and version every event.

## Implementasi (Fase F2, 2026-11-19)

**Koneksi:** Socket.IO path `/api/v1/realtime`, `io(url, { path: '/api/v1/realtime',
auth: { token: '<access token atau API key>' } })`. Token HANYA via `auth.token`
(query string diabaikan). Gagal handshake: `connect_error` dengan
`err.data.code` = `UNAUTHENTICATED` | `FORBIDDEN` (kredensial tanpa hak realtime) |
`TOO_MANY_CONNECTIONS` (maks `REALTIME_MAX_SOCKETS_PER_TENANT` per instans).

**Room (ditentukan server, klien tidak bisa memilih/join):**
`sessions` (semua yang punya akses baca sesi), `messages`, `qr` (hanya OWNER/ADMIN/MEMBER
atau scope `sessions:write`). VIEWER mendapat `sessions`+`messages`. API key: `sessions:read`
=> sessions, `messages:read` => messages, `sessions:write` => qr. Klien tidak dapat mengirim
event (tanpa handler; buffer masuk 4 KB).

**Event ke klien** (envelope `{v:1,event_id,event,occurred_at,tenant_id,data}`):

| Event | Room | `data` |
|---|---|---|
| `ready` | --- | `{v,tenant_id,rooms}` (sekali, setelah terhubung) |
| `session.status` | sessions | `{session_id,status,previous_status,reason,actor}` |
| `session.created` / `connected` / `disconnected` / `reconnecting` | sessions | idem (alias dari status terkait; `event_id` sama dengan `session.status`) |
| `session.qr` | qr | `{session_id,expires_in}` --- **sinyal saja**; ambil QR via `GET /sessions/:id/qr` |
| `message.status` | messages | `{message_id,session_id,to,status,provider_message_id,error_code,attempts}` (SENT/DELIVERED/READ/FAILED/UNKNOWN/RECONCILIATION_REQUIRED/CANCELLED) |
| `message.failed` | messages | idem (tambahan khusus FAILED) |
| `message.incoming` | messages | `{message_id,session_id,chat_id,from,from_name,type,text,provider_message_id,received_at}` |
| `realtime.resync` | semua | `{v}` --- listener server pulih; event mungkin terlewat, muat ulang state |
| `auth.expired` | --- | `{v}` --- kredensial kedaluwarsa/dicabut; koneksi diputus, login/refresh lalu sambung ulang |

Kredensial divalidasi ulang tiap `REALTIME_REVALIDATE_SECONDS` (30 dtk): token kedaluwarsa atau API key
dicabut => `auth.expired` + putus; perubahan role menyesuaikan room tanpa putus.

**Tidak diimplementasikan:** `queue.updated` (gunakan `message.status`). Tidak ada replay
berdasarkan event id; klien WAJIB memuat ulang state (`GET /sessions`, `/messages`) setelah
(re)connect. Dedup per `(event_id, event)`.
