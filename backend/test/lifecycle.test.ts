import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET ??= 'x'.repeat(40);
const L = await import('../src/modules/sessions/lifecycle.js');
import fs from 'fs';
import path from 'path';

test('tabel transisi lengkap dan konsisten', () => {
  assert.deepEqual(Object.keys(L.TRANSITIONS).sort(), [...L.SESSION_STATES].sort());
  for (const [from, tos] of Object.entries(L.TRANSITIONS)) for (const to of tos) assert.ok(L.SESSION_STATES.includes(to), `${from}->${to}`);
  assert.deepEqual(L.TRANSITIONS.DELETED, [], 'DELETED terminal');
  for (const s of L.SESSION_STATES) if (s !== 'DELETED') assert.ok(L.canTransition(s, 'DELETING') || s === 'DELETING', `${s} harus bisa dihapus`);
});

test('transisi ilegal ditolak, transisi sah diterima', () => {
  assert.equal(L.canTransition('CREATED', 'CONNECTED'), false);
  assert.equal(L.canTransition('DISCONNECTED', 'CONNECTED'), false);
  assert.equal(L.canTransition('DELETED', 'PENDING_ASSIGNMENT'), false);
  assert.equal(L.canTransition('CREATED', 'PENDING_ASSIGNMENT'), true);
  assert.equal(L.canTransition('PENDING_ASSIGNMENT', 'INITIALIZING'), true);
  assert.equal(L.canTransition('INITIALIZING', 'QR_REQUIRED'), true);
  assert.equal(L.canTransition('CONNECTED', 'RECONNECTING'), true);
  assert.equal(L.canTransition('LOGGED_OUT', 'CONNECTED'), false, 'logout harus lewat penempatan ulang/QR');
});

test('semua state selain CREATED dapat dicapai', () => {
  const reach = new Set<string>(['CREATED']);
  for (let i = 0; i < 20; i++) for (const s of [...reach]) for (const t of L.TRANSITIONS[s as L.SessionState]) reach.add(t);
  assert.deepEqual([...reach].sort(), [...L.SESSION_STATES].sort());
});

test('sanitizePayload membuang QR/kredensial/token dan membatasi ukuran', () => {
  const out = L.sanitizePayload({ reason: 'x', qr: 'data', qrCode: 'd', creds: {}, nested: { access_token: 't', ok: 1, password: 'p' }, apiKey: 'k', 'x-api-key': 'k', long: 'a'.repeat(900), arr: [1] });
  assert.deepEqual(Object.keys(out).sort(), ['long', 'nested', 'reason']);
  assert.deepEqual(out.nested, { ok: 1 });
  assert.equal((out.long as string).length, 500);
  assert.deepEqual(L.sanitizePayload('str'), {});
});

test('konteks platform hanya dipakai di modul istimewa (engine/runtime/database)', () => {
  const root = path.resolve(import.meta.dirname, '../src');
  const bad: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.ts') && /platform:\s*true/.test(fs.readFileSync(p, 'utf8'))) {
      const rel = path.relative(root, p);
      if (!/^(modules\/engine\/|runtime\/|database\/)/.test(rel)) bad.push(rel);
    } } };
  walk(root);
  assert.deepEqual(bad, [], 'jalur tenant tidak boleh memakai platform scope');
});
