import crypto from 'node:crypto';
import type pg from 'pg';

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

/** Hash kode pemulihan (kode 100 bit acak: SHA-256 cukup; dipisah dari domain hash lain dengan awalan). */
export const recoveryHash = (core: string) => crypto.createHash('sha256').update('rc:' + core).digest('hex');
export const RECOVERY_CODE_COUNT = 8;
export function newRecoverySet(count = RECOVERY_CODE_COUNT) {
  const cores = Array.from({ length: count }, newCodeCore);
  return { codes: cores.map((c) => formatCode('RC', c)), hashes: cores.map(recoveryHash) };
}
/** Simpan himpunan kode pemulihan; `replace` menghapus himpunan lama (kode lama hangus) dan mengosongkan penanda konfirmasi. Konteks user_id harus sudah ditetapkan. */
export async function storeRecoverySet(c: pg.PoolClient, userId: string, hashes: string[], replace: boolean) {
  if (replace) {
    await c.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
    await c.query('UPDATE users SET recovery_confirmed_at = NULL WHERE id = $1', [userId]);
  }
  await c.query('INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])', [userId, hashes]);
}
