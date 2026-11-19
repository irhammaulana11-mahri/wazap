import crypto from 'node:crypto';

// Alfabet tanpa 0/O/1/I/L agar mudah diketik; 20 karakter = 100 bit entropi. Dipakai kode workspace (WJ) dan kode pemulihan (RC).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CORE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$/;

export function newCodeCore(): string {
  let out = '';
  // Penolakan (rejection sampling) menghindari bias modulo: 31 simbol, ambil byte < 248 (= 31 * 8).
  while (out.length < 20) for (const b of crypto.randomBytes(32)) if (b < 248 && out.length < 20) out += ALPHABET[b % 31];
  return out;
}
/** `PREFIX-XXXXX-XXXXX-XXXXX-XXXXX` */
export const formatCode = (prefix: string, core: string) => `${prefix}-${core.match(/.{5}/g)!.join('-')}`;
/** Huruf kecil/tanda hubung/spasi diabaikan; awalan opsional. Mengembalikan 20 karakter inti atau null. Inti boleh saja diawali huruf yang sama dengan awalan. */
export function normalizeCode(prefix: string, input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length === 20 + prefix.length && s.startsWith(prefix)) s = s.slice(prefix.length);
  return CORE_RE.test(s) ? s : null;
}
