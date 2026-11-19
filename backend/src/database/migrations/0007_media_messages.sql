-- Fase F4: pesan media (image/video/audio/document) pada antrean + cermin riwayat mengikuti tipe.

ALTER TABLE message_queue DROP CONSTRAINT message_queue_message_type_check;
ALTER TABLE message_queue ADD CONSTRAINT message_queue_message_type_check CHECK (message_type IN ('text','image','video','audio','document'));
-- Bentuk payload mengikuti tipe: teks => {text}; media => {url, caption?, filename?, mimetype?}.
ALTER TABLE message_queue ADD CONSTRAINT message_queue_payload_shape CHECK (
  (message_type = 'text' AND payload ? 'text') OR (message_type <> 'text' AND payload ? 'url'));

CREATE OR REPLACE FUNCTION mirror_outbound_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.status NOT IN ('SENT','DELIVERED','READ') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at)
  VALUES (NEW.tenant_id, NEW.session_id, NEW.recipient || '@s.whatsapp.net', NEW.recipient, now())
  ON CONFLICT (session_id, remote_jid) DO UPDATE SET last_message_at = GREATEST(wa_chats.last_message_at, EXCLUDED.last_message_at)
  RETURNING id INTO cid;
  INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, queue_id, occurred_at)
  VALUES (NEW.tenant_id, NEW.session_id, cid, 'OUT', NEW.provider_message_id, NEW.message_type,
          COALESCE(NEW.payload->>'text', NEW.payload->>'caption'), NEW.status, NEW.id, now())
  ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status;
  RETURN NEW;
END $$;
