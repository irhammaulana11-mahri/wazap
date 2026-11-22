-- Retensi API key: konteks platform (penyapu retensi) boleh MENGHAPUS baris kunci yang SUDAH dicabut; kunci aktif tidak dapat dihapus lewat jalur ini.
-- Tidak ada SELECT/UPDATE/INSERT platform baru (SELECT sudah ada sejak 0022). Tanpa USING (true): syarat revoked_at menjaga kunci aktif.
CREATE POLICY api_keys_platform_delete_revoked ON api_keys FOR DELETE USING (is_platform() AND revoked_at IS NOT NULL);
