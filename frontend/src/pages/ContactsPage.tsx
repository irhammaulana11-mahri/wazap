import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { ContactItem } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { ExportDrawer } from '../components/export/ExportDrawer';
import {
  Users,
  Search,
  Phone,
  Calendar,
  Send,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  Download,
} from 'lucide-react';
import { Link } from 'react-router-dom';

export const ContactsPage: React.FC = () => {
  const { role } = useAuth();
  const canExport = role === 'OWNER';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [isExportDrawerOpen, setIsExportDrawerOpen] = useState(false);

  const {
    data: contactsResult,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['contacts', { page, pageSize }],
    queryFn: () => api.getContacts(page, pageSize),
  });

  const contacts = contactsResult?.data || [];
  const meta = contactsResult?.meta;
  const totalPages = meta?.total && meta?.page_size ? Math.ceil(meta.total / meta.page_size) : 1;

  const filtered = contacts.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q))
    );
  });

  if (isError) {
    return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Kontak WhatsApp</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Daftar nomor kontak WhatsApp yang pernah berinteraksi atau tersinkronisasi dengan gateway.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama atau nomor..."
              className="pl-9 pr-4 py-2 border border-slate-300 dark:border-slate-800 rounded-lg text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-emerald-500 focus:outline-none w-64 shadow-xs"
            />
          </div>

          {canExport && (
            <button
              type="button"
              onClick={() => setIsExportDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-sm font-semibold transition shadow-xs cursor-pointer"
              title="Ekspor seluruh daftar kontak pelanggan"
            >
              <Download className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              <span>Ekspor Kontak</span>
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <LoadingState message="Memuat daftar kontak..." />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Tidak ada kontak ditemukan"
          description="Belum ada nomor kontak yang cocok dengan kueri pencarian Anda."
          icon={<Users className="w-8 h-8" />}
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3.5">Nama Kontak</th>
                <th className="px-6 py-3.5">Nomor Telepon</th>
                <th className="px-6 py-3.5">Pesan Terakhir</th>
                <th className="px-6 py-3.5 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((c, idx) => (
                <tr key={idx} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/50 transition">
                  <td className="px-6 py-4 font-medium text-slate-900 dark:text-white flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80 flex items-center justify-center font-bold text-xs shrink-0">
                      {(c.name || c.phone || 'WA').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <span className="font-semibold block">{c.name || 'Kontak WhatsApp'}</span>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">{c.chats ? `${c.chats} sesi chat` : ''}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-700 dark:text-slate-300 font-mono">
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                      +{c.phone}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-500 dark:text-slate-400">
                    {c.last_message_at ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                        {new Date(c.last_message_at).toLocaleDateString('id-ID')}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      to="/messages"
                      className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/80 border border-emerald-200 dark:border-emerald-800/80 rounded-lg text-xs font-semibold transition"
                    >
                      <Send className="w-3 h-3" />
                      Kirim Pesan
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {meta && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <span>Tampilkan:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span>kontak per halaman</span>
                <span className="text-slate-300 dark:text-slate-600 mx-1">•</span>
                <span>
                  Halaman {meta.page || 1} dari {totalPages} ({meta.total ?? contacts.length} total)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-2.5 py-1 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-40 transition flex items-center gap-1 font-medium cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Sebelumnya</span>
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages}
                  className="px-2.5 py-1 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-40 transition flex items-center gap-1 font-medium cursor-pointer"
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
        initialType="contacts"
        lockType={true}
      />
    </div>
  );
};