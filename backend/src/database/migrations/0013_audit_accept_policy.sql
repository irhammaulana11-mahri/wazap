-- Perketat pencatatan audit "undangan diterima": selain token, email akun pencatat harus sama dengan email undangan
-- (sebelumnya pemegang token yang bukan penerima dapat memalsukan catatan itu). Migrasi baru karena 0012 sudah diterapkan.
DROP POLICY audit_insert_accept ON audit_logs;
CREATE POLICY audit_insert_accept ON audit_logs FOR INSERT WITH CHECK (
  action = 'invitation.accepted' AND actor_user_id = ctx_uuid('user_id')
  AND EXISTS (SELECT 1 FROM tenant_invitations i
              WHERE i.tenant_id = audit_logs.tenant_id AND i.token_hash = ctx_text('invite_hash')
                AND i.email = (SELECT u.email FROM users u WHERE u.id = ctx_uuid('user_id'))));
