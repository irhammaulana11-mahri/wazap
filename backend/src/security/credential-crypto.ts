import crypto from 'crypto';

/**
 * Enkripsi kredensial/rahasia sesi (AES-256-GCM) dengan keyring bervensi.
 * Format blob (bytea): [1B format=1][4B versi kunci BE][12B IV][ciphertext][16B tag].
 * AAD mengikat blob ke konteksnya (session|jenis|id) sehingga blob tidak bisa ditukar antar baris/sesi.
 * Master key hanya dari environment; tidak pernah ke DB, log, atau pesan error.
 */
const FORMAT = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER = 1 + 4;

export class CryptoError extends Error {}

export interface Keyring {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

/** Parse "1:<base64 32B>,2:<base64 32B>". Pesan error tidak memuat nilai kunci. */
export function parseKeyring(spec: string | undefined, activeVersion?: number): Keyring {
  if (!spec || !spec.trim()) throw new CryptoError('CREDENTIAL_ENCRYPTION_KEYS belum dikonfigurasi');
  const keys = new Map<number, Buffer>();
  for (const part of spec.split(',')) {
    const [v, b64, extra] = part.trim().split(':');
    const ver = Number(v);
    if (!Number.isInteger(ver) || ver < 1 || !b64 || extra !== undefined) throw new CryptoError('Format CREDENTIAL_ENCRYPTION_KEYS tidak valid (versi:base64)');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new CryptoError(`Kunci enkripsi versi ${ver} harus 32 byte (base64)`);
    if (keys.has(ver)) throw new CryptoError(`Versi kunci ${ver} duplikat`);
    keys.set(ver, key);
  }
  const active = activeVersion ?? Math.max(...keys.keys());
  if (!keys.has(active)) throw new CryptoError(`Versi kunci aktif ${active} tidak ada di keyring`);
  return { activeVersion: active, keys };
}

export interface CredentialCrypto {
  readonly activeVersion: number;
  encrypt(plaintext: Buffer, aad: string): { blob: Buffer; keyVersion: number };
  decrypt(blob: Buffer, aad: string): Buffer;
}

export function createCredentialCrypto(ring: Keyring): CredentialCrypto {
  return {
    activeVersion: ring.activeVersion,
    encrypt(plaintext, aad) {
      const key = ring.keys.get(ring.activeVersion)!;
      const iv = crypto.randomBytes(IV_LEN);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plaintext), c.final()]);
      const head = Buffer.alloc(HEADER);
      head.writeUInt8(FORMAT, 0);
      head.writeUInt32BE(ring.activeVersion, 1);
      return { blob: Buffer.concat([head, iv, ct, c.getAuthTag()]), keyVersion: ring.activeVersion };
    },
    decrypt(blob, aad) {
      if (blob.length < HEADER + IV_LEN + TAG_LEN || blob.readUInt8(0) !== FORMAT) throw new CryptoError('Blob kredensial tidak valid');
      const ver = blob.readUInt32BE(1);
      const key = ring.keys.get(ver);
      if (!key) throw new CryptoError(`Kunci enkripsi versi ${ver} tidak tersedia`);
      const iv = blob.subarray(HEADER, HEADER + IV_LEN);
      const tag = blob.subarray(blob.length - TAG_LEN);
      const ct = blob.subarray(HEADER + IV_LEN, blob.length - TAG_LEN);
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]);
      } catch {
        // Tidak membedakan penyebab (tamper/AAD salah) dan tidak membocorkan detail.
        throw new CryptoError('Dekripsi kredensial gagal (data diubah atau konteks tidak cocok)');
      }
    },
  };
}

let shared: CredentialCrypto | undefined;
/** Instance dari environment (lazy; gagal jelas bila kunci belum diset). */
export function getCredentialCrypto(env: { CREDENTIAL_ENCRYPTION_KEYS?: string; CREDENTIAL_ACTIVE_KEY_VERSION?: number }): CredentialCrypto {
  return (shared ??= createCredentialCrypto(parseKeyring(env.CREDENTIAL_ENCRYPTION_KEYS, env.CREDENTIAL_ACTIVE_KEY_VERSION)));
}

/** Seperti getCredentialCrypto tetapi mengembalikan undefined bila kunci belum dikonfigurasi (API tetap jalan tanpa fitur QR). */
export function tryGetCredentialCrypto(env: { CREDENTIAL_ENCRYPTION_KEYS?: string; CREDENTIAL_ACTIVE_KEY_VERSION?: number }): CredentialCrypto | undefined {
  if (!env.CREDENTIAL_ENCRYPTION_KEYS?.trim()) return undefined;
  return getCredentialCrypto(env);
}
