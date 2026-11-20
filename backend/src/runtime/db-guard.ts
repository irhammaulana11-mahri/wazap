import type { GatewayDb } from '../database/gateway.js';
import { config } from '../config/env.js';
import { assessRole, inspectDbRole, roleCheckMode } from '../database/role-check.js';

interface GuardLog { warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void }

/** Isolasi tenant bergantung pada RLS: tolak start bila role runtime melewatinya (DB_ROLE_CHECK=enforce). Dipakai API dan pekerja. */
export async function enforceDbRole(db: GatewayDb, log: GuardLog, exit: (code: number) => void = (c) => process.exit(c)): Promise<void> {
  const mode = roleCheckMode(config);
  if (mode === 'off') return;
  try {
    const a = assessRole(await inspectDbRole(db.pool, config.DB_SCHEMA));
    for (const w of a.warnings) log.warn(w);
    for (const f of a.fatal) log.error(f);
    if (a.fatal.length && mode === 'enforce') { log.error({}, 'Menolak start: role DB tidak aman (DB_ROLE_CHECK=enforce).'); exit(1); }
  } catch (err) {
    log.warn({ err }, 'Pemeriksaan role DB gagal');
  }
}

const REQUIRED_TABLES = ['engine_nodes', 'session_leases', 'wa_sessions', 'message_queue', 'outbox_events'];
/** Pekerja tidak pernah menjalankan migrasi: pastikan schema sudah dimigrasi (`npm run migrate:prod`) sebelum bekerja. */
export async function assertSchemaMigrated(db: GatewayDb): Promise<void> {
  const r = await db.pool.query(
    `SELECT t AS missing FROM unnest($2::text[]) AS t WHERE to_regclass(quote_ident($1) || '.' || quote_ident(t)) IS NULL`,
    [db.schema, REQUIRED_TABLES]
  );
  if (r.rowCount) throw new Error(`Schema "${db.schema}" belum dimigrasi (tabel hilang: ${r.rows.map((x) => x.missing).join(', ')}). Jalankan migrasi lebih dulu.`);
}
