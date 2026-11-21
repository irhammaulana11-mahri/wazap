import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Janji privasi platform admin (ADR-054): konsol hanya melihat metadata dan agregat. RLS tidak dapat membatasi KOLOM, jadi batas itu dijaga kode: tes ini memindai
 * sumber modul platform (tanpa komentar) dan gagal bila ada tabel di luar daftar putih atau kolom/tabel sensitif disebut. Uji isi respons nyata ada di platform-workspaces.test.ts.
 */
const DIR = path.resolve(import.meta.dirname, '../src/modules/platform');
const SQL_FILES = ['platform.service.ts', 'platform.workspaces.ts', 'platform.audit.ts'];   // berkas yang memuat SQL
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
const read = (f: string) => strip(fs.readFileSync(path.join(DIR, f), 'utf8'));

/** Tabel yang boleh disentuh modul platform, dan MENGAPA (tiap tambahan harus keputusan sadar + pembaruan ADR). */
const ALLOWED_TABLES = new Set([
  'tenants', 'tenant_settings', 'tenant_memberships', 'tenant_invitations', 'wa_sessions', 'api_keys',   // metadata dan hitungan agregat
  'platform_admins', 'platform_defaults', 'platform_audit_logs', 'audit_logs',                           // milik platform; audit workspace hanya INSERT transparansi
  'users',                                                                                                // surel/status/versi token akun admin (login)
]);
const FORBIDDEN = [
  'wa_messages', 'wa_chats', 'message_queue', 'session_auth_state', 'session_credentials', 'session_qr', 'alert_channels', 'alert_rules', 'alert_deliveries',
  'webhook_endpoints', 'webhook_deliveries', 'outbox_events', 'tenant_join_codes', 'tenant_join_requests', 'refresh_tokens', 'user_recovery_codes',
  'key_hash', 'secret_ciphertext', 'target_ciphertext', 'ciphertext', 'token_hash', 'payload', 'session_name', 'contact_phone', 'recipient',
];

test('modul platform hanya menyentuh tabel daftar putih dan tidak pernah menyebut tabel/kolom sensitif', () => {
  const tablesSeen = new Map<string, string[]>(); const hits: string[] = [];
  for (const f of SQL_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TRUNCATE)\s+([a-z_][a-z0-9_]*)/gi)) {
      const t = m[1]!.toLowerCase(); if (['of', 'only', 'select', 'set', 'table'].includes(t)) continue;
      tablesSeen.set(t, [...(tablesSeen.get(t) ?? []), f]);
    }
    for (const w of FORBIDDEN) if (new RegExp(`\\b${w}\\b`, 'i').test(src)) hits.push(`${f}: menyebut "${w}"`);
  }
  assert.ok(tablesSeen.size >= 8, `pemindai harus menemukan tabel (ditemukan ${[...tablesSeen.keys()].join(', ')})`);
  const outside = [...tablesSeen.keys()].filter((t) => !ALLOWED_TABLES.has(t));
  assert.deepEqual(outside, [], `tabel di luar daftar putih: ${outside.join(', ')} (tambahan wajib keputusan sadar dan pembaruan ADR-054)`);
  assert.deepEqual(hits, [], 'kolom/tabel sensitif tidak boleh disebut modul platform');
});

test('password_hash hanya dibaca SEKALI, di login (verifikasi kata sandi); audit workspace hanya di-INSERT; users tidak pernah ditulis', () => {
  const all = SQL_FILES.map((f) => ({ f, src: read(f) }));
  // password_hash hanya muncul sebagai PASANGAN di login: kueri yang membacanya dan baris yang langsung meneruskannya ke verifyPassword. Tidak boleh dikembalikan/disimpan.
  const lines = all.flatMap(({ f, src }) => src.split('\n').filter((l) => /password_hash/.test(l)).map((l) => ({ f, l })));
  assert.equal(lines.length, 2, `password_hash muncul pada ${lines.length} baris (harus tepat 2: kueri login dan verifyPassword)`);
  assert.ok(lines.every((x) => x.f === 'platform.service.ts'));
  assert.ok(lines.some((x) => /FROM users WHERE email/.test(x.l)) && lines.some((x) => /verifyPassword\(/.test(x.l)), 'pasangan: kueri login dan verifyPassword');
  for (const { f, src } of all) {
    assert.ok(!/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+users\b/i.test(src), `${f}: tabel users tidak boleh ditulis`);
    assert.ok(!/\b(UPDATE|DELETE\s+FROM)\s+audit_logs\b/i.test(src), `${f}: audit_logs workspace hanya boleh di-INSERT`);
    assert.ok(!/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+platform_audit_logs\b/i.test(src), `${f}: audit platform append-only`);
    assert.ok(!/\b(DELETE\s+FROM|TRUNCATE)\s+(tenants|tenant_settings|tenant_memberships|wa_sessions|api_keys)\b/i.test(src.replace(/DELETE FROM platform_admins/g, '')), `${f}: tidak ada penghapusan data workspace`);
  }
});

test('hanya modul platform yang menyebut tabel platform; modul lain tidak membaca platform_admins/platform_audit_logs', () => {
  const root = path.resolve(import.meta.dirname, '../src'); const bad: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) { const rel = path.relative(root, p); if (/^(modules\/platform\/|runtime\/(platform-admin-cli|rotate-keys)\.ts|database\/)/.test(rel)) continue; if (/\bplatform_(admins|audit_logs)\b/.test(strip(fs.readFileSync(p, 'utf8')))) bad.push(rel); }
  } };
  walk(root);
  assert.deepEqual(bad, [], 'tabel platform hanya boleh disentuh modul platform, CLI admin, dan rotasi kunci');
});
