import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Kontrak PERILAKU klien ekspor frontend (ADR-048): menjalankan `api.exportData` yang sebenarnya dengan `fetch` palsu dan memeriksa permintaan
 * yang benar-benar dikirim. Lebih kuat daripada tes statis `frontend-contract.test.ts` (yang membaca teks): yang diperiksa adalah method, path,
 * header, dan BODY terhadap skema Zod strict milik backend (routeContracts), jadi field salah/lebih/kurang langsung gagal.
 * Env opsional FRONTEND_SRC mengarahkan ke salinan frontend/src lain (dipakai uji mutasi).
 */
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const apiFile = path.join(FE, 'services/api.ts');
const skip = !fs.existsSync(apiFile) && 'frontend tidak ada';

const { CONTRACTS } = await import('../src/http/openapi/build.js');
const fe: any = skip ? null : await import(pathToFileURL(apiFile).href);
const api = fe?.api, tokenStore = fe?.tokenStore, ApiError = fe?.ApiError, setUnauthorizedHandler = fe?.setUnauthorizedHandler;

interface Call { url: string; method?: string; headers: Headers; body?: string; credentials?: string }
function stubFetch(handler: (c: Call, n: number, init: any) => Response | Promise<Response>) {
  const calls: Call[] = []; const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method, headers: new Headers(init.headers), body: init.body, credentials: init.credentials };
    calls.push(c);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return handler(c, calls.length, init);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const csvOk = (rows = 3, extra: Record<string, string> = {}) => new Response('a,b\r\n1,2\r\n', {
  status: 200,
  headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="wazap-ws-messages-20261120.csv"', 'x-export-rows': String(rows), ...extra },
});
const jsonErr = (status: number, code: string, message: string, details: unknown[] = [], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code, message, details }, request_id: 'rid-123' }), { status, headers: { 'content-type': 'application/json', ...headers } });

const SESSION = '3f2b8c1e-0a4d-4c55-9a77-1f2e3d4c5b6a';
const FROM = '2026-11-01T00:00:00+07:00', TO = '2026-11-08T00:00:00+07:00';
const CASES: Record<string, Record<string, unknown>> = {
  messages: { password: 'rahasia-1', format: 'csv', from: FROM, to: TO, session_id: SESSION, direction: 'IN' },
  outbound: { password: 'rahasia-1', format: 'ndjson', from: FROM, to: TO, session_id: SESSION, status: 'FAILED' },
  chats: { password: 'rahasia-1', format: 'ndjson', session_id: SESSION },
  contacts: { password: 'rahasia-1', format: 'csv' },
  'audit-logs': { password: 'rahasia-1', format: 'csv', from: FROM, to: TO },
  members: { password: 'rahasia-1', format: 'ndjson' },
};

test('exportData: tiap jenis memanggil POST /api/v1/exports/<jenis> dengan body yang lolos skema strict backend', { skip }, async () => {
  for (const [type, body] of Object.entries(CASES)) {
    tokenStore.set('token-uji');
    const s = stubFetch(() => csvOk(3));
    try {
      const res = await api.exportData(type, body);
      assert.equal(s.calls.length, 1, `${type}: satu permintaan`);
      const c = s.calls[0]!;
      assert.equal(c.url, `/api/v1/exports/${type}`, `${type}: path`);
      assert.equal(c.method, 'POST', `${type}: method`);
      assert.equal(c.headers.get('content-type'), 'application/json');
      assert.equal(c.headers.get('authorization'), 'Bearer token-uji', `${type}: token dari tokenStore (bukan URL/cookie)`);
      assert.ok(!c.url.includes('rahasia') && !c.url.includes('password') && !c.url.includes('?'), `${type}: kata sandi/parameter tidak boleh di URL`);
      const sent = JSON.parse(c.body!);
      const schema = CONTRACTS[`POST /exports/${type}`]!.body!;
      assert.doesNotThrow(() => schema.parse(sent), `${type}: body harus lolos skema strict backend; dikirim ${JSON.stringify(sent)}`);
      assert.deepEqual(sent, body, `${type}: semua field yang relevan terkirim, tanpa tambahan`);
      assert.equal(res.rows, 3); assert.equal(res.filename, 'wazap-ws-messages-20261120.csv');
      assert.equal(await res.blob.text(), 'a,b\r\n1,2\r\n');
    } finally { s.restore(); tokenStore.clear(); }
  }
});

test('exportData: field yang tidak relevan untuk jenisnya dibuang (backend strictObject menolak field asing dengan 400)', { skip }, async () => {
  const noise = { password: 'p', format: 'csv', from: FROM, to: TO, session_id: SESSION, direction: 'IN', status: 'FAILED' };
  const expectKeys: Record<string, string[]> = {
    contacts: ['password', 'format'], members: ['password', 'format'], chats: ['password', 'format', 'session_id'],
    'audit-logs': ['password', 'format', 'from', 'to'], messages: ['password', 'format', 'from', 'to', 'session_id', 'direction'],
    outbound: ['password', 'format', 'from', 'to', 'session_id', 'status'],
  };
  for (const [type, keys] of Object.entries(expectKeys)) {
    const s = stubFetch(() => csvOk());
    try { await api.exportData(type, noise); const sent = JSON.parse(s.calls[0]!.body!); assert.deepEqual(Object.keys(sent).sort(), [...keys].sort(), `${type}: field terkirim`); }
    finally { s.restore(); }
  }
});

