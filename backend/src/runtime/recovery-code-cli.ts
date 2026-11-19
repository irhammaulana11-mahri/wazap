import { getGatewayDb } from '../database/gateway.js';
import { createIdentityService } from '../modules/identity/identity.service.js';

/**
 * `npm run admin:recovery-code -- --email pengguna@contoh.id` (produksi: `node dist/runtime/recovery-code-cli.js --email ...`).
 * Alat operator untuk pengguna yang lupa kata sandi DAN tidak menyimpan kode pemulihannya (tanpa email, tidak ada jalur lain): menerbitkan kode
 * pemulihan baru (kode lama hangus) dan mencetaknya SEKALI. Serahkan lewat kanal yang terverifikasi (pastikan peminta memang pemilik akun);
 * pengguna lalu memakainya di POST /auth/reset-password. Kode tidak dicatat ke log; hanya email yang ditulis ke stderr.
 */
async function main() {
  const i = process.argv.indexOf('--email');
  const email = i > 0 ? process.argv[i + 1] : undefined;
  if (!email) { console.error('pemakaian: --email <alamat email akun>'); process.exit(1); }
  const db = getGatewayDb();
  try {
    const code = await createIdentityService(db).adminIssueRecoveryCode(email);
    if (!code) { console.error(`akun tidak ditemukan: ${email}`); process.exitCode = 2; return; }
    console.error(`kode pemulihan baru untuk ${email} (tampil sekali):`);
    console.log(code);
  } finally {
    await db.close();
  }
}
main().catch((err) => { console.error('gagal:', (err as Error).message); process.exit(1); });
