import { config } from '../config/env.js';
import { getGatewayDb } from '../database/gateway.js';
import { getCredentialCrypto } from '../security/credential-crypto.js';
import { createKeyRotator } from './rotate-keys.js';

/**
 * `npm run keys:rotate [-- --dry-run]`. Prasyarat: CREDENTIAL_ENCRYPTION_KEYS memuat kunci LAMA dan BARU, dan
 * CREDENTIAL_ACTIVE_KEY_VERSION = versi baru (atau versi tertinggi). Cetak laporan JSON (tanpa data rahasia).
 * Exit 2 bila ada baris yang gagal didekripsi atau (non dry-run) kunci lama belum aman dipensiunkan.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getGatewayDb();
  try {
    const rep = await createKeyRotator(db, getCredentialCrypto(config)).run({ dryRun });
    console.log(JSON.stringify(rep, null, 2));
    const failed = rep.authState.failed + rep.webhookSecrets.failed;
    if (failed > 0 || (!dryRun && !rep.retireReady)) process.exitCode = 2;
  } finally {
    await db.close();
  }
}
main().catch((err) => { console.error('rotasi kunci gagal:', (err as Error).message); process.exit(1); });
