/**
 * Penulis CSV/NDJSON untuk ekspor (ADR-048).
 *
 * KEAMANAN: isi pesan berasal dari pihak luar. Sel teks yang diawali `=`, `+`, `-`, `@`, tab, atau carriage return diberi awalan `'` agar
 * spreadsheet tidak mengeksekusinya sebagai formula (`=HYPERLINK(...)`, `@SUM(...)`). Hanya TEKS yang dinetralkan; angka bertipe number tidak diubah.
 */
export const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTE = /[",\r\n]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  else if (typeof v === 'boolean') return v ? 'true' : 'false';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTE.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',') + '\r\n';

/** Satu objek JSON per baris; Date menjadi ISO-8601. */
export const ndjsonLine = (record: Record<string, unknown>): string =>
  JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
