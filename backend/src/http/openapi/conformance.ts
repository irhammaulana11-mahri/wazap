import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OPERATIONS } from './operations.js';
import { ErrorBody } from './schemas.js';
import { opKey } from './build.js';

/**
 * Mode kontrak (WAZAP_CONTRACT_CHECK=1): setiap response asli diperiksa terhadap skema yang diterbitkan. Dijalankan di seluruh suite tes,
 * jadi ratusan tes ikut menjadi tes kontrak tanpa skenario tambahan. Pelanggaran dicatat dan membuat proses keluar dengan kode 1
 * (tidak mengubah response). Tidak aktif di produksi kecuali env diset.
 */
export interface Violation { op: string; status: number; problem: string }
export const violations: Violation[] = [];
const seen = new Set<string>();
let exitHook = false;
const installed = new WeakSet<FastifyInstance>();

export function installContractCheck(app: FastifyInstance): void {
  if (installed.has(app)) return; // idempoten: tes dapat memasangnya sendiri walau env sudah memasangnya lewat buildApp
  installed.add(app);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      if (violations.length === 0) return;
      const uniq = [...new Map(violations.map((v) => [`${v.op} ${v.status} ${v.problem}`, v])).values()];
      process.stderr.write(`\n[KONTRAK] ${uniq.length} pelanggaran kontrak OpenAPI:\n${uniq.map((v) => `  - ${v.op} -> ${v.status}: ${v.problem}`).join('\n')}\n`);
      process.exitCode = 1;
    });
  }
  app.addHook('onSend', (req, reply, payload, done) => {
    try { check(req.method, req.routeOptions?.url, reply.statusCode, payload, String(reply.getHeader('content-type') ?? '')); } catch (e) { violations.push({ op: 'internal', status: 0, problem: String((e as Error).message) }); }
    done(null, payload);
  });
}

const fmt = (e: z.ZodError) => e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

function check(method: string, url: string | undefined, status: number, payload: unknown, contentType = ''): void {
  if (!url || method === 'HEAD' || method === 'OPTIONS') return; // 404 tanpa route, preflight
  if (!url.startsWith('/api/v1') && !url.startsWith('/health')) return; // route buatan tes (mis. /boom), bukan bagian API publik
  const key = opKey(method, url);
  const op = OPERATIONS[key];
  if (!op) { violations.push({ op: key, status, problem: 'route tidak terdokumentasi di OPERATIONS' }); return; }
  seen.add(`${key} ${status}`);
  let body: unknown;
  if (typeof payload === 'string' && payload.length > 0) { try { body = JSON.parse(payload); } catch { body = undefined; } }
  if (status >= 400) {
    // Galat: harus berbentuk amplop galat standar (kecuali health 503 yang memakai bentuk health).
    const documented = op.responses[status];
    const schema = documented ?? ErrorBody;
    const r = schema.safeParse(body);
    if (!r.success) violations.push({ op: key, status, problem: `body galat tidak sesuai: ${fmt(r.error)}` });
    return;
  }
  if (op.stream && status < 300) { // aliran non-JSON: periksa status dan Content-Type saja
    if (status !== 200) violations.push({ op: key, status, problem: `status sukses ${status} tidak terdokumentasi (hanya 200)` });
    else if (!op.stream.contentTypes.some((ct) => contentType.toLowerCase().startsWith(ct))) violations.push({ op: key, status, problem: `Content-Type ${contentType || '(kosong)'} bukan salah satu dari ${op.stream.contentTypes.join(', ')}` });
    return;
  }
  if (!(status in op.responses)) { violations.push({ op: key, status, problem: `status sukses ${status} tidak terdokumentasi (terdokumentasi: ${Object.keys(op.responses).join(', ')})` }); return; }
  const schema = op.responses[status];
  if (schema === null) { if (body !== undefined) violations.push({ op: key, status, problem: 'seharusnya tanpa body' }); return; }
  const r = (schema as z.ZodType).safeParse(body);
  if (!r.success) violations.push({ op: key, status, problem: `body tidak sesuai skema: ${fmt(r.error)}` });
}