test('exportData: format bawaan csv; progres byte bertahap; nama berkas dengan fallback bila header tidak ada', { skip }, async () => {
  const enc = new TextEncoder();
  const chunks = ['abc', 'defg', 'hi'].map((x) => enc.encode(x));
  const s = stubFetch(() => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } }), { status: 200, headers: { 'content-type': 'text/csv' } }));
  try {
    const seen: number[] = [];
    const r = await api.exportData('contacts', { password: 'p' }, { onProgress: (b: number) => seen.push(b) });
    assert.equal(JSON.parse(s.calls[0]!.body!).format, 'csv', 'format bawaan');
    assert.deepEqual(seen, [3, 7, 9], 'progres kumulatif per potongan');
    assert.equal(await r.blob.text(), 'abcdefghi');
    assert.match(r.filename, /\.csv$/, 'nama cadangan bila Content-Disposition tidak ada'); assert.equal(r.rows, undefined);
  } finally { s.restore(); }
});

test('exportData: galat non-200 menjadi ApiError lengkap (status, kode, rincian, request_id); 429 membawa Retry-After (detik)', { skip }, async () => {
  const cases: [number, string, unknown[], Record<string, string>][] = [
    [422, 'EXPORT_TOO_LARGE', [{ max_rows: 3, estimated_rows: 4, capped: true }], {}],
    [403, 'INVALID_PASSWORD', [], {}], [409, 'EXPORT_IN_PROGRESS', [], {}], [503, 'NOT_CONFIGURED', [], {}], [400, 'VALIDATION_ERROR', [{ path: 'from', message: 'x' }], {}],
    [429, 'RATE_LIMITED', [], { 'retry-after': '30' }],
  ];
  for (const [status, code, details, headers] of cases) {
    const s = stubFetch(() => jsonErr(status, code, `pesan ${code}`, details, headers));
    try {
      await assert.rejects(api.exportData('messages', CASES.messages), (e: any) => {
        assert.ok(e instanceof ApiError, `${code}: harus ApiError`);
        assert.deepEqual([e.status, e.code, e.message, e.requestId], [status, code, `pesan ${code}`, 'rid-123']);
        assert.deepEqual(e.details, details);
        if (status === 429) assert.equal(e.retryAfterSec, 30, '429: ApiError.retryAfterSec (detik) dari header Retry-After, agar UI menampilkan waktu tunggu');
        return true;
      });
    } finally { s.restore(); }
  }
});

test('exportData: 401 => satu kali refresh single-flight lalu ulangi sekali dengan token baru; gagal lagi => token dibuang dan handler dipanggil', { skip }, async () => {
  tokenStore.set('lama');
  const s = stubFetch((c) => {
    if (c.url === '/api/v1/auth/refresh') return new Response(JSON.stringify({ success: true, data: { access_token: 'baru' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return c.headers.get('authorization') === 'Bearer baru' ? csvOk() : jsonErr(401, 'UNAUTHENTICATED', 'kedaluwarsa');
  });
  try {
    const [a, b] = await Promise.all([api.exportData('contacts', CASES.contacts), api.exportData('members', CASES.members)]);
    assert.equal(a.rows, 3); assert.equal(b.rows, 3);
    assert.equal(s.calls.filter((c) => c.url === '/api/v1/auth/refresh').length, 1, 'refresh single-flight untuk dua permintaan bersamaan');
    const retried = s.calls.filter((c) => c.url.startsWith('/api/v1/exports/') && c.headers.get('authorization') === 'Bearer baru');
    assert.equal(retried.length, 2, 'tiap permintaan diulang tepat sekali dengan token baru');
    assert.equal(tokenStore.get(), 'baru');
  } finally { s.restore(); }

  tokenStore.set('lama'); let kicked = 0; setUnauthorizedHandler(() => { kicked++; });
  const f = stubFetch((c) => (c.url === '/api/v1/auth/refresh' ? jsonErr(401, 'INVALID_REFRESH_TOKEN', 'x') : jsonErr(401, 'UNAUTHENTICATED', 'x')));
  try {
    await assert.rejects(api.exportData('contacts', CASES.contacts), (e: any) => e instanceof ApiError && e.status === 401);
    assert.equal(tokenStore.get(), null, 'token dibuang'); assert.equal(kicked, 1, 'handler tidak berwenang dipanggil sekali');
    assert.equal(f.calls.filter((c) => c.url.startsWith('/api/v1/exports/')).length, 1, 'tanpa ulangi bila refresh gagal');
  } finally { f.restore(); tokenStore.clear(); }
});

test('exportData: pembatalan (AbortSignal) menghentikan pembacaan dan melempar AbortError', { skip }, async () => {
  const s = stubFetch((_c, _n, init) => new Response(new ReadableStream({
    start(ctrl) { ctrl.enqueue(new TextEncoder().encode('x')); init.signal.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError'))); },
  }), { status: 200, headers: { 'content-type': 'text/csv' } }));
  try {
    const ac = new AbortController(); let first = false;
    const p = api.exportData('contacts', CASES.contacts, { signal: ac.signal, onProgress: () => { if (!first) { first = true; ac.abort(); } } });
    await assert.rejects(p, (e: any) => e?.name === 'AbortError');
  } finally { s.restore(); }
});
