import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Penerimaan frontend untuk ADR-055 (API key dicabut disembunyikan lalu dihapus permanen; audit pembuatan/pencabutan) dan perbaikan filter aksi audit.
 * TIDAK AKTIF secara bawaan agar CI tidak merah selama frontend belum diperbarui; aktifkan dengan FRONTEND_APIKEYS_CHECK=1
 * (docs/08_AI_AGENTS/FRONTEND_APIKEYS_AGENT_PROMPT.md). Setelah frontend selesai dan terverifikasi, hapus penjaga `skip`. FRONTEND_SRC mengarah ke salinan lain (uji mutasi).
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const skip = (process.env.FRONTEND_APIKEYS_CHECK !== '1' && 'dinonaktifkan sampai frontend diperbarui (FRONTEND_APIKEYS_CHECK=1)') || (!fs.existsSync(FE) && 'frontend tidak ada');
// komentar dibuang sebelum diperiksa: syarat tidak boleh dipenuhi hanya dengan menulis komentar
const read = (p: string) => fs.readFileSync(path.join(FE, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const BACKEND_ACTIONS = new Set([...fs.readFileSync(path.join(ROOT, 'backend/src/modules/audit/audit.ts'), 'utf8').split('export interface AuditEntry')[0].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));

test('filter aksi audit hanya memakai nama aksi yang benar-benar ada di backend, dan memuat api_key.created/api_key.revoked', { skip }, () => {
  const src = read('pages/AuditLogsPage.tsx');
  const values = [...src.matchAll(/<option\s+value="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(values.length >= 5, 'filter aksi tidak ditemukan');
  const bad = values.filter((v) => !BACKEND_ACTIONS.has(v));
  assert.deepEqual(bad, [], `nilai filter yang tidak pernah dicatat backend (filter ini selalu kosong): ${bad.join(', ')}`);
  for (const a of ['api_key.created', 'api_key.revoked']) {
    assert.ok(values.includes(a), `filter harus memuat ${a}`);
    assert.ok(new RegExp(`log\\.action\\s*===\\s*'${a.replace('.', '\\.')}'`).test(src), `label ramah untuk ${a} harus ada`);
  }
});

test('halaman API key: kunci yang sudah dicabut tidak ditampilkan sebagai aktif (revoked_at dipakai), 404 saat mencabut ditangani, daftar tidak meminta include_revoked', { skip }, () => {
  const page = read('pages/ApiKeysPage.tsx');
  assert.match(page, /revoked_at/, 'halaman tidak menyaring/menandai kunci dicabut');
  assert.match(page, /404|NOT_FOUND/, 'pencabutan kunci yang sudah terhapus (404) tidak ditangani');
  const api = read('services/api.ts');
  const block = api.slice(api.indexOf('getApiKeys'), api.indexOf('createApiKey'));
  assert.ok(block.length > 20 && !/include_revoked\s*=\s*true/.test(block), 'daftar kunci tidak boleh meminta kunci yang dicabut');
});

test('klien daftar API key meminta halaman penuh dan tidak memotong diam-diam (page_size atau paginasi lewat meta.total)', { skip }, () => {
  const api = read('services/api.ts');
  const block = api.slice(api.indexOf('getApiKeys'), api.indexOf('createApiKey'));
  assert.match(block, /page_size|meta/, 'getApiKeys hanya mengambil 20 kunci pertama tanpa paginasi');
});
