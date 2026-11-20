import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const { buildApp } = await import('../src/app.js');
const { collectRoutes, generateOpenApi, CONTRACTS } = await import('../src/http/openapi/build.js');
const { OPERATIONS } = await import('../src/http/openapi/operations.js');
const { API_KEY_SCOPES } = await import('../src/modules/identity/principal.js');

const app = buildApp();
const get = collectRoutes(app);
await app.ready();
const routes = get();
await app.close();
const doc = generateOpenApi(routes) as any;

test('kelengkapan: setiap route publik ada di OPERATIONS dan sebaliknya (route baru tanpa dokumen = gagal)', () => {
  const real = new Set(routes.filter((r) => r.url.startsWith('/api/v1') || r.url.startsWith('/health')).map((r) => r.key));
  const docd = new Set(Object.keys(OPERATIONS));
  const undocumented = [...real].filter((k) => !docd.has(k));
  const ghost = [...docd].filter((k) => !real.has(k));
  assert.deepEqual(undocumented, [], `route belum terdokumentasi di src/http/openapi/operations.ts: ${undocumented.join(', ')}`);
  assert.deepEqual(ghost, [], `dokumen untuk route yang tidak ada: ${ghost.join(', ')}`);
  assert.ok(real.size >= 75);
});

test('kontrak request: setiap kunci milik route nyata, dan route berbody/query memiliki skema', () => {
  const real = new Set(routes.map((r) => r.key));
  assert.deepEqual(Object.keys(CONTRACTS).filter((k) => !real.has(k)), []);
  for (const k of ['POST /auth/register', 'POST /auth/login', 'POST /messages/send', 'POST /messages/send-media', 'POST /sessions', 'POST /webhooks', 'GET /sessions', 'GET /messages', 'GET /audit-logs'])
    assert.ok(CONTRACTS[k], `kontrak request hilang: ${k}`);
});

test('struktur dokumen: operationId unik, $ref terselesaikan, parameter path sesuai, tag dideklarasikan, ada respons sukses', () => {
  assert.equal(doc.openapi, '3.1.0');
  const ids = new Set<string>(); const tags = new Set(doc.tags.map((t: any) => t.name));
  const refs: string[] = [];
  const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === '$ref') refs.push(v as string); else walk(v); } };
  walk(doc);
  for (const r of refs) { const [, , a, b] = r.split('/'); assert.ok(doc.components?.[a!]?.[b!], `$ref tidak terselesaikan: ${r}`); }
  let n = 0;
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, op] of Object.entries<any>(item)) {
    n++;
    assert.ok(!ids.has(op.operationId), `operationId ganda ${op.operationId}`); ids.add(op.operationId);
    for (const t of op.tags) assert.ok(tags.has(t), `tag ${t} tidak dideklarasikan`);
    const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const declared = (op.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name).sort();
    assert.deepEqual(declared, inPath, `${method} ${path}: parameter path tidak cocok`);
    assert.ok(Object.keys(op.responses).some((s) => /^2\d\d$/.test(s)), `${method} ${path}: tanpa respons sukses`);
    assert.ok(Array.isArray(op.security), `${method} ${path}: security harus eksplisit (publik = [])`);
  }
  assert.ok(n >= 75);
});

test('keamanan diturunkan dari guard nyata (bukan salinan tulisan tangan)', () => {
  const op = (m: string, p: string) => doc.paths[p][m];
  assert.deepEqual(op('post', '/api/v1/auth/login').security, [], 'login publik');
  assert.deepEqual(op('post', '/api/v1/auth/reset-password').security, []);
  assert.deepEqual(op('get', '/health/live').security, []);
  const sessions = op('get', '/api/v1/sessions');
  assert.deepEqual(sessions.security, [{ bearerAuth: [] }, { apiKeyAuth: ['sessions:read'] }]);
  assert.deepEqual(sessions['x-roles'], ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
  assert.deepEqual(op('post', '/api/v1/messages/send')['x-roles'], ['OWNER', 'ADMIN', 'MEMBER'], 'VIEWER tidak boleh mengirim');
  assert.equal(op('post', '/api/v1/messages/send')['x-required-scope'], 'messages:send');
  for (const [p, m] of [['/api/v1/team/members', 'get'], ['/api/v1/api-keys', 'post'], ['/api/v1/tenant', 'delete'], ['/api/v1/auth/me', 'get']] as const) {
    assert.deepEqual(op(m, p).security, [{ bearerAuth: [] }], `${m} ${p}: hanya pengguna dashboard`);
    assert.equal(op(m, p)['x-user-only'], true);
  }
  assert.deepEqual(op('delete', '/api/v1/tenant')['x-roles'], ['OWNER']);
  const valid = new Set<string>(API_KEY_SCOPES);
  for (const item of Object.values<any>(doc.paths)) for (const o of Object.values<any>(item)) if (o['x-required-scope']) assert.ok(valid.has(o['x-required-scope']), `scope tidak dikenal: ${o['x-required-scope']}`);
});

test('request: body/query berasal dari skema route (strict, wajib/opsional, batas)', () => {
  const send = doc.paths['/api/v1/messages/send'].post;
  const body = send.requestBody.content['application/json'].schema;
  assert.equal(body.additionalProperties, false, 'strictObject => additionalProperties:false');
  assert.deepEqual([...body.required].sort(), ['message', 'session_id', 'to', 'type']);
  assert.equal(body.properties.type.const, 'text');
  assert.ok(send.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.in === 'header'));
  const list = doc.paths['/api/v1/sessions'].get.parameters;
  const status = list.find((p: any) => p.name === 'status');
  assert.ok(status.schema.enum.includes('CONNECTED') && status.required === false);
  assert.ok(doc.paths['/api/v1/sessions/{sessionId}/qr'].get.parameters.find((p: any) => p.name === 'sessionId').required);
});

test('galat standar terdokumentasi sesuai guard dan skema', () => {
  const send = doc.paths['/api/v1/messages/send'].post.responses;
  for (const s of ['202', '400', '401', '403', '413', '429', '503']) assert.ok(send[s], `send: respons ${s}`);
  const login = doc.paths['/api/v1/auth/login'].post.responses;
  assert.equal(login['401'], undefined, 'login publik tidak mengiklankan 401 dari guard (kegagalan kredensial lewat 401 domain bila ada)');
  assert.ok(doc.paths['/api/v1/sessions/{sessionId}'].get.responses['404']);
  assert.equal(doc.paths['/health/live'].get.responses['429'], undefined);
});

test('berkas terbit docs/02_BACKEND/openapi.json selalu mutakhir terhadap kode (jalankan: npm run openapi)', () => {
  const file = new URL('../../docs/02_BACKEND/openapi.json', import.meta.url);
  assert.ok(fs.existsSync(file), 'docs/02_BACKEND/openapi.json belum dihasilkan: npm run openapi');
  assert.equal(fs.readFileSync(file, 'utf-8'), JSON.stringify(doc, null, 2) + '\n', 'openapi.json tidak mutakhir: jalankan "npm run openapi" dan commit hasilnya');
});
