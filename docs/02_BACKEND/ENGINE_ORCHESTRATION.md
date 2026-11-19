# Engine Orchestration

## Engine registration

Engine registers: - engine_id - hostname - application version - adapter
version - heartbeat timestamp - health status - resource metrics -
configurable capacity - assigned session count

## Placement

Dispatcher chooses a healthy engine using weighted least-loaded
placement. Inputs include memory headroom, CPU, active sessions,
connection health, configured capacity, and tenant policy.

No capacity -\> `PENDING_ASSIGNMENT`; do not overcommit silently.

## Lease

-   One lease per session.
-   Lease has expiry and fencing token.
-   Heartbeat renews lease.
-   Lease expiry triggers controlled recovery.
-   Old owner must be fenced before new owner connects.
-   Credential state must be versioned and safely persisted.

## Failure recovery

1.  Detect stale heartbeat.
2.  Mark engine suspect/unhealthy.
3.  Stop assigning new work.
4.  Determine sessions owned by engine.
5.  Fence old owner and confirm process/socket termination where
    possible.
6.  Recover latest auth state.
7.  Assign new owner with incremented fencing token.
8.  Reconnect and emit lifecycle event.

## Capacity

Capacity is measured empirically. Never hardcode a universal
sessions-per-engine number. Use configurable guardrails and load-test
results.

## Implementasi (Fase C, 2026-11-19)

Kode: `backend/src/modules/engine/{engine.service,lease.service,control-plane}.ts`.

-   **Registrasi/heartbeat:** `register` upsert per `node_name`;
    `heartbeat` memperbarui snapshot dan memulihkan SUSPECT/UNHEALTHY ->
    HEALTHY (tidak untuk DRAINING/STOPPED). `sweep`: HEALTHY -> SUSPECT
    setelah `ENGINE_SUSPECT_AFTER_SECONDS` (30), -> UNHEALTHY setelah
    `ENGINE_UNHEALTHY_AFTER_SECONDS` (60).
-   **Penempatan:** engine HEALTHY dengan heartbeat segar, beban (lease
    aktif) < `max_sessions`, lolos guard memori opsional; urut
    beban/bobot (weighted least-loaded). Tanpa kapasitas, sesi tetap
    `PENDING_ASSIGNMENT` (tidak overcommit). Input CPU belum dipakai
    (hanya `min_free_mem_mb`); bobot dan batas dikonfigurasi, bukan angka asumsi.
-   **Lease:** TTL `ENGINE_LEASE_TTL_SECONDS` (30), heartbeat disarankan
    `ENGINE_HEARTBEAT_SECONDS` (10). API internal: `acquire`, `renew`
    (false => engine WAJIB berhenti), `release`, `withFence`.
-   **Pemulihan (control-plane, tiap `CONTROL_PLANE_INTERVAL_MS`=5000):**
    sweep engine -> kedaluwarsakan lease -> sesi aktif dengan
    `desired_state=CONNECTED` kembali ke PENDING_ASSIGNMENT -> finalisasi
    DISCONNECTING/DELETING tanpa owner -> penempatan adil antar tenant
    (round-robin per tenant, batch 50). Satu sesi per transaksi.
-   **Leader election:** advisory lock sesi; hanya satu control-plane
    aktif. Dijalankan embedded di proses API (`ENABLE_EMBEDDED_CONTROL_PLANE`,
    default true); entrypoint proses terpisah belum dibuat.
-   **Batasan fencing:** fencing menjamin engine lama tidak dapat menulis
    state persisten. Konfirmasi bahwa proses/socket lama benar-benar
    berhenti belum dapat dilakukan sampai engine nyata (Fase D); engine
    harus berhenti sendiri saat `renew` gagal.

## Implementasi (Fase D, 2026-11-19)

-   **EngineRuntime** (`engine-runtime.ts`): `start()` mendaftar node
    (upsert `node_name`; gunakan `ENGINE_NODE_NAME` stabil), memulihkan lease
    yatim milik node ini, lalu loop tiap `ENGINE_SYNC_INTERVAL_MS`: heartbeat +
    snapshot (mem_free_mb, cpu_load1, sessions_running) tiap
    `ENGINE_HEARTBEAT_SECONDS`, memindai lease milik node, memulai
    `SessionRunner` untuk sesi `INITIALIZING`, memperpanjang lease
    (`renew`; gagal => runner `lost`), meminta runner menyelesaikan
    `DISCONNECTING`. `stop()`: DRAINING -> shutdown semua runner -> STOPPED.
-   **Fencing nyata:** auth state, QR, dan status ditulis lewat
    `withFence` (lease dikunci `FOR SHARE`; `lease_expires_at > now()`
    wajib). Engine macet melewati TTL tidak bisa menulis walau belum ada
    takeover. Diuji: engine "zombie" ditolak menulis creds/keys/status dan tidak
    menghapus auth state setelah lease berpindah.
-   **Penghentian proses lama:** tetap tidak dapat dikonfirmasi dari luar
    proses. Mitigasi: runner berhenti sendiri saat `renew`/tulis gagal;
    penulisan persisten dijamin ditolak. Risiko tersisa: socket zombie dapat
    tetap terhubung ke WhatsApp hingga tick berikutnya (<= `ENGINE_SYNC_INTERVAL_MS`
    + `ENGINE_HEARTBEAT_SECONDS`).
-   **Kapasitas:** `ENGINE_MAX_SESSIONS` (default 10) hanyalah pengaman
    konfigurasi, BUKAN hasil benchmark. Tentukan lewat load test (Fase G).
-   **Embedded:** `ENABLE_EMBEDDED_ENGINE=true` menjalankan engine di proses
    API (default dev). Proses engine terpisah belum ada entrypoint-nya.
    Server menolak start (fail fast) bila engine aktif tanpa
    `CREDENTIAL_ENCRYPTION_KEYS`.

## Pembaruan Fase E

`SessionRunner` menjalankan pompa kirim saat `CONNECTED` (berhenti saat putus,
mulai lagi saat tersambung): satu klaim -> kirim -> tulis hasil (berfencing)
-> jeda -> ulang; `wait` dari rate limit/jadwal menentukan tidur berikutnya
(maks 60 dtk), idle polling `QUEUE_POLL_MS`. Control-plane: `reap` pesan
dan pembatalan job saat sesi DELETED; penempatan kini melewati (bukan berhenti
pada) sesi PENDING yang lease-nya masih dipegang pihak lain.
Belum ada batas konkurensi kirim global per engine (hanya serial per sesi).

## Pembaruan Fase F

-   `SessionRunner` kini juga memproses `onMessage` (pesan masuk -> `inbox.record`, berfencing,
    idempoten) dan `onReceipt` (-> `queue.receipt`) dalam antrean peristiwa yang sama
    dengan status, sehingga urutan terjaga. Lease hilang => berhenti lokal tanpa menulis
    (diuji: pesan masuk dari engine zombie tidak tersimpan).
-   Pekerja latar (di proses API bila `ENABLE_EMBEDDED_*`; tanpa leader election karena
    semuanya `FOR UPDATE SKIP LOCKED` dan idempoten): `outbox-relay` (`OUTBOX_POLL_MS`),
    `webhook-deliverer` (`WEBHOOK_POLL_MS`, perlu kunci enkripsi), `retention`
    (`RETENTION_INTERVAL_MINUTES`). Realtime: `attachRealtime` pada server HTTP.
-   Shutdown (LIFO): realtime -> http -> ... pekerja berhenti menunggu iterasi berjalan.
