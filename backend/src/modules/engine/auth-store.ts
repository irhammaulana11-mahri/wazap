import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import type pg from 'pg';
import type { GatewayDb } from '../../database/gateway.js';
import type { CredentialCrypto } from '../../security/credential-crypto.js';
import { FencedError, type Lease, type LeaseService } from './lease.service.js';

/** Hapus auth state, QR, dan referensi kredensial sesi dalam transaksi yang sudah ada. */
export async function eraseAuthIn(c: pg.PoolClient, sessionId: string): Promise<void> {
  await c.query('DELETE FROM session_auth_state WHERE session_id = $1', [sessionId]);
  await c.query('DELETE FROM session_qr WHERE session_id = $1', [sessionId]);
  await c.query('DELETE FROM session_credentials WHERE session_id = $1', [sessionId]);
}

/** Handle auth state untuk satu sesi, dimiliki satu lease. Semua penulisan dibatasi fencing token. */
export interface AuthHandle {
  state: AuthenticationState;
  /** Simpan creds terkini (terserialisasi, urut). */
  saveCreds(): Promise<void>;
  /** True bila akun sudah pernah dipasangkan (creds.registered). */
  readonly registered: boolean;
}

const CREDS = 'creds';
export const aadOf = (sessionId: string, type: string, id: string) => `wazap:auth:v1|${sessionId}|${type}|${id}`;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v, BufferJSON.replacer));
const decode = <T>(b: Buffer): T => JSON.parse(b.toString('utf8'), BufferJSON.reviver) as T;

export interface AuthStoreOptions {
  /** Dipanggil bila penulisan ditolak karena fencing (engine kehilangan kepemilikan). */
  onFenced?: () => void;
}

/**
 * Penyimpanan auth state Baileys di PostgreSQL, terenkripsi per item (AES-256-GCM, AAD terikat sesi+jenis+id).
 * Hanya dipakai engine (RLS platform). Penulisan memakai leases.withFence: engine lama tidak bisa menimpa state
 * setelah kepemilikan berpindah. Versi auth (session_credentials.auth_version) naik tiap creds disimpan.
 */
export function createAuthStore(deps: { db: GatewayDb; leases: LeaseService; crypto: CredentialCrypto }) {
  const { db, leases, crypto } = deps;

  const fenced = async <T>(lease: Lease, opts: AuthStoreOptions, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    try {
      return await leases.withFence(lease, fn);
    } catch (e) {
      if (e instanceof FencedError) opts.onFenced?.();
      throw e;
    }
  };

  async function readItems(sessionId: string, type: string, ids: string[]): Promise<Map<string, Buffer>> {
    const rows = await db.tx({ platform: true }, async (c) =>
      (
        await c.query(
          'SELECT item_id, ciphertext FROM session_auth_state WHERE session_id = $1 AND item_type = $2 AND item_id = ANY($3::text[])',
          [sessionId, type, ids]
        )
      ).rows as { item_id: string; ciphertext: Buffer }[]
    );
    return new Map(rows.map((r) => [r.item_id, crypto.decrypt(r.ciphertext, aadOf(sessionId, type, r.item_id))]));
  }

  return {
    /** Buka auth state sesi: muat creds terenkripsi atau buat creds baru (belum tersimpan sampai saveCreds). */
    async open(lease: Lease, tenantId: string, opts: AuthStoreOptions = {}): Promise<AuthHandle> {
      const sessionId = lease.sessionId;
      const stored = (await readItems(sessionId, CREDS, [CREDS])).get(CREDS);
      const creds: AuthenticationCreds = stored ? decode<AuthenticationCreds>(stored) : initAuthCreds();

      // saveCreds dan keys.set diserialisasi agar urutan tulis = urutan kejadian.
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => {});
        return run;
      };

      const handle: AuthHandle = {
        get registered() {
          return Boolean(creds.registered);
        },
        saveCreds: () =>
          serial(() =>
            fenced(lease, opts, async (c) => {
              const { blob, keyVersion } = crypto.encrypt(encode(creds), aadOf(sessionId, CREDS, CREDS));
              await c.query(
                `INSERT INTO session_auth_state (session_id, tenant_id, item_type, item_id, ciphertext, encryption_key_version)
                 VALUES ($1,$2,$3,$3,$4,$5)
                 ON CONFLICT (session_id, item_type, item_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, encryption_key_version = EXCLUDED.encryption_key_version`,
                [sessionId, tenantId, CREDS, blob, keyVersion]
              );
              const v = (await c.query('UPDATE wa_sessions SET auth_version = auth_version + 1 WHERE id = $1 RETURNING auth_version', [sessionId])).rows[0];
              await c.query(
                `INSERT INTO session_credentials (session_id, tenant_id, storage_key, encryption_key_version, auth_version)
                 VALUES ($1,$2,'db:session_auth_state',$3,$4)
                 ON CONFLICT (session_id) DO UPDATE SET encryption_key_version = EXCLUDED.encryption_key_version, auth_version = EXCLUDED.auth_version`,
                [sessionId, tenantId, keyVersion, v.auth_version]
              );
            })
          ),
        state: {
          creds,
          keys: {
            async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
              const out: { [id: string]: SignalDataTypeMap[T] } = {};
              if (!ids.length) return out;
              const found = await readItems(sessionId, type, ids);
              for (const id of ids) {
                const raw = found.get(id);
                if (!raw) continue;
                let value = decode<unknown>(raw);
                if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
                out[id] = value as SignalDataTypeMap[T];
              }
              return out;
            },
            set: (data) =>
              serial(() =>
                fenced(lease, opts, async (c) => {
                  const upserts: { type: string; id: string; blob: Buffer; ver: number }[] = [];
                  const deletes: { type: string; id: string }[] = [];
                  for (const [type, items] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(items ?? {})) {
                      if (value === null || value === undefined) deletes.push({ type, id });
                      else {
                        const { blob, keyVersion } = crypto.encrypt(encode(value), aadOf(sessionId, type, id));
                        upserts.push({ type, id, blob, ver: keyVersion });
                      }
                    }
                  }
                  if (upserts.length) {
                    await c.query(
                      `INSERT INTO session_auth_state (session_id, tenant_id, item_type, item_id, ciphertext, encryption_key_version)
                       SELECT $1, $2, t.type, t.id, t.blob, t.ver
                       FROM unnest($3::text[], $4::text[], $5::bytea[], $6::int[]) AS t(type, id, blob, ver)
                       ON CONFLICT (session_id, item_type, item_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, encryption_key_version = EXCLUDED.encryption_key_version`,
                      [sessionId, tenantId, upserts.map((u) => u.type), upserts.map((u) => u.id), upserts.map((u) => u.blob), upserts.map((u) => u.ver)]
                    );
                  }
                  if (deletes.length) {
                    await c.query(
                      `DELETE FROM session_auth_state WHERE session_id = $1 AND (item_type, item_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
                      [sessionId, deletes.map((d) => d.type), deletes.map((d) => d.id)]
                    );
                  }
                })
              ),
          },
        },
      };
      return handle;
    },

    /** Hapus seluruh auth state sesi (logout/delete). Tidak memerlukan lease: dipakai juga control-plane saat DELETING. */
    async erase(sessionId: string): Promise<void> {
      await db.tx({ platform: true }, (c) => eraseAuthIn(c, sessionId));
    },
  };
}
export type AuthStore = ReturnType<typeof createAuthStore>;
