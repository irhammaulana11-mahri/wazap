import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Menjaga runbook/dokumen operasi tidak menyimpang dari kode: perintah, berkas, variabel env, teks log, kode galat, dan angka batas laju yang dikutip
// harus benar-benar ada. (Pelajaran: contoh PM2 `env_file` pernah salah karena tidak ada di PM2; snippet Nginx pernah rentan.)
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';
const { config } = await import('../src/config/env.js');

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const DOCS = ['docs/07_DEPLOYMENT/RUNBOOK.md', 'docs/07_DEPLOYMENT/BACKUP_RESTORE.md', 'docs/07_DEPLOYMENT/DEPLOYMENT_GUIDE.md', 'docs/07_DEPLOYMENT/DB_ROLES.md', 'docs/07_DEPLOYMENT/PM2_CONFIGURATION.md', 'deploy/staging/README.md'];
const src = (() => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts') || p.endsWith('.sql')) out.push(fs.readFileSync(p, 'utf-8')); } }; walk(path.join(ROOT, 'backend/src')); return out.join('\n'); })();

test('perintah `npm run <skrip>` di dokumen operasi ada di package.json', () => {
  const scripts = new Set(Object.keys(JSON.parse(read('backend/package.json')).scripts));
  const missing: string[] = [];
  for (const f of DOCS) for (const m of read(f).matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) if (!scripts.has(m[1]!)) missing.push(`${f}: npm run ${m[1]}`);
  assert.deepEqual(missing, [], `skrip tidak ada di package.json: ${missing.join('; ')}`);
});

test('berkas skrip/SQL yang dirujuk dokumen operasi ada di repo', () => {
  const missing: string[] = [];
  for (const f of DOCS) for (const m of read(f).matchAll(/((?:deploy|backend\/scripts|docs)\/[A-Za-z0-9_./-]+\.(?:sh|sql|mjs|cjs|md|json))/g)) {
    const rel = m[1]!.replace(/[.,;:)]+$/, '');
    if (rel.includes('<') || rel.includes('...')) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${f}: ${rel}`);
  }
  assert.deepEqual(missing, [], `berkas dirujuk tetapi tidak ada: ${missing.join('; ')}`);
});

test('nama variabel env di RUNBOOK/BACKUP_RESTORE adalah variabel konfigurasi yang nyata', () => {
  // dari definisi skema (variabel opsional tidak muncul di objek config bila tidak diisi)
  const known = new Set([...read('backend/src/config/env.ts').matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*z\./gm)].map((m) => m[1]!));
  assert.ok(known.size > 80 && known.has('ENGINE_NODE_NAME') && known.has('CREDENTIAL_ACTIVE_KEY_VERSION'), 'pembacaan skema env gagal');
  const prefixes = /^(DB_|WORKER_|ENGINE_|WEBHOOK_|RETENTION_|CREDENTIAL_|ENABLE_|JWT_|API_|TRUST_|SHUTDOWN_|QUEUE_|MEDIA_|JOIN_|DASHBOARD_|AUTO_MIGRATE|ACCESS_TOKEN_|REFRESH_TOKEN_)/;
  const bad: string[] = [];
  for (const f of ['docs/07_DEPLOYMENT/RUNBOOK.md', 'docs/07_DEPLOYMENT/BACKUP_RESTORE.md']) {
    for (const m of read(f).matchAll(/`([A-Z][A-Z0-9_]{3,})(?:=[^`]*)?`/g)) {
      const name = m[1]!;
      if (prefixes.test(name) && !known.has(name)) bad.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(bad, [], `variabel tidak ada di config: ${bad.join('; ')}`);
});

test('teks log, status, dan kode yang dikutip RUNBOOK benar-benar dikeluarkan kode', () => {
  const runbook = read('docs/07_DEPLOYMENT/RUNBOOK.md');
  const phrases = [
    'belum dimigrasi', 'role DB tidak aman', 'sudah berjalan di proses lain', 'kunci singleton hilang dan tidak dapat direbut kembali',
    'gagal menempatkan sesi', 'gagal memulihkan sesi dengan lease kedaluwarsa', 'auth_state_unavailable', 'duplicate_phone_number',
    'AUTO_CONSECUTIVE_FAILURES', 'realtime.resync', 'confirm_duplicate_risk', 'SERVICE_UNAVAILABLE', 'RECONCILIATION_REQUIRED', 'LOGGED_OUT',
    'CREDENTIAL_ENCRYPTION_KEYS belum diset',
  ];
  const notInSrc = phrases.filter((p) => !src.includes(p)), notInDoc = phrases.filter((p) => !runbook.includes(p));
  assert.deepEqual(notInSrc, [], `kutipan tidak ada di kode: ${notInSrc.join('; ')}`);
  assert.deepEqual(notInDoc, [], `kutipan hilang dari RUNBOOK: ${notInDoc.join('; ')}`);
});

test('angka batas laju dan retensi di RUNBOOK sama dengan kode', () => {
  const routes = read('backend/src/modules/identity/identity.routes.ts');
  assert.match(routes, /limit\(`login-ip:\$\{req\.ip\}`, 20, 5 \* 60_000\)/);
  assert.match(routes, /limit\(`login-email:\$\{emailKey\}`, 8, 15 \* 60_000\)/);
  assert.match(routes, /limit\(`reg:\$\{req\.ip\}`, 5, 60 \* 60_000\)/);
  assert.match(routes, /limit\(`reset-ip:\$\{req\.ip\}`, 10, 60 \* 60_000\)/);
  const rb = read('docs/07_DEPLOYMENT/RUNBOOK.md');
  for (const s of ['login 20 per 5 menit', '8 per 15 menit per email', 'register 5 per jam', 'reset kata sandi 10 per jam', '600 per menit', '1.200 per menit']) assert.ok(rb.includes(s), `RUNBOOK tidak memuat "${s}"`);
  assert.equal(config.API_RATE_LIMIT_IP_PER_MINUTE, 600); assert.equal(config.API_RATE_LIMIT_TENANT_PER_MINUTE, 1200);
  assert.equal(config.WEBHOOK_AUTO_DISABLE_AFTER, 10); assert.equal(config.WEBHOOK_MAX_ATTEMPTS, 8);
  assert.equal(config.ENGINE_LEASE_TTL_SECONDS, 30); assert.equal(config.SHUTDOWN_TIMEOUT_MS, 15000); assert.equal(config.RETENTION_INTERVAL_MINUTES, 60);
  assert.deepEqual([config.RETENTION_CONTENT_DAYS, config.RETENTION_ROW_DAYS, config.RETENTION_OUTBOX_DAYS, config.RETENTION_WEBHOOK_DELIVERY_DAYS, config.RETENTION_AUDIT_DAYS, config.RETENTION_TENANT_DAYS, config.RETENTION_JOIN_REQUEST_DAYS], [30, 180, 7, 30, 365, 30, 90]);
});

test('skrip operasi: sintaks valid dan pagar kunci tetap ada (role BYPASSRLS, tanpa berkas parsial, verifikasi RLS)', () => {
  const backup = read('deploy/ops/backup.sh'), drill = read('deploy/ops/restore-drill.sh'), role = read('deploy/ops/setup-backup-role.sql');
  assert.match(backup, /rolsuper or rolbypassrls/, 'pagar role harus ada');
  assert.match(backup, /\.partial/); assert.match(backup, /trap 'rm -f "\$PARTIAL"' EXIT/);
  assert.match(backup, /sha256sum/); assert.match(backup, /MIN_KEEP=3/);
  assert.match(drill, /--exit-on-error/); assert.match(drill, /relforcerowsecurity/); assert.match(drill, /DROP DATABASE IF EXISTS/);
  assert.match(role, /BYPASSRLS/); assert.match(role, /pg_read_all_data/); assert.match(role, /default_transaction_read_only = on/);
  assert.ok(!/PASSWORD\s+'/i.test(role), 'SQL role tidak boleh memuat kata sandi');
});
