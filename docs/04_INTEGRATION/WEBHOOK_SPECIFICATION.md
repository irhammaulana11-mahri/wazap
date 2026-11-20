# Webhook Specification

## Events

-   `session.status`
-   `message.incoming`
-   `message.sent`
-   `message.delivered` when confirmed
-   `message.read` when confirmed
-   `message.failed`
-   `message.unknown`

## Envelope

``` json
{
  "event_id": "uuid",
  "event": "message.sent",
  "occurred_at": "ISO-8601",
  "data": {}
}
```

## Security

-   HMAC signature over timestamp and raw body.
-   Include timestamp and event ID.
-   Verify HTTPS endpoints; block private/internal network targets
    unless explicitly allowed by platform policy.
-   Protect against SSRF, redirects to private IPs, DNS rebinding and
    unsafe schemes.
-   Secrets are stored encrypted and shown once.
-   Rotate webhook secrets.

## Delivery

-   Transactional outbox.
-   Bounded timeout.
-   Exponential retry with jitter.
-   Delivery attempts and sanitized response metadata.
-   Dead-letter state and manual replay.
-   Consumers should deduplicate by event_id.

## Implementasi (Fase F1, 2026-11-19)

### Event dan payload `data`

| Event | Pemicu | `data` |
|---|---|---|
| `session.status` | setiap perubahan status sesi | `{session_id,status,previous_status,reason,actor}` |
| `message.sent` | job `SENT` (diterima server WhatsApp) | `{message_id,session_id,to,status,provider_message_id,error_code,attempts}` |
| `message.delivered` / `message.read` | receipt WhatsApp | idem |
| `message.failed` | gagal pasti | idem (`error_code`) |
| `message.unknown` | `UNKNOWN` atau `RECONCILIATION_REQUIRED` | idem (`status` membedakan) |
| `message.cancelled` | dibatalkan klien / sesi dihapus | idem |
| `message.incoming` | pesan masuk 1:1 | `{message_id,session_id,chat_id,from,from_name,type,text,provider_message_id,received_at}` |
| `webhook.test` | `POST /webhooks/:id/test` (tanpa filter langganan) | `{message}` |

Isi pesan KELUAR tidak pernah ada di event. `message.incoming.text` memuat teks
(atau caption) pesan masuk.

### Pengiriman

`POST` JSON ke URL endpoint, body = envelope `{event_id,event,occurred_at,data}`.

| Header | Isi |
|---|---|
| `X-Wazap-Event-Id` | sama dengan `event_id` (kunci dedup; tetap sama pada setiap retry) |
| `X-Wazap-Event` | nama event |
| `X-Wazap-Delivery-Id` | id delivery |
| `X-Wazap-Timestamp` | detik epoch saat percobaan ini |
| `X-Wazap-Signature` | `v1=` + hex HMAC-SHA256(secret, `"<timestamp>.<rawBody>"`) |

Verifikasi penerima: hitung ulang HMAC atas **raw body** persis seperti diterima,
bandingkan constant-time, tolak bila `|now - timestamp| > 300` detik.
Contoh (Node): `crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex')`.

Sukses = respons 2xx dalam `WEBHOOK_TIMEOUT_MS`. Selain itu (non-2xx, 3xx --- redirect
TIDAK diikuti, timeout, galat jaringan/TLS) = gagal dan dicoba ulang dengan backoff
eksponensial `base*2^(n-1)` (maks `WEBHOOK_RETRY_MAX_MS`) + jitter 50-100%, hingga
`WEBHOOK_MAX_ATTEMPTS` (default 8) lalu `DEAD`. Langsung `DEAD` (tanpa retry):
URL tak valid / target internal terblokir, endpoint nonaktif/terhapus, secret tak
terbaca. Replay manual untuk `DEAD`. Jaminan: **at-least-once**, urutan tidak
dijamin, dedup lewat `event_id`. Body respons penerima tidak disimpan.

Retensi: delivery selesai dihapus setelah `RETENTION_WEBHOOK_DELIVERY_DAYS` (30);
outbox `DISPATCHED` setelah 7 hari (ADR-022).

## Circuit breaker (Fase G)

Setelah `WEBHOOK_AUTO_DISABLE_AFTER` (default 10) delivery `DEAD` berturut-turut, endpoint dinonaktifkan otomatis
(`active=false`, `disabled_reason=AUTO_CONSECUTIVE_FAILURES`). Event baru tidak lagi dikirim ke endpoint tersebut; delivery
tertunda menjadi `DEAD` (`ENDPOINT_INACTIVE`) dan dapat di-replay setelah endpoint diaktifkan lagi. Satu delivery sukses
mereset hitungan; percobaan yang masih akan di-retry dan `webhook.test` tidak dihitung. Pastikan endpoint Anda memantau
status ini (`GET /webhooks`) atau pantau lonjakan `DEAD` di `GET /webhooks/:id/deliveries?status=DEAD`.

## Terbukti dengan penerima nyata (2026-11-20)

-   Tanda tangan `v1=` valid pada 18/18 permintaan; header `X-Wazap-Event-Id` sama dengan `event_id` di body.
-   Retry: `event_id` dan `delivery_id` TETAP pada semua percobaan (500, 500, 200; jeda ~9 dan ~16 dtk). **Urutan tidak dijamin**: `message.delivered` dapat tiba sebelum `message.sent` saat salah satunya sedang di-retry; konsumen harus idempoten dan tidak bergantung pada urutan.
-   Replay mengirim ulang event yang sama dengan `event_id` dan `delivery_id` yang sama (sama dengan retry di mata penerima).
-   Redirect 302 tidak diikuti: dicatat gagal (`HTTP_ERROR`) dan di-retry. Pemeriksaan SSRF juga berlaku saat pendaftaran URL (422 `INVALID_WEBHOOK_URL`).
-   `message.incoming.text` bisa `null` untuk media tanpa caption (gambar, video, dokumen); isi media tidak dibawa.
