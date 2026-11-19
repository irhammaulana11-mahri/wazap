-- Fase G: circuit breaker webhook. Endpoint yang terus gagal (delivery DEAD berturut-turut) dinonaktifkan otomatis.
ALTER TABLE webhook_endpoints ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0);
ALTER TABLE webhook_endpoints ADD COLUMN disabled_at timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason varchar(48);
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_disabled_consistency CHECK (disabled_at IS NULL OR active = false);
