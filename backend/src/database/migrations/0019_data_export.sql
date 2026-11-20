-- Ekspor data workspace (ADR-048): indeks untuk pembacaan berurutan (keyset) per tenant dan jenis target audit baru.

-- Ekspor pesan membaca seluruh chat satu tenant per rentang waktu. Indeks yang ada hanya per chat (idx_wa_messages_chat) dan per created_at global;
-- tanpa indeks ini kueri keyset (occurred_at, id) harus mengurutkan ulang atau memindai tenant lain.
CREATE INDEX idx_wa_messages_tenant_time ON wa_messages (tenant_id, occurred_at, id);

-- Laporan pengiriman: idx_message_queue_tenant_list berurutan (created_at DESC, id) sehingga tidak cocok untuk ORDER BY created_at, id.
CREATE INDEX idx_message_queue_tenant_time ON message_queue (tenant_id, created_at, id);

-- Jejak audit ekspor (aksi data.exported sudah sesuai pola CHECK aksi: ^[a-z_]+\.[a-z_]+$).
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check
  CHECK (target_type IN ('member','invitation','settings','join_request','join_code','account','api_key','session','tenant','export'));
