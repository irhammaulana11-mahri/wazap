import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Regresi: batas "happy eyeballs" bawaan Node (250 ms per alamat) membatalkan sambungan IPv4 yang sehat tetapi jauh (RTT Telegram dari
 * Indonesia 230-320 ms), lalu jatuh ke IPv6 yang tidak terjangkau => CONNECTION_FAILED acak pada notifikasi dan webhook (ditemukan di staging).
 * Perilaku jaringan tidak dapat dibuat deterministik di tes, jadi yang dijaga adalah opsi pada permintaan keluar.
 */
test('postJson menaikkan autoSelectFamilyAttemptTimeout di atas 250 ms', () => {
  const src = fs.readFileSync(new URL('../src/modules/engine/webhook-delivery.ts', import.meta.url), 'utf8');
  const m = src.match(/autoSelectFamilyAttemptTimeout:\s*Math\.max\((\d+)/);
  assert.ok(m, 'opsi autoSelectFamilyAttemptTimeout harus diatur pada lib.request di postJson');
  assert.ok(Number(m![1]) > 250, 'batas minimum harus jauh di atas 250 ms bawaan Node');
});
