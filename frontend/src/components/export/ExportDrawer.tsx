import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X,
  Download,
  FileSpreadsheet,
  FileCode,
  Calendar,
  AlertTriangle,
  ShieldAlert,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Copy,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import {
  ExportType,
  ExportFormat,
  ExportRequestBody,
  WhatsAppSession,
} from '../../types';
import { useToast } from '../../context/ToastContext';
import { verifyExportBlob } from '../../utils/exportIntegrity';
import { buildExportRange } from '../../utils/exportRange';

interface ExportDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  initialType?: ExportType;
  lockType?: boolean;
  initialSessionId?: string;
}

const TYPE_CONFIG: Record<
  ExportType,
  {
    label: string;
    description: string;
    needsRange: boolean;
    supportsSession: boolean;
    supportsDirection: boolean;
    supportsStatus: boolean;
  }
> = {
  messages: {
    label: 'Pesan Obrolan (Inbound & Outbound)',
    description: 'Seluruh riwayat pesan obrolan pelanggan (masuk dan keluar) yang tercatat.',
    needsRange: true,
    supportsSession: true,
    supportsDirection: true,
    supportsStatus: false,
  },
  outbound: {
    label: 'Antrean Pesan Keluar (Outbox Queue)',
    description: 'Catatan pesan keluar yang dikirim via gateway, termasuk status pengiriman.',
    needsRange: true,
    supportsSession: true,
    supportsDirection: false,
    supportsStatus: true,
  },
  chats: {
    label: 'Daftar Percakapan (Threads)',
    description: 'Daftar kontak percakapan aktif per nomor telepon dan sesi.',
    needsRange: false,
    supportsSession: true,
    supportsDirection: false,
    supportsStatus: false,
  },
  contacts: {
    label: 'Kontak Pelanggan',
    description: 'Ringkasan kontak pelanggan 1:1 unik lintas sesi WhatsApp.',
    needsRange: false,
    supportsSession: false,
    supportsDirection: false,
    supportsStatus: false,
  },
  'audit-logs': {
    label: 'Log Audit Workspace',
    description: 'Catatan rekam jejak aktivitas, perubahan setelan, dan tindakan anggota tim.',
    needsRange: true,
    supportsSession: false,
    supportsDirection: false,
    supportsStatus: false,
  },
  members: {
    label: 'Anggota Tim & Peran',
    description: 'Daftar seluruh anggota workspace, email, peran hak akses, dan status bergabung.',
    needsRange: false,
    supportsSession: false,
    supportsDirection: false,
    supportsStatus: false,
  },
};

const QUEUE_STATUS_OPTIONS = [
  { value: '', label: 'Semua Status' },
  { value: 'PENDING', label: 'PENDING (Menunggu)' },
  { value: 'PROCESSING', label: 'PROCESSING (Diproses)' },
  { value: 'SENT', label: 'SENT (Terkirim ke Server)' },
  { value: 'DELIVERED', label: 'DELIVERED (Diterima)' },
  { value: 'READ', label: 'READ (Dibaca)' },
  { value: 'FAILED', label: 'FAILED (Gagal)' },
  { value: 'CANCELLED', label: 'CANCELLED (Dibatalkan)' },
  { value: 'UNKNOWN', label: 'UNKNOWN (Tidak Diketahui)' },
  { value: 'RECONCILIATION_REQUIRED', label: 'RECONCILIATION_REQUIRED (Perlu Rekonsiliasi)' },
];

