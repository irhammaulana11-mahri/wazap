-- Fase H4 (lanjutan): 8 kode pemulihan sekali pakai, pemulihan workspace terhapus, dan audit untuk reset kata sandi dan pembuatan permintaan bergabung.

-- (1) Audit tanpa konteks tenant, dibuktikan oleh kepemilikan akun/kode. Pola sama dengan audit_insert_accept (0012/0013).
-- Reset kata sandi dicatat ke SETIAP workspace tempat pengguna menjadi anggota (admin dapat melihat pengambilalihan akun).
CREATE POLICY audit_insert_reset ON audit_logs FOR INSERT WITH CHECK (
  action = 'account.password_reset' AND actor_user_id = ctx_uuid('user_id')
  AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = audit_logs.tenant_id AND m.user_id = ctx_uuid('user_id')));
-- Pembuatan permintaan bergabung dicatat ke workspace tujuan dengan kode workspace yang valid.
CREATE POLICY audit_insert_join_request ON audit_logs FOR INSERT WITH CHECK (
  action = 'join_request.created' AND actor_user_id = ctx_uuid('user_id')
  AND EXISTS (SELECT 1 FROM tenant_join_codes j WHERE j.tenant_id = audit_logs.tenant_id AND j.code_hash = ctx_text('join_hash')));

-- (2) Waktu penghapusan workspace (masa tunggu pemulihan dan retensi dihitung dari sini, bukan updated_at yang berubah oleh pembaruan lain).
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ADD COLUMN deleted_at timestamptz;
UPDATE tenants SET deleted_at = updated_at WHERE status = 'DELETED';
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ADD CONSTRAINT tenants_deleted_at_check CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL));

-- (3) Kode pemulihan: himpunan (8) kode sekali pakai per pengguna menggantikan satu kode di users.recovery_hash. Hanya hash yang disimpan.
CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  char(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_recovery_codes_user ON user_recovery_codes (user_id);
ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE user_recovery_codes FORCE ROW LEVEL SECURITY;
-- Hanya pemilik (konteks user_id); reset memakai konteks user_id yang ditetapkan SETELAH email dicari. Tanpa akses platform.
CREATE POLICY recovery_codes_own ON user_recovery_codes FOR ALL USING (user_id = ctx_uuid('user_id')) WITH CHECK (user_id = ctx_uuid('user_id'));

-- Pindahkan kode tunggal lama (bila ada) sebagai salah satu kode; kolom lama dihapus. recovery_confirmed_at: penanda "sudah menyimpan" untuk banner.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY; ALTER TABLE user_recovery_codes NO FORCE ROW LEVEL SECURITY;
INSERT INTO user_recovery_codes (user_id, code_hash) SELECT id, recovery_hash FROM users WHERE recovery_hash IS NOT NULL;
ALTER TABLE users FORCE ROW LEVEL SECURITY; ALTER TABLE user_recovery_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE users DROP COLUMN recovery_hash, ADD COLUMN recovery_confirmed_at timestamptz;
