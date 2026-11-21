import crypto from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1) dan kode pemulihan untuk MFA platform admin (ADR-054). Tanpa dependensi baru. Dibuktikan terhadap vektor uji RFC 6238 (test/totp.test.ts).
 * Rahasia TOTP berupa 20 byte acak; disimpan terenkripsi (AAD `wazap:totp:v1|<user_id>`), tidak pernah dikembalikan oleh API; hanya dicetak SEKALI oleh CLI.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const totpAad = (userId: string) => `wazap:totp:v1|${userId}`;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('karakter base32 tidak valid');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): Buffer => crypto.randomBytes(20);
export const stepOf = (unixSeconds: number, step = STEP_SECONDS) => Math.floor(unixSeconds / step);

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpAt = (secret: Buffer, unixSeconds: number, digits = 6, step = STEP_SECONDS) => hotp(secret, stepOf(unixSeconds, step), digits);

/**
 * Memeriksa kode. Mengembalikan LANGKAH WAKTU yang cocok (untuk disimpan sebagai anti-pengulangan) atau null. Jendela ±`window` langkah menoleransi selisih jam;
 * langkah harus LEBIH BESAR dari `lastStep` sehingga satu kode tidak dapat dipakai dua kali. Perbandingan waktu-konstan; format selain `digits` angka ditolak.
 */
export function verifyTotp(secret: Buffer, code: string, opts: { now?: number; lastStep?: number; window?: number; digits?: number } = {}): number | null {
  const digits = opts.digits ?? 6, window = opts.window ?? 1, last = opts.lastStep ?? 0;
  if (typeof code !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const cur = stepOf(opts.now ?? Math.floor(Date.now() / 1000));
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let s = cur - window; s <= cur + window; s++) {   // seluruh jendela selalu dihitung (tidak berhenti pada kecocokan pertama)
    if (s <= last || s < 0) continue;
    const expect = Buffer.from(hotp(secret, s, digits));
    if (crypto.timingSafeEqual(expect, given) && matched === null) matched = s;
  }
  return matched;
}

export function otpauthUri(email: string, secret: Buffer, issuer = 'WAZAP'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---------- kode pemulihan: sekali pakai, hanya hash yang disimpan ----------
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // tanpa i, l, o, 0, 1 (mudah tertukar)
export const normalizeRecovery = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
export const hashRecovery = (s: string) => crypto.createHash('sha256').update(normalizeRecovery(s)).digest('hex');
/** Bentuk kode pemulihan: 12 karakter dari alfabet di atas (boleh berkelompok dengan tanda hubung). */
export const looksLikeRecovery = (s: string) => new RegExp(`^[${RC_ALPHABET}]{12}$`).test(normalizeRecovery(s));

export function generateRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    let raw = '';
    for (const b of crypto.randomBytes(12)) raw += RC_ALPHABET[b % RC_ALPHABET.length];   // bias modulo ~0,4%: dapat diabaikan untuk 58 bit entropi
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return { codes, hashes: codes.map(hashRecovery) };
}
