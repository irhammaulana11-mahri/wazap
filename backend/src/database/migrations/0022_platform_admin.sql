-- 0022 Platform admin (ADR-054): akun pemilik platform, kuota bawaan, jejak audit platform, dan dukungan penangguhan workspace yang dapat dipulihkan.
-- Konteks platform di basis data (is_platform()) HANYA dipakai modul istimewa (engine, runtime, database, platform; dijaga tes). Kebijakan di bawah sengaja SEMPIT:
-- hanya tabel dan perintah yang dibutuhkan konsol platform, dan modul platform hanya menjalankan kueri terkurasi (tanpa isi pesan, kontak, kredensial, kunci API).

-- 1. Kolom baru
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz;
-- Penangguhan memutus sesi secara dapat dipulihkan: sesi yang berniat tersambung ditandai agar tersambung lagi saat workspace diaktifkan kembali
-- (sesi yang sengaja diputus pengguna tidak ikut disambungkan).
ALTER TABLE wa_sessions ADD COLUMN resume_connect boolean NOT NULL DEFAULT false;

-- 2. Kuota bawaan workspace baru: satu baris. Dibaca konteks terautentikasi (registrasi berjalan tanpa konteks platform), ditulis hanya platform. Baris awal dibuat SEBELUM RLS FORCE.
CREATE TABLE platform_defaults (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  max_sessions        integer NOT NULL DEFAULT 3  CHECK (max_sessions >= 1),
  max_api_keys        integer NOT NULL DEFAULT 20 CHECK (max_api_keys >= 0),
  max_members         integer NOT NULL DEFAULT 10 CHECK (max_members >= 1),
  messages_per_minute integer NOT NULL DEFAULT 60 CHECK (messages_per_minute >= 1),
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_defaults DEFAULT VALUES;
ALTER TABLE platform_defaults ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_defaults FORCE ROW LEVEL SECURITY;
-- Dibaca konteks yang terautentikasi (registrasi berjalan dengan konteks tenant); BUKAN `USING (true)`: konteks tanpa tenant/pengguna/platform tidak melihat apa pun.
CREATE POLICY platform_defaults_read   ON platform_defaults FOR SELECT USING (ctx_uuid('tenant_id') IS NOT NULL OR ctx_uuid('user_id') IS NOT NULL OR is_platform());
CREATE POLICY platform_defaults_update ON platform_defaults FOR UPDATE USING (is_platform()) WITH CHECK (is_platform());
-- Tanpa kebijakan INSERT/DELETE: tetap satu baris.

-- 3. Akun platform admin. Akun adalah pengguna biasa (users) yang didaftarkan lewat CLI di server; tidak ada jalur dari internet untuk membuat/mencabutnya.
CREATE TABLE platform_admins (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status           varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  totp_cipher      bytea       NOT NULL,                       -- rahasia TOTP, AES-256-GCM, AAD wazap:totp:v1|<user_id>
  totp_key_version integer     NOT NULL CHECK (totp_key_version > 0),
  totp_last_step   bigint      NOT NULL DEFAULT 0,             -- langkah waktu TOTP terakhir yang diterima: satu kode tidak dapat dipakai dua kali
  recovery_hashes  text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(recovery_hashes) <= 20),   -- SHA-256 kode pemulihan sekali pakai
  failed_attempts  integer     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admins_all ON platform_admins FOR ALL USING (is_platform()) WITH CHECK (is_platform());

-- 4. Jejak audit platform: append-only MUTLAK (UPDATE dan DELETE ditolak untuk semua, termasuk platform). Tanpa FK ke tenant: jejak tetap ada setelah workspace dihapus permanen.
CREATE TABLE platform_audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid,
  admin_email   varchar(254) NOT NULL,
  action        varchar(48)  NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  tenant_id     uuid,
  details       jsonb        NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),   -- tanpa rahasia
  reason        varchar(500),
  ip            varchar(45),
  request_id    varchar(64),
  created_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_time   ON platform_audit_logs (created_at DESC, id DESC);
CREATE INDEX idx_platform_audit_tenant ON platform_audit_logs (tenant_id, created_at DESC, id DESC);
CREATE FUNCTION platform_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs bersifat append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER trg_platform_audit_guard BEFORE UPDATE OR DELETE ON platform_audit_logs FOR EACH ROW EXECUTE FUNCTION platform_audit_guard();
CREATE TRIGGER trg_platform_audit_truncate BEFORE TRUNCATE ON platform_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_guard();
ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_select ON platform_audit_logs FOR SELECT USING (is_platform());
CREATE POLICY platform_audit_insert ON platform_audit_logs FOR INSERT WITH CHECK (is_platform());

-- 5. Kebijakan platform SEMPIT pada tabel yang disentuh konsol platform (RLS tidak dapat membatasi kolom; pembatasan kolom dijaga kueri terkurasi dan tes pemindai sumber).
--    tenants: SELECT platform sudah ada (0016); tambah UPDATE (status, suspended_at). tenant_settings: kuota. Keanggotaan dan API key: HANYA SELECT (daftar OWNER dan hitungan).
CREATE POLICY tenants_platform_update          ON tenants            FOR UPDATE USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY tenant_settings_platform         ON tenant_settings    FOR ALL    USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY memberships_platform_select      ON tenant_memberships FOR SELECT USING (is_platform());
CREATE POLICY api_keys_platform_select         ON api_keys           FOR SELECT USING (is_platform());
-- Undangan tertunda dihitung sebagai pemakaian kuota anggota (definisi yang sama dengan penolakan pembuatan); modul platform hanya menghitung, tidak pernah membaca token_hash/email.
CREATE POLICY invitations_platform_select      ON tenant_invitations FOR SELECT USING (is_platform());
-- Jejak transparansi di audit workspace ("diubah oleh platform"): hanya INSERT.
CREATE POLICY audit_logs_platform_insert       ON audit_logs         FOR INSERT WITH CHECK (is_platform());
