import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Kontrak frontend <-> backend: setiap alamat API yang dipanggil frontend (frontend/src) harus ada di spesifikasi OpenAPI terbit
// (path DAN method). Menangkap frontend yang memanggil endpoint yang dihapus/diganti nama, dan sebaliknya mengingatkan bila backend berubah.
const ROOT = new URL('../../', import.meta.url).pathname;
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/02_BACKEND/openapi.json'), 'utf-8')) as { paths: Record<string, Record<string, unknown>> };
const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
const ops = new Set<string>(); const paths = new Set<string>();
for (const [p, item] of Object.entries(spec.paths)) { paths.add(norm(p)); for (const m of Object.keys(item)) ops.add(`${m.toUpperCase()} ${norm(p)}`); }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); }
  return out;
}
const SRC = path.join(ROOT, 'frontend/src');

// Literal yang BUKAN endpoint REST: path Socket.IO (dokumen: SOCKET_EVENTS.md).
const NOT_REST = new Set(['/api/v1/realtime']);

test('semua panggilan API di SELURUH frontend/src cocok dengan operasi di openapi.json (path dan method)', { skip: !fs.existsSync(SRC) && 'frontend tidak ada' }, () => {
  // Tiap panggilan: literal '/api/v1/...' diikuti (dalam jendela pendek, sebelum panggilan berikutnya) opsi `method: 'X'`; tanpa itu = GET.
  const re = /(['"`])(\/api\/v1\/[^'"`\s]*)\1/g;
  const calls: { p: string; method: string; file: string }[] = [];
  let exportsSeen = false;
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // Pemeriksaan awalan (mis. path.startsWith('/api/v1/auth/') untuk cookie/401) bukan permintaan.
      if (/(startsWith|includes)\(\s*$/.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
      const raw = m[2]!.split('?')[0]!;
      if (NOT_REST.has(raw)) continue;
      // Ekspor memakai fetch dengan path dari variabel sehingga method-nya tidak terbaca pembaca teks ini; kontraknya diperiksa oleh tes PERILAKU
      // (frontend-export-client.test.ts: menjalankan klien sungguhan dan memvalidasi body terhadap skema strict backend). Komentar `/* method: */` tidak dihitung.
      if (/^\/api\/v1\/exports(\/|$)/.test(raw)) { exportsSeen = true; continue; }
      const p = raw.replace(/\$\{[^}]*\}/g, '{}');
      const tail = text.slice(re.lastIndex, re.lastIndex + 220).split(/request<|req</)[0]!;
      const mm = /method:\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(tail);
      calls.push({ p, method: mm?.[1] ?? 'GET', file: path.relative(SRC, file) });
    }
  }
  assert.ok(calls.length >= 50, `terlalu sedikit panggilan terbaca (${calls.length}); parser perlu diperbarui`);
  if (exportsSeen) assert.ok(fs.existsSync(path.join(ROOT, 'backend/test/frontend-export-client.test.ts')), 'frontend memanggil /api/v1/exports tetapi tes perilaku backend/test/frontend-export-client.test.ts tidak ada');
  const bad: string[] = [];
  for (const { p, method, file } of calls) {
    // `${query}` di ujung path adalah string query, bukan segmen path
    const cands = [p, p.replace(/\/$/, ''), p.replace(/\{\}$/, '')];
    if (!cands.some((c) => ops.has(`${method} ${c}`))) bad.push(`${method} ${p} (${file})${cands.some((c) => paths.has(c)) ? ': path ada, method berbeda' : ': path tidak ada'}`);
  }
  assert.deepEqual([...new Set(bad)], [], `frontend memanggil endpoint yang tidak ada di spesifikasi:\n  ${[...new Set(bad)].join('\n  ')}`);
});

test('frontend tidak menyimpan rahasia di kode atau berkas yang ter-commit', { skip: !fs.existsSync(SRC) && 'frontend tidak ada' }, () => {
  const hits: string[] = [];
  for (const f of walk(SRC)) {
    const t = fs.readFileSync(f, 'utf-8');
    if (/(JWT_SECRET|CREDENTIAL_ENCRYPTION_KEYS|DB_PASSWORD)\s*[=:]\s*['"`][A-Za-z0-9+/_-]{16,}/.test(t)) hits.push(path.relative(ROOT, f));
    if (/gwk_[A-Za-z0-9]{16,}/.test(t)) hits.push(`${path.relative(ROOT, f)} (API key)`);
  }
  assert.deepEqual(hits, []);
  assert.ok(!fs.readdirSync(path.join(ROOT, 'frontend')).some((n) => n.startsWith('.env') && n !== '.env.example'), 'berkas .env frontend tidak boleh ada di repo');
});
