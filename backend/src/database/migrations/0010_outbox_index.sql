-- Fase G: hasil validasi EXPLAIN pada 200k event outbox. Penyapu retensi (`WHERE status='DISPATCHED' AND dispatched_at < ...
-- ORDER BY dispatched_at LIMIT n`) memakai Seq Scan + Sort (~100 ms) dengan indeks parsial lama; indeks komposit
-- (status, dispatched_at) membuatnya Index Scan terurut (~0,6 ms).
DROP INDEX idx_outbox_dispatched;
CREATE INDEX idx_outbox_status_dispatched ON outbox_events (status, dispatched_at);
