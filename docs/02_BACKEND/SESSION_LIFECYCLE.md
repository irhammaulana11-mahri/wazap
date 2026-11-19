# Session Lifecycle

## States

`CREATED`, `PENDING_ASSIGNMENT`, `INITIALIZING`, `QR_REQUIRED`,
`CONNECTING`, `CONNECTED`, `RECONNECTING`, `DISCONNECTING`,
`DISCONNECTED`, `LOGGED_OUT`, `ERROR`, `DELETING`, `DELETED`.

## Main transitions

-   Create -\> CREATED -\> PENDING_ASSIGNMENT -\> INITIALIZING.
-   QR required -\> CONNECTING -\> CONNECTED.
-   Temporary network loss -\> RECONNECTING -\> CONNECTED.
-   Authentication invalid/logout -\> LOGGED_OUT or QR_REQUIRED.
-   User disconnect -\> DISCONNECTING -\> DISCONNECTED.
-   Delete -\> DELETING -\> DELETED after cleanup/retention policy.

## Requirements

-   Every transition creates a session event.
-   Transition rules are validated centrally.
-   QR is ephemeral and only emitted to authorized tenant users.
-   Auth state is persisted before reporting stable connection.
-   Network errors do not automatically erase credentials.
-   Logout and credential corruption are distinct from temporary
    disconnect.
-   Reconnect uses bounded exponential backoff with jitter.
-   Engine restart restores sessions using stored auth state.
-   Session deletion revokes ownership and erases credentials according
    to policy.

## Ownership

One active engine owner per session. Lease includes expiry and
monotonically increasing fencing token. Heartbeat and takeover must be
race-safe. A stale engine must not write credentials or process jobs
after losing ownership.

## Baileys caveat

Confirm exact event names and connection behavior against the pinned
Baileys version. Do not assume event semantics from older versions.

## Implementasi (Fase C, 2026-11-19)

-   Aturan transisi terpusat di `backend/src/modules/sessions/lifecycle.ts`
    (`TRANSITIONS`); validasi status asal dilakukan di SQL
    (`WHERE status = ...` setelah `FOR UPDATE`), aman dari race, dan setiap
    transisi menulis `wa_session_events` pada transaksi yang sama.
-   Matriks (dari -> ke): CREATED -> PENDING_ASSIGNMENT|DELETING;
    PENDING_ASSIGNMENT -> INITIALIZING|DISCONNECTED|DELETING;
    INITIALIZING -> QR_REQUIRED|CONNECTING|CONNECTED|ERROR|LOGGED_OUT|
    PENDING_ASSIGNMENT|DISCONNECTING|DELETING; QR_REQUIRED -> CONNECTING|
    ERROR|PENDING_ASSIGNMENT|DISCONNECTING|DELETING; CONNECTING ->
    CONNECTED|QR_REQUIRED|RECONNECTING|ERROR|LOGGED_OUT|PENDING_ASSIGNMENT|
    DISCONNECTING|DELETING; CONNECTED -> RECONNECTING|DISCONNECTING|
    LOGGED_OUT|ERROR|PENDING_ASSIGNMENT|DELETING; RECONNECTING ->
    CONNECTED|QR_REQUIRED|ERROR|LOGGED_OUT|PENDING_ASSIGNMENT|DISCONNECTING|
    DELETING; DISCONNECTING -> DISCONNECTED|ERROR|DELETING; DISCONNECTED,
    LOGGED_OUT -> PENDING_ASSIGNMENT|DELETING; ERROR -> PENDING_ASSIGNMENT|
    DISCONNECTED|DELETING; DELETING -> DELETED; DELETED terminal.
-   `desired_state` mencatat niat pengguna; hanya sesi `CONNECTED` yang
    ditempatkan atau dipulihkan.
-   Perintah API: `connect` (idempoten), `disconnect` (PENDING -> DISCONNECTED
    langsung; sesi yang dimiliki engine -> DISCONNECTING, diselesaikan engine
    atau control-plane setelah lease lepas/kedaluwarsa), `reconnect` (lepas lease
    lalu antre ulang), `delete` (lease dicabut -> DELETING; control-plane
    menghapus referensi kredensial -> DELETED; nama langsung bebas dipakai).
