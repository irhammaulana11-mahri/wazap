import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createTestDb, dbAvailable } from './helpers.js';

// Latihan rotasi kunci memakai CLI SUNGGUHAN (`npm run keys:rotate` = src/runtime/rotate-keys-cli.ts) sebagai proses terpisah, persis seperti operator.
// Menegaskan kontrak operasional di RUNBOOK: dry-run tidak mengubah apa pun, rotasi memindahkan semua data, kunci lama baru boleh dipensiunkan
// setelah rotasi, pensiun terlalu dini => exit 2 tanpa membocorkan rahasia, konfigurasi salah => exit 1.
const skip = !(await dbAvailable()) && 'PostgreSQL tidak tersedia';
const { createIdentityService } = await import('../src/modules/identity/identity.service.js');
const { createSessionService } = await import('../src/modules/sessions/sessions.service.js');
const { createWebhookService } = await import('../src/modules/webhooks/webhooks.service.js');
const { aadOf } = await import('../src/modules/engine/auth-store.js');
const { createCredentialCrypto, parseKeyring } = await import('../src/security/credential-crypto.js');

const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');
const v1 = createCredentialCrypto(parseKeyring(`1:${k1}`));
const t = skip ? null : await createTestDb(10);
const db = t?.db as any;
after(async () => { await t?.drop(); });
let n = 0;
const q = (sql: string, args: any[] = []) => db.tx({ platform: true }, async (c: any) => (await c.query(sql, args)).rows);

async function seed() {
  const reg = await createIdentityService(db).register({ email: `rc${++n}@x.test`, password: 'correct-horse-battery', tenantName: `T${n}` });
  const principal = { type: 'user', tenantId: reg.tenant.id, userId: reg.user.id, role: 'OWNER' } as any;
  const s = await createSessionService(db, { crypto: v1 }).create(principal, { name: `rcs${n}`, autoConnect: false });
  for (const [type, id, plain] of [['creds', 'creds', 'KREDENSIAL-RAHASIA'], ['pre-key', '7', 'PREKEY-7'], ['session', 'abc@s.whatsapp.net', 'SESI-ABC']] as const) {
    const { blob, keyVersion } = v1.encrypt(Buffer.from(plain), aadOf(s.id, type, id));
    await q(`INSERT INTO session_auth_state (session_id, tenant_id, item_type, item_id, ciphertext, encryption_key_version) VALUES ($1,$2,$3,$4,$5,$6)`, [s.id, reg.tenant.id, type, id, blob, keyVersion]);
  }
  await q(`INSERT INTO session_credentials (session_id, tenant_id, storage_key, encryption_key_version) VALUES ($1,$2,'auth',1)`, [s.id, reg.tenant.id]);
  await createWebhookService(db, { crypto: v1, policy: { allowHttp: true, allowPrivate: true } }).create(reg.tenant.id, { url: 'http://127.0.0.1:9/h', events: ['*'] });
  return s.id as string;
}
const versions = async (sid: string) => (await q('SELECT encryption_key_version v FROM session_auth_state WHERE session_id = $1 ORDER BY item_type', [sid])).map((r: any) => r.v);

function cli(env: Record<string, string | undefined>, args: string[] = []) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const e = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', DB_SCHEMA: db.schema, ...env } as Record<string, string>;
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/runtime/rotate-keys-cli.ts', ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, out, err }));
  });
}
const BOTH = { CREDENTIAL_ENCRYPTION_KEYS: `1:${k1},2:${k2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' };
const ONLY2 = { CREDENTIAL_ENCRYPTION_KEYS: `2:${k2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' };

test('CLI: dry-run melapor tanpa mengubah; rotasi nyata memindahkan semua; kunci lama lalu boleh dipensiunkan', { skip, timeout: 120_000 }, async () => {
  const sid = await seed();
  const dry = await cli(BOTH, ['--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  const dr = JSON.parse(dry.out);
  assert.ok(dr.authState.rotated >= 3 && dr.webhookSecrets.rotated >= 1 && dr.authState.failed === 0);
  assert.equal(dr.retireReady, false, 'dry-run tidak pernah menyatakan siap pensiun');
  assert.deepEqual(await versions(sid), [1, 1, 1], 'dry-run tidak boleh mengubah data');

  const real = await cli(BOTH);
  assert.equal(real.code, 0, real.out + real.err);
  const rr = JSON.parse(real.out);
  assert.equal(rr.activeVersion, 2); assert.equal(rr.retireReady, true);
  assert.deepEqual(await versions(sid), [2, 2, 2]);
  assert.equal((await q('SELECT encryption_key_version v FROM session_credentials WHERE session_id = $1', [sid]))[0].v, 2, 'penanda kredensial ikut naik');

  const retired = await cli(ONLY2, ['--dry-run']); // kunci 1 sudah dipensiunkan: tidak ada lagi yang membutuhkannya
  assert.equal(retired.code, 0, retired.err);
  const rt = JSON.parse(retired.out);
  assert.equal(rt.authState.failed, 0); assert.equal(rt.authState.rotated, 0);

  const again = await cli(BOTH); // idempoten
  assert.equal(again.code, 0); assert.equal(JSON.parse(again.out).authState.rotated, 0);
});

test('CLI: kunci lama dipensiunkan TERLALU DINI => exit 2, melaporkan gagal, tidak membocorkan rahasia atau kunci', { skip, timeout: 120_000 }, async () => {
  const sid = await seed(); // baris baru masih berkunci v1
  const r = await cli(ONLY2);
  assert.equal(r.code, 2, 'harus gagal agar operator tidak menghapus kunci yang masih dibutuhkan');
  const rep = JSON.parse(r.out);
  assert.ok(rep.authState.failed >= 3);
  assert.deepEqual(await versions(sid), [1, 1, 1], 'baris yang gagal didekripsi tidak diubah');
  for (const secret of ['KREDENSIAL-RAHASIA', 'PREKEY-7', 'SESI-ABC', k1, k2]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret), 'keluaran tidak boleh memuat rahasia');
});

test('CLI: konfigurasi salah => exit 1 dengan pesan jelas tanpa menampilkan kunci', { skip, timeout: 60_000 }, async () => {
  const none = await cli({ CREDENTIAL_ENCRYPTION_KEYS: '', CREDENTIAL_ACTIVE_KEY_VERSION: undefined });
  assert.equal(none.code, 1);
  assert.match(none.err, /CREDENTIAL_ENCRYPTION_KEYS belum dikonfigurasi/);
  const bad = await cli({ CREDENTIAL_ENCRYPTION_KEYS: `1:${k1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '9' });
  assert.equal(bad.code, 1);
  assert.ok(!bad.err.includes(k1) && !bad.out.includes(k1));
  const malformed = await cli({ CREDENTIAL_ENCRYPTION_KEYS: 'bukan-format', CREDENTIAL_ACTIVE_KEY_VERSION: undefined });
  assert.equal(malformed.code, 1);
});
