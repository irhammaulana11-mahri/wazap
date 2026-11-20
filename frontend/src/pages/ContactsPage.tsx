import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { ContactItem } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  Users,
  Search,
  Phone,
  Calendar,
  Send,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';

export const ContactsPage: React.FC = () => {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

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
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Kontak WhatsApp</h1>
          <p className="text-sm text-slate-500">
            Daftar nomor kontak WhatsApp yang pernah berinteraksi atau tersinkronisasi dengan gateway.
          </p>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama atau nomor..."
            className="pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none w-64 shadow-sm"
          />
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
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3.5">Nama Kontak</th>
                <th className="px-6 py-3.5">Nomor Telepon</th>
                <th className="px-6 py-3.5">Pesan Terakhir</th>
                <th className="px-6 py-3.5 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c, idx) => (
                <tr key={idx} className="hover:bg-slate-50/70 transition">
                  <td className="px-6 py-4 font-medium text-slate-900 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs shrink-0">
                      {(c.name || c.phone || 'WA').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <span className="font-semibold block">{c.name || 'Kontak WhatsApp'}</span>
                      <span className="text-[10px] text-slate-400">{c.chats ? `${c.chats} sesi chat` : ''}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-700 font-mono">
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      +{c.phone}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-500">
                    {c.last_message_at ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        {new Date(c.last_message_at).toLocaleDateString('id-ID')}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      to="/messages"
                      className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg text-xs font-semibold transition"
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
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 text-xs text-slate-500">
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
                <span>kontak per halaman</span>
                <span className="text-slate-300 mx-1">•</span>
                <span>
                  Halaman {meta.page || 1} dari {totalPages} ({meta.total ?? contacts.length} total)
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
    </div>
  );
};