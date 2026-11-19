import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, dbAvailable } from './helpers.js';

const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { createKeyRotator } = await import('../src/runtime/rotate-keys.js');
const { aadOf } = await import('../src/modules/engine/auth-store.js');
const { webhookSecretAad } = await import('../src/security/webhook-signature.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');

const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');
const ring = (spec: string, active?: number) => createCredentialCrypto(parseKeyring(spec, active));
const v1 = ring(`1:${k1}`);
const both = ring(`1:${k1},2:${k2}`, 2); // v2 aktif, v1 masih terbaca
const onlyV2 = ring(`2:${k2}`);

const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
after(async () => { await t?.drop(); });
let n = 0;
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);

async function seed() {
  const reg = await createIdentityService(db).register({ email: `rk${++n}@x.test`, password: 'correct-horse-battery', tenantName: `T${n}` });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await createSessionService(db, { crypto: v1 }).create(principal, { name: `rks${n}`, autoConnect: false });
  const items: [string, string, string][] = [['creds', 'creds', 'KREDENSIAL-RAHASIA'], ['pre-key', '7', 'PREKEY-7'], ['session', 'abc@s.whatsapp.net', 'SESI-ABC']];
  for (const [type, id, plain] of items) {
    const { blob, keyVersion } = v1.encrypt(Buffer.from(plain), aadOf(s.id, type, id));
    await q(`INSERT INTO session_auth_state (session_id, tenant_id, item_type, item_id, ciphertext, encryption_key_version) VALUES ($1,$2,$3,$4,$5,$6)`, [s.id, reg.tenant.id, type, id, blob, keyVersion]);
  }
  await q(`INSERT INTO session_credentials (session_id, tenant_id, storage_key, encryption_key_version) VALUES ($1,$2,'auth',1)`, [s.id, reg.tenant.id]);
  const wh = await createWebhookService(db, { crypto: v1, policy: { allowHttp: true, allowPrivate: true } }).create(reg.tenant.id, { url: 'http://127.0.0.1:9/h', events: ['*'] });
  return { sid: s.id as string, tenantId: reg.tenant.id as string, items, wh };
}
const versions = async (sid: string) => (await q('SELECT item_type, encryption_key_version v FROM session_auth_state WHERE session_id = $1 ORDER BY item_type', [sid])).map((r: any) => r.v);

test('dry-run: melaporkan apa yang akan dirotasi tanpa mengubah apa pun', { skip }, async () => {
  const s = await seed();
  const rep = await createKeyRotator(db, both).run({ dryRun: true });
  assert.ok(rep.authState.rotated >= 3 && rep.webhookSecrets.rotated >= 1);
  assert.deepEqual(await versions(s.sid), [1, 1, 1]);
  assert.equal(rep.retireReady, false, 'dry-run tidak pernah menyatakan siap pensiun');
});

test('rotasi: semua data pindah ke kunci aktif, isi tetap sama, kunci lama tidak lagi dibutuhkan; idempoten', { skip }, async () => {
  const s = await seed();
  const rep = await createKeyRotator(db, both).run({ batch: 2 }); // batch kecil: uji paginasi
  assert.equal(rep.activeVersion, 2);
  assert.equal(rep.authState.failed, 0); assert.equal(rep.webhookSecrets.failed, 0);
  assert.deepEqual(await versions(s.sid), [2, 2, 2]);
  const rows = await q('SELECT item_type, item_id, ciphertext FROM session_auth_state WHERE session_id = $1', [s.sid]);
  for (const [type, id, plain] of s.items) {
    const row = rows.find((r: any) => r.item_type === type && r.item_id === id);
    assert.equal(onlyV2.decrypt(row.ciphertext, aadOf(s.sid, type, id)).toString(), plain, 'isi dipertahankan, terbaca hanya dengan kunci baru');
    assert.throws(() => v1.decrypt(row.ciphertext, aadOf(s.sid, type, id)), /tidak tersedia|gagal/, 'kunci lama tidak lagi membuka');
    assert.throws(() => onlyV2.decrypt(row.ciphertext, aadOf(s.sid, type, 'item-lain')), /gagal/, 'AAD tetap mengikat');
  }
  const wh = (await q('SELECT secret_ciphertext, secret_key_version v FROM webhook_endpoints WHERE id = $1', [s.wh.id]))[0];
  assert.equal(wh.v, 2);
  assert.equal(onlyV2.decrypt(wh.secret_ciphertext, webhookSecretAad(s.tenantId, s.wh.id)).toString(), s.wh.secret, 'secret webhook utuh');
  assert.equal((await q('SELECT encryption_key_version v FROM session_credentials WHERE session_id = $1', [s.sid]))[0].v, 2);
  const again = await createKeyRotator(db, both).run();
  assert.deepEqual([again.authState.rotated, again.webhookSecrets.rotated], [0, 0]);
  assert.equal(again.retireReady, true, 'tidak ada baris selain kunci aktif dan tidak ada kegagalan');
  assert.deepEqual(Object.keys(again.versions.session_auth_state), ['2']);
});

