# Tenant Isolation

## Mandatory rules

1.  Resolve tenant from authenticated user membership or API key.
2.  Ignore or reject client-supplied tenant_id as authority.
3.  Add tenant_id to every tenant-owned table.
4.  Use composite foreign keys where relationships cross tenant-owned
    tables.
5.  Apply tenant filters in repositories/services.
6.  Apply PostgreSQL RLS as defense in depth.
7.  Set tenant context transaction-locally; never leak pooled connection
    context.
8.  Restrict admin cross-tenant operations to explicit privileged
    services and audit them.

## Required negative tests

-   Tenant A cannot GET Tenant B session.
-   Tenant A cannot disconnect/delete Tenant B session.
-   Tenant A cannot read messages/chats/contacts of Tenant B.
-   Tenant A cannot use Tenant B session_id to send.
-   Tenant A cannot read/replay Tenant B webhook deliveries.
-   API key revoked/expired cannot access resources.
-   Socket user cannot join another tenant's room.

## Status implementasi (Fase B)

Diterapkan dan diuji untuk domain identity: tenant dari principal
terverifikasi, composite FK, RLS ENABLE+FORCE, konteks transaction-local
(tidak bocor antar koneksi pool), API key revoked/expired ditolak,
cross-tenant read/revoke API key ditolak. Tes domain lain (session,
message, webhook, socket) menunggu fasenya.

## Status implementasi (Fase C)

Ditambah dan diuji: Tenant A tidak dapat GET/status/events/connect/
disconnect/reconnect/delete sesi Tenant B (404); tenant tidak dapat membaca
`engine_nodes`/`session_credentials`; INSERT lintas tenant ditolak RLS;
event dengan tenant tidak cocok ditolak composite FK; `platform` scope hanya
di modul engine/runtime/database (tes memindai source). Belum: chats,
messages, webhook, socket room.

## Status implementasi (Fase D)

Ditambah dan diuji: tenant tidak dapat membaca `session_auth_state`
(RLS, 0 baris) maupun menulis `session_qr`; tenant lain => 404 pada
`GET /sessions/:id/qr`; blob terenkripsi tidak dapat ditukar antar item atau
antar sesi (AAD); engine non-pemilik ditolak menulis (fencing).

## Status implementasi (Fase E)

Diuji: tenant A tidak dapat GET/status/cancel/retry/list pesan tenant B (404/kosong);
tidak dapat mengirim lewat sesi tenant B (404); kunci idempotensi independen per
tenant; tenant tidak dapat menulis `message_attempts` (RLS); batas pesan/menit
tenant A tidak memengaruhi tenant B; tenant kecil tidak menunggu antrean
tenant besar (lane per sesi).

## Status implementasi (Fase F)

Diuji: tenant lain tidak dapat melihat/mengubah/menghapus/rotate/test/replay endpoint webhook
maupun delivery (404); tenant tidak dapat membaca/mengubah/menghapus `outbox_events` (RLS);
tenant tidak dapat menulis `wa_chats`/`wa_messages` (RLS) dan hanya membaca miliknya; chat/kontak
tenant lain => 404/kosong; sesi tenant lain tidak dapat dipakai `bulk`/`send-media` (404);
socket tenant A tidak menerima event tenant B dan klien tidak dapat bergabung ke room
sembarang; VIEWER/API key tanpa scope tidak menerima sinyal QR; batas pesan/menit
tenant tetap terisolasi untuk bulk. NOTIFY memuat `tenant_id`; server memetakan ke room
per tenant (bukan broadcast).

## Status implementasi (Fase G)

Diuji otomatis di `test/security.test.ts`: cakupan RLS seluruh schema (tabel baru wajib RLS+FORCE+kebijakan), tabel ber-`tenant_id`
terlindungi, tanpa kebijakan `USING (true)`, tanpa fungsi SECURITY DEFINER, role runtime bukan superuser/BYPASSRLS. Batas laju per
tenant terisolasi (tenant B tidak ikut terblokir; ganti IP tidak menghindari batas tenant). `test/e2e.test.ts` menjalankan jalur lengkap
dengan dua tenant: tenant B tidak menerima event socket/webhook tenant A, tidak dapat membaca QR/chat/pesan/mengirim lewat sesi A.

## Status implementasi (Fase H)

Diuji: tenant lain tidak dapat melihat/mengubah/menghapus anggota atau undangan tenant ini (404/kosong) maupun menyelinap lewat SQL; hanya pemilik email + token yang sah yang dapat
membuat keanggotaan di tenant pengundang; kebijakan RLS mencegah eskalasi peran dan pendaftaran pengguna lain; metrik penggunaan dan filter tanggal hanya mengembalikan data tenant
sendiri (sesi tenant lain dalam `session_id` menghasilkan nol, bukan kebocoran); `tenant_invitations` tidak dapat dibaca platform.

## Status implementasi (Fase H2)

Diuji: jejak audit tenant lain tidak terbaca/ditulis/diubah/dihapus (RLS); tenant tidak dapat memalsukan jejak untuk tenant lain atau atas nama pengguna lain; pemegang token undangan berakun lain tidak dapat
mencatat penerimaan; perubahan kuota satu tenant tidak memengaruhi tenant lain.
