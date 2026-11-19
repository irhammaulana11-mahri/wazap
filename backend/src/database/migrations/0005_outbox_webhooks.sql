-- Fase F1: transactional outbox + webhook (endpoint, delivery, attempt).

-- ===== outbox_events: ditulis TRIGGER dalam transaksi yang sama dengan perubahan status =====
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  aggregate_type varchar(32) NOT NULL,
  aggregate_id   uuid        NOT NULL,
  event_type     varchar(48) NOT NULL,
  payload        jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status         varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DISPATCHED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  CHECK ((status = 'DISPATCHED') = (dispatched_at IS NOT NULL))
);
CREATE INDEX idx_outbox_pending ON outbox_events (created_at, id) WHERE status = 'PENDING';
CREATE INDEX idx_outbox_dispatched ON outbox_events (dispatched_at) WHERE status = 'DISPATCHED';

-- Sesi: setiap baris wa_session_events (perubahan status) => event session.status. Tanpa QR/secret (payload sudah disanitasi).
CREATE FUNCTION outbox_from_session_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_status IS NULL THEN RETURN NEW; END IF;
  INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (NEW.tenant_id, 'session', NEW.session_id, 'session.status', jsonb_build_object(
    'session_id', NEW.session_id, 'status', NEW.to_status, 'previous_status', NEW.from_status,
    'reason', NEW.payload->>'reason', 'actor', NEW.actor));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outbox_session_event AFTER INSERT ON wa_session_events FOR EACH ROW EXECUTE FUNCTION outbox_from_session_event();

-- Pesan: perubahan status yang bermakna bagi klien. Tanpa isi pesan.
CREATE FUNCTION outbox_from_message_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  ev := CASE NEW.status
    WHEN 'SENT' THEN 'message.sent'
    WHEN 'DELIVERED' THEN 'message.delivered'
    WHEN 'READ' THEN 'message.read'
    WHEN 'FAILED' THEN 'message.failed'
    WHEN 'UNKNOWN' THEN 'message.unknown'
    WHEN 'RECONCILIATION_REQUIRED' THEN 'message.unknown'
    WHEN 'CANCELLED' THEN 'message.cancelled'
    ELSE NULL END;
  IF ev IS NULL THEN RETURN NEW; END IF;
  INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (NEW.tenant_id, 'message', NEW.id, ev, jsonb_build_object(
    'message_id', NEW.id, 'session_id', NEW.session_id, 'to', NEW.recipient, 'status', NEW.status,
    'provider_message_id', NEW.provider_message_id, 'error_code', NEW.last_error_code, 'attempts', NEW.attempts));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outbox_message_status AFTER UPDATE OF status ON message_queue FOR EACH ROW EXECUTE FUNCTION outbox_from_message_status();

-- ===== webhook_endpoints =====
CREATE TABLE webhook_endpoints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url                varchar(2048) NOT NULL CHECK (url ~ '^https?://'),
  description        varchar(200),
  events             text[]       NOT NULL DEFAULT ARRAY['*'] CHECK (cardinality(events) BETWEEN 1 AND 32),
  secret_ciphertext  bytea        NOT NULL,
  secret_key_version integer      NOT NULL CHECK (secret_key_version > 0),
  secret_hint        varchar(8)   NOT NULL,
  active             boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id, created_at DESC);
CREATE TRIGGER trg_webhook_endpoints_updated BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== webhook_deliveries: satu per (endpoint, event) =====
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  endpoint_id      uuid        NOT NULL,
  event_id         uuid        NOT NULL,
  event_type       varchar(48) NOT NULL,
  payload          jsonb       NOT NULL,
  status           varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','DEAD')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer     NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_status_code integer,
  last_error_code  varchar(48),
  last_duration_ms integer,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_webhook_deliveries_claim ON webhook_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC, id);
CREATE TRIGGER trg_webhook_deliveries_updated BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== webhook_delivery_attempts: metadata respons tersanitasi (tanpa body/header respons) =====
CREATE TABLE webhook_delivery_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  delivery_id    uuid        NOT NULL,
  attempt_number integer     NOT NULL CHECK (attempt_number > 0),
  started_at     timestamptz NOT NULL DEFAULT now(),
  duration_ms    integer,
  status_code    integer,
  error_code     varchar(48),
  outcome        varchar(16) NOT NULL CHECK (outcome IN ('DELIVERED','RETRY','DEAD')),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES webhook_deliveries (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_webhook_attempts_delivery ON webhook_delivery_attempts (delivery_id, id);

-- ===== RLS =====
ALTER TABLE outbox_events              ENABLE ROW LEVEL SECURITY; ALTER TABLE outbox_events              FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints          ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_endpoints          FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries         ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_deliveries         FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_attempts  ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_delivery_attempts  FORCE ROW LEVEL SECURITY;

-- Outbox: tenant hanya MENULIS (lewat trigger dalam konteksnya); baca/ubah/hapus hanya platform (relay).
CREATE POLICY outbox_insert ON outbox_events FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY outbox_platform_select ON outbox_events FOR SELECT USING (is_platform());
CREATE POLICY outbox_platform_update ON outbox_events FOR UPDATE USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY outbox_platform_delete ON outbox_events FOR DELETE USING (is_platform());

CREATE POLICY webhook_endpoints_all ON webhook_endpoints FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform())
  WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY webhook_deliveries_all ON webhook_deliveries FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform())
  WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY webhook_attempts_select ON webhook_delivery_attempts FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY webhook_attempts_insert ON webhook_delivery_attempts FOR INSERT WITH CHECK (is_platform());
