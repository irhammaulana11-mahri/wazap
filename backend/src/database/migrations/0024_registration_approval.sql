-- Persetujuan pendaftaran workspace oleh pemilik platform (ADR-056). Status baru: PENDING (menunggu persetujuan) dan REJECTED (ditolak; dapat disetujui kemudian).
-- Tenant PENDING/REJECTED tidak ACTIVE sehingga SEMUA jalur autentikasi (HTTP, refresh, API key, realtime, switch-tenant) sudah menolaknya tanpa perubahan lain.
-- Kebijakan RLS tidak berubah: platform sudah boleh SELECT dan UPDATE tenants (0016, 0022).
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','DELETED','REJECTED'));
ALTER TABLE tenants ADD COLUMN decided_at timestamptz;   -- waktu keputusan setuju/tolak terakhir (NULL bila tidak pernah melalui persetujuan)
CREATE INDEX idx_tenants_pending ON tenants (created_at) WHERE status = 'PENDING';
