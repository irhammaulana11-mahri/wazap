# Test Plan

## Test layers

-   Unit: services, state transitions, validators, scheduling.
-   Integration: PostgreSQL transactions, RLS, queue claim, lease.
-   Contract: OpenAPI, REST schemas, Socket.IO and webhook payloads.
-   E2E: registration through session connection and message job
    lifecycle.
-   Security: tenant isolation, auth, API scopes, SSRF, secret leakage.
-   Resilience: engine crash, worker crash, DB interruption, network
    disconnect.
-   Load: concurrent API submissions, active sessions, queue throughput,
    DB pool.

## Test environment

Use test tenant, test numbers/accounts, isolated database and explicit
cleanup. Never run destructive or load tests against production WhatsApp
accounts without approval.

## Required evidence

Record test command, environment, result, logs (sanitized), and commit
hash.

## Status pengujian (Fase G, 2026-11-19)

-   `npm test`: 193 tes (unit + integrasi DB + realtime + e2e), stabil 2 kali berturut-turut. `npm run test:perf`: 6 validasi
    EXPLAIN + throughput dasar pada ~1,3 juta baris (di luar `npm test`).
-   Uji manual dengan WhatsApp nyata (lolos): pairing QR, kirim teks/media/bulk, receipt DELIVERED/READ, pesan masuk, webhook
    (tanda tangan), restart tanpa QR, unlink, nomor tidak terdaftar, idempotensi.
-   **Belum ada:** uji beban multi-koneksi/multi-sesi, uji ketahanan (chaos: kill engine saat kirim di lingkungan nyata),
    SAST/DAST, uji penetrasi, uji frontend end-to-end, uji pemisahan role DB.
