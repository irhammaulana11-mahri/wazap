-- Fase H3: permintaan bergabung (calon anggota mendaftar dengan kode workspace dan kata sandi buatannya sendiri; akun baru aktif
-- di workspace setelah OWNER/ADMIN menyetujui). Pelengkap undangan (0011), bukan pengganti.

-- Kode workspace: hanya hash yang disimpan (tampil sekali saat dibuat/diputar), satu kode aktif per tenant. tenant_name disalin agar
-- pemohon (belum anggota, tidak dapat membaca tabel tenants) dapat melihat nama workspace yang ia ajukan.
CREATE TABLE tenant_join_codes (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash   char(64)     NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  tenant_name varchar(255) NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
ALTER TABLE tenant_join_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_join_codes FORCE ROW LEVEL SECURITY;
-- Tenant mengelola kodenya; pemohon menemukan baris HANYA lewat hash kode yang sedang diproses (konteks app.join_hash). Tanpa akses platform.
CREATE POLICY join_codes_select ON tenant_join_codes FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR code_hash = ctx_text('join_hash'));
CREATE POLICY join_codes_insert ON tenant_join_codes FOR INSERT WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY join_codes_update ON tenant_join_codes FOR UPDATE USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
CREATE POLICY join_codes_delete ON tenant_join_codes FOR DELETE USING (tenant_id = ctx_uuid('tenant_id'));

CREATE TABLE tenant_join_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        varchar(254) NOT NULL CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),  -- salinan saat pengajuan
  status       varchar(16)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  expires_at   timestamptz  NOT NULL,
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_role varchar(20) CHECK (decided_role IS NULL OR decided_role IN ('ADMIN','MEMBER','VIEWER','OWNER')),
  decided_at   timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK ((status = 'APPROVED') = (decided_role IS NOT NULL))
);
-- Satu permintaan tertunda per (tenant, pengguna).
CREATE UNIQUE INDEX uq_join_requests_pending ON tenant_join_requests (tenant_id, user_id) WHERE status = 'PENDING';
CREATE INDEX idx_join_requests_tenant ON tenant_join_requests (tenant_id, created_at DESC, id);
CREATE INDEX idx_join_requests_user ON tenant_join_requests (user_id);

ALTER TABLE tenant_join_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_join_requests FORCE ROW LEVEL SECURITY;
-- Tenant melihat/memutuskan permintaannya; pemohon hanya melihat miliknya sendiri (untuk pesan "menunggu persetujuan" saat login).
CREATE POLICY join_requests_select ON tenant_join_requests FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR user_id = ctx_uuid('user_id'));
-- Pemohon boleh membuat permintaan HANYA bila: ia pemilik user_id tsb, kode workspace valid (konteks app.join_hash), email = email akunnya,
-- status awal PENDING. Tidak ada jalur lain untuk menjadi anggota: persetujuan (UPDATE + INSERT membership) hanya lewat konteks tenant.
CREATE POLICY join_requests_insert ON tenant_join_requests FOR INSERT WITH CHECK (
  user_id = ctx_uuid('user_id') AND status = 'PENDING' AND decided_at IS NULL AND decided_role IS NULL
  AND email = (SELECT u.email FROM users u WHERE u.id = ctx_uuid('user_id'))
  AND EXISTS (SELECT 1 FROM tenant_join_codes j WHERE j.tenant_id = tenant_join_requests.tenant_id AND j.code_hash = ctx_text('join_hash')));
CREATE POLICY join_requests_update ON tenant_join_requests FOR UPDATE USING (tenant_id = ctx_uuid('tenant_id')) WITH CHECK (tenant_id = ctx_uuid('tenant_id'));
-- Pemohon hanya boleh menutup permintaan TERTUNDA miliknya yang sudah kedaluwarsa (agar dapat mengajukan ulang); tidak dapat menyetujui diri sendiri.
CREATE POLICY join_requests_expire_own ON tenant_join_requests FOR UPDATE
  USING (user_id = ctx_uuid('user_id') AND status = 'PENDING' AND expires_at <= now())
  WITH CHECK (user_id = ctx_uuid('user_id') AND status = 'REJECTED' AND decided_by IS NULL AND decided_role IS NULL);

-- Audit: jenis target baru.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN ('member','invitation','settings','join_request','join_code'));
