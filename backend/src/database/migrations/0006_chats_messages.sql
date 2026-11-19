-- Fase F3: chat & riwayat pesan (masuk + cermin pesan keluar), receipt DELIVERED/READ, event message.incoming.

CREATE TABLE wa_chats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid         NOT NULL,
  session_id      uuid         NOT NULL,
  remote_jid      varchar(96)  NOT NULL,
  contact_phone   varchar(20)  CHECK (contact_phone IS NULL OR contact_phone ~ '^[0-9]{5,20}$'),
  display_name    varchar(100),
  last_message_at timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (session_id, remote_jid),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_wa_chats_tenant_recent ON wa_chats (tenant_id, last_message_at DESC NULLS LAST, id);
CREATE INDEX idx_wa_chats_phone ON wa_chats (tenant_id, contact_phone) WHERE contact_phone IS NOT NULL;
CREATE TRIGGER trg_wa_chats_updated BEFORE UPDATE ON wa_chats FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE wa_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL,
  session_id          uuid         NOT NULL,
  chat_id             uuid         NOT NULL,
  direction           varchar(3)   NOT NULL CHECK (direction IN ('IN','OUT')),
  provider_message_id varchar(128),
  message_type        varchar(16)  NOT NULL CHECK (message_type IN ('text','image','video','audio','document','sticker','location','contact','other')),
  body                text,
  status              varchar(16)  NOT NULL CHECK (status IN ('RECEIVED','SENT','DELIVERED','READ')),
  queue_id            uuid,
  occurred_at         timestamptz  NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  body_purged_at      timestamptz,
  CHECK ((direction = 'IN' AND status = 'RECEIVED') OR (direction = 'OUT' AND status <> 'RECEIVED')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, chat_id) REFERENCES wa_chats (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id) REFERENCES wa_sessions (tenant_id, id) ON DELETE CASCADE
);
-- Idempotensi pesan masuk (WhatsApp dapat mengirim ulang saat reconnect): satu id penyedia per sesi & arah.
CREATE UNIQUE INDEX uq_wa_messages_provider ON wa_messages (session_id, direction, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_wa_messages_queue ON wa_messages (queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX idx_wa_messages_chat ON wa_messages (chat_id, occurred_at DESC, id);
CREATE INDEX idx_wa_messages_retention ON wa_messages (created_at) WHERE body IS NOT NULL;

-- Pencocokan receipt: provider id pesan keluar per sesi.
CREATE INDEX idx_message_queue_provider ON message_queue (session_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Cermin pesan keluar: SENT/DELIVERED/READ => baris wa_messages OUT (+ chat). Berjalan dalam transaksi yang sama.
CREATE FUNCTION mirror_outbound_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.status NOT IN ('SENT','DELIVERED','READ') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO wa_chats (tenant_id, session_id, remote_jid, contact_phone, last_message_at)
  VALUES (NEW.tenant_id, NEW.session_id, NEW.recipient || '@s.whatsapp.net', NEW.recipient, now())
  ON CONFLICT (session_id, remote_jid) DO UPDATE SET last_message_at = GREATEST(wa_chats.last_message_at, EXCLUDED.last_message_at)
  RETURNING id INTO cid;
  INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, queue_id, occurred_at)
  VALUES (NEW.tenant_id, NEW.session_id, cid, 'OUT', NEW.provider_message_id, 'text', NEW.payload->>'text', NEW.status, NEW.id, now())
  ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mirror_outbound AFTER UPDATE OF status ON message_queue FOR EACH ROW EXECUTE FUNCTION mirror_outbound_message();

-- Pesan masuk => event message.incoming (outbox). Isi teks ikut (klien memerlukannya); outbox dibersihkan job retensi.
CREATE FUNCTION outbox_from_incoming() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  IF NEW.direction <> 'IN' THEN RETURN NEW; END IF;
  SELECT remote_jid, contact_phone, display_name INTO c FROM wa_chats WHERE id = NEW.chat_id;
  INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (NEW.tenant_id, 'message', NEW.id, 'message.incoming', jsonb_build_object(
    'message_id', NEW.id, 'session_id', NEW.session_id, 'chat_id', NEW.chat_id, 'from', COALESCE(c.contact_phone, c.remote_jid),
    'from_name', c.display_name, 'type', NEW.message_type, 'text', NEW.body, 'provider_message_id', NEW.provider_message_id,
    'received_at', NEW.occurred_at));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outbox_incoming AFTER INSERT ON wa_messages FOR EACH ROW EXECUTE FUNCTION outbox_from_incoming();

ALTER TABLE wa_chats    ENABLE ROW LEVEL SECURITY; ALTER TABLE wa_chats    FORCE ROW LEVEL SECURITY;
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY; ALTER TABLE wa_messages FORCE ROW LEVEL SECURITY;

-- Tenant hanya MEMBACA; penulisan hanya platform (engine/trigger dalam konteks engine, job retensi).
CREATE POLICY wa_chats_select ON wa_chats FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY wa_chats_write  ON wa_chats FOR ALL USING (is_platform()) WITH CHECK (is_platform());
CREATE POLICY wa_messages_select ON wa_messages FOR SELECT USING (tenant_id = ctx_uuid('tenant_id') OR is_platform());
CREATE POLICY wa_messages_write  ON wa_messages FOR ALL USING (is_platform()) WITH CHECK (is_platform());
