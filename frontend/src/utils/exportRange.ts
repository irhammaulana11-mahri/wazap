/**
 * Modul murni pembuat rentang tanggal ekspor (ADR-048).
 * Bebas dari impor React/DOM.
 */

export type RangeResult =
  | { ok: true; from: string; to: string; spanDays: number }
  | { ok: false; reason: 'kosong' | 'tidak-valid' | 'urutan' | 'terlalu-panjang' };

function pad(n: number): string {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

function formatLocalIso(d: Date): string {
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offsetHours = pad(offset / 60);
  const offsetMinutes = pad(offset % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`;
}

export function buildExportRange(
  startStr: string,
  endStr: string,
  maxSpanDays: number
): RangeResult {
  if (!startStr || !endStr || !startStr.trim() || !endStr.trim()) {
    return { ok: false, reason: 'kosong' };
  }

  const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const mStart = dateRegex.exec(startStr.trim());
  const mEnd = dateRegex.exec(endStr.trim());
  if (!mStart || !mEnd) {
    return { ok: false, reason: 'tidak-valid' };
  }

  const startY = Number(mStart[1]);
  const startM = Number(mStart[2]);
  const startD = Number(mStart[3]);

  const endY = Number(mEnd[1]);
  const endM = Number(mEnd[2]);
  const endD = Number(mEnd[3]);

  const startDate = new Date(startY, startM - 1, startD, 0, 0, 0, 0);
  const endDate = new Date(endY, endM - 1, endD, 0, 0, 0, 0);

  if (
    startDate.getFullYear() !== startY ||
    startDate.getMonth() !== startM - 1 ||
    startDate.getDate() !== startD ||
    endDate.getFullYear() !== endY ||
    endDate.getMonth() !== endM - 1 ||
    endDate.getDate() !== endD
  ) {
    return { ok: false, reason: 'tidak-valid' };
  }

  if (endDate.getTime() < startDate.getTime()) {
    return { ok: false, reason: 'urutan' };
  }

  const nextDay = new Date(endY, endM - 1, endD + 1, 0, 0, 0, 0);
  const from = formatLocalIso(startDate);
  const to = formatLocalIso(nextDay);

  const DAY_MS = 86_400_000;
  // spanMs diukur dari parsing ISO string atau selisih timestamp Date
  const spanMs = Date.parse(to) - Date.parse(from);
  if (spanMs > maxSpanDays * DAY_MS) {
    return { ok: false, reason: 'terlalu-panjang' };
  }

  // Kalender hari terpilih (inklusif: 1-1 = 1 hari, 1-7 = 7 hari)
  const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1;

  return {
    ok: true,
    from,
    to,
    spanDays,
  };
}
