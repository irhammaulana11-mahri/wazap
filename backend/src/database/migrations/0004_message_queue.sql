-- Fase E: antrean pesan keluar (PostgreSQL durable queue) + riwayat percobaan append-only.

CREATE TABLE message_queue (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid         NOT NULL,
  session_id            uuid         NOT NULL,
  idempotency_key       varchar(255),
  request_hash          char(64),
  recipient             varchar(20)  NOT NULL CHECK (recipient ~ '^[0-9]{8,15}$'),
  message_type          varchar(16)  NOT NULL DEFAULT 'text' CHECK (message_type IN ('text')),
  payload               jsonb        NOT NULL,
  status                varchar(32)  NOT NULL DEFAULT 'PENDING' CHECK (status IN
    ('PENDING','PROCESSING','SENT','DELIVERED','READ','FAILED','CANCELLED','UNKNOWN','RECONCILIATION_REQUIRED')),
  priority              smallint     NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  attempts              integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts          integer      NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  scheduled_at          timestamptz  NOT NULL DEFAULT now(),
  processing_at         timestamptz,
  processing_expires_at timestamptz,
  processing_engine_id  uuid,
  provider_message_id   varchar(128),
  completed_at          timestamptz,
  last_error_code       varchar(64),
  actor                 varchar(16)  NOT NULL CHECK (actor IN ('USER','API_KEY','SYSTEM')),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CHECK ((status = 'PROCESSING') = (processing_expires_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id)
);
-- Idempotensi submit: satu kunci per tenant.
CREATE UNIQUE INDEX uq_message_queue_idem ON message_queue (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Klaim: lane per sesi, urut prioritas lalu jadwal lalu FIFO.
CREATE INDEX idx_message_queue_claim ON message_queue (session_id, priority DESC, scheduled_at, created_at) WHERE status = 'PENDING';
CREATE INDEX idx_message_queue_processing ON message_queue (processing_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX idx_message_queue_pending_age ON message_queue (scheduled_at) WHERE status = 'PENDING';
CREATE INDEX idx_message_queue_tenant_pending ON message_queue (tenant_id) WHERE status = 'PENDING';
CREATE INDEX idx_message_queue_tenant_list ON message_queue (tenant_id, created_at DESC, id);
CREATE TRIGGER trg_message_queue_updated BEFORE UPDATE ON message_queue FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE message_attempts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  job_id              uuid        NOT NULL,
  attempt_number      integer     NOT NULL CHECK (attempt_number > 0),
  engine_id           uuid,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  outcome             varchar(24) CHECK (outcome IN ('SENT','RETRY','FAILED','UNKNOWN','ABANDONED')),
  provider_message_id varchar(128),
  error_code          varchar(64),
  error_detail        varchar(500),
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (tenant_id, job_id) REFERENCES message_queue (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_message_attempts_rate ON message_attempts (tenant_id, started_at DESC);

-- Append-only: percobaan hanya dapat diselesaikan SEKALI (outcome NULL -> terisi); tidak ada DELETE langsung.
CREATE FUNCTION enforce_attempt_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'message_attempts bersifat append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.outcome IS NOT NULL
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'percobaan yang sudah selesai tidak dapat diubah' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_message_attempts_append_only BEFORE UPDATE ON message_attempts FOR EACH ROW EXECUTE FUNCTION enforce_attempt_append_only();
-- DELETE langsung diblokir, kecuali cascade dari job (pg_trigger_depth > 0).
CREATE FUNCTION enforce_attempt_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'message_attempts bersifat append-only' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_message_attempts_no_delete BEFORE DELETE ON message_attempts FOR EACH ROW EXECUTE FUNCTION enforce_attempt_no_delete();

ALTER TABLE message_queue    ENABLE ROW LEVEL SECURITY; ALTER TABLE message_queue    FORCE ROW LEVEL SECURITY;
ALTER TABLE message_attempts ENABLE ROW LEVEL SECURITY; ALTER TABLE message_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY message_queue_all ON message_queue FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform())
  WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());

-- Percobaan: tenant hanya membaca; tulis hanya platform (engine/control-plane).
CREATE POLICY message_attempts_select ON message_attempts FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY message_attempts_insert ON message_attempts FOR INSERT WITH CHECK (is_platform());
CREATE POLICY message_attempts_update ON message_attempts FOR UPDATE USING (is_platform()) WITH CHECK (is_platform());

-- Engine (platform) perlu MEMBACA batas pesan/menit tenant saat klaim job. Hanya SELECT; tulis tetap tenant.
CREATE POLICY tenant_settings_platform_select ON tenant_settings FOR SELECT USING (is_platform());
