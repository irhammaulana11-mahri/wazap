-- 0002 Session registry, engine registry, lease/fencing, credential reference.
-- search_path = schema target. Bergantung pada 0001 (tenants, ctx_uuid, ctx_text, set_updated_at).
-- Konteks tambahan: app.scope = 'platform' hanya diisi layanan istimewa (control-plane/engine),
-- tidak pernah dari input klien. Akses lintas tenant oleh platform harus eksplisit dan diaudit.

CREATE FUNCTION is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT ctx_text('scope') = 'platform' $$;

-- ===== engine_nodes (platform-level, bukan tenant-owned) =====
CREATE TABLE engine_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_name         varchar(100) NOT NULL UNIQUE CHECK (length(btrim(node_name)) > 0),
  hostname          varchar(255) NOT NULL,
  status            varchar(20)  NOT NULL DEFAULT 'STARTING'
                    CHECK (status IN ('STARTING','HEALTHY','SUSPECT','UNHEALTHY','DRAINING','STOPPED')),
  version           varchar(50)  NOT NULL,
  adapter_version   varchar(50),
  heartbeat_at      timestamptz  NOT NULL DEFAULT now(),
  resource_snapshot jsonb        NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resource_snapshot) = 'object'),
  -- {"max_sessions": int >= 0, "weight": number > 0 (opsional), "min_free_mem_mb": int (opsional)}
  capacity_config   jsonb        NOT NULL CHECK (
                      jsonb_typeof(capacity_config) = 'object'
                      AND (capacity_config->>'max_sessions') ~ '^[0-9]+$'),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_engine_nodes_updated BEFORE UPDATE ON engine_nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_engine_nodes_status ON engine_nodes (status, heartbeat_at);

-- ===== wa_sessions =====
CREATE TABLE wa_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_name   varchar(50)  NOT NULL CHECK (length(btrim(session_name)) >= 2),
  phone_number   varchar(32),
  status         varchar(24)  NOT NULL DEFAULT 'CREATED' CHECK (status IN (
                   'CREATED','PENDING_ASSIGNMENT','INITIALIZING','QR_REQUIRED','CONNECTING','CONNECTED',
                   'RECONNECTING','DISCONNECTING','DISCONNECTED','LOGGED_OUT','ERROR','DELETING','DELETED')),
  status_reason  varchar(100),
  desired_state  varchar(16)  NOT NULL DEFAULT 'DISCONNECTED' CHECK (desired_state IN ('CONNECTED','DISCONNECTED')),
  adapter        varchar(32)  NOT NULL DEFAULT 'BAILEYS' CHECK (adapter IN ('BAILEYS')),
  engine_id      uuid REFERENCES engine_nodes(id) ON DELETE SET NULL,   -- denormalisasi; otoritas = session_leases
  auth_version   integer      NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);
CREATE TRIGGER trg_wa_sessions_updated BEFORE UPDATE ON wa_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Nama unik per tenant selama sesi belum dihapus; nomor WhatsApp tidak boleh ganda dalam satu tenant.
CREATE UNIQUE INDEX uq_wa_sessions_name  ON wa_sessions (tenant_id, lower(session_name)) WHERE status NOT IN ('DELETING','DELETED');
CREATE UNIQUE INDEX uq_wa_sessions_phone ON wa_sessions (tenant_id, phone_number) WHERE phone_number IS NOT NULL AND status NOT IN ('DELETING','DELETED');
CREATE INDEX idx_wa_sessions_tenant ON wa_sessions (tenant_id, created_at DESC);
CREATE INDEX idx_wa_sessions_pending ON wa_sessions (updated_at) WHERE status = 'PENDING_ASSIGNMENT';
CREATE INDEX idx_wa_sessions_finalize ON wa_sessions (updated_at) WHERE status IN ('DISCONNECTING','DELETING');
CREATE INDEX idx_wa_sessions_engine ON wa_sessions (engine_id) WHERE engine_id IS NOT NULL;

-- ===== wa_session_events (append-only) =====
CREATE TABLE wa_session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  session_id  uuid        NOT NULL,
  event_type  varchar(64) NOT NULL,
  from_status varchar(24),
  to_status   varchar(24),
  actor       varchar(16) NOT NULL CHECK (actor IN ('USER','API_KEY','SYSTEM','ENGINE')),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),  -- sudah disanitasi; tanpa QR/secret
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_wa_session_events_session ON wa_session_events (session_id, id DESC);

-- ===== session_leases: satu baris per sesi, tidak pernah dihapus agar fencing_token monoton =====
CREATE TABLE session_leases (
  session_id       uuid PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  engine_id        uuid REFERENCES engine_nodes(id) ON DELETE RESTRICT,
  lease_expires_at timestamptz,
  fencing_token    bigint      NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  acquired_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE,
  CHECK ((engine_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX idx_session_leases_expiry ON session_leases (lease_expires_at) WHERE engine_id IS NOT NULL;
CREATE INDEX idx_session_leases_engine ON session_leases (engine_id) WHERE engine_id IS NOT NULL;

-- Trigger: fencing_token tidak boleh turun (monoton) dan tidak boleh mundur oleh UPDATE apa pun.
CREATE FUNCTION enforce_fencing_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'fencing_token tidak boleh turun' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.engine_id IS NOT NULL AND NEW.engine_id IS DISTINCT FROM OLD.engine_id AND NEW.fencing_token = OLD.fencing_token THEN
    RAISE EXCEPTION 'perpindahan owner wajib menaikkan fencing_token' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leases_fencing BEFORE UPDATE ON session_leases FOR EACH ROW EXECUTE FUNCTION enforce_fencing_monotonic();

-- ===== session_credentials: hanya referensi ke storage terenkripsi; tidak ada plaintext =====
CREATE TABLE session_credentials (
  session_id             uuid PRIMARY KEY,
  tenant_id              uuid         NOT NULL,
  storage_key            varchar(255) NOT NULL,
  encryption_key_version integer      NOT NULL CHECK (encryption_key_version > 0),
  auth_version           integer      NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE TRIGGER trg_session_credentials_updated BEFORE UPDATE ON session_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ RLS ============
ALTER TABLE engine_nodes         ENABLE ROW LEVEL SECURITY; ALTER TABLE engine_nodes         FORCE ROW LEVEL SECURITY;
ALTER TABLE wa_sessions          ENABLE ROW LEVEL SECURITY; ALTER TABLE wa_sessions          FORCE ROW LEVEL SECURITY;
ALTER TABLE wa_session_events    ENABLE ROW LEVEL SECURITY; ALTER TABLE wa_session_events    FORCE ROW LEVEL SECURITY;
ALTER TABLE session_leases       ENABLE ROW LEVEL SECURITY; ALTER TABLE session_leases       FORCE ROW LEVEL SECURITY;
ALTER TABLE session_credentials  ENABLE ROW LEVEL SECURITY; ALTER TABLE session_credentials  FORCE ROW LEVEL SECURITY;

-- Engine & credential reference: hanya layanan platform.
CREATE POLICY engine_nodes_platform ON engine_nodes FOR ALL USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY session_credentials_platform ON session_credentials FOR ALL USING (is_platform()) WITH CHECK (is_platform());

CREATE POLICY wa_sessions_all ON wa_sessions FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform())
  WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());

-- Event: append-only (tanpa kebijakan UPDATE/DELETE).
CREATE POLICY wa_session_events_select ON wa_session_events FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY wa_session_events_insert ON wa_session_events FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());

CREATE POLICY session_leases_all ON session_leases FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id') OR is_platform())
  WITH CHECK (tenant_id = ctx_uuid('tenant_id') OR is_platform());
