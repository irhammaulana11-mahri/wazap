-- Fase H: tim (undangan, email anggota), kuota anggota, dan indeks untuk metrik penggunaan.

-- Email anggota disalin ke keanggotaan agar daftar tim tidak perlu membaca tabel users: kebijakan RLS users hanya
-- mengizinkan baris milik sendiri, dan baris itu memuat password_hash (jangan dilonggarkan).
ALTER TABLE tenant_memberships ADD COLUMN member_email varchar(254)
  CHECK (member_email IS NULL OR (member_email = lower(btrim(member_email)) AND position('@' in member_email) > 1));

-- Backfill sebagai pemilik tabel: RLS FORCE dimatikan sebentar di dalam transaksi migrasi ini saja.
ALTER TABLE tenant_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
UPDATE tenant_memberships m SET member_email = u.email FROM users u WHERE u.id = m.user_id AND m.member_email IS NULL;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_settings ADD COLUMN max_members integer NOT NULL DEFAULT 10 CHECK (max_members >= 1);

-- ===== undangan anggota (token sekali pakai; hanya hash yang disimpan) =====
CREATE TABLE tenant_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       varchar(254) NOT NULL CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
  role        varchar(20)  NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  token_hash  char(64)     NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status      varchar(16)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz  NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL))
);
-- Satu undangan PENDING per (tenant, email).
CREATE UNIQUE INDEX uq_invitations_pending ON tenant_invitations (tenant_id, email) WHERE status = 'PENDING';
CREATE INDEX idx_invitations_tenant ON tenant_invitations (tenant_id, created_at DESC, id);

ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;

-- Tenant mengelola undangannya; penerima menemukan undangan HANYA lewat hash token yang sedang diproses (konteks app.invite_hash).
CREATE POLICY invitations_select ON tenant_invitations FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR token_hash = ctx_text('invite_hash'));
CREATE POLICY invitations_insert ON tenant_invitations FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY invitations_update ON tenant_invitations FOR UPDATE USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
-- Penerima hanya boleh mengubah undangan PENDING yang belum kedaluwarsa menjadi ACCEPTED atas namanya sendiri.
CREATE POLICY invitations_accept ON tenant_invitations FOR UPDATE
  USING (token_hash = ctx_text('invite_hash') AND status = 'PENDING' AND expires_at > now())
  WITH CHECK (status = 'ACCEPTED' AND accepted_by = ctx_uuid('user_id'));

-- Penerima boleh membuat keanggotaan di tenant pengundang HANYA bila: ia pemilik user_id tsb, token undangan valid,
-- email akunnya = email undangan, dan role = role undangan. Tidak ada jalur lain untuk masuk ke tenant lain.
CREATE POLICY memberships_insert_invited ON tenant_memberships FOR INSERT WITH CHECK (
  user_id = ctx_uuid('user_id') AND EXISTS (
    SELECT 1 FROM tenant_invitations i
    WHERE i.tenant_id = tenant_memberships.tenant_id AND i.token_hash = ctx_text('invite_hash')
      AND i.status = 'PENDING' AND i.expires_at > now()
      AND i.role = tenant_memberships.role AND i.email = tenant_memberships.member_email
      AND i.email = (SELECT u.email FROM users u WHERE u.id = ctx_uuid('user_id'))));

-- Metrik penggunaan: pesan masuk per tenant dalam rentang waktu.
CREATE INDEX idx_wa_messages_tenant_in ON wa_messages (tenant_id, created_at) WHERE direction = 'IN';
