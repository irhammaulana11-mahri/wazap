import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Penerimaan frontend konsol platform (ADR-054; prompt: docs/08_AI_AGENTS/FRONTEND_PLATFORM_AGENT_PROMPT.md). TIDAK AKTIF secara bawaan agar CI tidak merah selama frontend belum selesai;
 * aktifkan dengan FRONTEND_PLATFORM_CHECK=1 (saat aktif, berkas yang belum ada MENGGAGALKAN tes, bukan dilewati). Setelah frontend terverifikasi, hapus penjaga `skip`.
 * FRONTEND_SRC mengarahkan ke salinan frontend/src lain (uji mutasi dan kontrol positif).
 *
 * Yang dibuktikan: klien platform yang SEBENARNYA dijalankan dengan `fetch` palsu dan tiap permintaan diperiksa terhadap skema Zod strict backend (method, path, query, body);
 * token platform terpisah total dari token workspace (tidak saling dipakai, tidak pernah ke storage); perilaku galat (401, 429 Retry-After, jaringan/Access); serta pemindai
 * sumber untuk pemisahan modul dan larangan menyimpan/mencatat rahasia.
 */
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const skip = process.env.FRONTEND_PLATFORM_CHECK !== '1' && 'dinonaktifkan sampai frontend konsol platform selesai (FRONTEND_PLATFORM_CHECK=1)';
const apiFile = path.join(FE, 'services/api.ts'), pFile = path.join(FE, 'services/platformApi.ts');

const { CONTRACTS } = await import('../src/http/openapi/build.js');
let ws: any = null, mod: any = null, loadError = '';
if (!skip) {
  try { ws = await import(pathToFileURL(apiFile).href); mod = await import(pathToFileURL(pFile).href); } catch (e) { loadError = String((e as Error).message ?? e); }
}
const UUID = '3f2b8c1e-0a4d-4c55-9a77-1f2e3d4c5b6a';

interface Call { url: string; method?: string; headers: Headers; body?: string; credentials?: string }
function stubFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []; const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method, headers: new Headers(init.headers), body: init.body, credentials: init.credentials };
    calls.push(c); return handler(c, calls.length);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const okBody = (data: unknown, meta?: unknown) => new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });
const errBody = (status: number, code: string, message: string, details: unknown[] = [], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code, message, details }, request_id: 'rid-9' }), { status, headers: { 'content-type': 'application/json', ...headers } });
/** Akses storage/dokumen oleh klien platform = kegagalan: dibungkus Proxy yang melempar. */
function forbidStorage() {
  const boom = (n: string) => new Proxy({}, { get: (_t, p) => { throw new Error(`klien platform menyentuh ${n}.${String(p)} (token/rahasia tidak boleh disimpan di storage atau cookie)`); }, set: () => { throw new Error(`klien platform menulis ${n}`); } });
  const prev = { l: (globalThis as any).localStorage, s: (globalThis as any).sessionStorage, d: (globalThis as any).document };
  (globalThis as any).localStorage = boom('localStorage'); (globalThis as any).sessionStorage = boom('sessionStorage'); (globalThis as any).document = boom('document');
  return () => { (globalThis as any).localStorage = prev.l; (globalThis as any).sessionStorage = prev.s; (globalThis as any).document = prev.d; };
}
const queryOf = (url: string) => Object.fromEntries(new URL(url, 'http://x').searchParams.entries());
const strictQuery = (key: string, url: string) => { const q = queryOf(url); const schema = (CONTRACTS as any)[key]!.query!; assert.doesNotThrow(() => schema.parse(q), `${key}: query harus lolos skema strict backend; dikirim ${JSON.stringify(q)}`); return q; };

test('klien platform dimuat dan mengekspor kontrak yang disyaratkan prompt', { skip }, () => {
  assert.equal(loadError, '', `services/platformApi.ts harus ada dan dapat dimuat: ${loadError}`);
  for (const k of ['login', 'verify', 'me', 'listWorkspaces', 'getWorkspace', 'updateQuotas', 'suspend', 'activate', 'getDefaults', 'updateDefaults', 'listAudit', 'backupStatus']) assert.equal(typeof mod.platformApi?.[k], 'function', `platformApi.${k}`);
  for (const k of ['get', 'set', 'clear']) assert.equal(typeof mod.platformSession?.[k], 'function', `platformSession.${k}`);
  assert.equal(typeof mod.setPlatformUnauthorizedHandler, 'function');
});

