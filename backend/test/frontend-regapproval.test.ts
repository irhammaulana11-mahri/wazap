import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Penerimaan frontend untuk ADR-056 (persetujuan pendaftaran workspace). TIDAK AKTIF secara bawaan agar CI tidak merah selama frontend belum diperbarui; aktifkan dengan
 * FRONTEND_REGAPPROVAL_CHECK=1 (docs/08_AI_AGENTS/FRONTEND_REGAPPROVAL_AGENT_PROMPT.md). Setelah frontend selesai dan terverifikasi, hapus penjaga `skip`.
 * FRONTEND_SRC mengarah ke salinan lain (uji mutasi). Pemindaian statis atas kode TANPA komentar: tidak membuktikan tampilan di browser (karena itu ada verifikasi manual).
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const skip = (process.env.FRONTEND_REGAPPROVAL_CHECK !== '1' && 'dinonaktifkan sampai frontend diperbarui (FRONTEND_REGAPPROVAL_CHECK=1)') || (!fs.existsSync(FE) && 'frontend tidak ada');
const read = (p: string) => fs.readFileSync(path.join(FE, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const between = (s: string, from: string, to: string) => { const i = s.indexOf(from); const j = s.indexOf(to, i + from.length); return i < 0 ? '' : s.slice(i, j < 0 ? undefined : j); };

test('api.register membedakan 202 PENDING_APPROVAL dari sesi dan TIDAK menyimpan token yang tidak ada', { skip }, () => {
  const api = read('services/api.ts');
  const block = between(api, 'register: async', 'login: async');
  assert.ok(block.length > 40, 'api.register tidak ditemukan');
  assert.match(block, /PENDING_APPROVAL/, 'api.register tidak mengenali respons 202 PENDING_APPROVAL');
  const guard = block.search(/PENDING_APPROVAL/), set = block.search(/tokenStore\.set\(/);
  assert.ok(set < 0 || set > guard, 'tokenStore.set dipanggil sebelum pemeriksaan PENDING_APPROVAL (token undefined akan tersimpan)');
  assert.match(block, /access_token/, 'jalur sesi (mode terbuka) harus tetap ada');
});

test('halaman daftar: layar menunggu persetujuan dengan kode pemulihan, tanpa masuk ke dashboard pada jalur pending', { skip }, () => {
  const page = read('pages/RegisterPage.tsx');
  assert.match(page, /menunggu persetujuan/i, 'tidak ada pesan "menunggu persetujuan"');
  assert.match(page, /pending|PENDING_APPROVAL/, 'halaman tidak membedakan hasil pending');
  assert.match(page, /recovery_codes|recoveryCodes/, 'kode pemulihan tidak ditampilkan pada jalur pending');
  assert.doesNotMatch(page, /localStorage|sessionStorage/, 'kode pemulihan tidak boleh disimpan di storage');
});

test('halaman login menangani REGISTRATION_PENDING dan REGISTRATION_REJECTED', { skip }, () => {
  const page = read('pages/LoginPage.tsx');
  for (const c of ['REGISTRATION_PENDING', 'REGISTRATION_REJECTED']) assert.match(page, new RegExp(c), `LoginPage tidak menangani ${c}`);
});

test('klien platform: status PENDING/REJECTED, decided_at, dan metode approve/reject ke jalur yang benar', { skip }, () => {
  const api = read('services/platformApi.ts');
  assert.match(api, /'PENDING'/); assert.match(api, /'REJECTED'/); assert.match(api, /decided_at/);
  assert.match(api, /approve\s*:\s*async/, 'platformApi.approve tidak ada'); assert.match(api, /reject\s*:\s*async/, 'platformApi.reject tidak ada');
  assert.match(api, /workspaces\/\$\{encodeURIComponent\(id\)\}\/approve/, 'jalur approve salah'); assert.match(api, /workspaces\/\$\{encodeURIComponent\(id\)\}\/reject/, 'jalur reject salah');
  assert.doesNotMatch(between(api, 'approve:', 'reject:'), /localStorage|sessionStorage|document\.cookie/, 'klien platform tidak boleh menyentuh storage/cookie');
});

test('daftar workspace: filter PENDING/REJECTED dan lencana jumlah menunggu; detail: Setujui/Tolak dengan alasan wajib untuk tolak', { skip }, () => {
  const list = read('pages/platform/PlatformWorkspacesPage.tsx');
  assert.match(list, /value="PENDING"/, 'filter PENDING tidak ada'); assert.match(list, /value="REJECTED"/, 'filter REJECTED tidak ada');
  assert.match(list, /page_size\s*:\s*1/, 'lencana jumlah menunggu (status=PENDING, page_size=1, meta.total) tidak ada'); assert.match(list, /meta|total/, 'lencana tidak memakai meta.total');
  const det = read('pages/platform/PlatformWorkspaceDetailPage.tsx');
  assert.match(det, /platformApi\.approve\(/, 'detail tidak memanggil approve'); assert.match(det, /platformApi\.reject\(/, 'detail tidak memanggil reject');
  assert.match(det, /Setujui/); assert.match(det, /Tolak/);
  assert.match(det, /'PENDING'/, 'detail tidak membedakan status PENDING'); assert.match(det, /'REJECTED'/, 'detail tidak membedakan status REJECTED');
  assert.match(det, /\.trim\(\)\.length\s*(>=|<)\s*3/, 'tolak harus mewajibkan alasan minimal 3 karakter (reason.trim().length)');
});
