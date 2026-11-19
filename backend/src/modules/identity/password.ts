import { hash, verify } from '@node-rs/argon2';

// Argon2id (default @node-rs/argon2: m=19456 KiB, t=2, p=1 — rekomendasi OWASP).
export const hashPassword = (plain: string) => hash(plain);

let dummyHash: Promise<string> | undefined;

/** Verifikasi tanpa membocorkan apakah user ada: hash tidak ada => verifikasi terhadap dummy hash. */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hash('dummy-password-for-timing-equalization');
    await verify(await dummyHash, plain).catch(() => false);
    return false;
  }
  return verify(stored, plain).catch(() => false);
}
