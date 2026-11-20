// npm run openapi            -> menulis ../docs/02_BACKEND/openapi.json
// npm run openapi -- --check -> gagal (exit 1) bila berkas terbit berbeda dari kode (CI)
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
import fs from 'node:fs';
import path from 'node:path';

const { buildApp } = await import('../../app.js');
const { collectRoutes, generateOpenApi } = await import('./build.js');

const out = path.resolve(process.cwd(), process.env.OPENAPI_OUT ?? '../docs/02_BACKEND/openapi.json');
const app = buildApp();
const routes = collectRoutes(app);
await app.ready();
const doc = generateOpenApi(routes());
await app.close();
const text = JSON.stringify(doc, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf-8') : '';
  if (cur !== text) { console.error(`openapi.json TIDAK mutakhir terhadap kode: jalankan "npm run openapi" dan commit hasilnya (${out})`); process.exit(1); }
  console.log(`openapi.json mutakhir (${Object.keys(doc.paths).length} path)`);
} else {
  fs.writeFileSync(out, text);
  const ops = Object.values(doc.paths as Record<string, object>).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`ditulis ${out}: ${ops} operasi, ${Object.keys(doc.components.schemas).length} skema`);
}
process.exit(0);
