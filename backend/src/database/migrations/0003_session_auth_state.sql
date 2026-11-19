-- Fase D: penyimpanan auth state terenkripsi + QR sementara.
-- Semua nilai disimpan sebagai blob AES-256-GCM (lihat src/security/credential-crypto.ts); tidak ada plaintext.

-- Satu baris per item auth state (creds, pre-key, session, sender-key, app-state-sync-key, ...).
CREATE TABLE session_auth_state (
  session_id             uuid         NOT NULL,
  tenant_id              uuid         NOT NULL,
  item_type              varchar(64)  NOT NULL,
  item_id                varchar(255) NOT NULL,
  ciphertext             bytea        NOT NULL,
  encryption_key_version integer      NOT NULL CHECK (encryption_key_version > 0),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, item_type, item_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_session_auth_state_keyver ON session_auth_state (encryption_key_version);
CREATE TRIGGER trg_session_auth_state_updated BEFORE UPDATE ON session_auth_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- QR pairing: kredensial login berumur pendek. Ditulis engine (platform), dibaca jalur tenant lewat RLS.
CREATE TABLE session_qr (
  session_id             uuid PRIMARY KEY,
  tenant_id              uuid        NOT NULL,
  ciphertext             bytea       NOT NULL,
  encryption_key_version integer     NOT NULL CHECK (encryption_key_version > 0),
  expires_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE session_auth_state ENABLE ROW LEVEL SECURITY; ALTER TABLE session_auth_state FORCE ROW LEVEL SECURITY;
ALTER TABLE session_qr         ENABLE ROW LEVEL SECURITY; ALTER TABLE session_qr         FORCE ROW LEVEL SECURITY;

-- Auth state: hanya layanan platform (engine). Tenant tidak pernah membacanya.
CREATE POLICY session_auth_state_platform ON session_auth_state FOR ALL USING (is_platform()) WITH CHECK (is_platform());

-- QR: tenant boleh MEMBACA miliknya (ciphertext; dekripsi di API); tulis/hapus hanya platform.
CREATE POLICY session_qr_select ON session_qr FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY session_qr_insert ON session_qr FOR INSERT WITH CHECK (is_platform());
CREATE POLICY session_qr_update ON session_qr FOR UPDATE USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY session_qr_delete ON session_qr FOR DELETE USING (is_platform());
