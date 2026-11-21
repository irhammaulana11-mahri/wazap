import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  platformApi,
  PlatformWorkspaceSummary,
} from '../../services/platformApi';
import {
  Building2,
  Search,
  Filter,
  ArrowRight,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';

export const PlatformWorkspacesPage: React.FC = () => {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-workspaces', { q, status, page, pageSize }],
    queryFn: () =>
      platformApi.listWorkspaces({
        q: q.trim() || undefined,
        status: status === 'ALL' ? 'ALL' : status,
        page,
        page_size: pageSize,
      }),
  });

  const items: PlatformWorkspaceSummary[] = data?.items || [];
  const total = data?.meta?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <Building2 className="w-6 h-6 text-purple-400" />
            <span>Manajemen Workspace Pelanggan</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Pantau seluruh tenant, alokasi batas kuota, dan status operasional sistem.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold transition self-start sm:self-auto disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-purple-400' : ''}`} />
          <span>Segarkan</span>
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Cari berdasarkan nama workspace, slug, atau email owner..."
            className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-400">
            <Filter className="w-3.5 h-3.5 text-slate-500" />
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as any);
                setPage(1);
              }}
              className="bg-transparent text-xs text-white focus:outline-none cursor-pointer"
            >
              <option value="ALL">Semua Status</option>
              <option value="ACTIVE">Aktif (ACTIVE)</option>
              <option value="SUSPENDED">Ditangguhkan (SUSPENDED)</option>
              <option value="DELETED">Dihapus (DELETED)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table Container */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-purple-400 mb-2" />
            <span>Memuat data workspace...</span>
          </div>
        ) : isError ? (
          <div className="p-8 text-center text-rose-400 text-xs flex items-center justify-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>{(error as Error)?.message || 'Gagal memuat daftar workspace.'}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-xs">
            Tidak ada workspace yang sesuai dengan kriteria pencarian.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950 text-slate-400 font-semibold border-b border-slate-800 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Workspace</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Owner</th>
                  <th className="py-3 px-4 text-center">Sesi WA</th>
                  <th className="py-3 px-4 text-center">Kunci API</th>
                  <th className="py-3 px-4 text-center">Anggota</th>
                  <th className="py-3 px-4 text-center">Rate Limit</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {items.map((ws) => (
                  <tr key={ws.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3.5 px-4 font-sans">
                      <div className="font-bold text-white text-xs">{ws.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">{ws.slug}</div>
                    </td>
                    <td className="py-3.5 px-4 font-sans">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                          ws.status === 'ACTIVE'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : ws.status === 'SUSPENDED'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800'
                            : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}
                      >
                        {ws.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-sans text-slate-300 text-xs">
                      {ws.owners && ws.owners.length > 0 ? (
                        <span>{ws.owners[0]}</span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center text-xs">
                      <span className="text-purple-400 font-bold">{ws.used?.sessions ?? 0}</span>
                      <span className="text-slate-600"> / {ws.limits?.max_sessions ?? '—'}</span>
                    </td>
                    <td className="py-3.5 px-4 text-center text-xs">
                      <span className="text-purple-400 font-bold">{ws.used?.api_keys ?? 0}</span>
                      <span className="text-slate-600"> / {ws.limits?.max_api_keys ?? '—'}</span>
                    </td>
                    <td className="py-3.5 px-4 text-center text-xs">
                      <span className="text-purple-400 font-bold">{ws.used?.members ?? 0}</span>
                      <span className="text-slate-600"> / {ws.limits?.max_members ?? '—'}</span>
                    </td>
                    <td className="py-3.5 px-4 text-center text-xs text-slate-400">
                      {ws.limits?.messages_per_minute ?? '—'} msg/m
                    </td>
                    <td className="py-3.5 px-4 text-right font-sans">
                      <Link
                        to={`/platform/workspaces/${ws.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40 rounded-lg text-xs font-semibold transition"
                      >
                        <span>Kelola</span>
                        <ArrowRight className="w-3 h-3" />
                      </Link>
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
