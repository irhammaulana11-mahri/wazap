import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { platformApi, PlatformBackupStatusResult } from '../../services/platformApi';
import {
  Database,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  Cloud,
  FileCheck,
  Clock,
  ShieldCheck,
} from 'lucide-react';

export const PlatformBackupPage: React.FC = () => {
  const { data: backup, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-backup-status'],
    queryFn: () => platformApi.backupStatus(),
  });

  const formatBytes = (bytes?: number | null) => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2.5">
            <Database className="w-6 h-6 text-purple-600 dark:text-purple-400" />
            <span>Status Cadangan Basis Data (Backup Status)</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Status pemantauan berkala pencadangan database PostgreSQL & WAL archiving (ADR-052).
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold transition disabled:opacity-50 shadow-xs cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-purple-600 dark:text-purple-400' : ''}`} />
          <span>Segarkan</span>
        </button>
      </div>

      {isLoading ? (
        <div className="p-12 text-center text-slate-400 text-xs">
          <span>Memeriksa berkas status cadangan...</span>
        </div>
      ) : isError ? (
        <div className="p-8 text-center text-rose-500 text-xs flex items-center justify-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{(error as Error)?.message || 'Gagal mengambil status cadangan.'}</span>
        </div>
      ) : backup ? (
        <div className="space-y-6">
          {/* Status Alert Banner */}
          {!backup.configured ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-2xl text-xs flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
                    Belum Terpasang
                  </span>
                  <strong className="text-slate-900 dark:text-white">Status Cadangan Belum Dikonfigurasi</strong>
                </div>
                <p className="text-amber-700 dark:text-amber-400/90 leading-relaxed">
                  Variabel lingkungan PLATFORM_BACKUP_STATUS_FILE belum diatur pada server backend.
                </p>
              </div>
            </div>
          ) : !backup.available ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-2xl text-xs flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
                    Tidak Tersedia
                  </span>
                  <strong className="text-slate-900 dark:text-white">Berkas Status Tidak Tersedia</strong>
                </div>
                <p className="text-amber-700 dark:text-amber-400/90 leading-relaxed">
                  {backup.reason || 'Berkas status belum dibuat atau belum ada pencadangan yang berhasil.'}
                </p>
              </div>
            </div>
          ) : backup.stale ? (
            <div className="p-4 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 rounded-2xl text-xs flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-rose-100 dark:bg-rose-900/70 text-rose-800 dark:text-rose-300 border border-rose-300 dark:border-rose-700">
                    Kritis (Stale)
                  </span>
                  <strong className="text-slate-900 dark:text-white">Cadangan Kedaluwarsa</strong>
                </div>
                <p className="text-rose-700 dark:text-rose-400/90 leading-relaxed">
                  Cadangan terakhir berusia {backup.age_hours ?? '—'} jam, melampaui batas toleransi {backup.max_age_hours} jam. Segera periksa cron script di server host.
                </p>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 rounded-2xl text-xs flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-emerald-100 dark:bg-emerald-900/70 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700">
                    Status Sehat
                  </span>
                  <strong className="text-slate-900 dark:text-white">Pencadangan Berjalan Optimal</strong>
                </div>
                <p className="text-emerald-700 dark:text-emerald-400/90 leading-relaxed">
                  Berkas cadangan tersimpan dengan aman ({backup.age_hours ?? 0} jam yang lalu).
                </p>
              </div>
            </div>
          )}

          {/* Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {/* Last Success */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Cadangan Terakhir</span>
                <Clock className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <div className="text-lg font-bold text-slate-900 dark:text-white">
                  {backup.status?.last_success_at
                    ? new Date(backup.status.last_success_at).toLocaleString('id-ID')
                    : 'Belum pernah'}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">
                  {backup.age_hours !== null ? `${backup.age_hours} jam yang lalu` : '—'}
                </p>
              </div>
            </div>

            {/* Storage Location */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Lokasi Penyimpanan</span>
                {backup.status?.location === 'offsite' ? (
                  <Cloud className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                )}
              </div>
              <div>
                <div className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider font-mono">
                  {backup.status?.location ?? 'UNKNOWN'}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {backup.status?.location === 'offsite'
                    ? 'Tersimpan di cloud / remote storage terpisah'
                    : backup.status?.location === 'separate_disk'
                    ? 'Tersimpan di disk fisik terpisah'
                    : 'Tersimpan di partisi lokal server'}
                </p>
              </div>
            </div>

            {/* Last File & Size */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Ukuran Berkas</span>
                <FileCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
                  {formatBytes(backup.status?.last_size_bytes)}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate font-mono">
                  {backup.status?.last_file || '—'}
                </p>
              </div>
            </div>
          </div>

          {/* Read-Only Policy Notice */}
          <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-xs text-slate-600 dark:text-slate-400 space-y-2 shadow-xs">
            <div className="flex items-center gap-2 flex-wrap text-slate-900 dark:text-white font-bold">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-purple-100 dark:bg-purple-900/60 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                Kebijakan Keamanan
              </span>
              <span>ADR-054 Baca-Saja</span>
            </div>
            <p className="leading-relaxed">
              Konsol platform web hanya menyediakan status pengawasan baca-saja. Tombol eksekusi cadangan atau pemulihan (restore) sengaja ditiadakan dari dashboard untuk mencegah risiko pembajakan sesi web dan serangan ransomware. Seluruh operasi pemulihan basis data harus dilakukan langsung melalui shell server host berizin oleh operator infrastruktur.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
