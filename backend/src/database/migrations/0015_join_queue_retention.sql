-- Fase H3 (lanjutan): batas permintaan tertunda per tenant dan retensi permintaan bergabung.

-- (1) Batas antrean. Pemohon belum anggota sehingga, tanpa kebijakan ini, ia hanya melihat baris miliknya dan tidak dapat menghitung antrean tenant.
-- Kebijakan ini membuka baris PENDING yang masih berlaku milik tenant yang kodenya sedang dipakai (konteks app.join_hash) KHUSUS untuk menghitung;
-- kode aplikasi hanya menjalankan count(*). Tidak membuka permintaan yang sudah diputuskan/kedaluwarsa maupun milik tenant lain.
CREATE POLICY join_requests_queue_count ON tenant_join_requests FOR SELECT USING (
  status = 'PENDING' AND expires_at > now()
  AND EXISTS (SELECT 1 FROM tenant_join_codes j WHERE j.tenant_id = tenant_join_requests.tenant_id AND j.code_hash = ctx_text('join_hash')));

-- (2) Retensi (konteks platform): hanya SELECT dan DELETE (seperti audit_logs); tidak ada INSERT/UPDATE platform.
CREATE POLICY join_requests_platform_select ON tenant_join_requests FOR SELECT USING (is_platform());
CREATE POLICY join_requests_platform_delete ON tenant_join_requests FOR DELETE USING (is_platform());
CREATE INDEX idx_join_requests_created ON tenant_join_requests (created_at);
