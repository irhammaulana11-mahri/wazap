-- Fase F5: retensi data pesan (ADR-019). Isi pesan & nomor dimasker setelah N hari; baris dihapus setelah M hari.

ALTER TABLE message_queue ADD COLUMN content_purged_at timestamptz;
-- Nomor penerima boleh dalam bentuk termasker (****7890) setelah retensi konten; format asli tetap divalidasi ketat.
ALTER TABLE message_queue DROP CONSTRAINT message_queue_recipient_check;
ALTER TABLE message_queue ADD CONSTRAINT message_queue_recipient_check CHECK (recipient ~ '^[0-9]{8,15}$' OR recipient ~ '^\*{4,11}[0-9]{4}$');
ALTER TABLE message_queue ADD CONSTRAINT message_queue_purge_consistency CHECK (content_purged_at IS NULL OR completed_at IS NOT NULL);

-- Indeks parsial agar penyapuan retensi tidak memindai seluruh tabel.
CREATE INDEX idx_message_queue_purge ON message_queue (completed_at) WHERE completed_at IS NOT NULL AND content_purged_at IS NULL;
CREATE INDEX idx_message_queue_rowdelete ON message_queue (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX idx_wa_messages_created ON wa_messages (created_at);
CREATE INDEX idx_webhook_deliveries_done ON webhook_deliveries (created_at) WHERE status <> 'PENDING';
