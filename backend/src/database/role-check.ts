import type pg from 'pg';

export interface RoleReport {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsSchema: boolean;
  canCreateInSchema: boolean;
}
export interface RoleAssessment {
  /** Pelanggaran yang membuat RLS tidak berarti (superuser/BYPASSRLS). */
  fatal: string[];
  /** Hak berlebih untuk role runtime (pemilik/DDL schema). */
  warnings: string[];
}

/** Baca atribut role koneksi runtime terhadap schema gateway. Panggil SETELAH migrasi (schema harus ada). */
export async function inspectDbRole(pool: pg.Pool, schema: string): Promise<RoleReport> {
  const r = (
    await pool.query(
      `SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              COALESCE(n.nspowner = r.oid, false) AS owns,
              COALESCE(has_schema_privilege(r.rolname, n.nspname, 'CREATE'), false) AS can_create
       FROM pg_roles r LEFT JOIN pg_namespace n ON n.nspname = $1 WHERE r.rolname = current_user`,
      [schema]
    )
  ).rows[0];
  return { role: r.role, superuser: r.superuser, bypassRls: r.bypass, ownsSchema: r.owns, canCreateInSchema: r.can_create };
}

/**
 * Superuser dan BYPASSRLS MELEWATI row-level security sepenuhnya (FORCE RLS pun tidak berlaku): isolasi tenant
 * hanya "di atas kertas". Pemilik/DDL schema dapat menonaktifkan RLS bila aplikasi dibobol.
 */
export function assessRole(r: RoleReport): RoleAssessment {
  const fatal: string[] = [];
  const warnings: string[] = [];
  if (r.superuser) fatal.push(`role DB "${r.role}" adalah SUPERUSER: RLS tidak berlaku`);
  if (r.bypassRls) fatal.push(`role DB "${r.role}" memiliki BYPASSRLS: RLS tidak berlaku`);
  if (r.ownsSchema) warnings.push(`role runtime "${r.role}" memiliki schema: dapat mengubah/menonaktifkan RLS lewat DDL; pisahkan role migrasi (lihat docs/07_DEPLOYMENT/DB_ROLES.md)`);
  else if (r.canCreateInSchema) warnings.push(`role runtime "${r.role}" boleh CREATE di schema: cabut hak DDL`);
  return { fatal, warnings };
}

/** Putusan start: 'enforce' melempar bila ada pelanggaran fatal; 'warn' hanya mengembalikan pesan; 'off' tidak memeriksa. */
export function roleCheckMode(env: { DB_ROLE_CHECK?: 'enforce' | 'warn' | 'off'; NODE_ENV: string }): 'enforce' | 'warn' | 'off' {
  return env.DB_ROLE_CHECK ?? (env.NODE_ENV === 'production' ? 'enforce' : 'warn');
}
