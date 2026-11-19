import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { config } from '../../config/env.js';
import type { Lease, LeaseService } from './lease.service.js';
import { notifyEvents } from '../realtime/event-channel.js';
import { randomUUID } from 'node:crypto';

export const qrAad = (sessionId: string) => `wazap:qr:v1|${sessionId}`;

/** QR pairing sementara, terenkripsi. Ditulis engine dengan fencing; dibaca jalur tenant (lihat SessionService.getQr). */
export function createQrStore(deps: { db: GatewayDb; leases: LeaseService; crypto: CredentialCrypto }) {
  const { leases, crypto } = deps;
  return {
    async put(lease: Lease, tenantId: string, qr: string, ttlSeconds = config.QR_TTL_SECONDS): Promise<void> {
      const { blob, keyVersion } = crypto.encrypt(Buffer.from(qr), qrAad(lease.sessionId));
      await leases.withFence(lease, async (c) => {
        await c.query(
          `INSERT INTO session_qr (session_id, tenant_id, ciphertext, encryption_key_version, expires_at)
           VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))
           ON CONFLICT (session_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
             encryption_key_version = EXCLUDED.encryption_key_version, expires_at = EXCLUDED.expires_at, updated_at = now()`,
          [lease.sessionId, tenantId, blob, keyVersion, ttlSeconds]
        );
        // Sinyal realtime TANPA isi QR: klien mengambil QR lewat GET /sessions/:id/qr (terautentikasi).
        await notifyEvents(c, [{ tenantId, id: randomUUID(), event: 'session.qr', occurredAt: new Date().toISOString(), data: { session_id: lease.sessionId, expires_in: ttlSeconds } }]);
      });
    },
    async clear(lease: Lease): Promise<void> {
      await leases.withFence(lease, (c) => c.query('DELETE FROM session_qr WHERE session_id = $1', [lease.sessionId]));
    },
  };
}
export type QrStore = ReturnType<typeof createQrStore>;
