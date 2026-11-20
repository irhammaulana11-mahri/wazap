// Perf auth state WhatsApp (ADR-044). Mengukur biaya penyimpanan kunci Signal per sesi dan pada banyak sesi bersamaan.
// Jalankan: node --import tsx --test --test-timeout=300000 test/perf/auth-store.perf.ts   (butuh PostgreSQL; schema sementara gw_test_*)
// Ambang sengaja longgar (~10x hasil terukur di mesin dev) agar tidak rapuh; tujuannya menangkap regresi orde-besaran
// (mis. kembali memuat semua baris saat start, atau satu transaksi per kunci).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from '../helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../../src/modules/sessions/sessions.service.js');
const { createEngineService } = await import('../../src/modules/engine/engine.service.js');
const { createLeaseService } = await import('../../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../../src/modules/engine/auth-store.js');
const { createCredentialCrypto, parseKeyring } = await import('../../src/security/credential-crypto.js');

const t = skip ? null : await createTestDb();
const db = t?.db as any;
after(async () => { await t?.drop(); });
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));
const ms = (a: bigint) => Number(process.hrtime.bigint() - a) / 1e6;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
const rnd = (b: number) => crypto.randomBytes(b);
let n = 0;

async function rig() {
  const identity = createIdentityService(db), sessions = createSessionService(db), engines = createEngineService(db), leases = createLeaseService(db, { ttlSeconds: 600 });
  const store = createAuthStore({ db, leases, crypto: cr });
  const eng = (await engines.register({ nodeName: `perf-${++n}`, hostname: 'h', version: '1', capacity: { maxSessions: 500 } })).id;
  const reg = await identity.register({ email: `p${n}@x.test`, password: 'correct-horse-battery', tenantName: `T${n}` });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await sessions.create(principal, { name: `s${n}`, autoConnect: false });
  const lease = (await leases.acquire(s.id, eng))!;
  return { store, tenantId: reg.tenant.id as string, sessionId: s.id as string, lease };
}
/** Bentuk data seperti sinkronisasi awal Baileys: pre-key (197 B), lid-mapping (49 B), tctoken (~160 B). */
function syncData(pre: number, lid: number, tc: number) {
  return {
    'pre-key': Object.fromEntries(Array.from({ length: pre }, (_, i) => [String(i + 1), { private: rnd(32), public: rnd(33) }])),
    'lid-mapping': Object.fromEntries(Array.from({ length: lid }, (_, i) => [`${100000000000000 + i}_reverse`, String(6280000000000 + i)])),
    tctoken: Object.fromEntries(Array.from({ length: tc }, (_, i) => [`${100000000000000 + i}@lid`, { token: rnd(100), timestamp: String(Date.now()) }])),
  } as any;
}
async function bulkWrite(h: any, data: any, chunk: number) {
  const flat: [string, string, unknown][] = [];
  for (const [type, items] of Object.entries(data)) for (const [id, v] of Object.entries(items as object)) flat.push([type, id, v]);
  for (let i = 0; i < flat.length; i += chunk) { const d: any = {}; for (const [type, id, v] of flat.slice(i, i + chunk)) (d[type] ??= {})[id] = v; await h.state.keys.set(d); }
  return flat.length;
}

