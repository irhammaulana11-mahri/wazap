import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(process.cwd(), 'src/database/migrations')];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error('Direktori migrasi tidak ditemukan');
  return found;
}

/**
 * Runner SQL berversi. Tiap file dijalankan dalam satu transaksi dengan search_path = schema target.
 * Checksum dicatat; file yang sudah diterapkan lalu berubah => error (jangan edit migrasi lama).
 * Advisory lock mencegah dua proses migrasi bersamaan.
 */
export async function migrate(pool: pg.Pool, schema: string, dir = resolveMigrationsDir()): Promise<MigrationResult> {
  if (!SCHEMA_RE.test(schema)) throw new Error('Nama schema tidak valid');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
    // PostgreSQL memeriksa hak CREATE pada database SEBELUM menilai IF NOT EXISTS, sehingga role migrator berhak-minimal
    // (pemilik schema yang sudah dibuat DBA, tanpa CREATE di database) gagal walau schema sudah ada. Buat hanya bila belum ada.
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (exists.rowCount === 0) await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum])
    );
    for (const file of files) {
      const version = file.slice(0, 4);
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const prev = done.get(version);
      if (prev) {
        if (prev !== checksum) throw new Error(`Checksum migrasi ${file} berubah setelah diterapkan`);
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [version, file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]).catch(() => {});
    client.release();
  }
  return result;
}
