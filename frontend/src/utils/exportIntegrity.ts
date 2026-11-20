/**
 * Modul murni verifikasi kelengkapan berkas ekspor (ADR-048).
 * Bebas dari impor React/DOM; hanya menggunakan API standar Blob dan TextDecoder.
 */

export interface IntegrityResult {
  ok: boolean;
  rows: number;
  reason?: string;
}

export async function verifyExportBlob(
  blob: Blob,
  format: 'csv' | 'ndjson',
  expectedRows: number | undefined,
  opts?: { approximate?: boolean }
): Promise<IntegrityResult> {
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder('utf-8');

  if (format === 'csv') {
    let inQuotes = false;
    let recordsCount = 0;
    let hasCharsInRecord = false;
    let isFirstChar = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (isFirstChar) {
          isFirstChar = false;
          if (c === '\uFEFF') continue;
        }

        if (c === '"') {
          inQuotes = !inQuotes;
          hasCharsInRecord = true;
        } else if (!inQuotes && c === '\n') {
          if (hasCharsInRecord) {
            recordsCount++;
            hasCharsInRecord = false;
          }
        } else if (!inQuotes && c === '\r') {
          // CRLF handling: ignore \r
        } else {
          hasCharsInRecord = true;
        }
      }
    }

    // Flush any remaining decoder bytes
    const tail = decoder.decode();
    if (tail) {
      for (let i = 0; i < tail.length; i++) {
        const c = tail[i];
        if (c === '"') {
          inQuotes = !inQuotes;
          hasCharsInRecord = true;
        } else if (!inQuotes && c === '\n') {
          if (hasCharsInRecord) {
            recordsCount++;
            hasCharsInRecord = false;
          }
        } else if (!inQuotes && c === '\r') {
          // ignore \r
        } else {
          hasCharsInRecord = true;
        }
      }
    }

    if (inQuotes) {
      const rows = recordsCount > 0 ? recordsCount - 1 : 0;
      return {
        ok: false,
        rows,
        reason: 'Berkas terpotong di dalam tanda kutip',
      };
    }

    if (hasCharsInRecord) {
      recordsCount++;
    }

    const rows = recordsCount > 0 ? recordsCount - 1 : 0;

    if (opts?.approximate) {
      return { ok: true, rows };
    }

    if (expectedRows !== undefined && rows < expectedRows) {
      return {
        ok: false,
        rows,
        reason: `Jumlah baris data (${rows}) kurang dari yang diharapkan (${expectedRows})`,
      };
    }

    return { ok: true, rows };
  }

  // Format NDJSON
  let buffer = '';
  let dataRowCount = 0;
  let lastLine = '';
  let manifestFoundBeforeEnd = false;

  const processLine = (l: string) => {
    const trimmed = l.trim();
    if (!trimmed) return;

    if (lastLine) {
      try {
        const prevObj = JSON.parse(lastLine);
        if (prevObj && typeof prevObj === 'object' && prevObj._manifest) {
          manifestFoundBeforeEnd = true;
        }
      } catch {
        // Not a JSON object
      }
      dataRowCount++;
    }
    lastLine = trimmed;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const l of lines) {
      processLine(l);
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const lines = buffer.split('\n');
    for (const l of lines) {
      processLine(l);
    }
  }

  if (manifestFoundBeforeEnd) {
    return {
      ok: false,
      rows: dataRowCount,
      reason: 'Manifest bukan baris terakhir',
    };
  }

  if (!lastLine) {
    return {
      ok: false,
      rows: 0,
      reason: 'Berkas kosong atau tidak ada data',
    };
  }

  let parsedManifest: any = null;
  try {
    parsedManifest = JSON.parse(lastLine);
  } catch {
    return {
      ok: false,
      rows: dataRowCount,
      reason: 'Manifest terpotong atau format JSON tidak valid',
    };
  }

  if (!parsedManifest || typeof parsedManifest !== 'object' || !parsedManifest._manifest) {
    return {
      ok: false,
      rows: dataRowCount + 1,
      reason: 'Manifest tidak ditemukan pada baris terakhir',
    };
  }

  const manifestRows = parsedManifest._manifest.rows;
  if (typeof manifestRows !== 'number') {
    return {
      ok: false,
      rows: dataRowCount,
      reason: 'Manifest tidak memiliki properti rows yang valid',
    };
  }

  if (manifestRows !== dataRowCount) {
    return {
      ok: false,
      rows: dataRowCount,
      reason: `Jumlah baris manifest (${manifestRows}) tidak cocok dengan baris data (${dataRowCount})`,
    };
  }

  if (expectedRows !== undefined && !opts?.approximate && dataRowCount < expectedRows) {
    return {
      ok: false,
      rows: dataRowCount,
      reason: `Jumlah baris data (${dataRowCount}) kurang dari yang diharapkan (${expectedRows})`,
    };
  }

  return {
    ok: true,
    rows: dataRowCount,
  };
}
