import React from 'react';
import {
  History,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { AlertCatalogData, AlertDeliveryItem } from '../../types';

interface AlertDeliveriesSectionProps {
  catalog?: AlertCatalogData;
  deliveries: AlertDeliveryItem[];
  isLoading: boolean;
  onRefresh: () => void;
}

export const AlertDeliveriesSection: React.FC<AlertDeliveriesSectionProps> = ({
  catalog,
  deliveries,
  isLoading,
  onRefresh,
}) => {
  const ruleMap = new Map(catalog?.rules.map((r) => [r.code, r.label]) || []);

  const formatDateTime = (isoString?: string | null) => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d);
    } catch {
      return isoString;
    }
  };

  const getErrorExplanation = (errorCode?: string | null, statusCode?: number | null) => {
    if (!errorCode && !statusCode) return null;
    if (
      errorCode === 'HTTP_401' ||
      errorCode === 'HTTP_403' ||
      errorCode === 'HTTP_404' ||
      statusCode === 401 ||
      statusCode === 403 ||
      statusCode === 404
    ) {
      return 'Token bot dicabut atau obrolan tidak ditemukan.';
    }
    if (errorCode === 'RATE_CAPPED') {
      return 'Dibatasi: kuota pengiriman kanal per jam telah terlampaui.';
    }
    if (errorCode === 'CHANNEL_INACTIVE') {
      return 'Kanal dalam status dinonaktifkan saat kejadian terpicu.';
    }
    if (errorCode === 'TIMEOUT' || errorCode === 'DNS_FAILED' || errorCode === 'TLS_ERROR') {
      return 'Gangguan jaringan atau batas waktu respons terlampaui.';
    }
    return errorCode || `HTTP ${statusCode}`;
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xs p-6 sm:p-7 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              Riwayat Pengiriman Alarm
            </h2>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
              <History className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              <span>50 Terakhir</span>
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            Catatan 50 pesan notifikasi terakhir yang dikirim ke bot Telegram dan webhook Slack.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs sm:text-sm font-semibold rounded-xl border border-slate-200/60 dark:border-slate-700 transition shrink-0 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-emerald-600 dark:text-emerald-400' : ''}`} />
          <span>Muat Ulang</span>
        </button>
      </div>

      {/* Table Content */}
      {isLoading ? (
        <div className="py-12 text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-600 dark:text-emerald-400 mx-auto" />
          <p className="text-xs text-slate-500 dark:text-slate-400">Memuat log riwayat pengiriman notifikasi...</p>
        </div>
      ) : deliveries.length === 0 ? (
        <div className="py-12 px-4 text-center rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 space-y-2">
          <History className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto" />
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Belum Ada Pengiriman Alarm</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Riwayat akan terisi otomatis saat terdapat kejadian gateway yang memicu salah satu aturan notifikasi aktif Anda.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-2xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50/80 dark:bg-slate-950/60 text-slate-600 dark:text-slate-300 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="py-3 px-4">Waktu</th>
                <th className="py-3 px-4">Aturan Pemicu</th>
                <th className="py-3 px-4">Kanal Tujuan</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Percobaan</th>
                <th className="py-3 px-4">Keterangan / Galat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-200">
              {deliveries.map((item) => {
                const ruleLabel = ruleMap.get(item.rule_code) || item.rule_code;
                const errDetail = getErrorExplanation(item.last_error_code, item.last_status_code);

                return (
                  <tr key={item.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/50 transition">
                    <td className="py-3 px-4 whitespace-nowrap font-medium text-slate-600 dark:text-slate-400">
                      {formatDateTime(item.sent_at || item.created_at)}
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-bold text-slate-900 dark:text-white block">{ruleLabel}</span>
                      <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">{item.rule_code}</span>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap font-semibold">
                      {item.channel_name || <span className="text-slate-400 dark:text-slate-500 italic">Kanal dihapus</span>}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {item.status === 'SENT' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                          <span>Terkirim</span>
                        </span>
                      )}
                      {item.status === 'PENDING' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/80">
                          <Clock className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                          <span>Menunggu</span>
                        </span>
                      )}
                      {item.status === 'DEAD' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800/80">
                          <XCircle className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                          <span>Gagal Total</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap font-mono">
                      {item.attempts}x
                    </td>
                    <td className="py-3 px-4 max-w-xs">
                      {item.status === 'DEAD' ? (
                        <span className="text-rose-700 dark:text-rose-300 font-medium leading-relaxed block">
                          {errDetail}
                        </span>
                      ) : item.status === 'SENT' ? (
                        <span className="text-slate-400 dark:text-slate-500">—</span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">Dalam antrean pengiriman</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
