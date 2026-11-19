import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './helpers.js';

const { parseKeyring, createCredentialCrypto, CryptoError } = await import('../src/security/credential-crypto.js');
const k = () => crypto.randomBytes(32).toString('base64');

test('roundtrip, IV acak, blob tidak memuat plaintext', () => {
  const c = createCredentialCrypto(parseKeyring(`1:${k()}`));
  const pt = Buffer.from('rahasia-whatsapp-123');
  const a = c.encrypt(pt, 'ctx'); const b = c.encrypt(pt, 'ctx');
  assert.notDeepEqual(a.blob, b.blob);
  assert.ok(!a.blob.includes(pt));
  assert.deepEqual(c.decrypt(a.blob, 'ctx'), pt);
  assert.equal(a.keyVersion, 1);
});

test('tamper dan AAD salah ditolak tanpa membocorkan detail', () => {
  const c = createCredentialCrypto(parseKeyring(`1:${k()}`));
  const { blob } = c.encrypt(Buffer.from('x'), 'sess-A|creds');
  assert.throws(() => c.decrypt(blob, 'sess-B|creds'), CryptoError);
  const bad = Buffer.from(blob); bad[bad.length - 20] ^= 1;
  assert.throws(() => c.decrypt(bad, 'sess-A|creds'), CryptoError);
  assert.throws(() => c.decrypt(Buffer.alloc(5), 'x'), CryptoError);
});

test('rotasi kunci: blob lama tetap terbaca, enkripsi baru memakai versi aktif; versi hilang ditolak', () => {
  const k1 = k(); const k2 = k();
  const old = createCredentialCrypto(parseKeyring(`1:${k1}`)).encrypt(Buffer.from('lama'), 'a').blob;
  const rot = createCredentialCrypto(parseKeyring(`1:${k1},2:${k2}`));
  assert.equal(rot.activeVersion, 2);
  assert.equal(rot.decrypt(old, 'a').toString(), 'lama');
  assert.equal(rot.encrypt(Buffer.from('baru'), 'a').keyVersion, 2);
  const only2 = createCredentialCrypto(parseKeyring(`2:${k2}`));
  assert.throws(() => only2.decrypt(old, 'a'), /versi 1/);
});

test('parseKeyring: validasi format dan pesan error tidak memuat nilai kunci', () => {
  const secret = k();
  for (const bad of [undefined, '', 'abc', `x:${secret}`, `1:${Buffer.alloc(16).toString('base64')}`, `1:${secret},1:${secret}`]) {
    assert.throws(() => parseKeyring(bad as any), (e: Error) => e instanceof CryptoError && !e.message.includes(secret));
  }
  assert.throws(() => parseKeyring(`1:${secret}`, 5), /aktif/);
});
