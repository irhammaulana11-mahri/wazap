import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecovery, hotp, looksLikeRecovery, normalizeRecovery, otpauthUri, stepOf, totpAt, verifyTotp } from '../src/security/totp.js';

// Vektor uji RFC 6238 Appendix B (SHA-1; rahasia ASCII "12345678901234567890", 8 digit). Kode 6 digit = 6 digit terakhir dari kode 8 digit (mod 10^6).
const SECRET = Buffer.from('12345678901234567890');
const RFC: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

test('TOTP: sesuai vektor uji RFC 6238 (8 digit) dan turunannya 6 digit', () => {
  for (const [t, code] of RFC) {
    assert.equal(totpAt(SECRET, t, 8), code, `T=${t}`);
    assert.equal(totpAt(SECRET, t, 6), code.slice(2), `T=${t} (6 digit)`);
  }
});

test('HOTP: sesuai vektor uji RFC 4226 Appendix D', () => {
  const exp = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  exp.forEach((c, i) => assert.equal(hotp(SECRET, i, 6), c, `counter ${i}`));
});

test('base32: vektor RFC 4648, bolak-balik, huruf kecil dan spasi ditoleransi, karakter asing ditolak', () => {
  for (const [plain, enc] of [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']])
    assert.equal(base32Encode(Buffer.from(plain)), enc, plain);
  assert.equal(base32Decode('mzxw 6ytb oi==').toString(), 'foobar');
  const s = generateTotpSecret(); assert.equal(s.length, 20); assert.deepEqual(base32Decode(base32Encode(s)), s);
  assert.throws(() => base32Decode('MZXW1'), /tidak valid/);
});

test('verifyTotp: menerima langkah sekarang dan ±1, menolak di luar jendela, mengembalikan langkah yang cocok', () => {
  const now = 1_700_000_000, cur = stepOf(now);
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now), { now }), cur);
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now - 30), { now }), cur - 1, 'satu langkah lalu (selisih jam)');
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now + 30), { now }), cur + 1);
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now - 90), { now }), null, 'tiga langkah lalu ditolak');
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now + 90), { now }), null);
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now - 60), { now, window: 2 }), cur - 2, 'jendela dapat diatur');
});

test('verifyTotp: anti-pengulangan (langkah harus lebih besar dari lastStep) dan masukan salah bentuk', () => {
  const now = 1_700_000_000, cur = stepOf(now), code = totpAt(SECRET, now);
  assert.equal(verifyTotp(SECRET, code, { now, lastStep: cur }), null, 'kode yang sama tidak dapat dipakai dua kali');
  assert.equal(verifyTotp(SECRET, code, { now, lastStep: cur - 1 }), cur, 'langkah baru lebih besar dari lastStep');
  assert.equal(verifyTotp(SECRET, totpAt(SECRET, now - 30), { now, lastStep: cur }), null, 'langkah lebih lama dari yang sudah dipakai ditolak');
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 345', '１２３４５６', ' 123456', '123456 ', null as any, undefined as any, 123456 as any]) assert.equal(verifyTotp(SECRET, bad, { now }), null, String(bad));
  assert.doesNotThrow(() => verifyTotp(SECRET, '000000', { now: 0 }), 'waktu 0: langkah negatif dilewati, tidak melempar');
});

test('otpauth URI: format baku untuk aplikasi autentikator, label dan penerbit di-encode', () => {
  const u = otpauthUri('a+b@x.test', SECRET);
  assert.equal(u, `otpauth://totp/WAZAP:a%2Bb%40x.test?secret=${base32Encode(SECRET)}&issuer=WAZAP&algorithm=SHA1&digits=6&period=30`);
});

test('kode pemulihan: 10 kode unik berbentuk xxxx-xxxx-xxxx, hanya hash yang dikembalikan untuk disimpan, normalisasi konsisten', () => {
  const { codes, hashes } = generateRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10); assert.equal(new Set(hashes).size, 10);
  for (const c of codes) { assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/); assert.ok(!/[ilo01]/.test(c), 'tanpa karakter mudah tertukar'); assert.ok(looksLikeRecovery(c)); }
  codes.forEach((c, i) => { assert.equal(hashRecovery(c), hashes[i]); assert.equal(hashRecovery(c.toUpperCase()), hashes[i], 'huruf besar'); assert.equal(hashRecovery(c.replace(/-/g, ' ')), hashes[i], 'spasi'); });
  assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && hashes.every((h, i) => h !== codes[i]), 'hash, bukan kode');
  assert.equal(normalizeRecovery(' ABCD-efgh-2345 '), 'abcdefgh2345');
  assert.equal(looksLikeRecovery('123456'), false, 'kode TOTP bukan kode pemulihan'); assert.equal(looksLikeRecovery('abcd-efgh-ijkl'), false, 'karakter di luar alfabet');
});
