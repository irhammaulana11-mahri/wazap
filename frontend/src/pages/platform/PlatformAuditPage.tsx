import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { platformApi, PlatformAuditItem } from '../../services/platformApi';
import {
  ShieldAlert,
  Search,
  Filter,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  ArrowRight,
} from 'lucide-react';

export const PlatformAuditPage: React.FC = () => {
  const [tenantId, setTenantId] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-audit', { tenantId, action, page, pageSize }],
    queryFn: () =>
      platformApi.listAudit({
        tenant_id: tenantId.trim() || undefined,
        action: action.trim() || undefined,
        page,
        page_size: pageSize,
      }),
  });

  const items: PlatformAuditItem[] = data?.items || [];
  const total = data?.meta?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const formatChanges = (changes: any) => {
    if (!changes || typeof changes !== 'object') return null;
    return (
      <div className="flex flex-wrap gap-2 mt-1">
        {Object.entries(changes).map(([k, v]: [string, any]) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-950 border border-slate-800 text-[10px] font-mono text-purple-300"
          >
            <strong>{k}:</strong>
            <span className="text-slate-400">{v?.from ?? '—'}</span>
            <ArrowRight className="w-2.5 h-2.5 text-slate-500" />
            <span className="text-emerald-400 font-bold">{v?.to ?? '—'}</span>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <ShieldAlert className="w-6 h-6 text-purple-400" />
            <span>Jejak Audit Konsol Platform</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Rekaman aktivitas tindakan administratif, perubahan kuota, penangguhan, dan autentikasi operator.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-purple-400' : ''}`} />
          <span>Segarkan</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={tenantId}
            onChange={(e) => {
              setTenantId(e.target.value);
              setPage(1);
            }}
            placeholder="Filter berdasarkan Tenant ID (UUID)..."
            className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-purple-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-400">
            <Filter className="w-3.5 h-3.5 text-slate-500" />
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              className="bg-transparent text-xs text-white focus:outline-none cursor-pointer"
            >
              <option value="">Semua Aksi</option>
              <option value="tenant.quota_changed">tenant.quota_changed</option>
              <option value="tenant.suspended">tenant.suspended</option>
              <option value="tenant.reactivated">tenant.reactivated</option>
              <option value="platform.defaults_changed">platform.defaults_changed</option>
              <option value="platform_admin.login">platform_admin.login</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-purple-400 mb-2" />
            <span>Memuat rekaman log audit...</span>
          </div>
        ) : isError ? (
          <div className="p-8 text-center text-rose-400 text-xs flex items-center justify-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>{(error as Error)?.message || 'Gagal memuat jejak audit.'}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-xs">
            Tidak ada rekaman log audit yang cocok dengan filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950 text-slate-400 font-semibold border-b border-slate-800 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Admin Operator</th>
                  <th className="py-3 px-4">Aksi</th>
                  <th className="py-3 px-4">Workspace (Tenant ID)</th>
                  <th className="py-3 px-4">Rincian Perubahan & Alasan</th>
                  <th className="py-3 px-4">Request IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {items.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3.5 px-4 text-[11px] text-slate-400 whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString('id-ID')}
                    </td>
                    <td className="py-3.5 px-4 font-sans font-medium text-white text-xs">
                      {log.admin_email}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-950 text-purple-300 border border-purple-800">
                        {log.action}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-[11px] text-slate-400">
                      {log.tenant_id ? (
                        <span className="text-slate-300">{log.tenant_id.slice(0, 8)}...</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-sans max-w-sm">
                      {log.reason && (
                        <div className="text-[11px] text-slate-300 font-semibold mb-1">
                          &ldquo;{log.reason}&rdquo;
                        </div>
                      )}
                      {log.details?.changes && formatChanges(log.details.changes)}
                    </td>
                    <td className="py-3.5 px-4 text-[11px] text-slate-500 whitespace-nowrap">
                      {log.ip || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>
            Halaman <strong className="text-white">{page}</strong> dari <strong className="text-white">{totalPages}</strong>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1.5 border border-slate-800 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 border border-slate-800 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
