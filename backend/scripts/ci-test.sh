#!/usr/bin/env bash
# Menjalankan `npm test` di CI dengan pagar: tes yang DILEWATI atau DIBATALKAN dianggap gagal.
# Alasan: tes memakai `skip` bila PostgreSQL tidak terjangkau; tanpa pagar ini DB yang salah konfigurasi membuat
# seluruh suite "lulus" tanpa menjalankan satu pun tes yang berarti. Env: MIN_TESTS (default 280) = batas bawah jumlah tes.
set -uo pipefail
cd "$(dirname "$0")/.."
MIN_TESTS="${MIN_TESTS:-280}"
LOG="$(mktemp)"; trap 'rm -f "$LOG"' EXIT
npm test 2>&1 | tee "$LOG"; rc=${PIPESTATUS[0]}
n() { sed -n "s/^# $1 \([0-9]*\)$/\1/p" "$LOG" | tail -1; }
tests="$(n tests)"; pass="$(n pass)"; fail="$(n fail)"; skipped="$(n skipped)"; cancelled="$(n cancelled)"
echo "== ringkasan: tests=${tests:-?} pass=${pass:-?} fail=${fail:-?} skipped=${skipped:-?} cancelled=${cancelled:-?} (rc=$rc, min=$MIN_TESTS)"
bad=0
[ "$rc" -eq 0 ] || { echo "GAGAL: npm test keluar dengan kode $rc"; bad=1; }
[ -n "${tests:-}" ] || { echo "GAGAL: ringkasan TAP tidak ditemukan"; bad=1; }
[ "${fail:-1}" = 0 ] || { echo "GAGAL: ada tes gagal"; bad=1; }
[ "${skipped:-1}" = 0 ] || { echo "GAGAL: ada tes DILEWATI (apakah PostgreSQL terjangkau? lihat DB_* di env CI)"; bad=1; }
[ "${cancelled:-1}" = 0 ] || { echo "GAGAL: ada tes dibatalkan"; bad=1; }
[ "${tests:-0}" -ge "$MIN_TESTS" ] || { echo "GAGAL: hanya ${tests:-0} tes (< $MIN_TESTS); berkas tes hilang/tidak terbaca?"; bad=1; }
exit "$bad"
