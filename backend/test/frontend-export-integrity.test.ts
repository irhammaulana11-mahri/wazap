import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Kontrak modul murni frontend untuk ekspor (ADR-048) dan penjaga statis atas temuan verifikasi UI. Modul diuji dengan data yang dibuat PENULIS CSV BACKEND
 * (csvRow), sehingga klien dan server terbukti saling cocok pada kasus sulit (CRLF/kutipan di dalam sel).
 *   frontend/src/utils/exportIntegrity.ts : verifyExportBlob(blob, format, expectedRows, opts?) -> {ok, rows, reason?}
 *   frontend/src/utils/exportRange.ts     : buildExportRange(startStr, endStr, maxSpanDays)    -> {ok:true, from, to, spanDays} | {ok:false, reason}
 * Env opsional FRONTEND_SRC mengarahkan ke salinan frontend/src lain.
 */
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const { csvRow, BOM, ndjsonLine } = await import('../src/modules/export/csv.js');
const { CONTRACTS } = await import('../src/http/openapi/build.js');

async function load(rel: string): Promise<any> {
  const f = path.join(FE, rel);
  if (!fs.existsSync(f)) assert.fail(`modul belum dibuat: frontend/src/${rel} (lihat docs/08_AI_AGENTS/FRONTEND_EXPORT_FIXES_PROMPT.md)`);
  return import(pathToFileURL(f).href);
}
const src = (rel: string) => { const f = path.join(FE, rel); assert.ok(fs.existsSync(f), `berkas tidak ada: ${rel}`); return fs.readFileSync(f, 'utf-8'); };

// ---------- exportIntegrity ----------
const HEAD = ['occurred_at', 'text'];
const ROWS = ['halo', 'baris 1\r\nbaris 2 (CRLF di dalam sel)', 'koma, "kutip", dan emoji 😀', 'x\r\ny\r\nz', 'lf\ndi dalam'];
const csv = (n: number) => BOM + csvRow(HEAD) + ROWS.slice(0, n).map((t, i) => csvRow([`2026-11-2${i}T00:00:00.000Z`, t])).join('');
const blob = (s: string) => new Blob([s]);

test('verifyExportBlob CSV: berkas lengkap lolos walau sel berisi CRLF, LF, kutipan, koma, dan emoji; hitungan tepat', async () => {
  const { verifyExportBlob } = await load('utils/exportIntegrity.ts');
  const r = await verifyExportBlob(blob(csv(5)), 'csv', 5);
  assert.deepEqual([r.ok, r.rows], [true, 5], JSON.stringify(r));
  assert.equal((await verifyExportBlob(blob(csv(5)), 'csv', undefined)).rows, 5, 'tanpa X-Export-Rows tetap menghitung');
});

test('verifyExportBlob CSV: berkas TERPOTONG terdeteksi, termasuk saat sel CRLF membuat hitungan teks naif tampak cukup (temuan 1)', async () => {
  const { verifyExportBlob } = await load('utils/exportIntegrity.ts');
  for (const n of [0, 1, 2, 3, 4]) {
    const r = await verifyExportBlob(blob(csv(n)), 'csv', 5);
    assert.equal(r.ok, false, `terpotong di ${n} dari 5 baris harus ditolak (dilaporkan: ${JSON.stringify(r)})`);
    assert.equal(r.rows, n, `jumlah baris terhitung ${n}`);
  }
  const cutInQuote = csv(2) + '2026-11-29T00:00:00.000Z,"teks yang terputus di tenga';
  const r = await verifyExportBlob(blob(cutInQuote), 'csv', 3);
  assert.equal(r.ok, false, 'terputus di dalam tanda kutip'); assert.ok(r.reason, 'ada alasan yang dapat ditampilkan');
});

test('verifyExportBlob CSV: jenis perkiraan (contacts) tidak dipersoalkan; jumlah baris lebih banyak dari perkiraan tidak dianggap terpotong', async () => {
  const { verifyExportBlob } = await load('utils/exportIntegrity.ts');
  assert.equal((await verifyExportBlob(blob(csv(3)), 'csv', 5, { approximate: true })).ok, true);
  assert.equal((await verifyExportBlob(blob(csv(5)), 'csv', 3)).ok, true, 'baris lampau yang tiba selama ekspor boleh membuat hasil lebih banyak');
});