test('akun besar (30 ribu baris): start, baca, tulis, dan hapus tidak bergantung pada jumlah baris', { skip }, async () => {
  const r = await rig(); const h = await r.store.open(r.lease, r.tenantId); h.state.creds.registered = true; await h.saveCreds();
  const t0 = process.hrtime.bigint(); const rows = await bulkWrite(h, syncData(807, 24000, 5200), 500); const syncMs = ms(t0);
  assert.ok(rows >= 30000);
  assert.ok(syncMs < 15_000, `sinkron awal ${rows} baris terlalu lama: ${syncMs.toFixed(0)} ms`);

  const opens: number[] = []; for (let i = 0; i < 20; i++) { const a = process.hrtime.bigint(); await r.store.open(r.lease, r.tenantId); opens.push(ms(a)); }
  assert.ok(pct(opens, 0.95) < 100, `open() harus konstan (tidak memuat massal): p95=${pct(opens, 0.95).toFixed(1)} ms`);

  const hh = await r.store.open(r.lease, r.tenantId); const gets: number[] = [], sets: number[] = [];
  for (let i = 0; i < 100; i++) { const a = process.hrtime.bigint(); await hh.state.keys.get('pre-key', Array.from({ length: 10 }, (_, k) => String(1 + ((i * 10 + k) % 800)))); gets.push(ms(a)); }
  for (let i = 0; i < 100; i++) { const a = process.hrtime.bigint(); await hh.state.keys.set({ session: { [`${100918964056266 + i}_1.0`]: rnd(1300) } as any }); sets.push(ms(a)); }
  assert.ok(pct(gets, 0.95) < 100, `get 10 id p95=${pct(gets, 0.95).toFixed(1)} ms`);
  assert.ok(pct(sets, 0.95) < 100, `set 1 item p95=${pct(sets, 0.95).toFixed(1)} ms`);

  const a = process.hrtime.bigint(); await r.store.erase(r.sessionId); const delMs = ms(a);
  assert.ok(delMs < 5_000, `erase ${rows} baris: ${delMs.toFixed(0)} ms`);
  const left = (await db.tx({ platform: true }, (c: any) => c.query('SELECT count(*)::int n FROM session_auth_state WHERE session_id = $1', [r.sessionId]))).rows[0].n;
  assert.equal(left, 0, 'erase harus menghapus semuanya');
  console.log(`  [perf] ${rows} baris: sinkron ${syncMs.toFixed(0)} ms, open p95 ${pct(opens, 0.95).toFixed(1)} ms, get10 p95 ${pct(gets, 0.95).toFixed(1)} ms, set1 p95 ${pct(sets, 0.95).toFixed(1)} ms, erase ${delMs.toFixed(0)} ms`);
});

test('50 sesi bersamaan (pool 10): throughput jauh di atas kebutuhan dan tanpa galat', { skip }, async () => {
  const N = 50; const handles: any[] = [];
  for (let i = 0; i < N; i++) { const r = await rig(); const h = await r.store.open(r.lease, r.tenantId); h.state.creds.registered = true; await h.saveCreds(); await bulkWrite(h, syncData(300, 400, 100), 500); handles.push(h); }
  const lat: number[] = []; let ops = 0, errs = 0; const DUR = 10_000, stop = Date.now() + DUR;
  await Promise.all(handles.map(async (h, idx) => {
    let i = 0;
    while (Date.now() < stop) {
      const a = process.hrtime.bigint();
      try { if (i++ % 5 === 0) await h.state.keys.set({ session: { [`${idx}_${i}.0`]: rnd(1300) } as any }); else await h.state.keys.get('pre-key', ['1', '2', '3']); } catch { errs++; }
      lat.push(ms(a)); ops++;
    }
  }));
  const rate = ops / (DUR / 1000);
  // Kebutuhan realistis: 50 sesi x 5 pesan/dtk x ~5 operasi kunci/pesan ~ 1.250 op/dtk. Ambang 1.000 op/dtk = batas bawah yang masih aman pada hardware ini.
  assert.equal(errs, 0, 'tidak boleh ada galat di bawah beban');
  assert.ok(rate > 1000, `throughput ${rate.toFixed(0)} op/dtk di bawah ambang`);
  assert.ok(pct(lat, 0.95) < 250, `p95 ${pct(lat, 0.95).toFixed(1)} ms terlalu tinggi saat jenuh`);
  console.log(`  [perf] ${N} sesi: ${rate.toFixed(0)} op/dtk, galat=${errs}, p50 ${pct(lat, 0.5).toFixed(1)} ms, p95 ${pct(lat, 0.95).toFixed(1)} ms`);
});
