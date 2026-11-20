# Load Test Plan

## Objective

Determine real capacity of the initial Ubuntu host while existing seven
Python bots and two web applications remain operational.

## Variables

-   Number of connected sessions.
-   Inbound event rate.
-   API request rate.
-   Outbound job submission rate.
-   Message payload/media size.
-   Number of tenants.
-   Queue depth.
-   Worker count.
-   Database connection pool size.

## Measurements

-   CPU and RAM by process.
-   PostgreSQL CPU, memory, connections, locks, query latency.
-   API p50/p95/p99 latency and error rate.
-   Queue wait time and processing duration.
-   Session reconnect frequency.
-   Engine event loop lag.
-   Disk I/O and storage growth.

## Method

1.  Establish baseline with existing workload.
2.  Add one test session and measure.
3.  Increase sessions gradually.
4.  Add concurrent API submissions.
5.  Test queue fairness across tenants.
6.  Restart one worker and verify recovery.
7.  Test database/network interruption.
8.  Stop when guardrails are reached; do not chase a target number.

## Guardrails

Define CPU, memory, DB connection, latency, and queue thresholds before
each run. Do not infer production capacity from a short idle test.
Record exact software versions and test data.

## Hasil awal (Fase G)

Lihat DATABASE_DESIGN §13. Throughput dasar satu proses/satu koneksi: enqueue ~7 ms/pesan (~140/dtk), relay outbox ~1,8 ms/event
(~555/dtk) pada ~1,3 juta baris, PostgreSQL 18 default di mesin dev. Belum ada uji beban multi-koneksi; target dan batas
sebenarnya (sesi per engine, pesan/dtk per sesi) HARUS diukur di infrastruktur target, bukan diasumsikan dari angka ini.

## Hasil uji ketahanan (2026-11-20)
Langkah 6 (restart worker) dan 7 (gangguan database/jaringan) metode di atas kini punya uji otomatis di `backend/test/resilience.test.ts`
(lihat TEST_PLAN). Ini membuktikan kebenaran saat gangguan, BUKAN kapasitas: uji beban multi-sesi tetap harus dijalankan di infrastruktur target.

## Hasil: penyimpanan auth state (2026-11-20; ADR-044)
`node --import tsx --test --test-timeout=300000 test/perf/auth-store.perf.ts` (PostgreSQL lokal, tanpa latensi jaringan). Ambang lulus/gagal ~10x lebih longgar dari hasil terukur.
| Skenario | Terukur |
|---|---|
| Akun 2,8 ribu baris (akun uji nyata) | sinkron awal 130 ms; `open` p95 0,9 ms; `get` p95 0,7 ms; `set` p95 1,3 ms; erase 2 ms |
| Akun besar 30 ribu baris | sinkron awal 0,7-0,9 dtk; `open` p95 2 ms (tidak bergantung jumlah baris); `get` 10 id p95 2 ms; `set` p95 4 ms; erase 14 ms; tabel 11 MB |
| 50 sesi bersamaan, pool 10, jenuh | 6.900-8.900 op/dtk; p95 10-13 ms; 0 galat (kebutuhan realistis ~1.250 op/dtk) |
Belum diukur: DB berjarak (latensi jaringan), laju pesan tinggi dengan Baileys sungguhan, kontensi pool dengan lease/heartbeat pada >20 sesi.
