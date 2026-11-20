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

