-- Identitas chat tunggal per kontak. WhatsApp (Baileys 7) menyebut kontak yang sama dengan dua JID: nomor telepon (@s.whatsapp.net) dan
-- LID (@lid). Pesan keluar dicatat trigger dengan JID nomor, balasan masuk datang dengan JID LID: sebelumnya keduanya membuat chat
-- terpisah untuk kontak yang sama (ditemukan pada uji WhatsApp sungguhan). Dua jalur penulis (trigger keluar dan inbox masuk) kini
-- memakai SATU fungsi, resolve_chat, sehingga aturannya tidak dapat menyimpang.

ALTER TABLE wa_chats ADD COLUMN lid_jid varchar(96);
CREATE UNIQUE INDEX uq_wa_chats_lid ON wa_chats (session_id, lid_jid) WHERE lid_jid IS NOT NULL;
CREATE INDEX idx_wa_chats_session_phone ON wa_chats (session_id, contact_phone) WHERE contact_phone IS NOT NULL;

-- Mengembalikan id chat kanonik untuk kontak (p_jid, p_phone) pada sesi, membuatnya bila belum ada, dan MENGGABUNGKAN chat lain
-- milik kontak yang sama (pesan dipindahkan, tidak ada yang hilang). Kecocokan: remote_jid, lid_jid, atau nomor telepon yang sama.
-- Kanonik: yang ber-JID nomor, lalu yang tertua. Dipanggil hanya dalam konteks platform (engine/trigger), seperti penulisan wa_chats lain.
-- Dua kunci advisory (JID dahulu, lalu nomor; urutan tetap agar tidak deadlock) menyerialkan penulis yang berebut kontak yang sama.
CREATE FUNCTION resolve_chat(p_tenant uuid, p_session uuid, p_jid text, p_phone text, p_name text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  canon wa_chats%ROWTYPE; o wa_chats%ROWTYPE;
  is_lid boolean := p_jid LIKE '%@lid';
  moved_lid text; moved_name text; moved_phone text; last_at timestamptz; cid uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('wa_chat:' || p_session::text || ':jid:' || p_jid, 0));
  IF p_phone IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wa_chat:' || p_session::text || ':tel:' || p_phone, 0));
  END IF;

  SELECT * INTO canon FROM wa_chats
   WHERE session_id = p_session AND (remote_jid = p_jid OR lid_jid = p_jid OR (p_phone IS NOT NULL AND contact_phone = p_phone))
   ORDER BY (remote_jid LIKE '%@s.whatsapp.net') DESC, created_at, id LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO wa_chats (tenant_id, session_id, remote_jid, lid_jid, contact_phone, display_name, last_message_at)
    VALUES (p_tenant, p_session, CASE WHEN p_phone IS NOT NULL THEN p_phone || '@s.whatsapp.net' ELSE p_jid END,
            CASE WHEN is_lid THEN p_jid END, p_phone, p_name, p_at)
    RETURNING id INTO cid;
    RETURN cid;
  END IF;

  FOR o IN SELECT * FROM wa_chats
            WHERE session_id = p_session AND id <> canon.id
              AND (remote_jid = p_jid OR lid_jid = p_jid OR (p_phone IS NOT NULL AND contact_phone = p_phone))
            ORDER BY created_at, id LOOP
    UPDATE wa_messages SET chat_id = canon.id WHERE chat_id = o.id;
    DELETE FROM wa_chats WHERE id = o.id;
    IF o.remote_jid LIKE '%@lid' THEN moved_lid := COALESCE(moved_lid, o.remote_jid); ELSE moved_lid := COALESCE(moved_lid, o.lid_jid); END IF;
    moved_name := COALESCE(moved_name, o.display_name);
    moved_phone := COALESCE(moved_phone, o.contact_phone);
    last_at := GREATEST(last_at, o.last_message_at);
  END LOOP;

  UPDATE wa_chats SET
    contact_phone = COALESCE(contact_phone, p_phone, moved_phone),
    display_name = COALESCE(p_name, display_name, moved_name),
    lid_jid = COALESCE(lid_jid, CASE WHEN is_lid THEN p_jid END, moved_lid),
    last_message_at = GREATEST(last_message_at, p_at, last_at)
  WHERE id = canon.id;
  RETURN canon.id;
END $$;

-- Cermin pesan keluar (versi 0007: semua tipe) kini memakai resolve_chat.
CREATE OR REPLACE FUNCTION mirror_outbound_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.status NOT IN ('SENT','DELIVERED','READ') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  cid := resolve_chat(NEW.tenant_id, NEW.session_id, NEW.recipient || '@s.whatsapp.net', NEW.recipient, NULL, now());
  INSERT INTO wa_messages (tenant_id, session_id, chat_id, direction, provider_message_id, message_type, body, status, queue_id, occurred_at)
  VALUES (NEW.tenant_id, NEW.session_id, cid, 'OUT', NEW.provider_message_id, NEW.message_type,
          COALESCE(NEW.payload->>'text', NEW.payload->>'caption'), NEW.status, NEW.id, now())
  ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status;
  RETURN NEW;
END $$;

-- Perbaiki duplikat yang sudah terlanjur ada. wa_chats di bawah FORCE RLS: setel konteks platform HANYA di transaksi migrasi ini
-- (set_config lokal; hilang saat COMMIT).
DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('app.scope', 'platform', true);
  FOR r IN SELECT tenant_id, session_id, contact_phone FROM wa_chats WHERE contact_phone IS NOT NULL
            GROUP BY tenant_id, session_id, contact_phone HAVING count(*) > 1 LOOP
    PERFORM resolve_chat(r.tenant_id, r.session_id, r.contact_phone || '@s.whatsapp.net', r.contact_phone, NULL, NULL);
  END LOOP;
END $$;
