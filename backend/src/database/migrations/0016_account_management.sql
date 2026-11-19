-- Fase H4: manajemen akun (ganti kata sandi/email, kode pemulihan, keluar dari semua perangkat), ganti nama, hapus workspace.

-- (1) Kolom akun. recovery_hash: SHA-256 kode pemulihan sekali pakai (kode 100 bit; tampil sekali). token_version: dinaikkan saat ganti kata sandi/reset/
-- keluar dari semua perangkat; access token membawa versi saat terbit dan ditolak bila berbeda (mematikan token curian tanpa menunggu 15 menit; deterministik,
-- tidak bergantung pada ketelitian jam).
ALTER TABLE users
  ADD COLUMN recovery_hash char(64) CHECK (recovery_hash IS NULL OR recovery_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN token_version integer NOT NULL DEFAULT 0,
  ADD COLUMN password_changed_at timestamptz;

-- (2) Audit: jenis target baru.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check
  CHECK (target_type IN ('member','invitation','settings','join_request','join_code','account','api_key','session','tenant'));

-- (3) Ganti email: salinan member_email di SEMUA keanggotaan pengguna (lintas tenant) harus ikut berubah, padahal kebijakan UPDATE keanggotaan hanya untuk
-- tenant aktif. Kebijakan ini membolehkan pemilik akun memperbarui baris keanggotaannya sendiri; trigger memastikan di luar konteks tenant baris itu
-- HANYA boleh berganti member_email dan nilainya harus sama dengan email akun (peran/status tidak dapat diubah lewat jalur ini).
CREATE POLICY memberships_sync_email ON tenant_memberships FOR UPDATE
  USING (user_id = ctx_uuid('user_id')) WITH CHECK (user_id = ctx_uuid('user_id'));
CREATE FUNCTION tenant_memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM ctx_uuid('tenant_id') THEN
    IF NEW.role <> OLD.role OR NEW.status <> OLD.status OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at
       OR NEW.member_email IS DISTINCT FROM (SELECT u.email FROM users u WHERE u.id = NEW.user_id) THEN
      RAISE EXCEPTION 'keanggotaan di luar tenant aktif hanya boleh menyinkronkan member_email' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tenant_memberships_guard BEFORE UPDATE ON tenant_memberships FOR EACH ROW EXECUTE FUNCTION tenant_memberships_guard();

-- (4) Hapus workspace = status DELETED (lunak); retensi (konteks platform) menghapus barisnya (cascade) setelah masa tunggu.
CREATE POLICY tenants_platform_select ON tenants FOR SELECT USING (is_platform());
CREATE POLICY tenants_platform_delete ON tenants FOR DELETE USING (is_platform() AND status = 'DELETED');
