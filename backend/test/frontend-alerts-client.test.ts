import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Kontrak PERILAKU klien notifikasi alarm di frontend (ADR-049): menjalankan fungsi `api.*` sungguhan dengan `fetch` palsu dan memeriksa permintaan
 * yang benar-benar dikirim (method, path, header, BODY terhadap skema strict backend) dan bentuk keluaran. Env FRONTEND_SRC mengarah ke salinan lain (uji mutasi).
 * Sengaja MERAH sampai UI dikerjakan; di-commit bersamaan dengan frontend final (lihat docs/08_AI_AGENTS/FRONTEND_ALERTS_AGENT_PROMPT.md).
 */
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const ROOT = new URL('../../', import.meta.url).pathname;
const FE = process.env.FRONTEND_SRC ?? path.join(ROOT, 'frontend/src');
const apiFile = path.join(FE, 'services/api.ts');
const skip = !fs.existsSync(apiFile) && 'frontend tidak ada';

const { CONTRACTS } = await import('../src/http/openapi/build.js');
const fe: any = skip ? null : await import(pathToFileURL(apiFile).href);
const api = fe?.api, tokenStore = fe?.tokenStore, ApiError = fe?.ApiError;

interface Call { url: string; method?: string; headers: Headers; body?: string }
function stubFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []; const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method, headers: new Headers(init.headers), body: init.body };
    calls.push(c); return handler(c, calls.length);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code, message, details: [] }, request_id: 'rid-9' }), { status, headers: { 'content-type': 'application/json', ...headers } });

const ID = '3f2b8c1e-0a4d-4c55-9a77-1f2e3d4c5b6a';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';
const SECRET_WORDS = ['rahasia-pw-1', TOKEN, 'hooks.slack.com'];

type Case = { name: string; run: () => Promise<any>; method: string; url: string; contract?: string; body?: unknown; response: unknown; expect: unknown };
const rule = { code: 'session.logged_out', enabled: true, threshold: null, cooldown_minutes: 60, channel_ids: [ID], updated_at: null };
const CASES: Case[] = [
  { name: 'getAlertCatalog', run: () => api.getAlertCatalog(), method: 'GET', url: '/api/v1/alerts/catalog', response: { enabled: true, rules: [] }, expect: { enabled: true, rules: [] } },
  { name: 'listAlertChannels', run: () => api.listAlertChannels(), method: 'GET', url: '/api/v1/alerts/channels', response: [], expect: [] },
  { name: 'createAlertChannel (Telegram)', method: 'POST', url: '/api/v1/alerts/channels', contract: 'POST /alerts/channels',
    body: { type: 'TELEGRAM', name: 'Tim', token: TOKEN, chat_id: '-1001234567890', password: 'rahasia-pw-1' },
    run: () => api.createAlertChannel({ type: 'TELEGRAM', name: 'Tim', token: TOKEN, chat_id: '-1001234567890', password: 'rahasia-pw-1' }), response: { id: ID }, expect: { id: ID } },
  { name: 'createAlertChannel (Slack)', method: 'POST', url: '/api/v1/alerts/channels', contract: 'POST /alerts/channels',
    body: { type: 'SLACK', name: 'Slack', url: 'https://hooks.slack.com/services/T/B/X', password: 'rahasia-pw-1' },
    run: () => api.createAlertChannel({ type: 'SLACK', name: 'Slack', url: 'https://hooks.slack.com/services/T/B/X', password: 'rahasia-pw-1' }), response: { id: ID }, expect: { id: ID } },
  { name: 'updateAlertChannel (nama/aktif, tanpa kata sandi)', method: 'PATCH', url: `/api/v1/alerts/channels/${ID}`, contract: 'PATCH /alerts/channels/:channelId',
    body: { name: 'Baru', active: false }, run: () => api.updateAlertChannel(ID, { name: 'Baru', active: false }), response: { id: ID }, expect: { id: ID } },
  { name: 'updateAlertChannel (ganti target Telegram)', method: 'PATCH', url: `/api/v1/alerts/channels/${ID}`, contract: 'PATCH /alerts/channels/:channelId',
    body: { token: TOKEN, chat_id: '555', password: 'rahasia-pw-1' }, run: () => api.updateAlertChannel(ID, { token: TOKEN, chat_id: '555', password: 'rahasia-pw-1' }), response: { id: ID }, expect: { id: ID } },
  { name: 'deleteAlertChannel (DELETE dengan body {password})', method: 'DELETE', url: `/api/v1/alerts/channels/${ID}`, contract: 'DELETE /alerts/channels/:channelId',
    body: { password: 'rahasia-pw-1' }, run: () => api.deleteAlertChannel(ID, 'rahasia-pw-1'), response: { id: ID, deleted: true }, expect: { id: ID, deleted: true } },
  { name: 'testAlertChannel', method: 'POST', url: `/api/v1/alerts/channels/${ID}/test`, run: () => api.testAlertChannel(ID), response: { ok: false, status_code: 401, error_code: null, duration_ms: 5 }, expect: { ok: false, status_code: 401, error_code: null, duration_ms: 5 } },
  { name: 'listAlertRules', run: () => api.listAlertRules(), method: 'GET', url: '/api/v1/alerts/rules', response: [rule], expect: [rule] },
  { name: 'putAlertRule', method: 'PUT', url: '/api/v1/alerts/rules/session.disconnected_long', contract: 'PUT /alerts/rules/:code',
    body: { enabled: true, threshold: 15, cooldown_minutes: 30, channel_ids: [ID] }, run: () => api.putAlertRule('session.disconnected_long', { enabled: true, threshold: 15, cooldown_minutes: 30, channel_ids: [ID] }), response: rule, expect: rule },
  { name: 'listAlertDeliveries (tanpa limit)', run: () => api.listAlertDeliveries(), method: 'GET', url: '/api/v1/alerts/deliveries', response: [], expect: [] },
  { name: 'listAlertDeliveries (limit=25)', run: () => api.listAlertDeliveries(25), method: 'GET', url: '/api/v1/alerts/deliveries?limit=25', contract: 'GET /alerts/deliveries', response: [], expect: [] },
];