test('verifyExportBlob NDJSON: manifest harus ada, TERAKHIR, dan jumlahnya sama dengan baris data (temuan: sebelumnya hanya cek manifest ada)', async () => {
  const { verifyExportBlob } = await load('utils/exportIntegrity.ts');
  const data = (n: number) => Array.from({ length: n }, (_, i) => ndjsonLine({ id: i, text: `pesan ${i} 😀` })).join('');
  const manifest = (rows: number) => ndjsonLine({ _manifest: { type: 'messages', rows, schema_version: 1 } });
  { const r = await verifyExportBlob(blob(data(3) + manifest(3)), 'ndjson', 3); assert.deepEqual([r.ok, r.rows], [true, 3]); }
  assert.equal((await verifyExportBlob(blob(data(0) + manifest(0)), 'ndjson', 0)).ok, true, 'kosong tetapi lengkap');
  assert.equal((await verifyExportBlob(blob(data(3)), 'ndjson', 3)).ok, false, 'tanpa manifest = terpotong');
  assert.equal((await verifyExportBlob(blob(data(2) + manifest(3)), 'ndjson', 3)).ok, false, 'manifest bilang 3 tetapi hanya 2 baris');
  assert.equal((await verifyExportBlob(blob(data(3) + manifest(5)), 'ndjson', 3)).ok, false, 'jumlah manifest tidak cocok');
  assert.equal((await verifyExportBlob(blob(data(2) + manifest(2) + data(1)), 'ndjson', 2)).ok, false, 'manifest bukan baris terakhir');
  assert.equal((await verifyExportBlob(blob(data(3) + manifest(3).trim()), 'ndjson', 3)).ok, true, 'tanpa baris baru di akhir tetap sah');
  assert.equal((await verifyExportBlob(blob(data(3) + '{"_manifest": {"rows": 3'), 'ndjson', 3)).ok, false, 'manifest terpotong');
});

test('verifyExportBlob: 100 ribu baris diperiksa bertahap (tanpa memuat satu string raksasa) dalam waktu wajar', async () => {
  const { verifyExportBlob } = await load('utils/exportIntegrity.ts');
  const parts = [BOM + csvRow(HEAD)];
  for (let i = 0; i < 100_000; i++) parts.push(csvRow([`2026-11-20T00:00:00.000Z`, i % 7 === 0 ? `baris\r\nganda ${i}` : `pesan ${i}`]));
  const t0 = performance.now();
  const r = await verifyExportBlob(new Blob(parts), 'csv', 100_000);
  const ms = performance.now() - t0;
  assert.deepEqual([r.ok, r.rows], [true, 100_000]);
  assert.ok(ms < 4000, `terlalu lambat: ${ms.toFixed(0)} ms`);
});

// ---------- exportRange ----------
function withTz<T>(tz: string, fn: () => T): T { const old = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } }

test('buildExportRange: awal hari lokal dengan offset, `to` eksklusif (awal hari berikutnya), offset negatif dan berpecahan menit benar', async () => {
  const { buildExportRange } = await load('utils/exportRange.ts');
  assert.deepEqual(withTz('Asia/Jakarta', () => buildExportRange('2026-11-01', '2026-11-07', 92)), { ok: true, from: '2026-11-01T00:00:00+07:00', to: '2026-11-08T00:00:00+07:00', spanDays: 7 });
  assert.equal(withTz('America/Sao_Paulo', () => buildExportRange('2026-11-01', '2026-11-01', 92)).from, '2026-11-01T00:00:00-03:00', 'offset negatif');
  assert.equal(withTz('Asia/Kolkata', () => buildExportRange('2026-11-01', '2026-11-01', 92)).to, '2026-11-02T00:00:00+05:30', 'offset +05:30');
  assert.equal(withTz('Asia/Jakarta', () => buildExportRange('2026-12-31', '2026-12-31', 92)).to, '2027-01-01T00:00:00+07:00', 'pergantian tahun');
});

test('buildExportRange: input kosong/tidak valid/terbalik/terlalu panjang ditolak SEBELUM dikirim (temuan 3: tanggal kosong menghasilkan NaN)', async () => {
  const { buildExportRange } = await load('utils/exportRange.ts');
  const bad = (a: string, b: string, max = 92) => withTz('Asia/Jakarta', () => buildExportRange(a, b, max));
  for (const [a, b] of [['', '2026-11-07'], ['2026-11-01', ''], ['', ''], ['2026-02-30', '2026-03-01'], ['bukan-tanggal', '2026-11-07'], ['2026-13-01', '2026-13-02'], ['2026-11-1', '2026-11-7']]) {
    const r = bad(a, b); assert.equal(r.ok, false, `harus ditolak: "${a}" - "${b}"`); assert.ok(r.reason);
  }
  assert.equal(bad('2026-11-08', '2026-11-01').ok, false, 'akhir sebelum awal');
  assert.equal(bad('2026-11-01', '2026-11-01').ok, true, 'satu hari sah');
  assert.equal(bad('2026-01-01', '2026-04-02', 92).ok, true, '92 hari tepat sah');
  assert.equal(bad('2026-01-01', '2026-04-03', 92).ok, false, '93 hari ditolak');
});

