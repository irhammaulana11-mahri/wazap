# Queue Design

## Phase 1

PostgreSQL durable queue. Claim jobs in transactions using
`FOR UPDATE SKIP LOCKED`. Use short transactions; do not hold DB locks
while sending over network.

## Scheduling

-   Fair scheduling across tenants.
-   Per-session outbound serial lane by default.
-   Separate inbound event processing from outbound queue.
-   Configurable per-tenant and per-session concurrency/rate limits.
-   Priority and scheduled_at support.
-   Bounded retry with exponential backoff and jitter.
-   Dead-letter/reconciliation state.

## Job state

`PENDING` -\> `PROCESSING` -\> `SENT` / `FAILED` / `UNKNOWN`. Optional
`RETRY_WAIT`, `CANCELLED`, `RECONCILIATION_REQUIRED`.

## Reliability

-   API idempotency key prevents duplicate job creation.
-   Attempt history is append-only.
-   A processing lease/visibility timeout recovers abandoned jobs.
-   Do not blindly retry when send outcome is ambiguous.
-   Use provider message identifier when available.
-   Use outbox for status events/webhooks.
-   Do not claim exactly-once delivery.

## Scaling

Move queue to Redis/BullMQ or broker only after measured PostgreSQL
contention/throughput need. Preserve job contract and status semantics
during migration.

## Implementasi (Fase E, 2026-11-19)

Kode: `modules/messaging/{messages.service,messages.routes}.ts` (tenant),
`modules/engine/message-queue.ts` (klaim/selesai/reap, platform),
`modules/engine/session-runner.ts` (pompa kirim), migrasi 0004.

-   **Status:** `PENDING` -> `PROCESSING` -> `SENT` | `FAILED` | `UNKNOWN`;
    `CANCELLED`; `RECONCILIATION_REQUIRED`; `DELIVERED`/`READ` dicadangkan
    (tanda terima, Fase F). Retry = kembali ke `PENDING` dengan `scheduled_at`
    di masa depan (tanpa status RETRY_WAIT terpisah).
-   **Submit:** validasi (nomor internasional 8-15 digit, tanpa kode negara
    implisit; teks <= `MESSAGE_MAX_LENGTH`), sesi harus milik tenant dan
    berstatus PENDING_ASSIGNMENT/INITIALIZING/CONNECTING/CONNECTED/RECONNECTING
    dengan desired CONNECTED (selain itu 409 `SESSION_UNAVAILABLE`), batas
    `MAX_PENDING_PER_TENANT` (429 `QUEUE_FULL`). `priority` 0-9 (besar dulu),
    `scheduled_at` (<= 7 hari).
-   **Idempotensi:** unique `(tenant_id, idempotency_key)` + `request_hash`
    (sha256 sesi|to|type|text|priority|jadwal). Kunci sama + hash sama => job yang
    sama (`Idempotent-Replayed: true`); hash beda => 422. 10 request paralel =>
    1 job (diuji). Tanpa header => tidak ada dedupe.
-   **Klaim:** per sesi, urut `priority DESC, scheduled_at, created_at`;
    advisory lock per tenant menserialkan pengecekan batas pesan/menit
    (jendela 60 dtk dari `message_attempts`). Batas tercapai => `wait`, job tetap
    PENDING. Jeda antar kirim dalam sesi: `SESSION_SEND_INTERVAL_MS` (+ jitter
    0-50%).
-   **Hasil adapter:** `sent`; `retry` (NOT_CONNECTED/transient, aman diulang,
    backoff `min(max, base*2^(n-1))` jitter 50-100%, batas `max_attempts` =>
    FAILED `MAX_ATTEMPTS_REACHED`); `failed` (nomor tidak terdaftar,
    permanen); `unknown` (ambigu, tanpa retry otomatis).
-   **Pemulihan (control-plane):** PROCESSING melewati
    `MESSAGE_PROCESSING_TIMEOUT_SECONDS` => `RECONCILIATION_REQUIRED` +
    attempt `ABANDONED`; PENDING lebih tua dari `MESSAGE_TTL_SECONDS` (dari
    `scheduled_at`) => FAILED `EXPIRED`; sesi DELETED => PENDING dibatalkan
    `SESSION_DELETED`.
-   **Graceful:** disconnect/shutdown menunggu pengiriman yang sedang berjalan
    (maks timeout kirim + 2 dtk) sebelum menutup socket.
-   **Fencing:** hasil job ditulis lewat `withFence`; engine yang kehilangan
    lease ditolak dan job direkonsiliasi (aman, bukan dikirim ulang).
-   **Privasi:** isi pesan dan nomor tujuan disimpan di `payload`/`recipient`
    dan TIDAK dicatat di log. Retensi/penghapusan isi pesan belum ada.
-   **Belum:** media (`send-media`), `bulk`, kontak/chat, pesan masuk
    (`wa_messages`), status DELIVERED/READ, outbox/webhook (Fase F),
    LISTEN/NOTIFY (pompa polling `QUEUE_POLL_MS`).

## Pembaruan Fase F

-   **Media:** job `image|video|audio|document`; payload `{url,caption?,filename?,mimetype?}`.
    Engine mengunduh (anti-SSRF, `MEDIA_MAX_BYTES`, tanpa redirect, tipe divalidasi) lalu
    `sendMedia`. Kegagalan unduh terjadi sebelum kirim: sementara => `retry`, permanen
    => `failed` (1 percobaan). Hasil kirim ambigu tetap `UNKNOWN` seperti teks.
-   **Bulk:** satu transaksi, urutan batch dipertahankan (`scheduled_at` naik 1 mikrodetik
    per item), idempotensi per batch (`<key>#<index>`), batas antrean dihitung untuk
    seluruh batch (advisory lock per tenant); batas pesan/menit tetap saat klaim.
-   **Receipt:** `queue.receipt` (berfencing) memajukan `SENT -> DELIVERED -> READ`;
    receipt terlambat/duplikat tidak memundurkan.
-   **Outbox:** perubahan status job menghasilkan event lewat trigger (ADR-017).
-   **Retensi:** isi/nomor dihapus 30 hari setelah status akhir, baris 180 hari (ADR-022);
    `retry` setelah purge ditolak `CONTENT_PURGED`.
-   **Masih belum:** LISTEN/NOTIFY untuk pompa kirim (masih polling `QUEUE_POLL_MS`);
    batas konkurensi kirim global per engine; unduhan media dibuffer di memori (maks
    `MEDIA_MAX_BYTES` per pengiriman aktif).
