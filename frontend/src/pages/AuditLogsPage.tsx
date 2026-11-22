import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { AuditLogItem } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  ShieldAlert,
  ShieldCheck,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Globe,
  Lock,
  Download,
} from 'lucide-react';
import { ExportDrawer } from '../components/export/ExportDrawer';

export const AuditLogsPage: React.FC = () => {
  const { role } = useAuth();
  const isAuthorized = role === 'OWNER';

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [actionFilter, setActionFilter] = useState('');
  const [isExportDrawerOpen, setIsExportDrawerOpen] = useState(false);

  const {
    data: auditResult,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['audit-logs', { page, pageSize, actionFilter }],
    queryFn: () =>
      api.getAuditLogs({
        page,
        page_size: pageSize,
        action: actionFilter || undefined,
      }),
    enabled: isAuthorized,
  });

  const logs = auditResult?.data || [];
  const meta = auditResult?.meta;
  const totalPages = meta?.total && meta?.page_size ? Math.ceil(meta.total / meta.page_size) : 1;

  if (!isAuthorized) {
    return (
      <div className="p-12 text-center bg-white rounded-xl border border-slate-200 max-w-lg mx-auto mt-12 space-y-3">
        <Lock className="w-12 h-12 text-amber-500 mx-auto" />
        <h2 className="text-lg font-bold text-slate-800">Akses Dibatasi</h2>
        <p className="text-xs text-slate-500 leading-relaxed">
          Halaman Log Audit hanya dapat diakses oleh peran <strong>OWNER</strong> workspace untuk kebutuhan kepatuhan dan keamanan data.
        </p>
      </div>
    );
  }

  if (isError) {
    return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Audit Log Workspace</h1>
          <p className="text-sm text-slate-500">
            Catatan jejak aktivitas administratif penting, modifikasi kuota, dan mutasi anggota tim.
          </p>
        </div>

        {/* Filter Action & Export */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-400" />
            <select
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700 focus:outline-none"
            >
              <option value="">Semua Aksi</option>
              <option value="api_key.created">API key dibuat</option>
              <option value="api_key.revoked">API key dicabut</option>
              <option value="api_key.updated">API key diubah</option>
              <option value="invitation.created">Undangan Dikirim</option>
              <option value="invitation.accepted">Anggota Bergabung</option>
              <option value="invitation.revoked">Undangan Dibatalkan</option>
              <option value="member.role_changed">Perubahan Peran</option>
              <option value="member.removed">Anggota Dikeluarkan</option>
              <option value="tenant.quota_changed">Kuota Diubah Platform</option>
              <option value="tenant.suspended">Workspace Ditangguhkan</option>
              <option value="tenant.reactivated">Workspace Diaktifkan</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => setIsExportDrawerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold transition shadow-xs"
            title="Ekspor seluruh rekaman log audit"
          >
            <Download className="w-3.5 h-3.5 text-slate-500" />
            <span>Ekspor Log Audit</span>
          </button>
        </div>
      </div>

      {isLoading ? (
        <LoadingState message="Memuat log audit..." />
      ) : logs.length === 0 ? (
        <EmptyState
          title="Belum ada catatan aktivitas"
          description="Aktivitas administratif akan tercatat di sini secara otomatis."
          icon={<ShieldCheck className="w-8 h-8" />}
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3.5">Waktu</th>
                <th className="px-6 py-3.5">Pelaku (Actor)</th>
                <th className="px-6 py-3.5">Aksi (Action)</th>
                <th className="px-6 py-3.5">Target / Detail</th>
                <th className="px-6 py-3.5">Alamat IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {logs.map((log) => {
                const isPlatformActor = log.actor?.email === 'platform';
                const actorDisplay = isPlatformActor
                  ? 'Pemilik platform'
                  : log.actor?.email || log.actor?.user_id;

                let actionLabel: string = log.action;
                if (log.action === 'api_key.created') {
                  actionLabel = 'API key dibuat';
                } else if (log.action === 'api_key.revoked') {
                  actionLabel = 'API key dicabut';
                } else if (log.action === 'api_key.updated') {
                  actionLabel = 'API key diubah';
                } else if (log.action === 'invitation.created') {
                  actionLabel = 'Undangan dikirim';
                } else if (log.action === 'invitation.accepted') {
                  actionLabel = 'Anggota bergabung';
                } else if (log.action === 'invitation.revoked') {
                  actionLabel = 'Undangan dibatalkan';
                } else if (log.action === 'member.role_changed') {
                  actionLabel = 'Peran anggota diubah';
                } else if (log.action === 'member.removed') {
                  actionLabel = 'Anggota dikeluarkan';
                } else if (log.action === 'tenant.quota_changed') {
                  actionLabel = 'Kuota diubah oleh pemilik platform';
                } else if (log.action === 'tenant.suspended') {
                  actionLabel = 'Workspace ditangguhkan';
                } else if (log.action === 'tenant.reactivated') {
                  actionLabel = 'Workspace diaktifkan kembali';
                }

                return (
                  <tr key={log.id} className="hover:bg-slate-50/70 transition">
                    <td className="px-6 py-3.5 text-slate-500 whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString('id-ID')}
                    </td>
                    <td className="px-6 py-3.5 font-sans font-medium text-slate-900">
                      <div>
                        <span className={isPlatformActor ? 'font-bold text-emerald-800' : ''}>
                          {actorDisplay}
                        </span>
                        {!isPlatformActor && log.actor?.role && (
                          <span className="text-[10px] text-slate-400 block font-mono">
                            [{log.actor.role}]
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3.5">
                      <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-[11px] font-semibold">
                        {actionLabel}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 font-sans text-slate-600">
                      <div className="text-xs">
                        {log.target?.type && (
                          <span className="font-semibold text-slate-800">
                            {log.target.type}:
                          </span>
                        )}{' '}
                        {log.target?.id && (
                          <span className="font-mono text-slate-500 text-[11px]">
                            {log.target.id.slice(0, 12)}
                          </span>
                        )}
                        {log.details?.name && (
                          <p className="text-[11px] text-slate-700 mt-0.5">
                            <span className="font-semibold">Nama:</span> <span className="font-mono">{String(log.details.name)}</span>
                          </p>
                        )}
                        {log.details?.changes ? (
                          <div className="space-y-0.5 mt-1">
                            {Object.entries(log.details.changes).map(([k, v]: [string, any]) => (
                              <div key={k} className="text-[11px] text-slate-600 font-mono">
                                <span className="font-semibold text-slate-800">{k}:</span>{' '}
                                <span className="text-slate-400">
                                  {JSON.stringify(v?.from ?? v?.before ?? '-')}
                                </span>
                                {' -> '}
                                <span className="text-emerald-700 font-bold">
                                  {JSON.stringify(v?.to ?? v?.after ?? '-')}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : log.details?.reason ? (
                          <p className="text-[11px] text-slate-600 mt-0.5">
                            <span className="font-semibold">Alasan:</span> {log.details.reason}
                          </p>
                        ) : log.details && (
                          <p className="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">
                            {JSON.stringify(log.details)}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3.5 text-slate-400 text-[11px] whitespace-nowrap">
                      {log.ip || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {meta && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 text-xs text-slate-500 font-sans">
              <div className="flex items-center gap-2">
                <span>Tampilkan:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span>per halaman</span>
                <span className="text-slate-300 mx-1">•</span>
                <span>
                  Halaman {meta.page || 1} dari {totalPages} ({meta.total_capped ? `${meta.total}+` : meta.total} catatan)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-2.5 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Sebelumnya</span>
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages}
                  className="px-2.5 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1 font-medium"
                >
                  <span>Selanjutnya</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Export Drawer */}
      <ExportDrawer
        isOpen={isExportDrawerOpen}
        onClose={() => setIsExportDrawerOpen(false)}
        initialType="audit-logs"
        lockType={true}
      />
    </div>
  );
};