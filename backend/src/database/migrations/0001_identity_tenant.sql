-- 0001 Identity & tenant isolation.
-- Dijalankan dengan search_path = schema target (default: gateway). Semua nama tanpa kualifikasi schema.
-- Konteks RLS dibaca dari setting transaksi-lokal: app.tenant_id, app.user_id,
-- app.login_email, app.api_key_hash, app.refresh_hash (lihat database/gateway.ts).

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Membaca setting konteks sebagai uuid/teks; NULL bila tidak diset/kosong.
CREATE FUNCTION ctx_text(name text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.' || name, true), '') $$;

CREATE FUNCTION ctx_uuid(name text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE v text := nullif(current_setting('app.' || name, true), '');
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(255) NOT NULL CHECK (length(btrim(name)) > 0),
  slug        varchar(63)  NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  status      varchar(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         varchar(254) NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
  password_hash text         NOT NULL,
  status        varchar(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_memberships (
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       varchar(20) NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  status     varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_memberships_user ON tenant_memberships (user_id);

CREATE TABLE tenant_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_sessions         integer NOT NULL DEFAULT 3  CHECK (max_sessions >= 0),
  max_api_keys         integer NOT NULL DEFAULT 20 CHECK (max_api_keys >= 0),
  messages_per_minute  integer NOT NULL DEFAULT 60 CHECK (messages_per_minute >= 0),
  settings             jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenant_settings_updated BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  key_prefix         varchar(16)  NOT NULL,
  key_hash           char(64)     NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes             jsonb        NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  created_by_user_id uuid,
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Composite tenant FK: pembuat harus anggota tenant yang sama.
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id)
    ON DELETE SET NULL (created_by_user_id)
);
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid     NOT NULL,
  tenant_id      uuid     NOT NULL,
  family_id      uuid     NOT NULL,
  token_hash     char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Token terikat pada keanggotaan: membership dihapus => token ikut terhapus.
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_user ON refresh_tokens (user_id);

-- ============ Row Level Security ============
ALTER TABLE tenants            ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants            FORCE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY; ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings    ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_settings    FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys           ENABLE ROW LEVEL SECURITY; ALTER TABLE api_keys           FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens     ENABLE ROW LEVEL SECURITY; ALTER TABLE refresh_tokens     FORCE ROW LEVEL SECURITY;

-- tenants: baca bila tenant aktif atau user anggota; tulis hanya tenant aktif.
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
  id = ctx_uuid('tenant_id')
  OR id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = ctx_uuid('user_id')));
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (id = ctx_uuid('tenant_id'));
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (id = ctx_uuid('tenant_id')) WITH CHECK (id = ctx_uuid('tenant_id'));
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (id = ctx_uuid('tenant_id'));

-- users: identitas global; terlihat hanya untuk dirinya atau lookup login by email yang sedang diproses.
CREATE POLICY users_select ON users FOR SELECT USING (id = ctx_uuid('user_id') OR email = ctx_text('login_email'));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (id = ctx_uuid('user_id'));
CREATE POLICY users_update ON users FOR UPDATE USING (id = ctx_uuid('user_id')) WITH CHECK (id = ctx_uuid('user_id'));
CREATE POLICY users_delete ON users FOR DELETE USING (id = ctx_uuid('user_id'));

-- memberships: user melihat keanggotaannya; mutasi hanya dalam tenant aktif.
CREATE POLICY memberships_select ON tenant_memberships FOR SELECT USING (
  tenant_id = ctx_uuid('tenant_id') OR user_id = ctx_uuid('user_id'));
CREATE POLICY memberships_insert ON tenant_memberships FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY memberships_update ON tenant_memberships FOR UPDATE USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY memberships_delete ON tenant_memberships FOR DELETE USING (tenant_id = ctx_uuid('tenant_id'));

CREATE POLICY tenant_settings_all ON tenant_settings FOR ALL
  USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));

-- api_keys: resolusi kredensial hanya lewat hash yang sedang diverifikasi (tanpa tenant).
CREATE POLICY api_keys_select ON api_keys FOR SELECT USING (
  tenant_id = ctx_uuid('tenant_id') OR key_hash = ctx_text('api_key_hash'));
CREATE POLICY api_keys_insert ON api_keys FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY api_keys_update ON api_keys FOR UPDATE USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY api_keys_delete ON api_keys FOR DELETE USING (tenant_id = ctx_uuid('tenant_id'));

-- refresh_tokens: milik user, atau token yang sedang di-rotate (lookup by hash).
CREATE POLICY refresh_select ON refresh_tokens FOR SELECT USING (
  user_id = ctx_uuid('user_id') OR token_hash = ctx_text('refresh_hash'));
CREATE POLICY refresh_insert ON refresh_tokens FOR INSERT WITH CHECK (user_id = ctx_uuid('user_id'));
CREATE POLICY refresh_update ON refresh_tokens FOR UPDATE USING (user_id = ctx_uuid('user_id')) WITH CHECK (user_id = ctx_uuid('user_id'));
CREATE POLICY refresh_delete ON refresh_tokens FOR DELETE USING (user_id = ctx_uuid('user_id'));

-- Rollback / forward-fix: tidak ada DROP otomatis. Forward-fix lewat migrasi baru;
-- rollback manual (dev saja): DROP SCHEMA <schema> CASCADE.
