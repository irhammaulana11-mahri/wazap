import type { ZodType } from 'zod';

/** Kontrak request satu route: skema Zod YANG SAMA dengan yang dipakai handler (dihasilkan jadi OpenAPI; tidak ada salinan). */
export interface RouteContract {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** Body boleh dihilangkan (handler memakai `req.body ?? {}`). */
  bodyOptional?: boolean;
}

/** Metadata guard yang ditempelkan pada fungsi preHandler (tidak mengubah perilaku). Dibaca generator OpenAPI dari opsi route nyata. */
export type GuardMeta =
  | { kind: 'authenticate' }
  | { kind: 'role'; roles: string[] }
  | { kind: 'scope'; scope: string }
  | { kind: 'access'; scope: string; roles: string[] }
  /** Token platform admin (ADR-054): bukan token workspace dan bukan API key. */
  | { kind: 'platform' };