test('tiap metode memanggil method/path/query/body yang lolos skema strict backend; field asing dan undefined dibuang; id di-encode', { skip }, async () => {
  const { platformApi: api, platformSession: sess } = mod;
  const restoreStore = forbidStorage();
  const s = stubFetch((c) => (c.url.endsWith('/auth/verify') ? okBody({ access_token: 'tok-platform', expires_in: 1800, admin: { user_id: UUID, email: 'a@x.test' }, recovery_remaining: 10 })
    : c.url.includes('/workspaces?') || c.url.endsWith('/workspaces') || c.url.includes('/audit') ? okBody([], { page: 1, page_size: 25, total: 0 }) : okBody({})));
  const last = () => s.calls[s.calls.length - 1]!;
  try {
    sess.clear();
    await api.login('a@x.test', 'kata-sandi'); let c = last();
    assert.deepEqual([c.url, c.method], ['/api/v1/platform/auth/login', 'POST']); assert.deepEqual(JSON.parse(c.body!), { email: 'a@x.test', password: 'kata-sandi' });
    assert.doesNotThrow(() => (CONTRACTS as any)['POST /platform/auth/login'].body.parse(JSON.parse(c.body!)));
    await api.verify('mfa.token.nilai.panjang.1234567890', '123456'); c = last();
    assert.deepEqual([c.url, c.method], ['/api/v1/platform/auth/verify', 'POST']); assert.deepEqual(JSON.parse(c.body!), { mfa_token: 'mfa.token.nilai.panjang.1234567890', code: '123456' });
    assert.doesNotThrow(() => (CONTRACTS as any)['POST /platform/auth/verify'].body.parse(JSON.parse(c.body!)));
    assert.equal(sess.get(), 'tok-platform', 'verify menyimpan token platform di memori (platformSession)');
    await api.me(); assert.deepEqual([last().url, last().method], ['/api/v1/platform/me', 'GET']);
    await api.listWorkspaces({ q: 'toko', status: 'ALL', page: 2, page_size: 10 }); c = last();
    assert.equal(c.method, 'GET'); assert.equal(c.url.split('?')[0], '/api/v1/platform/workspaces'); assert.deepEqual(strictQuery('GET /platform/workspaces', c.url), { q: 'toko', status: 'ALL', page: '2', page_size: '10' });
    await api.listWorkspaces({ q: undefined, status: undefined } as any); assert.ok(!/undefined|null/.test(last().url), `parameter undefined tidak boleh terkirim: ${last().url}`);
    await api.listWorkspaces(); assert.equal(last().url.split('?')[0], '/api/v1/platform/workspaces');
    await api.getWorkspace(UUID); assert.deepEqual([last().url, last().method], [`/api/v1/platform/workspaces/${UUID}`, 'GET']);
    await api.getWorkspace('a/b?c'); assert.equal(last().url, `/api/v1/platform/workspaces/${encodeURIComponent('a/b?c')}`, 'id di-encode (tidak dapat menyisipkan path atau query)');
    await api.updateQuotas(UUID, { max_sessions: 5, reason: 'alasan uji', otp: '123456', foo: 1 } as any); c = last();
    assert.deepEqual([c.url, c.method], [`/api/v1/platform/workspaces/${UUID}/quotas`, 'PATCH']); assert.deepEqual(JSON.parse(c.body!), { max_sessions: 5, reason: 'alasan uji', otp: '123456' }, 'hanya field kontrak');
    assert.doesNotThrow(() => (CONTRACTS as any)['PATCH /platform/workspaces/:id/quotas'].body.parse(JSON.parse(c.body!)));
    for (const kind of ['suspend', 'activate'] as const) {
      await api[kind](UUID, { reason: 'alasan uji', otp: '654321', extra: 1 } as any); c = last();
      assert.deepEqual([c.url, c.method], [`/api/v1/platform/workspaces/${UUID}/${kind}`, 'POST']); assert.deepEqual(JSON.parse(c.body!), { reason: 'alasan uji', otp: '654321' });
      assert.doesNotThrow(() => (CONTRACTS as any)[`POST /platform/workspaces/:id/${kind}`].body.parse(JSON.parse(c.body!)));
    }
    await api.getDefaults(); assert.deepEqual([last().url, last().method], ['/api/v1/platform/defaults', 'GET']);
    await api.updateDefaults({ max_members: 12, messages_per_minute: 90, reason: 'kebijakan paket', otp: '123456' }); c = last();
    assert.deepEqual([c.url, c.method], ['/api/v1/platform/defaults', 'PATCH']); assert.doesNotThrow(() => (CONTRACTS as any)['PATCH /platform/defaults'].body.parse(JSON.parse(c.body!)));
    await api.listAudit({ tenant_id: UUID, action: 'tenant.quota_changed', page: 1, page_size: 25 }); c = last();
    assert.equal(c.url.split('?')[0], '/api/v1/platform/audit'); strictQuery('GET /platform/audit', c.url);
    await api.backupStatus(); assert.deepEqual([last().url, last().method], ['/api/v1/platform/backup-status', 'GET']);
    for (const call of s.calls) assert.ok(!call.url.includes('otp') && !call.url.includes('password') && !call.url.includes('token'), `rahasia tidak boleh di URL: ${call.url}`);
  } finally { s.restore(); restoreStore(); sess.clear(); }
});

