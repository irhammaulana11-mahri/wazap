import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createEngineService } = await import('../src/modules/engine/engine.service.js');
const { createLeaseService, FencedError } = await import('../src/modules/engine/lease.service.js');
const { createAuthStore } = await import('../src/modules/engine/auth-store.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');

const t = skip ? null : await createTestDb();
const db = t?.db as any;
after(async () => { await t?.drop(); });
const cr = createCredentialCrypto(parseKeyring(`1:${crypto.randomBytes(32).toString('base64')}`));

let n = 0;
async function rig() {
  const identity = createIdentityService(db); const sessions = createSessionService(db);
  const engines = createEngineService(db); const leases = createLeaseService(db, { ttlSeconds: 30 });
  const store = createAuthStore({ db, leases, crypto: cr });
  const reg = await identity.register({ email: `a${++n}@x.test`, password: 'correct-horse-battery', tenantName: `T${n}` });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await sessions.create(principal, { name: `s${n}`, autoConnect: false });
  const e1 = (await engines.register({ nodeName: `e1-${n}`, hostname: 'h', version: '1', capacity: { maxSessions: 5 } })).id;
  const e2 = (await engines.register({ nodeName: `e2-${n}`, hostname: 'h', version: '1', capacity: { maxSessions: 5 } })).id;
  const lease = (await leases.acquire(s.id, e1))!;
  return { tenantId: reg.tenant.id as string, sessionId: s.id as string, e1, e2, lease, leases, store, engines };
}
const rows = (sid: string) => db.tx({ platform: true }, async (c: any) => (await c.query('SELECT item_type, item_id, ciphertext FROM session_auth_state WHERE session_id = $1 ORDER BY 1,2', [sid])).rows);

test('creds + keys: simpan terenkripsi, muat ulang identik (Buffer & app-state-sync-key), auth_version naik', { skip }, async () => {
  const r = await rig();
  const h = await r.store.open(r.lease, r.tenantId);
  assert.equal(h.registered, false);
  h.state.creds.registered = true;
  await h.saveCreds();
  await h.state.keys.set({
    'pre-key': { '1': { private: Buffer.from('PRIV-SECRET-1'), public: Buffer.from('PUB1') }, '2': { private: Buffer.from('p2'), public: Buffer.from('q2') } },
    session: { 'abc.0': Buffer.from('SESSION-BLOB') },
    'app-state-sync-key': { K1: { keyData: Buffer.from('SYNCKEY'), timestamp: 5 } as any },
  });

  const h2 = await r.store.open(r.lease, r.tenantId);
  assert.equal(h2.registered, true);
  assert.deepEqual(h2.state.creds.noiseKey, h.state.creds.noiseKey);
  const got = await h2.state.keys.get('pre-key', ['1', '2', '3']);
  assert.deepEqual(got['1'].private, Buffer.from('PRIV-SECRET-1')); assert.ok(got['2']); assert.equal(got['3'], undefined);
  assert.deepEqual((await h2.state.keys.get('session', ['abc.0']))['abc.0'], Buffer.from('SESSION-BLOB'));
  const sk = (await h2.state.keys.get('app-state-sync-key', ['K1']))['K1'] as any;
  assert.deepEqual(Buffer.from(sk.keyData), Buffer.from('SYNCKEY'));

  // null => hapus
  await h2.state.keys.set({ 'pre-key': { '1': null as any } });
  assert.equal((await h2.state.keys.get('pre-key', ['1']))['1'], undefined);

  // tidak ada plaintext di DB
  const all = await rows(r.sessionId);
  for (const row of all) for (const needle of ['PRIV-SECRET', 'SESSION-BLOB', 'SYNCKEY', 'noiseKey', 'registered']) assert.ok(!row.ciphertext.includes(Buffer.from(needle)), `${row.item_type}/${needle}`);
  const cred = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT auth_version, storage_key, encryption_key_version FROM session_credentials WHERE session_id = $1', [r.sessionId])).rows[0]);
  assert.equal(cred.storage_key, 'db:session_auth_state'); assert.equal(cred.encryption_key_version, 1); assert.equal(cred.auth_version, 1);
  await h2.saveCreds();
  const v = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT auth_version FROM wa_sessions WHERE id = $1', [r.sessionId])).rows[0].auth_version);
  assert.equal(v, 2);
});

