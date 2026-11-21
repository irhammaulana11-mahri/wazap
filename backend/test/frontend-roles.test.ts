import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Penerimaan frontend untuk ADR-053 (peran ADMIN dihapus). TIDAK AKTIF secara bawaan agar CI tidak merah selama frontend belum diperbarui; aktifkan dengan
 * FRONTEND_ROLES_CHECK=1 (dipakai agen frontend, docs/08_AI_AGENTS/FRONTEND_ROLES_AGENT_PROMPT.md). Setelah frontend selesai dan terverifikasi, hapus penjaga `skip`
 * agar regresi tertangkap CI. FRONTEND_SRC mengarahkan ke salinan frontend/src lain (uji mutasi).
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const skip = (process.env.FRONTEND_ROLES_CHECK !== '1' && 'dinonaktifkan sampai frontend diperbarui (FRONTEND_ROLES_CHECK=1)') || (!fs.existsSync(FE) && 'frontend tidak ada');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

test('frontend tidak lagi memakai peran ADMIN (ADR-053): tidak ada token ADMIN, Role tepat tiga nilai, tidak ada isOwnerOrAdmin', { skip }, () => {
  const hits: string[] = [];
  for (const f of files(FE)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/\bADMIN\b/.test(line) || /isOwnerOrAdmin/.test(line)) hits.push(`${path.relative(FE, f)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.equal(hits.length, 0, `masih ada rujukan ADMIN/isOwnerOrAdmin di frontend:\n${hits.join('\n')}`);
  const types = fs.readFileSync(path.join(FE, 'types/index.ts'), 'utf8');
  const m = types.match(/export type Role\s*=\s*([^;]+);/);
  assert.ok(m, 'type Role tidak ditemukan');
  assert.deepEqual([...m![1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]).sort(), ['MEMBER', 'OWNER', 'VIEWER']);
});
