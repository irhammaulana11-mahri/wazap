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

## Pembaruan (Fase H, 2026-11-19)

`npm test`: 212 tes (193 + Team 10 + Usage 9), stabil 2 kali berturut-turut. `npm run test:perf`: 8 validasi (termasuk kueri usage/filter tanggal dan latensi layanan usage).
Tes Team mencakup matriks peran, OWNER terakhir, balapan dua OWNER, undangan end-to-end, keamanan token, penegakan RLS di tingkat SQL, ditangguhkan/dihapus kehilangan akses,
`switch-tenant`. Tes Usage mencakup batas rentang inklusif-eksklusif, zona waktu Asia/Jakarta (tepat tengah malam lokal), bucket kosong, filter sesi, validasi, otorisasi, isolasi tenant.

## Pembaruan (Fase H2, 2026-11-19; `npm test` kini 230 tes termasuk `config.test.ts`)

`npm test`: 227 tes (212 + Audit 8 + Settings 7), stabil 2 kali. `npm run test:perf`: 9 validasi (audit 100 ribu baris memakai indeks). Tes audit mencakup kelengkapan aksi/pelaku/ip/request_id, tidak ada jejak untuk penolakan/no-op,
tidak ada rahasia di jejak, append-only dan isolasi di tingkat SQL, pemalsuan pencatatan, retensi. Tes settings mencakup izin, rentang/ceiling, di bawah pemakaian, berlaku seketika pada penegakan kuota, audit, kontrol ceiling lewat env.

## Pembaruan (code-review, 2026-11-20)

`npm test`: 238 tes (230 + `review-fixes.test.ts` 8), stabil 2 kali. Regresi mencakup: filter rahasia audit (batas kata), kuota pada reissue, pencabutan undangan (ditangguhkan/diturunkan/dihapus/keluar; promosi dan
undangan lain tidak tersentuh), pencabutan API key saat dihapus (ditangguhkan tidak), zona waktu offset ditolak dan konsisten dengan PostgreSQL, satu definisi kunci tim, dan ceiling yang diturunkan.
