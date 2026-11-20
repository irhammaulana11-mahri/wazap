-- Notifikasi alarm per workspace (ADR-049): kanal (Telegram/Slack-compatible), aturan, dan antrean pengiriman. Semua tabel RLS ENABLE+FORCE.

CREATE TABLE alert_channels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type                varchar(16)  NOT NULL CHECK (type IN ('TELEGRAM','SLACK')),
  name                varchar(60)  NOT NULL CHECK (length(btrim(name)) >= 1),
  target_ciphertext   bytea        NOT NULL,        -- Telegram: {token,chat_id}; Slack: URL webhook. AES-256-GCM dengan AAD tenant+id
  target_key_version  integer      NOT NULL CHECK (target_key_version > 0),
  target_hint         varchar(8)   NOT NULL,
  active              boolean      NOT NULL DEFAULT true,
  consecutive_failures integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_at         timestamptz,
  disabled_reason     varchar(48),
  created_by          uuid,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (disabled_at IS NULL OR active = false)
);
CREATE INDEX idx_alert_channels_tenant ON alert_channels (tenant_id, created_at DESC);
CREATE TRIGGER trg_alert_channels_updated BEFORE UPDATE ON alert_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alert_rules (
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_code         varchar(40) NOT NULL CHECK (rule_code IN ('session.logged_out','session.disconnected_long','session.reconnect_loop','webhook.endpoint_disabled','webhook.dead_burst','message.failed_burst','message.unknown','export.completed')),
  enabled           boolean     NOT NULL DEFAULT false,
  threshold         integer     CHECK (threshold IS NULL OR threshold BETWEEN 1 AND 100000),
  cooldown_minutes  integer     NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 5 AND 1440),
  channel_ids       uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(channel_ids) <= 5),
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_code)
);

CREATE TABLE alert_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  channel_id       uuid        NOT NULL,
  rule_code        varchar(40) NOT NULL,
  object_key       varchar(64) NOT NULL,
  window_key       varchar(32) NOT NULL,
  payload          jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),   -- fakta tersanitasi (nama sesi, angka); tanpa nomor/isi pesan
  status           varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DEAD')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_status_code integer,
  last_error_code  varchar(48),
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_id, rule_code, object_key, window_key),   -- idempotensi: satu kejadian = satu notifikasi per kanal
  FOREIGN KEY (tenant_id, channel_id) REFERENCES alert_channels (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_alert_deliveries_claim ON alert_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX idx_alert_deliveries_tenant ON alert_deliveries (tenant_id, created_at DESC, id);
CREATE INDEX idx_alert_deliveries_channel_sent ON alert_deliveries (channel_id, sent_at) WHERE status = 'SENT';
CREATE INDEX idx_alert_deliveries_done ON alert_deliveries (created_at) WHERE status <> 'PENDING';
CREATE TRIGGER trg_alert_deliveries_updated BEFORE UPDATE ON alert_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Indeks pendukung evaluator (jendela waktu terakhir, lintas tenant).
CREATE INDEX idx_wa_session_events_time ON wa_session_events (created_at) WHERE to_status IN ('LOGGED_OUT','RECONNECTING','DISCONNECTED');
CREATE INDEX idx_message_queue_alert ON message_queue (updated_at) WHERE status IN ('FAILED','UNKNOWN','RECONCILIATION_REQUIRED');

ALTER TABLE alert_channels   ENABLE ROW LEVEL SECURITY; ALTER TABLE alert_channels   FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_rules      ENABLE ROW LEVEL SECURITY; ALTER TABLE alert_rules      FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE alert_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY alert_channels_all ON alert_channels FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform()) WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY alert_rules_all ON alert_rules FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform()) WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY alert_deliveries_all ON alert_deliveries FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform()) WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());

-- Jejak audit: jenis target baru.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check
  CHECK (target_type IN ('member','invitation','settings','join_request','join_code','account','api_key','session','tenant','export','alert_channel','alert_rule'));