test('token platform terpisah total dari token workspace: header Authorization, tanpa API key, tanpa credentials, login/verify tanpa token, tidak pernah menyentuh storage', { skip }, async () => {
  const { platformApi: api, platformSession: sess } = mod; const { tokenStore } = ws;
  const restoreStore = forbidStorage();
  const s = stubFetch(() => okBody({}));
  try {
    tokenStore.set('token-WORKSPACE'); sess.set('token-PLATFORM');
    await api.me(); await api.getDefaults(); await api.listAudit(); await api.updateQuotas(UUID, { max_sessions: 4, reason: 'alasan uji', otp: '123456' });
    for (const c of s.calls) {
      assert.equal(c.headers.get('authorization'), 'Bearer token-PLATFORM', `${c.url}: hanya token platform`);
      assert.ok(!c.headers.has('x-api-key'), 'tanpa X-API-Key'); assert.equal(c.credentials, 'omit', `${c.url}: credentials harus 'omit' (cookie refresh pelanggan tidak ikut)`);
      assert.ok(!JSON.stringify([...c.headers.entries()]).includes('token-WORKSPACE'), 'token workspace tidak pernah dikirim ke rute platform');
    }
    s.calls.length = 0;
    await api.login('a@x.test', 'kata-sandi'); await api.verify('mfa.token.nilai.panjang.1234567890', '123456');
    for (const c of s.calls) assert.ok(!c.headers.has('authorization'), `${c.url}: login/verify tidak membawa Authorization walau token platform ada`);
    assert.equal(tokenStore.get(), 'token-WORKSPACE', 'token workspace tidak disentuh klien platform');
    sess.clear(); assert.equal(sess.get(), null);
  } finally { s.restore(); restoreStore(); tokenStore.clear(); sess.clear(); }
});

