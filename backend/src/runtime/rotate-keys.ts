import type { GatewayDb } from '../database/gateway.js';
import type { CredentialCrypto } from '../security/credential-crypto.js';
import { webhookSecretAad } from '../security/webhook-signature.js';
import { aadOf as authAad } from '../modules/engine/auth-store.js'; // satu-satunya definisi AAD auth state

export interface RotateTarget { rotated: number; skipped: number; failed: number }
export interface RotateReport {
  activeVersion: number;
  dryRun: boolean;
  authState: RotateTarget;
  webhookSecrets: RotateTarget;
  /** Jumlah baris per versi kunci SETELAH operasi: kunci lama aman dipensiunkan hanya bila tidak ada versi selain aktif dan failed = 0. */
  versions: Record<string, Record<string, number>>;
  retireReady: boolean;
}

/**
 * Enkripsi ulang data terenkripsi ke versi kunci AKTIF (konteks platform). Idempoten dan aman dijalankan saat
 * engine hidup: tiap baris diperbarui dengan compare-and-swap (`WHERE ciphertext = <yang dibaca>`), jadi tulisan engine
 * yang bersamaan menang dan baris itu dilewati (sudah memakai kunci aktif, karena engine selalu menulis dengan kunci aktif).
 * Baris yang gagal didekripsi dilaporkan (tanpa isi/id rahasia) dan TIDAK mengubah apa pun. QR tidak dirotasi (hidup <= TTL).
 */
export function createKeyRotator(db: GatewayDb, crypto: CredentialCrypto) {
  const active = crypto.activeVersion;

  async function rotateAuth(batch: number, dryRun: boolean): Promise<RotateTarget> {
    const t: RotateTarget = { rotated: 0, skipped: 0, failed: 0 };
    let last: [string, string, string] | undefined;
    for (;;) {
      const rows = await db.tx({ platform: true }, async (c) =>
        (await c.query(
          `SELECT session_id, item_type, item_id, ciphertext FROM session_auth_state
           WHERE encryption_key_version <> $1 AND ($2::uuid IS NULL OR (session_id, item_type, item_id) > ($2::uuid, $3, $4))
           ORDER BY session_id, item_type, item_id LIMIT $5`,
          [active, last?.[0] ?? null, last?.[1] ?? '', last?.[2] ?? '', batch])).rows as { session_id: string; item_type: string; item_id: string; ciphertext: Buffer }[]);
      if (!rows.length) break;
      for (const r of rows) {
        last = [r.session_id, r.item_type, r.item_id];
        let blob: Buffer, keyVersion: number;
        try {
          const plain = crypto.decrypt(r.ciphertext, authAad(r.session_id, r.item_type, r.item_id));
          ({ blob, keyVersion } = crypto.encrypt(plain, authAad(r.session_id, r.item_type, r.item_id)));
        } catch { t.failed++; continue; }
        if (dryRun) { t.rotated++; continue; }
        const u = await db.tx({ platform: true }, (c) => c.query(
          `UPDATE session_auth_state SET ciphertext = $4, encryption_key_version = $5
           WHERE session_id = $1 AND item_type = $2 AND item_id = $3 AND ciphertext = $6`,
          [r.session_id, r.item_type, r.item_id, blob, keyVersion, r.ciphertext]));
        if (u.rowCount === 1) t.rotated++; else t.skipped++;
      }
      if (rows.length < batch) break;
    }
    return t;
  }

  async function rotateWebhookSecrets(batch: number, dryRun: boolean): Promise<RotateTarget> {
    const t: RotateTarget = { rotated: 0, skipped: 0, failed: 0 };
    let lastId: string | undefined;
    for (;;) {
      const rows = await db.tx({ platform: true }, async (c) =>
        (await c.query(
          `SELECT id, tenant_id, secret_ciphertext FROM webhook_endpoints
           WHERE secret_key_version <> $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`, [active, lastId ?? null, batch])).rows as { id: string; tenant_id: string; secret_ciphertext: Buffer }[]);
      if (!rows.length) break;
      for (const r of rows) {
        lastId = r.id;
        let blob: Buffer, keyVersion: number;
        try {
          const plain = crypto.decrypt(r.secret_ciphertext, webhookSecretAad(r.tenant_id, r.id));
          ({ blob, keyVersion } = crypto.encrypt(plain, webhookSecretAad(r.tenant_id, r.id)));
        } catch { t.failed++; continue; }
        if (dryRun) { t.rotated++; continue; }
        const u = await db.tx({ platform: true }, (c) => c.query(
          `UPDATE webhook_endpoints SET secret_ciphertext = $2, secret_key_version = $3 WHERE id = $1 AND secret_ciphertext = $4`,
          [r.id, blob, keyVersion, r.secret_ciphertext]));
        if (u.rowCount === 1) t.rotated++; else t.skipped++;
      }
      if (rows.length < batch) break;
    }
    return t;
  }

  async function versions(): Promise<Record<string, Record<string, number>>> {
    return db.tx({ platform: true }, async (c) => {
      const a = (await c.query('SELECT encryption_key_version v, count(*)::int n FROM session_auth_state GROUP BY 1 ORDER BY 1')).rows;
      const w = (await c.query('SELECT secret_key_version v, count(*)::int n FROM webhook_endpoints GROUP BY 1 ORDER BY 1')).rows;
      return { session_auth_state: Object.fromEntries(a.map((r: any) => [r.v, r.n])), webhook_secrets: Object.fromEntries(w.map((r: any) => [r.v, r.n])) };
    });
  }

  return {
    async run(o: { batch?: number; dryRun?: boolean } = {}): Promise<RotateReport> {
      const batch = o.batch ?? 200; const dryRun = o.dryRun ?? false;
      const authState = await rotateAuth(batch, dryRun);
      const webhookSecrets = await rotateWebhookSecrets(batch, dryRun);
      if (!dryRun) {
        // Metadata versi pada session_credentials mengikuti auth state sesi tersebut.
        await db.tx({ platform: true }, (c) => c.query(
          `UPDATE session_credentials sc SET encryption_key_version = $1 WHERE encryption_key_version <> $1
             AND NOT EXISTS (SELECT 1 FROM session_auth_state a WHERE a.session_id = sc.session_id AND a.encryption_key_version <> $1)`, [active]));
      }
      const v = await versions();
      const old = Object.values(v).some((m) => Object.keys(m).some((k) => Number(k) !== active));
      return { activeVersion: active, dryRun, authState, webhookSecrets, versions: v, retireReady: !dryRun && !old && authState.failed === 0 && webhookSecrets.failed === 0 };
    },
  };
}
export type KeyRotator = ReturnType<typeof createKeyRotator>;
