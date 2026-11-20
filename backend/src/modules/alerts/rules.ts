/** Daftar aturan alarm TETAP di kode (ADR-049). Menambah aturan = ubah berkas ini, migrasi CHECK alert_rules, tes, dan dokumen. */
export interface RuleDef {
  code: string;
  label: string;
  description: string;
  /** Ambang numerik (null = tanpa ambang). */
  threshold: { default: number; min: number; max: number; unit: string } | null;
  /** true bila kondisi dapat berlanjut sehingga jeda ulang (cooldown) relevan. */
  repeats: boolean;
}

export const RULES: RuleDef[] = [
  { code: 'session.logged_out', label: 'Sesi keluar (LOGGED_OUT)', description: 'Sesi WhatsApp keluar dan perlu dipindai ulang.', threshold: null, repeats: false },
  { code: 'session.disconnected_long', label: 'Sesi terputus lama', description: 'Sesi yang seharusnya tersambung tidak CONNECTED melebihi batas menit.', threshold: { default: 10, min: 1, max: 1440, unit: 'menit' }, repeats: true },
  { code: 'session.reconnect_loop', label: 'Sesi sering putus-sambung', description: 'Banyak perubahan status putus/sambung ulang dalam 10 menit.', threshold: { default: 6, min: 3, max: 50, unit: 'kali/10 menit' }, repeats: true },
  { code: 'webhook.endpoint_disabled', label: 'Webhook dinonaktifkan otomatis', description: 'Endpoint webhook dinonaktifkan karena gagal berturut-turut.', threshold: null, repeats: false },
  { code: 'webhook.dead_burst', label: 'Banyak pengiriman webhook gagal', description: 'Pengiriman webhook berstatus DEAD melebihi batas dalam 1 jam.', threshold: { default: 5, min: 1, max: 1000, unit: 'pengiriman/jam' }, repeats: true },
  { code: 'message.failed_burst', label: 'Banyak pesan keluar gagal', description: 'Pesan keluar berstatus FAILED melebihi batas dalam 10 menit.', threshold: { default: 10, min: 1, max: 1000, unit: 'pesan/10 menit' }, repeats: true },
  { code: 'message.unknown', label: 'Pesan berstatus tidak pasti', description: 'Pesan keluar UNKNOWN atau perlu rekonsiliasi (hasil kirim tidak dapat dipastikan).', threshold: null, repeats: false },
  { code: 'export.completed', label: 'Ekspor data selesai', description: 'Seseorang mengunduh ekspor data workspace (kewaspadaan penyalahgunaan).', threshold: null, repeats: false },
];
export const RULE_BY_CODE = new Map(RULES.map((r) => [r.code, r]));
export const RULE_CODES = RULES.map((r) => r.code) as [string, ...string[]];
export const DEFAULT_COOLDOWN_MINUTES = 60;

/**
 * Teks notifikasi dari FAKTA tersanitasi. Tidak pernah memuat nomor telepon pelanggan akhir, isi pesan, URL penuh webhook, atau rahasia.
 * Nama sesi/host berasal dari data tenant dan dipotong; karakter kontrol dibuang agar tidak merusak format pesan.
 */
const clean = (v: unknown, max = 60) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export function buildAlertText(ruleCode: string, f: Record<string, unknown>, dashboardUrl?: string): string {
  const label = RULE_BY_CODE.get(ruleCode)?.label ?? ruleCode;
  const l: string[] = [`[WAZAP] ${label}`];
  switch (ruleCode) {
    case 'session.logged_out': l.push(`Sesi: ${clean(f.session_name)}`, 'Sesi keluar; pindai ulang QR untuk menyambungkan kembali.'); break;
    case 'session.disconnected_long': l.push(`Sesi: ${clean(f.session_name)}`, `Status: ${clean(f.status, 24)} selama sekitar ${Number(f.minutes) || 0} menit.`); break;
    case 'session.reconnect_loop': l.push(`Sesi: ${clean(f.session_name)}`, `${Number(f.count) || 0} perubahan status putus/sambung dalam 10 menit.`); break;
    case 'webhook.endpoint_disabled': l.push(`Tujuan: ${clean(f.endpoint_host, 80)}`, `Alasan: ${clean(f.reason, 48)}`); break;
    case 'webhook.dead_burst': l.push(`${Number(f.count) || 0} pengiriman webhook gagal total dalam 1 jam terakhir.`); break;
    case 'message.failed_burst': l.push(`${Number(f.count) || 0} pesan keluar gagal dalam 10 menit terakhir.`); break;
    case 'message.unknown': l.push(`Status: ${clean(f.status, 32)}`, 'Hasil pengiriman tidak dapat dipastikan; periksa di dashboard.'); break;
    case 'export.completed': l.push(`Jenis: ${clean(f.type, 24)}, baris: ${Number(f.rows) || 0}.`, 'Bila ini bukan Anda atau tim Anda, amankan akun.'); break;
    case 'channel.test': l.push('Pesan uji dari WAZAP. Kanal ini berfungsi.'); break;
  }
  if (dashboardUrl) l.push(dashboardUrl);
  return l.join('\n');
}