function pad(n: number): string {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

function toLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export const ExportDrawer: React.FC<ExportDrawerProps> = ({
  isOpen,
  onClose,
  initialType = 'messages',
  lockType = false,
  initialSessionId,
}) => {
  const { showToast } = useToast();

  const [type, setType] = useState<ExportType>(initialType);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [sessionId, setSessionId] = useState<string>(initialSessionId || '');
  const [direction, setDirection] = useState<'IN' | 'OUT' | ''>('');
  const [status, setStatus] = useState<string>('');

  // Date range defaults: 30 hari terakhir
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [startDateStr, setStartDateStr] = useState<string>(toLocalDateInput(defaultStart));
  const [endDateStr, setEndDateStr] = useState<string>(toLocalDateInput(now));

  // Password confirmation
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // Focus trap refs
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Export progress & abort control
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [downloadedBytes, setDownloadedBytes] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [tooLargeDetails, setTooLargeDetails] = useState<{ maxRows: number; estimatedRows: number } | null>(null);
  const [rateLimitWait, setRateLimitWait] = useState<number | null>(null);
  const [isForbiddenRole, setIsForbiddenRole] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Policy & sessions query (NO fallback numbers!)
  const {
    data: policy,
    isLoading: isLoadingPolicy,
    isError: isPolicyError,
    refetch: refetchPolicy,
  } = useQuery({
    queryKey: ['export-policy'],
    queryFn: () => api.getExportPolicy(),
    staleTime: 60_000,
  });

  const { data: sessions } = useQuery<WhatsAppSession[]>({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
    staleTime: 30_000,
  });

  // Focus restoration & save active element
  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement | null;
      setType(initialType);
      if (initialSessionId) setSessionId(initialSessionId);
      setPassword('');
      setErrorMessage(null);
      setErrorRequestId(null);
      setTooLargeDetails(null);
      setRateLimitWait(null);
      setIsForbiddenRole(false);
      setDownloadedBytes(0);
      setIsExporting(false);
    } else {
      if (triggerElementRef.current) {
        triggerElementRef.current.focus();
      }
    }
  }, [isOpen, initialType, initialSessionId]);

  // Rate limit countdown effect
  useEffect(() => {
    if (!rateLimitWait || rateLimitWait <= 0) return;
    const timer = setInterval(() => {
      setRateLimitWait((prev) => (prev && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitWait]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  if (!isOpen) return null;

  const currentConfig = TYPE_CONFIG[type];

  // Presets tanggal
  const handlePreset = (preset: '30days' | 'month' | 'lastMonth' | '7days') => {
    const today = new Date();
    if (preset === '30days') {
      const start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      setStartDateStr(toLocalDateInput(start));
      setEndDateStr(toLocalDateInput(today));
    } else if (preset === '7days') {
      const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      setStartDateStr(toLocalDateInput(start));
      setEndDateStr(toLocalDateInput(today));
    } else if (preset === 'month') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDateStr(toLocalDateInput(start));
      setEndDateStr(toLocalDateInput(today));
    } else if (preset === 'lastMonth') {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      setStartDateStr(toLocalDateInput(start));
      setEndDateStr(toLocalDateInput(end));
    }
    setErrorMessage(null);
    setErrorRequestId(null);
    setTooLargeDetails(null);
  };

  // Validasi rentang tanggal murni dengan buildExportRange
  const currentRangeResult =
    currentConfig.needsRange && policy
      ? buildExportRange(startDateStr, endDateStr, policy.max_span_days)
      : null;

  const isDateRangeInvalid = currentConfig.needsRange && currentRangeResult !== null && !currentRangeResult.ok;

  const handleCancelExport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsExporting(false);
    setStatusMessage('');
    showToast('info', 'Unduhan ekspor data dibatalkan');
  };

  // Keyboard trap: Tab & Escape
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isExporting) {
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setErrorMessage('Kata sandi akun wajib diisi untuk konfirmasi keamanan.');
      passwordInputRef.current?.focus();
      return;
    }

    if (currentConfig.needsRange) {
      if (!policy) {
        setErrorMessage('Kebijakan ekspor sedang dimuat. Harap tunggu.');
        return;
      }
      const rangeCheck = buildExportRange(startDateStr, endDateStr, policy.max_span_days);
      if (!rangeCheck.ok) {
        if (rangeCheck.reason === 'kosong') {
          setErrorMessage('Tanggal mulai dan akhir wajib diisi.');
        } else if (rangeCheck.reason === 'tidak-valid') {
          setErrorMessage('Tanggal yang dimasukkan tidak valid.');
        } else if (rangeCheck.reason === 'urutan') {
          setErrorMessage('Tanggal mulai harus lebih awal dari tanggal akhir.');
        } else if (rangeCheck.reason === 'terlalu-panjang') {
          setErrorMessage(`Rentang tanggal tidak boleh melebihi ${policy.max_span_days} hari.`);
        }
        return;
      }
    }

    setErrorMessage(null);
    setErrorRequestId(null);
    setTooLargeDetails(null);
    setRateLimitWait(null);
    setIsExporting(true);
    setDownloadedBytes(0);
    setStatusMessage('Menghubungkan ke server dan memeriksa data...');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const requestBody: ExportRequestBody = {
      password,
      format,
    };

    if (currentConfig.needsRange && policy) {
      const validatedRange = buildExportRange(startDateStr, endDateStr, policy.max_span_days);
      if (validatedRange.ok) {
        requestBody.from = validatedRange.from;
        requestBody.to = validatedRange.to;
      }
    }
    if (currentConfig.supportsSession && sessionId) {
      requestBody.session_id = sessionId;
    }
    if (currentConfig.supportsDirection && direction) {
      requestBody.direction = direction;
    }
    if (currentConfig.supportsStatus && status) {
      requestBody.status = status;
    }

    try {
      setStatusMessage('Mengalirkan data dari basis data...');
      const result = await api.exportData(
        type,
        requestBody,
        {
          signal: abortController.signal,
          onProgress: (bytes) => {
            setDownloadedBytes(bytes);
            setStatusMessage(`Mengunduh berkas (${formatBytes(bytes)})...`);
          },
        }
      );

      // Verifikasi baris kosong
      if (result.rows === 0) {
        setIsExporting(false);
        showToast('info', 'Tidak ada data pada rentang tanggal atau filter yang dipilih.');
        return;
      }

      // Verifikasi integritas kelengkapan berkas via verifyExportBlob streaming
      setStatusMessage('Memeriksa integritas kelengkapan berkas...');
      const verification = await verifyExportBlob(
        result.blob,
        format,
        result.rows,
        { approximate: type === 'contacts' }
      );

      if (!verification.ok) {
        setIsExporting(false);
        setErrorMessage(
          verification.reason || 'Berkas ekspor tidak lengkap (terpotong saat unduhan). Silakan ulangi ekspor.'
        );
        return;
      }

      // Unduh berkas via Blob URL
      const downloadUrl = URL.createObjectURL(result.blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = downloadUrl;
      downloadAnchor.download = result.filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      const rowLabel =
        type === 'contacts'
          ? `${verification.rows} baris (perkiraan)`
          : `${verification.rows} baris`;

      showToast(
        'success',
        `Ekspor data ${currentConfig.label} berhasil diunduh (${rowLabel}).`
      );

      setIsExporting(false);
      onClose();
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        return;
      }

      setIsExporting(false);

      if (err instanceof ApiError) {
        setErrorRequestId(err.requestId || null);

        if (err.status === 422 && err.code === 'EXPORT_TOO_LARGE') {
          const details = (err.details?.[0] as any) || {};
          const maxRows = details.max_rows ?? policy?.max_rows;
          const estimated = details.estimated_rows ?? maxRows;
          if (maxRows !== undefined) {
            setTooLargeDetails({ maxRows, estimatedRows: estimated || maxRows });
          }
          setErrorMessage(
            `Data terlalu banyak (estimasi ${(estimated || 0).toLocaleString('id-ID')} baris, batas maksimal ${(maxRows || 0).toLocaleString('id-ID')} baris). Silakan persempit rentang tanggal.`
          );
        } else if (err.status === 409 && err.code === 'EXPORT_IN_PROGRESS') {
          setErrorMessage('Ekspor lain untuk workspace ini masih berjalan. Harap tunggu hingga proses selesai.');
        } else if (err.status === 403 && err.code === 'INVALID_PASSWORD') {
          setErrorMessage('Kata sandi yang Anda masukkan salah. Harap periksa kembali.');
          passwordInputRef.current?.focus();
        } else if (err.status === 403) {
          setIsForbiddenRole(true);
          setErrorMessage('Anda tidak berwenang mengekspor data workspace.');
        } else if (err.status === 429) {
          const waitSec = err.retryAfterSec;
          setRateLimitWait(waitSec ?? null);
          setErrorMessage(
            waitSec
              ? `Terlalu banyak permintaan atau batas ekspor per jam tercapai. Coba lagi dalam ${waitSec} detik.`
              : 'Terlalu banyak permintaan atau batas ekspor per jam tercapai. Silakan coba kembali nanti.'
          );
        } else if (err.status === 503) {
          setErrorMessage(err.message || 'Layanan sedang sibuk. Silakan coba beberapa saat lagi.');
        } else {
          setErrorMessage(err.message || `Terjadi galat ekspor (${err.code}).`);
        }
      } else {
        setErrorMessage((err as Error)?.message || 'Koneksi jaringan terputus saat mengunduh data.');
      }
    } finally {
      // Kata sandi HARUS selalu dikosongkan di blok finally
      setPassword('');
      abortControllerRef.current = null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-drawer-title"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={() => {
          if (!isExporting) onClose();
        }}
      />

      {/* Drawer Panel */}
      <div
        ref={drawerRef}
        className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <Download className="w-4 h-4" />
            </div>
            <div>
              <h2 id="export-drawer-title" className="font-bold text-slate-900 text-sm">
                Ekspor Data Workspace
              </h2>
              <p className="text-xs text-slate-500">Unduh salinan data resmi sesuai kebijakan retensi</p>
            </div>
          </div>
          <button
            onClick={() => {
              if (isExporting) handleCancelExport();
              onClose();
            }}
            disabled={isExporting}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
            aria-label="Tutup panel ekspor"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col justify-between overflow-hidden">
          <div className="p-6 space-y-5 overflow-y-auto flex-1">
            {/* Operator Disabled Banner */}
            {policy && !policy.enabled && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800 leading-relaxed">
                  <span className="font-semibold block mb-0.5">Ekspor Dinonaktifkan Sementara</span>
                  Fitur ekspor data sedang dinonaktifkan oleh operator sistem. Anda tidak dapat memulai unduhan baru saat ini.
                </div>
              </div>
            )}

            {/* Policy Loading / Error State */}
            {isLoadingPolicy && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center gap-2.5 text-xs text-slate-600">
                <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                <span>Memuat batas kebijakan ekspor workspace...</span>
              </div>
            )}
            {isPolicyError && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start justify-between gap-3 text-xs text-rose-800">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>Gagal memuat batas kebijakan ekspor.</span>
                </div>
                <button
                  type="button"
                  onClick={() => refetchPolicy()}
                  className="font-bold underline text-rose-900"
                >
                  Coba lagi
                </button>
              </div>
            )}

            {/* Error Message Box with request_id */}
            {errorMessage && (
              <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 animate-in fade-in">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="text-xs text-red-800 leading-relaxed flex-1">
                  <span className="font-semibold block mb-0.5">Galat Ekspor</span>
                  {errorMessage}

                  {/* Countdown indicator for 429 */}
                  {rateLimitWait !== null && rateLimitWait > 0 && (
                    <div className="mt-1 font-semibold text-red-900">
                      Tunggu {rateLimitWait} detik sebelum mencoba kembali.
                    </div>
                  )}

                  {/* request_id with copy button */}
                  {errorRequestId && (
                    <div className="mt-2 text-[11px] text-red-700 bg-red-100/60 px-2 py-1 rounded-md flex items-center justify-between font-mono">
                      <span>Kode laporan: {errorRequestId}</span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(errorRequestId);
                          showToast('success', 'Kode laporan berhasil disalin');
                        }}
                        className="inline-flex items-center gap-1 text-red-800 hover:text-red-950 font-sans font-bold underline"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Salin</span>
                      </button>
                    </div>
                  )}

                  {tooLargeDetails && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handlePreset('month')}
                        className="px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg text-xs font-medium transition-colors"
                      >
                        Gunakan Bulan Ini
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePreset('7days')}
                        className="px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg text-xs font-medium transition-colors"
                      >
                        Persempit ke 7 Hari
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Selector Jenis Data */}
            <div>
              <label htmlFor="export-data-type" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Jenis Data yang Diekspor
              </label>
              {lockType ? (
                <div id="export-data-type" className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-xs font-bold text-slate-800">{currentConfig.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{currentConfig.description}</div>
                </div>
              ) : (
                <select
                  id="export-data-type"
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value as ExportType);
                    setErrorMessage(null);
                    setErrorRequestId(null);
                    setTooLargeDetails(null);
                  }}
                  disabled={isExporting}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {Object.entries(TYPE_CONFIG).map(([key, item]) => (
                    <option key={key} value={key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Format Selection */}
            <div>
              <label htmlFor="export-format-csv" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Format Berkas
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  id="export-format-csv"
                  type="button"
                  onClick={() => setFormat('csv')}
                  disabled={isExporting}
                  className={`p-3 rounded-xl border text-left transition-all flex items-start gap-2.5 ${
                    format === 'csv'
                      ? 'border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <FileSpreadsheet
                    className={`w-4 h-4 mt-0.5 shrink-0 ${format === 'csv' ? 'text-emerald-600' : 'text-slate-400'}`}
                  />
                  <div>
                    <div className="text-xs font-bold text-slate-800">CSV Spreadsheet</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">Untuk Excel / Google Sheets</div>
                  </div>
                </button>

                <button
                  id="export-format-ndjson"
                  type="button"
                  onClick={() => setFormat('ndjson')}
                  disabled={isExporting}
                  className={`p-3 rounded-xl border text-left transition-all flex items-start gap-2.5 ${
                    format === 'ndjson'
                      ? 'border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <FileCode
                    className={`w-4 h-4 mt-0.5 shrink-0 ${format === 'ndjson' ? 'text-emerald-600' : 'text-slate-400'}`}
                  />
                  <div>
                    <div className="text-xs font-bold text-slate-800">NDJSON</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">JSON baris demi baris integrasi</div>
                  </div>
                </button>
              </div>

              {format === 'csv' && (
                <p className="text-[11px] text-slate-500 mt-2 bg-slate-50 p-2.5 rounded-lg border border-slate-100 flex items-start gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Anti-Formula Injection:</strong> Karakter berawalan =, +, -, @ diawali tanda kutip tunggal
                    (') agar aman dibuka di Excel.
                  </span>
                </p>
              )}
            </div>

            {/* Rentang Tanggal (Wajib untuk messages, outbound, audit-logs) */}
            {currentConfig.needsRange && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="export-start-date" className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-500" />
                    Rentang Waktu {policy ? `(Maksimal ${policy.max_span_days} Hari)` : ''}
                  </label>
                  <span className="text-[11px] text-slate-500">
                    {currentRangeResult && currentRangeResult.ok ? `${currentRangeResult.spanDays} hari dipilih` : ''}
                  </span>
                </div>

                {/* Preset Buttons */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handlePreset('30days')}
                    disabled={isExporting}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                  >
                    30 Hari Terakhir
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreset('month')}
                    disabled={isExporting}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                  >
                    Bulan Ini
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreset('lastMonth')}
                    disabled={isExporting}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                  >
                    Bulan Lalu
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreset('7days')}
                    disabled={isExporting}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                  >
                    7 Hari
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <label htmlFor="export-start-date" className="block text-[11px] text-slate-500 mb-1">
                      Dari Tanggal (Inklusif)
                    </label>
                    <input
                      id="export-start-date"
                      type="date"
                      value={startDateStr}
                      onChange={(e) => setStartDateStr(e.target.value)}
                      disabled={isExporting}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="export-end-date" className="block text-[11px] text-slate-500 mb-1">
                      Sampai Tanggal (Inklusif)
                    </label>
                    <input
                      id="export-end-date"
                      type="date"
                      value={endDateStr}
                      onChange={(e) => setEndDateStr(e.target.value)}
                      disabled={isExporting}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                {isDateRangeInvalid && currentRangeResult && (
                  <p className="text-xs text-red-600 font-medium pt-1">
                    {currentRangeResult.reason === 'kosong'
                      ? 'Tanggal mulai dan akhir wajib diisi.'
                      : currentRangeResult.reason === 'urutan'
                      ? 'Tanggal mulai harus sebelum tanggal akhir.'
                      : currentRangeResult.reason === 'terlalu-panjang'
                      ? `Rentang melebihi batas maksimal ${policy ? policy.max_span_days : ''} hari.`
                      : 'Format tanggal tidak valid.'}
                  </p>
                )}
              </div>
            )}

            {/* Filter Sesi WhatsApp (messages, outbound, chats) */}
            {currentConfig.supportsSession && (
              <div>
                <label htmlFor="export-session-id" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Sesi WhatsApp (Opsional)
                </label>
                <select
                  id="export-session-id"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  disabled={isExporting}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">Semua Sesi WhatsApp</option>
                  {(sessions || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.session_name || s.phone_number || s.id} ({s.status})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Filter Arah Pesan (hanya messages) */}
            {currentConfig.supportsDirection && (
              <div>
                <label htmlFor="export-direction" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Arah Pesan
                </label>
                <select
                  id="export-direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT' | '')}
                  disabled={isExporting}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">Semua Arah (Masuk & Keluar)</option>
                  <option value="IN">Hanya Pesan Masuk (IN)</option>
                  <option value="OUT">Hanya Pesan Keluar (OUT)</option>
                </select>
              </div>
            )}

            {/* Filter Status Outbox (hanya outbound) */}
            {currentConfig.supportsStatus && (
              <div>
                <label htmlFor="export-status" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Status Pengiriman Antrean
                </label>
                <select
                  id="export-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={isExporting}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {QUEUE_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Password Confirmation */}
            <div className="pt-2 border-t border-slate-100">
              <label htmlFor="export-password" className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-slate-500" />
                  Kata Sandi Akun (Konfirmasi Keamanan)
                </span>
                <span className="text-[11px] text-red-500 font-normal">*Wajib</span>
              </label>
              <div className="relative">
                <input
                  id="export-password"
                  ref={passwordInputRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage?.includes('Kata sandi')) setErrorMessage(null);
                  }}
                  disabled={isExporting}
                  placeholder="Masukkan kata sandi akun login Anda"
                  className="w-full pr-10 pl-3 py-2 border border-slate-300 rounded-xl text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
                  aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Sebagai perlindungan privasi data pelanggan, verifikasi kata sandi akun diperlukan. Batas: 5 kesalahan
                per 15 menit.
              </p>
            </div>

            {/* Streaming Active Indicator */}
            {isExporting && (
              <div
                className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between gap-3 animate-in fade-in"
                aria-live="polite"
              >
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-emerald-600 animate-spin shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-emerald-900">{statusMessage}</div>
                    <div className="text-[11px] text-emerald-700 mt-0.5">
                      Ukuran terunduh: <strong>{formatBytes(downloadedBytes)}</strong>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelExport}
                  className="px-3 py-1.5 bg-white hover:bg-red-50 text-red-600 border border-red-200 rounded-lg text-xs font-semibold shadow-xs transition-colors"
                >
                  Batal
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-500">
              Jatah: <strong>{policy ? `${policy.per_hour}x` : '—'}</strong> ekspor / jam
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isExporting) handleCancelExport();
                  onClose();
                }}
                disabled={isExporting}
                className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
              >
                Tutup
              </button>
              <button
                type="submit"
                disabled={
                  isExporting ||
                  !policy ||
                  !policy.enabled ||
                  isDateRangeInvalid ||
                  !password ||
                  isForbiddenRole
                }
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:pointer-events-none"
              >
                {isExporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Mengunduh...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Mulai Ekspor Data</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
export default ExportDrawer;