-   Event: `session.created`, `session.status_changed`, `session.assigned`,
    `session.lease_expired`. Payload melewati `sanitizePayload` (membuang
    kunci qr/cred/secret/token/password/auth/api key).
-   **Belum (Fase D):** koneksi Baileys, QR, transisi yang dipicu engine
    (QR_REQUIRED, CONNECTED, RECONNECTING, LOGGED_OUT, ERROR), backoff
    reconnect, penyimpanan kredensial terenkripsi. Tanpa engine,
    sesi tetap PENDING_ASSIGNMENT.

## Implementasi (Fase D, 2026-11-19)

Penggerak: `modules/engine/session-runner.ts` (satu runner per sesi) dan
`engine-runtime.ts`. Aktor event: `ENGINE`. Transisi tambahan yang diizinkan:
`INITIALIZING -> RECONNECTING` (putus saat inisialisasi) dan
`QR_REQUIRED -> CONNECTED` (terbuka tanpa restart).

| Kejadian adapter | Hasil |
|---|---|
| QR baru | QR terenkripsi disimpan (TTL `QR_TTL_SECONDS`); status `QR_REQUIRED` (sekali; rotasi QR tidak membuat event) |
| open | `CONNECTED`, `phone_number` diisi, QR dihapus, hitungan reconnect direset |
| `restart_required` (515, normal setelah pairing) | `QR_REQUIRED -> CONNECTING`, socket baru segera |
| `connection_lost` | `RECONNECTING`, backoff `min(max, base*2^(n-1))` dengan jitter 50-100%; lewat `RECONNECT_MAX_ATTEMPTS` => `ERROR max_reconnect_attempts` |
| `connection_lost` saat `QR_REQUIRED` (QR tidak dipindai) | `ERROR qr_timeout`, lease dilepas (user `connect` lagi untuk QR baru) |
| `logged_out` (401) | `LOGGED_OUT`, **seluruh auth state dihapus**, `desired_state=DISCONNECTED`, lease dilepas; perlu pair ulang |
| `replaced` (440) / `bad_session` | `ERROR` (`connection_replaced` / `bad_session`), tanpa reconnect otomatis (tidak berebut sesi) |
| open tetapi nomor sudah dipakai sesi lain tenant | `ERROR duplicate_phone_number`, socket ditutup |
| user `disconnect` | `DISCONNECTING` -> engine menutup socket TANPA logout, kredensial dipertahankan -> `DISCONNECTED`, lease dilepas |
| user `delete` | lease dicabut; engine meng-unlink (logout best-effort) lalu berhenti; control-plane menghapus auth state+QR+referensi -> `DELETED` |
| user `reconnect` | lease dicabut; runner lama berhenti (tanpa logout); ditempatkan ulang dengan fencing token baru |
| engine shutdown rapi | socket ditutup, lease dilepas, sesi `CONNECTED` desired -> `PENDING_ASSIGNMENT` |
| node restart (lease inkarnasi lama) | saat `start()`: sesi -> `PENDING_ASSIGNMENT` (`session.lease_expired`), lease dilepas, lalu ditempatkan ulang |
| lease hilang / di-fence | runner berhenti lokal; TIDAK menulis apa pun |

Event baru: payload memuat `reason`, `kind`, `code` (tanpa QR/kredensial).

## Pembaruan Fase F

Setiap baris `wa_session_events` yang punya `to_status` menghasilkan event outbox
`session.status` (payload: `session_id,status,previous_status,reason,actor`) --- diteruskan
ke webhook dan Socket.IO (`session.status` + alias `created|connected|disconnected|
reconnecting`). Rotasi QR tidak mengubah status sehingga tidak membuat event outbox; engine
mengirim sinyal realtime `session.qr` (tanpa isi QR) saat QR disimpan.