test('klien alarm: tiap fungsi memanggil method+path yang benar, body lolos skema strict backend, mengembalikan isi data', { skip }, async () => {
  for (const c of CASES) {
    tokenStore.set('token-uji');
    const s = stubFetch(() => ok(c.response));
    try {
      const out = await c.run();
      assert.equal(s.calls.length, 1, `${c.name}: satu permintaan`);
      const call = s.calls[0]!;
      assert.equal(call.url, c.url, `${c.name}: URL`); assert.equal(call.method ?? 'GET', c.method, `${c.name}: method`);
      assert.equal(call.headers.get('authorization'), 'Bearer token-uji', `${c.name}: token dari tokenStore`);
      for (const w of SECRET_WORDS) assert.ok(!call.url.includes(w), `${c.name}: rahasia tidak boleh di URL`);
      if (c.body !== undefined) {
        const sent = JSON.parse(call.body!);
        assert.deepEqual(sent, c.body, `${c.name}: body persis tanpa field tambahan`);
        const schema = CONTRACTS[c.contract!]!.body!;
        assert.doesNotThrow(() => schema.parse(sent), `${c.name}: body harus lolos skema strict backend`);
      } else assert.ok(call.body === undefined || call.body === null, `${c.name}: tanpa body`);
      assert.deepEqual(out, c.expect, `${c.name}: keluaran = isi data`);
    } finally { s.restore(); tokenStore.clear(); }
  }
});

test('klien alarm: galat non-2xx menjadi ApiError lengkap (status, kode, request_id); 429 membawa retryAfterSec', { skip }, async () => {
  const cases: [number, string, Record<string, string>][] = [
    [422, 'INVALID_ALERT_TARGET', {}], [403, 'INVALID_PASSWORD', {}], [409, 'QUOTA_EXCEEDED', {}], [503, 'NOT_CONFIGURED', {}], [400, 'VALIDATION_ERROR', {}], [429, 'RATE_LIMITED', { 'retry-after': '45' }],
  ];
  const calls: [string, () => Promise<any>][] = [
    ['createAlertChannel', () => api.createAlertChannel({ type: 'SLACK', name: 'x', url: 'https://hooks.slack.com/services/a', password: 'p' })],
    ['testAlertChannel', () => api.testAlertChannel(ID)],
    ['putAlertRule', () => api.putAlertRule('session.logged_out', { enabled: false, channel_ids: [] })],
    ['deleteAlertChannel', () => api.deleteAlertChannel(ID, 'p')],
  ];
  for (const [name, fn] of calls) for (const [status, code, headers] of cases) {
    const s = stubFetch(() => err(status, code, `pesan ${code}`, headers));
    try {
      await assert.rejects(fn(), (e: any) => {
        assert.ok(e instanceof ApiError, `${name}/${code}: harus ApiError`);
        assert.deepEqual([e.status, e.code, e.message, e.requestId], [status, code, `pesan ${code}`, 'rid-9']);
        if (status === 429) assert.equal(e.retryAfterSec, 45, `${name}: 429 harus membawa retryAfterSec`);
        return true;
      });
    } finally { s.restore(); }
  }
});

test('klien alarm: 401 => satu kali refresh lalu ulangi sekali dengan token baru', { skip }, async () => {
  tokenStore.set('lama');
  const s = stubFetch((c) => {
    if (c.url === '/api/v1/auth/refresh') return ok({ access_token: 'baru' });
    return c.headers.get('authorization') === 'Bearer baru' ? ok([]) : err(401, 'UNAUTHENTICATED', 'kedaluwarsa');
  });
  try {
    assert.deepEqual(await api.listAlertChannels(), []);
    assert.equal(s.calls.filter((c) => c.url === '/api/v1/auth/refresh').length, 1);
    assert.equal(s.calls.filter((c) => c.url === '/api/v1/alerts/channels').length, 2, 'diulang tepat sekali');
  } finally { s.restore(); tokenStore.clear(); }
});

test('klien alarm: rahasia tidak bocor ke penyimpanan peramban atau ke ApiError.message setelah gagal', { skip }, async () => {
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
  (globalThis as any).localStorage = ls; (globalThis as any).sessionStorage = ls;
  const s = stubFetch(() => err(422, 'INVALID_ALERT_TARGET', 'Token bot Telegram tidak valid'));
  try {
    await assert.rejects(api.createAlertChannel({ type: 'TELEGRAM', name: 'x', token: TOKEN, chat_id: '1', password: 'rahasia-pw-1' }), (e: any) => {
      assert.ok(!String(e.message).includes(TOKEN) && !String(e.message).includes('rahasia-pw-1')); return true;
    });
    const dump = JSON.stringify([...store.entries()]);
    for (const w of SECRET_WORDS) assert.ok(!dump.includes(w), `rahasia ${w} tidak boleh ditulis ke penyimpanan peramban`);
  } finally { s.restore(); delete (globalThis as any).localStorage; delete (globalThis as any).sessionStorage; }
});
