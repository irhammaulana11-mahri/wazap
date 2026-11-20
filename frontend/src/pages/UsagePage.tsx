import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import {
  BarChart3,
  Smartphone,
  Key,
  Users,
  Activity,
  Send,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from 'lucide-react';

export const UsagePage: React.FC = () => {
  const [groupBy, setGroupBy] = useState<'day' | 'hour'>('day');

  // Summary query
  const {
    data: summary,
    isLoading: loadingSummary,
    error: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: ['usage-summary'],
    queryFn: () => api.getUsageSummary(),
    refetchInterval: 10000,
  });

  // Time-series messages query
  const {
    data: messageBuckets = [],
    isLoading: loadingBuckets,
    refetch: refetchBuckets,
  } = useQuery({
    queryKey: ['usage-messages', groupBy],
    queryFn: () => api.getUsageMessages(undefined, undefined, groupBy, 'Asia/Jakarta'),
    refetchInterval: 10000,
  });

  // Per-session usage query
  const {
    data: sessionStats = [],
    isLoading: loadingSessionStats,
    refetch: refetchSessionStats,
  } = useQuery({
    queryKey: ['usage-sessions'],
    queryFn: () => api.getUsageSessions(),
    refetchInterval: 10000,
  });

  if (loadingSummary && loadingBuckets) {
    return <LoadingState message="Memuat analitik penggunaan..." />;
  }

  if (summaryError) {
    return (
      <ErrorState
        message={(summaryError as Error).message}
        onRetry={() => {
          refetchSummary();
          refetchBuckets();
          refetchSessionStats();
        }}
      />
    );
  }

  const quotas = summary?.quotas;
  const messagesSummary = summary?.messages;

  // Max value in buckets for relative scaling in chart
  const maxBucketCount = Math.max(...messageBuckets.map((b) => b.total), 10);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Analitik & Penggunaan</h1>
        <p className="text-sm text-slate-500">
          Statistik kuota tenant, volume pesan WhatsApp, dan performa perangkat aktif.
        </p>
      </div>

      {/* Quota Progress Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Sesi */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Sesi WhatsApp</span>
            <Smartphone className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {quotas?.sessions?.used ?? 0}
            </span>
            <span className="text-xs text-slate-400">/ {quotas?.sessions?.max ?? 0} kuota</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all"
              style={{
                width: `${Math.min(
                  100,
                  ((quotas?.sessions?.used ?? 0) / Math.max(1, quotas?.sessions?.max ?? 1)) * 100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* API Keys */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">API Keys</span>
            <Key className="w-4 h-4 text-blue-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {quotas?.api_keys?.used ?? 0}
            </span>
            <span className="text-xs text-slate-400">/ {quotas?.api_keys?.max ?? 0} kuota</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all"
              style={{
                width: `${Math.min(
                  100,
                  ((quotas?.api_keys?.used ?? 0) / Math.max(1, quotas?.api_keys?.max ?? 1)) * 100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* Members */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Anggota Tim</span>
            <Users className="w-4 h-4 text-purple-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {quotas?.members?.used ?? 0}
            </span>
            <span className="text-xs text-slate-400">/ {quotas?.members?.max ?? 0} kuota</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-purple-500 h-full rounded-full transition-all"
              style={{
                width: `${Math.min(
                  100,
                  ((quotas?.members?.used ?? 0) / Math.max(1, quotas?.members?.max ?? 1)) * 100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* Rate Limit */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Throughput Rate</span>
            <Activity className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {quotas?.messages_per_minute ?? 60}
            </span>
            <span className="text-xs text-slate-400">msg / menit</span>
          </div>
          <p className="text-[11px] text-slate-400">Batas kecepatan antrean keluar</p>
        </div>
      </div>

      {/* Messages Time Series Bar Chart */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-emerald-600" />
            <h2 className="font-semibold text-slate-900">Aktivitas Volume Pesan</h2>
            <span className="text-xs text-slate-400">(WIB / Asia/Jakarta)</span>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs">
            <button
              onClick={() => setGroupBy('day')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                groupBy === 'day'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Harian
            </button>
            <button
              onClick={() => setGroupBy('hour')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                groupBy === 'hour'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Per Jam
            </button>
          </div>
        </div>

        {messageBuckets.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-xs border border-dashed rounded-lg">
            Belum ada data rekaman pesan dalam rentang waktu ini.
          </div>
        ) : (
          <div className="space-y-4 pt-4">
            <div className="flex items-end gap-2 h-44 border-b border-slate-200 pb-2 overflow-x-auto">
              {messageBuckets.map((bucket, idx) => {
                const heightPercent = Math.max(8, (bucket.total / maxBucketCount) * 100);
                const label = new Date(bucket.bucket).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                  ...(groupBy === 'hour' ? { hour: '2-digit' } : {}),
                });

                return (
                  <div
                    key={idx}
                    className="flex-1 min-w-[36px] flex flex-col items-center gap-1 group relative"
                  >
                    {/* Tooltip on hover */}
                    <div className="absolute -top-10 opacity-0 group-hover:opacity-100 bg-slate-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap pointer-events-none transition z-10 shadow-lg">
                      {label}: {bucket.total} pesan ({bucket.sent} terkirim, {bucket.failed} gagal)
                    </div>

                    <div
                      className="w-full bg-emerald-500 hover:bg-emerald-600 rounded-t transition-all"
                      style={{ height: `${heightPercent}%` }}
                    />
                    <span className="text-[10px] text-slate-400 truncate max-w-full font-mono">
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
              <span>Total Pesan: {messagesSummary ? messagesSummary.total : 0}</span>
              <span>
                Terkirim: {messagesSummary ? messagesSummary.sent : 0} | Gagal:{' '}
                {messagesSummary ? messagesSummary.failed : 0}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Per-Session Usage Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Performa Perangkat Sesi</h2>
        </div>

        {sessionStats.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs">
            Belum ada data sesi untuk dianalisis.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3">Sesi / Nama</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Pesan Keluar</th>
                  <th className="px-6 py-3">Pesan Masuk</th>
                  <th className="px-6 py-3">Pesan Gagal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sessionStats.map((stat) => (
                  <tr key={stat.session_id} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-3.5 font-medium text-slate-900">
                      {stat.session_name || stat.session_id.slice(0, 8)}
                    </td>
                    <td className="px-6 py-3.5 font-semibold text-slate-800">
                      {stat.status}
                    </td>
                    <td className="px-6 py-3.5 text-emerald-600 font-medium">
                      {stat.outgoing.toLocaleString()}
                    </td>
                    <td className="px-6 py-3.5 text-blue-600 font-medium">
                      {stat.incoming.toLocaleString()}
                    </td>
                    <td className="px-6 py-3.5 text-rose-500 font-medium">
                      {stat.failed.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};