test('galat: ApiError lengkap (status, kode, rincian, request_id); 429 membawa Retry-After; 401 menghapus token platform, memanggil handler SEKALI, tanpa refresh dan tanpa menyentuh token workspace; jaringan/Access', { skip }, async () => {
  const { platformApi: api, platformSession: sess, setPlatformUnauthorizedHandler: onUnauth } = mod; const { ApiError, tokenStore } = ws;
  const cases: [number, string, unknown[], Record<string, string>][] = [
    [400, 'VALIDATION_ERROR', [{ path: 'max_sessions', message: 'x' }], {}], [401, 'INVALID_OTP', [], {}], [409, 'LIMIT_BELOW_USAGE', [], {}], [409, 'NO_CHANGE', [], {}], [404, 'NOT_FOUND', [], {}],
    [429, 'ACCOUNT_LOCKED', [], { 'retry-after': '120' }], [429, 'RATE_LIMITED', [], { 'retry-after': '7' }],
  ];
  try {
    for (const [status, code, details, headers] of cases) {
      sess.set('tok'); let kicked = 0; onUnauth(() => { kicked++; });
      const s = stubFetch(() => errBody(status, code, `pesan ${code}`, details, headers));
      try {
        await assert.rejects(api.updateQuotas(UUID, { max_sessions: 4, reason: 'alasan uji', otp: '123456' }), (e: any) => {
          assert.ok(e instanceof ApiError, `${code}: ApiError`);
          assert.deepEqual([e.status, e.code, e.message, e.requestId], [status, code, `pesan ${code}`, 'rid-9']); assert.deepEqual(e.details, details);
          if (status === 429) assert.equal(e.retryAfterSec, Number(headers['retry-after']), `${code}: retryAfterSec (detik)`);
          return true;
        });
        assert.equal(s.calls.length, 1, `${code}: tidak ada percobaan ulang atau refresh`);
        if (status === 401) { assert.equal(sess.get(), null, '401: token platform dihapus'); assert.equal(kicked, 1, '401: handler dipanggil sekali'); }
        else { assert.equal(sess.get(), 'tok', `${status}: token tidak dihapus`); assert.equal(kicked, 0); }
      } finally { s.restore(); }
    }
    // 401 tidak boleh memicu alur refresh pelanggan dan tidak menyentuh token workspace
    tokenStore.set('token-WORKSPACE'); sess.set('tok'); let k = 0; onUnauth(() => { k++; });
    const s2 = stubFetch(() => errBody(401, 'UNAUTHENTICATED', 'kedaluwarsa'));
    try { await assert.rejects(api.me(), (e: any) => e instanceof ApiError && e.status === 401); assert.deepEqual(s2.calls.map((c) => c.url), ['/api/v1/platform/me'], 'tanpa /auth/refresh'); assert.equal(tokenStore.get(), 'token-WORKSPACE'); assert.equal(k, 1); } finally { s2.restore(); tokenStore.clear(); }
    // jaringan putus / respons bukan JSON (mis. halaman login Cloudflare Access): galat yang dapat ditampilkan, bukan crash
    for (const mk of [() => { throw new TypeError('Failed to fetch'); }, () => new Response('<html>Cloudflare Access</html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
      const s3 = stubFetch(mk as any);
      try { await assert.rejects(api.me(), (e: any) => { assert.ok(e instanceof ApiError); assert.equal(e.code, 'NETWORK_OR_ACCESS'); assert.match(e.message, /.+/); return true; }); } finally { s3.restore(); }
    }
  } finally { sess.clear(); onUnauth(() => {}); tokenStore.clear(); }
});

// ---------- pemindai sumber: pemisahan modul dan larangan membocorkan rahasia ----------
const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

test('pemindai sumber: klien platform tanpa storage/cookie/tokenStore/API key; modul platform terpisah dari modul pelanggan; tidak ada rahasia di console; halaman dan rute konsol ada', { skip }, () => {
  const client = strip(fs.readFileSync(pFile, 'utf8'));
  for (const bad of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'tokenStore', 'x-api-key', 'X-API-Key']) assert.ok(!client.includes(bad), `platformApi.ts tidak boleh memuat "${bad}"`);
  const platformOnly = (rel: string) => /^(services\/platformApi\.ts|pages\/platform\/|components\/platform\/)/.test(rel);
  const platformFiles = files(FE).filter((f) => platformOnly(path.relative(FE, f)));
  assert.ok(files(path.join(FE, 'pages/platform')).filter((f) => f.endsWith('.tsx')).length >= 5, 'pages/platform/ harus berisi minimal 5 halaman (login, daftar workspace, detail, default, audit; status cadangan boleh di dalam salah satunya)');
  const leaks: string[] = [], cross: string[] = [], storage: string[] = [];
  for (const f of files(FE)) {
    const rel = path.relative(FE, f), src = strip(fs.readFileSync(f, 'utf8'));
    if (platformOnly(rel)) {
      src.split('\n').forEach((l, i) => { if (/console\.(log|info|debug|warn|error)/.test(l) && /(otp|token|password|secret|recovery|code)/i.test(l)) leaks.push(`${rel}:${i + 1}`); if (/(localStorage|sessionStorage|document\.cookie)/.test(l)) storage.push(`${rel}:${i + 1}`); });
      if (/from ['"][^'"]*services\/api(\.js|\.ts)?['"]/.test(src) || /from ['"]\.\.?\/api(\.js|\.ts)?['"]/.test(src)) { const imp = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/api(?:\.js|\.ts)?['"]/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean)); const forbidden = imp.filter((x) => x !== 'ApiError'); if (forbidden.length) cross.push(`${rel} mengimpor klien pelanggan: ${forbidden.join(', ')}`); }
      if (/useAuth|AuthContext/.test(src)) cross.push(`${rel} memakai konteks auth pelanggan`);
    } else if (rel !== 'App.tsx' && /platformApi|platformSession/.test(src)) cross.push(`${rel} (di luar modul platform) memakai klien/sesi platform`);
  }
  assert.ok(platformFiles.length >= 6, 'berkas modul platform harus ada');
  assert.deepEqual(storage, [], 'modul platform tidak boleh memakai storage/cookie'); assert.deepEqual(leaks, [], 'console tidak boleh mencetak token/OTP/kata sandi/kode'); assert.deepEqual(cross, [], 'pemisahan modul platform dan pelanggan');
  const app = strip(fs.readFileSync(path.join(FE, 'App.tsx'), 'utf8'));
  assert.ok(/path=["']\/platform/.test(app), 'App.tsx harus mendaftarkan rute /platform'); assert.ok(/platformSession/.test(app), 'rute konsol dijaga oleh platformSession (bukan ProtectedRoute pelanggan)');
  const nav = files(path.join(FE, 'components/layout')).map((f) => strip(fs.readFileSync(f, 'utf8'))).join('\n');
  assert.ok(!/\/platform/.test(nav), 'menu/sidebar pelanggan tidak boleh memuat tautan ke konsol platform');
});
