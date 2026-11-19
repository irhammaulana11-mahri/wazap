-- Fase H2: audit log perubahan tim dan pengaturan tenant (append-only).

CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid,                                  -- tanpa FK: jejak tetap ada walau akun dihapus
  actor_email   varchar(254),                          -- salinan saat kejadian
  actor_role    varchar(20),
  action        varchar(48)  NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type   varchar(24)  NOT NULL CHECK (target_type IN ('member','invitation','settings')),
  target_id     varchar(64),
  target_email  varchar(254),
  details       jsonb        NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),  -- tanpa rahasia/token
  ip            varchar(45),
  request_id    varchar(64),
  created_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_tenant_action ON audit_logs (tenant_id, action, created_at DESC);
CREATE INDEX idx_audit_created ON audit_logs (created_at);

-- Append-only: UPDATE dilarang; DELETE hanya oleh platform (job retensi) atau cascade dari penghapusan tenant.
CREATE FUNCTION audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'audit_logs bersifat append-only' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 AND NOT is_platform() THEN
    RAISE EXCEPTION 'audit_logs hanya dapat dihapus oleh retensi' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_audit_logs_guard BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_logs FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
-- Penerima undangan (belum anggota) hanya boleh mencatat penerimaan undangannya sendiri, dengan token yang valid.
CREATE POLICY audit_insert_accept ON audit_logs FOR INSERT WITH CHECK (
  action = 'invitation.accepted' AND actor_user_id = ctx_uuid('user_id')
  AND EXISTS (SELECT 1 FROM tenant_invitations i WHERE i.tenant_id = audit_logs.tenant_id AND i.token_hash = ctx_text('invite_hash')));
CREATE POLICY audit_delete ON audit_logs FOR DELETE USING (is_platform());
