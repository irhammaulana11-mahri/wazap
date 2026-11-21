-- 0021 Peran workspace disederhanakan menjadi OWNER, MEMBER (agent), VIEWER (ADR-053). Peran ADMIN dihapus: baris ADMIN yang ada dikonversi ke MEMBER (hak turun,
-- bukan naik) dan batasan CHECK diganti. Semua hak ADMIN (webhook, API key, alarm, ekspor, audit, tim) menjadi milik OWNER.
-- Riwayat audit (audit_logs.actor_role dan details) TIDAK diubah: append-only, nilai ADMIN lama tetap sebagai catatan sejarah.
--
-- Tabel-tabel ini ENABLE+FORCE RLS dan keanggotaan punya trigger penjaga (0016), sehingga UPDATE data lintas tenant dari migrasi (tanpa konteks tenant) melihat 0 baris
-- atau ditolak. Migrasi berjalan dalam satu transaksi dan pemiliknya (migrator) boleh mengubah atributnya: FORCE dimatikan, trigger dimatikan, data diubah, lalu
-- KEDUANYA dikembalikan sebelum COMMIT. Bila ada langkah gagal, seluruh migrasi di-rollback dan keadaan semula utuh.

-- 1. Data: ADMIN -> MEMBER
ALTER TABLE tenant_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships DISABLE TRIGGER trg_tenant_memberships_guard;
UPDATE tenant_memberships SET role = 'MEMBER' WHERE role = 'ADMIN';
ALTER TABLE tenant_memberships ENABLE TRIGGER trg_tenant_memberships_guard;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_invitations NO FORCE ROW LEVEL SECURITY;
UPDATE tenant_invitations SET role = 'MEMBER' WHERE role = 'ADMIN';
ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_join_requests NO FORCE ROW LEVEL SECURITY;
UPDATE tenant_join_requests SET decided_role = 'MEMBER' WHERE decided_role = 'ADMIN';
ALTER TABLE tenant_join_requests FORCE ROW LEVEL SECURITY;

-- 2. Batasan: buang SEMUA CHECK yang menyebut ADMIN (nama otomatis berbeda di tiap tabel), lalu pasang yang baru dengan nama eksplisit
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('tenant_memberships'::regclass, 'tenant_invitations'::regclass, 'tenant_join_requests'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%ADMIN%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

ALTER TABLE tenant_memberships  ADD CONSTRAINT chk_memberships_role  CHECK (role IN ('OWNER','MEMBER','VIEWER'));
ALTER TABLE tenant_invitations  ADD CONSTRAINT chk_invitations_role  CHECK (role IN ('OWNER','MEMBER','VIEWER'));
ALTER TABLE tenant_join_requests ADD CONSTRAINT chk_join_requests_decided_role CHECK (decided_role IS NULL OR decided_role IN ('OWNER','MEMBER','VIEWER'));
