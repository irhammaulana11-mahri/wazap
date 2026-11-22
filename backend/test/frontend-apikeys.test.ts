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

test('kartu sesi menyediakan penyalinan ID sesi LENGKAP (integrasi membutuhkan session_id penuh)', { skip }, () => {
  const page = read('pages/SessionsPage.tsx');
  assert.match(page, /clipboard\.writeText\(\s*[A-Za-z_.]*session[A-Za-z_]*\.id\s*\)|clipboard\.writeText\(\s*[A-Za-z_]+\.id\s*\)/, 'tidak ada tombol yang menyalin ID sesi lengkap');
  assert.match(page, /Salin ID/i, 'tombol salin ID sesi tidak berlabel');
});

test('contoh kode di halaman API key memakai bentuk kunci yang benar (gwk_), bukan placeholder lama', { skip }, () => {
  const page = read('pages/ApiKeysPage.tsx');
  assert.doesNotMatch(page, /wzp_live/, 'placeholder kunci lama (wzp_live_...) masih ada: bukan bentuk kunci WAZAP');
  assert.match(page, /gwk_/, 'contoh kode harus memakai bentuk kunci gwk_...');
});

test('copyKey menunggu hasil clipboard: "Tersalin" hanya setelah berhasil, ada penanganan gagal dengan penyalinan manual', { skip }, () => {
  const page = read('pages/ApiKeysPage.tsx');
  const start = page.indexOf('const copyKey');
  assert.ok(start >= 0, 'fungsi copyKey tidak ditemukan');
  const body = page.slice(start, page.indexOf('\n  };', start) + 5);
  const write = body.search(/clipboard\.writeText\(/);
  assert.ok(write >= 0, 'copyKey tidak menyalin');
  assert.match(body, /async\s*\(|async\s+function|=\s*async/, 'copyKey harus async');
  assert.match(body, /await\s+navigator\.clipboard\.writeText\(|clipboard\.writeText\([^)]*\)\s*\.then\(/, 'hasil writeText tidak ditunggu');
  assert.match(body, /catch/, 'kegagalan clipboard tidak ditangani');
  const ok = body.indexOf('setCopiedKey(true)');
  assert.ok(ok > write, 'status "Tersalin" harus diatur SETELAH penyalinan');
  assert.match(body, /manual/i, 'tidak ada pesan/jalur penyalinan manual saat gagal');
});