test('baris rusak dilaporkan gagal, tidak diubah, dan menahan pensiun kunci lama; baris lain tetap dirotasi', { skip }, async () => {
  const s = await seed();
  const bad = Buffer.from((await q(`SELECT ciphertext FROM session_auth_state WHERE session_id = $1 AND item_type = 'pre-key'`, [s.sid]))[0].ciphertext);
  bad[bad.length - 1] ^= 0xff; // rusak tag GCM
  await q(`UPDATE session_auth_state SET ciphertext = $2 WHERE session_id = $1 AND item_type = 'pre-key'`, [s.sid, bad]);
  const rep = await createKeyRotator(db, both).run();
  assert.ok(rep.authState.failed >= 1);
  assert.equal(rep.retireReady, false);
  const after = await q('SELECT item_type, encryption_key_version v, ciphertext FROM session_auth_state WHERE session_id = $1 ORDER BY item_type', [s.sid]);
  assert.deepEqual(after.map((r: any) => [r.item_type, r.v]), [['creds', 2], ['pre-key', 1], ['session', 2]]);
  assert.ok(Buffer.compare(after.find((r: any) => r.item_type === 'pre-key').ciphertext, bad) === 0, 'baris rusak tidak disentuh');
  assert.equal(JSON.stringify(rep).includes('PREKEY'), false, 'laporan tanpa data rahasia');
});

test('tulisan engine bersamaan menang (compare-and-swap): baris dilewati, bukan ditimpa', { skip }, async () => {
  const s = await seed();
  const victim = s.items[1]!; // pre-key
  const engineBlob = both.encrypt(Buffer.from('DITULIS-ENGINE'), aadOf(s.sid, victim[0], victim[1])).blob;
  let fired = false;
  // Kripto pembungkus: setelah rotator mendekripsi baris pre-key, tandai agar "engine" menulis SEBELUM UPDATE rotator.
  const racing = {
    activeVersion: both.activeVersion,
    encrypt: both.encrypt.bind(both),
    decrypt(blob: Buffer, aad: string) {
      const out = both.decrypt(blob, aad);
      if (aad === aadOf(s.sid, victim[0], victim[1])) fired = true;
      return out;
    },
  };
  const origTx = db.tx.bind(db);
  let injected = false;
  db.tx = async (ctx: any, fn: any) => {
    if (fired && !injected) { // transaksi berikutnya milik rotator adalah UPDATE-nya: engine mendahului
      injected = true;
      await origTx({ platform: true }, (c: any) => c.query(`UPDATE session_auth_state SET ciphertext = $3, encryption_key_version = 2 WHERE session_id = $1 AND item_type = $2`, [s.sid, victim[0], engineBlob]));
    }
    return origTx(ctx, fn);
  };
  try {
    const rep = await createKeyRotator(db, racing as any).run({ batch: 1 });
    assert.ok(rep.authState.skipped >= 1, 'baris yang berubah dilewati');
  } finally { db.tx = origTx; }
  const row = (await q(`SELECT ciphertext, encryption_key_version v FROM session_auth_state WHERE session_id = $1 AND item_type = $2`, [s.sid, victim[0]]))[0];
  assert.equal(row.v, 2);
  assert.equal(both.decrypt(row.ciphertext, aadOf(s.sid, victim[0], victim[1])).toString(), 'DITULIS-ENGINE', 'tulisan engine tidak tertimpa');
});