test('buildExportRange: hasilnya selalu lolos validasi backend (skema strict + batas rentang dalam milidetik), termasuk di zona DST', async () => {
  const { buildExportRange } = await load('utils/exportRange.ts');
  const schema = CONTRACTS['POST /exports/audit-logs']!.body!;
  const DAY = 86_400_000;
  for (const tz of ['Asia/Jakarta', 'Asia/Kolkata', 'America/Sao_Paulo', 'America/New_York', 'Europe/London', 'Pacific/Auckland']) {
    for (const [a, b] of [['2026-09-01', '2026-09-30'], ['2026-08-02', '2026-11-01'], ['2026-03-01', '2026-05-31'], ['2026-10-01', '2026-12-31']]) {
      const r = withTz(tz, () => buildExportRange(a!, b!, 92));
      if (!r.ok) continue; // ditolak klien itu sah; yang tidak boleh terjadi adalah lolos klien tetapi ditolak backend
      assert.doesNotThrow(() => schema.parse({ password: 'p', format: 'csv', from: r.from, to: r.to }), `${tz} ${a}..${b}: format ISO ditolak backend`);
      const spanMs = Date.parse(r.to) - Date.parse(r.from);
      assert.ok(spanMs <= 92 * DAY, `${tz} ${a}..${b}: rentang ${(spanMs / DAY).toFixed(3)} hari akan ditolak backend (maks 92)`);
    }
  }
  const dst = withTz('America/New_York', () => buildExportRange('2026-08-02', '2026-11-01', 92));
  assert.equal(dst.ok, false, '92 hari kalender yang melewati akhir DST = 92 hari + 1 jam: backend menolak, klien harus menolak lebih dulu');
});

// ---------- penjaga statis atas temuan lain ----------
test('penjaga statis ExportDrawer/SettingsPage: tanpa angka cadangan kebijakan, label terhubung, fokus, kata sandi di finally, Retry-After, request_id, tanpa blob.text()', () => {
  const drawer = src('components/export/ExportDrawer.tsx'), settings = src('pages/SettingsPage.tsx'), api = src('services/api.ts');
  const fails: string[] = [];
  const fallback = /\b(?:export)?[pP]olicy\??\.[A-Za-z_.]+\s*(?:\?\?|\|\|)\s*\d/g;
  for (const [name, text] of [['ExportDrawer', drawer], ['SettingsPage', settings]] as const)
    for (const m of text.matchAll(fallback)) fails.push(`${name}: angka cadangan untuk nilai kebijakan "${m[0]}" (tampilkan keadaan memuat/galat, jangan menebak: server 180/92 hari, bukan 90)`);
  const labels = [...drawer.matchAll(/<label\b[^>]*>/g)];
  const unlinked = labels.filter((m) => !/htmlFor=/.test(m[0]));
  if (unlinked.length) fails.push(`ExportDrawer: ${unlinked.length} <label> tanpa htmlFor (tidak terhubung ke kontrolnya)`);
  if (/tabIndex=\{-1\}/.test(drawer)) fails.push('ExportDrawer: tabIndex={-1} membuat kontrol tidak dapat dijangkau keyboard (tombol tampilkan kata sandi)');
  if (!/key\s*===\s*'Tab'/.test(drawer) || !/document\.activeElement/.test(drawer)) fails.push("ExportDrawer: fokus harus terjebak di dalam drawer (key === 'Tab') dan kembali ke pemicu (simpan document.activeElement)");
  const submit = drawer.slice(drawer.indexOf('const handleSubmit'));
  const fin = /finally\s*\{[^}]*\}/.exec(submit);
  if (!fin || !/setPassword\(\s*''\s*\)/.test(fin[0])) fails.push("ExportDrawer: setPassword('') harus berada di blok finally pada handleSubmit (kata sandi dikosongkan pada sukses, galat, dan batal)");
  if (!/retryAfterSec/.test(drawer)) fails.push('ExportDrawer: 429 harus menampilkan waktu tunggu dari ApiError.retryAfterSec');
  if (!/requestId/.test(drawer)) fails.push('ExportDrawer: tampilkan request_id pada galat untuk laporan');
  if (/\.text\(\)/.test(drawer)) fails.push('ExportDrawer: jangan memuat seluruh berkas sebagai string (blob.text()); pakai verifyExportBlob');
  if (!/verifyExportBlob/.test(drawer) || !/buildExportRange/.test(drawer)) fails.push('ExportDrawer: harus memakai verifyExportBlob dan buildExportRange dari utils/');
  if (/\/\*\s*method:/.test(api)) fails.push("api.ts: hapus komentar /* method: ... */ (kontrak diperiksa tes perilaku, bukan komentar)");
  assert.deepEqual(fails, [], `\n  - ${fails.join('\n  - ')}`);
});
