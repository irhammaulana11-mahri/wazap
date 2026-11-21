import { config } from '../config/env.js';
import { getGatewayDb } from '../database/gateway.js';
import { createPlatformService } from '../modules/platform/platform.service.js';
import { tryGetCredentialCrypto } from '../security/credential-crypto.js';

/**
 * Alat operator untuk platform admin (ADR-054); SATU-SATUNYA jalur membuat/mencabut admin (tidak ada API/UI untuk itu).
 *   npm run admin:platform-admin -- create    --email pemilik@contoh.id     daftarkan pengguna yang SUDAH ADA; mencetak rahasia TOTP dan 10 kode pemulihan SEKALI
 *   npm run admin:platform-admin -- reset-mfa --email pemilik@contoh.id     daftarkan ulang perangkat MFA (rahasia dan kode pemulihan baru; yang lama hangus)
 *   npm run admin:platform-admin -- revoke    --email pemilik@contoh.id     cabut hak platform admin
 *   npm run admin:platform-admin -- list                                    daftar admin (tanpa rahasia)
 * (produksi: `node dist/runtime/platform-admin-cli.js <perintah> ...` dengan env api.env dimuat). Jalankan di terminal PRIBADI di server dan jangan dialihkan ke berkas:
 * rahasia TOTP dan kode pemulihan dicetak ke stdout sekali dan tidak disimpan dalam bentuk terbaca. Pesan status ke stderr tidak memuat rahasia.
 */
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };

function printEnrolment(r: { otpauthUri: string; secretBase32: string; recoveryCodes: string[] }) {
  console.log('');
  console.log('Daftarkan di aplikasi autentikator (Google Authenticator, Authy, 1Password, dll.):');
  console.log(`  Kunci setup (ketik manual) : ${r.secretBase32}`);
  console.log(`  URI otpauth                : ${r.otpauthUri}`);
  console.log('');
  console.log('Kode pemulihan (sekali pakai; simpan di password manager, TIDAK akan ditampilkan lagi):');
  console.log(r.recoveryCodes.map((c) => `  ${c}`).join('\n'));
  console.log('');
}

async function main() {
  const cmd = process.argv[2];
  const email = arg('--email');
  const need = () => { if (!email) { console.error('pemakaian: --email <alamat email akun>'); process.exit(1); } return email; };
  const db = getGatewayDb();
  const platform = createPlatformService(db, { crypto: tryGetCredentialCrypto(config) });
  try {
    if (cmd === 'create') {
      const r = await platform.createAdmin(need());
      console.error(`platform admin dibuat: ${email}`);
      printEnrolment(r);
    } else if (cmd === 'reset-mfa') {
      const r = await platform.resetMfa(need());
      console.error(`perangkat MFA didaftarkan ulang untuk: ${email} (kode lama hangus)`);
      printEnrolment(r);
    } else if (cmd === 'revoke') {
      await platform.revokeAdmin(need());
      console.error(`hak platform admin dicabut: ${email}`);
    } else if (cmd === 'list') {
      const rows = await platform.listAdmins();
      if (!rows.length) console.error('belum ada platform admin');
      for (const r of rows) console.log([r.email ?? r.user_id, r.status, `login terakhir: ${r.last_login_at?.toISOString() ?? '-'}`, `kode pemulihan tersisa: ${r.recovery_remaining}`, r.locked_until && r.locked_until > new Date() ? `DIKUNCI sampai ${r.locked_until.toISOString()}` : ''].filter(Boolean).join(' | '));
    } else {
      console.error('perintah: create | reset-mfa | revoke | list'); process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}
main().catch((err) => { console.error('gagal:', (err as Error).message); process.exit(1); });