test('fencing: engine lama tidak bisa menulis setelah takeover; onFenced dipanggil; data tidak berubah', { skip }, async () => {
  const r = await rig();
  let fenced = 0;
  const h = await r.store.open(r.lease, r.tenantId, { onFenced: () => fenced++ });
  await h.saveCreds();
  const before = await rows(r.sessionId);
  // lease kedaluwarsa, engine lain mengambil alih
  await db.tx({ platform: true }, (c: any) => c.query(`UPDATE session_leases SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`, [r.sessionId]));
  const l2 = await r.leases.acquire(r.sessionId, r.e2);
  assert.ok(l2 && l2.fencingToken > r.lease.fencingToken);
  await assert.rejects(h.saveCreds(), FencedError);
  await assert.rejects(h.state.keys.set({ session: { x: Buffer.from('zzz') } }), FencedError);
  assert.equal(fenced, 2);
  assert.deepEqual(await rows(r.sessionId), before);
  // owner baru dapat menulis
  const h2 = await r.store.open(l2!, r.tenantId); await h2.saveCreds();
});

test('blob tidak bisa ditukar antar item/sesi (AAD) dan tenant tidak dapat membaca auth state (RLS)', { skip }, async () => {
  const a = await rig(); const b = await rig();
  const ha = await a.store.open(a.lease, a.tenantId); await ha.saveCreds();
  await ha.state.keys.set({ session: { one: Buffer.from('1'), two: Buffer.from('2') } });
  const hb = await b.store.open(b.lease, b.tenantId); await hb.saveCreds();
  // tukar ciphertext item 'one' <- 'two' dalam sesi sama
  await db.tx({ platform: true }, (c: any) => c.query(
    `UPDATE session_auth_state SET ciphertext = (SELECT ciphertext FROM session_auth_state WHERE session_id = $1 AND item_id = 'two') WHERE session_id = $1 AND item_id = 'one'`, [a.sessionId]));
  await assert.rejects(ha.state.keys.get('session', ['one']), /Dekripsi/);
  // salin creds sesi B ke sesi A
  await db.tx({ platform: true }, (c: any) => c.query(
    `UPDATE session_auth_state SET ciphertext = (SELECT ciphertext FROM session_auth_state WHERE session_id = $2 AND item_type = 'creds') WHERE session_id = $1 AND item_type = 'creds'`, [a.sessionId, b.sessionId]));
  await assert.rejects(a.store.open(a.lease, a.tenantId), /Dekripsi/);
  // RLS: konteks tenant tidak melihat apa pun
  const seen = await db.tx({ tenantId: a.tenantId }, async (c: any) => (await c.query('SELECT count(*)::int n FROM session_auth_state')).rows[0].n);
  assert.equal(seen, 0);
  await assert.rejects(db.tx({ tenantId: a.tenantId }, (c: any) => c.query(`INSERT INTO session_qr (session_id, tenant_id, ciphertext, encryption_key_version, expires_at) VALUES ($1,$2,'\\x00',1, now())`, [a.sessionId, a.tenantId])), /row-level security/);
});

test('erase menghapus auth state, QR, dan referensi kredensial', { skip }, async () => {
  const r = await rig();
  const h = await r.store.open(r.lease, r.tenantId); await h.saveCreds();
  await h.state.keys.set({ session: { x: Buffer.from('1') } });
  await r.store.erase(r.sessionId);
  assert.equal((await rows(r.sessionId)).length, 0);
  const c = await db.tx({ platform: true }, async (c: any) => (await c.query('SELECT count(*)::int n FROM session_credentials WHERE session_id = $1', [r.sessionId])).rows[0].n);
  assert.equal(c, 0);
});
