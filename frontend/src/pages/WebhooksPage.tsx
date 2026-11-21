import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { WebhookItem } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { useConfirm } from '../context/ConfirmContext';
import {
  Webhook,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
  Power,
  RotateCcw,
  ShieldAlert,
  Activity,
  X,
} from 'lucide-react';

const AVAILABLE_EVENTS = [
  { id: '*', label: 'Semua Event (*)' },
  { id: 'session.status', label: 'Status Sesi (session.status)' },
  { id: 'message.incoming', label: 'Pesan Masuk (message.incoming)' },
  { id: 'message.sent', label: 'Pesan Terkirim (message.sent)' },
  { id: 'message.delivered', label: 'Pesan Diterima (message.delivered)' },
  { id: 'message.read', label: 'Pesan Dibaca (message.read)' },
  { id: 'message.failed', label: 'Pesan Gagal (message.failed)' },
];

export const WebhooksPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();

  // Create form state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['*']);
  const [formError, setFormError] = useState('');

  // Reveal-once secret dialog state (NEVER persisted to storage)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Status feedback
  const [actionSuccess, setActionSuccess] = useState('');

  // Fetch Webhooks
  const {
    data: webhooks = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['webhooks'],
    queryFn: api.getWebhooks,
  });

  // Create Mutation
  const createMutation = useMutation({
    mutationFn: () =>
      api.createWebhook(
        url.trim(),
        selectedEvents,
        description.trim() || undefined
      ),
    onSuccess: (res) => {
      setUrl('');
      setDescription('');
      setSelectedEvents(['*']);
      setFormError('');
      setIsCreateModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });

      if (res.secret) {
        setRevealedSecret(res.secret);
      }
    },
    onError: (err: any) => {
      setFormError(err.message || 'Gagal mendaftarkan webhook');
    },
  });

  // Toggle Active Mutation
  const toggleMutation = useMutation({
    mutationFn: (item: WebhookItem) =>
      api.updateWebhook(item.id, { active: !item.active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setActionSuccess('Webhook berhasil dihapus.');
      setTimeout(() => setActionSuccess(''), 3000);
    },
  });

  // Rotate Secret Mutation
  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      if (res.secret) {
        setRevealedSecret(res.secret);
      }
    },
  });

  // Test Webhook Mutation
  const testMutation = useMutation({
    mutationFn: (id: string) => api.testWebhook(id),
    onSuccess: () => {
      setActionSuccess('Event tes webhook berhasil dijadwalkan!');
      setTimeout(() => setActionSuccess(''), 4000);
    },
  });

  const handleToggleEvent = (evId: string) => {
    if (evId === '*') {
      setSelectedEvents(['*']);
      return;
    }
    setSelectedEvents((prev) => {
      const withoutAll = prev.filter((e) => e !== '*');
      if (withoutAll.includes(evId)) {
        const next = withoutAll.filter((e) => e !== evId);
        return next.length === 0 ? ['*'] : next;
      } else {
        return [...withoutAll, evId];
      }
    });
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setFormError('');
    createMutation.mutate();
  };

  const copySecret = () => {
    if (revealedSecret) {
      navigator.clipboard.writeText(revealedSecret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    }
  };

  if (isLoading) return <LoadingState message="Memuat daftar webhook..." />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Webhook Integrasi</h1>
          <p className="text-sm text-slate-500">
            Terima payload HTTP event WhatsApp secara realtime dengan tanda tangan HMAC-SHA256.
          </p>
        </div>
        <button
          onClick={() => {
            setFormError('');
            setIsCreateModalOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 rounded-lg text-sm font-medium text-white hover:bg-emerald-700 transition shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Tambah Endpoint Webhook
        </button>
      </div>

      {actionSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Webhooks List */}
      {webhooks.length === 0 ? (
        <EmptyState
          title="Belum ada webhook terdaftar"
          description="Daftarkan URL callback sistem backend Anda untuk menerima notifikasi pesan masuk dan status sesi."
          actionText="Tambah Webhook"
          onAction={() => setIsCreateModalOpen(true)}
          icon={<Webhook className="w-8 h-8" />}
        />
      ) : (
        <div className="space-y-4">
          {webhooks.map((item) => {
            const isAutoDisabled = item.disabled_reason === 'AUTO_CONSECUTIVE_FAILURES';

            return (
              <div
                key={item.id}
                className={`bg-white rounded-xl border p-5 transition shadow-sm ${
                  isAutoDisabled
                    ? 'border-rose-300 bg-rose-50/20'
                    : item.active
                    ? 'border-slate-200'
                    : 'border-slate-200 opacity-75'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2.5 h-2.5 rounded-full ${
                          item.active ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                      />
                      <span className="font-mono text-sm font-semibold text-slate-900 truncate">
                        {item.url}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          item.active
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-100 text-slate-500 border border-slate-200'
                        }`}
                      >
                        {item.active ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </div>

                    {item.description && (
                      <p className="text-xs text-slate-500">{item.description}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-500">
                      <span>Secret Hint:</span>
                      <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-700">
                        {item.secret_hint || 'whsec_***'}
                      </code>

                      <span className="text-slate-300">•</span>
                      <span>Events:</span>
                      <div className="flex flex-wrap gap-1">
                        {item.events.map((ev) => (
                          <span
                            key={ev}
                            className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded font-mono"
                          >
                            {ev}
                          </span>
                        ))}
                      </div>
                    </div>

                    {isAutoDisabled && (
                      <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>
                          Webhook dinonaktifkan otomatis oleh sistem karena kegagalan pengiriman beruntun.
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions Buttons */}
                  <div className="flex items-center gap-2 pt-2 lg:pt-0">
                    <button
                      onClick={() => testMutation.mutate(item.id)}
                      disabled={testMutation.isPending || !item.active}
                      className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-50"
                      title="Kirim tes event"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      Test Ping
                    </button>

                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Rotasi Secret Webhook',
                          message:
                            'Rotasi secret akan mengganti signing secret lama segera. Server penerima Anda harus diperbarui dengan secret baru agar validasi tanda tangan HMAC tetap valid. Lanjutkan?',
                          confirmLabel: 'Rotasi Secret',
                          variant: 'warning',
                        });
                        if (ok) {
                          rotateMutation.mutate(item.id);
                        }
                      }}
                      disabled={rotateMutation.isPending}
                      className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition"
                      title="Ganti Secret Signing"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Rotasi Secret
                    </button>

                    <button
                      onClick={() => toggleMutation.mutate(item)}
                      disabled={toggleMutation.isPending}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition border ${
                        item.active
                          ? 'bg-slate-50 text-slate-700 hover:bg-slate-100 border-slate-200'
                          : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      {item.active ? 'Nonaktifkan' : 'Aktifkan'}
                    </button>

                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Hapus Endpoint Webhook',
                          message:
                            'Yakin ingin menghapus endpoint webhook ini beserta seluruh riwayat pengiriman (delivery log)-nya?',
                          confirmLabel: 'Hapus Webhook',
                          variant: 'danger',
                        });
                        if (ok) {
                          deleteMutation.mutate(item.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                      title="Hapus Webhook"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Drawer: Tambah Webhook Baru */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsCreateModalOpen(false)}
          />
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Tambah Endpoint Webhook</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="flex-1 flex flex-col justify-between overflow-y-auto">
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    URL Target (HTTPS direkomendasikan)
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://app.domainanda.com/api/wa-webhook"
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Deskripsi / Nama (Opsional)
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Misal: CRM Production Webhook"
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Berlangganan Event Notifikasi
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {AVAILABLE_EVENTS.map((ev) => {
                      const isChecked = selectedEvents.includes(ev.id);
                      return (
                        <button
                          type="button"
                          key={ev.id}
                          onClick={() => handleToggleEvent(ev.id)}
                          className={`text-left px-3 py-2.5 rounded-xl border text-xs transition flex items-center justify-between ${
                            isChecked
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <span>{ev.label}</span>
                          {isChecked && <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {formError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Menyimpan...' : 'Simpan Webhook'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: Reveal-Once Secret */}
      {revealedSecret && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setRevealedSecret(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2 text-amber-600">
                <ShieldAlert className="w-5 h-5 shrink-0" />
                <h3 className="font-bold text-slate-900 text-sm">Salin Webhook Secret</h3>
              </div>
              <button
                onClick={() => setRevealedSecret(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <p className="text-xs text-slate-500 leading-relaxed">
                Secret ini digunakan untuk memvalidasi tanda tangan header HMAC-SHA256 (`x-hub-signature-256`) pada backend Anda.
                Kunci ini tidak dapat ditampilkan kembali setelah drawer ini ditutup.
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Signing Secret HMAC:</label>
                <div className="p-3 bg-slate-900 rounded-xl text-emerald-400 font-mono text-xs flex items-center justify-between gap-2 break-all">
                  <span>{revealedSecret}</span>
                  <button
                    onClick={copySecret}
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg shrink-0 transition"
                    title="Salin ke clipboard"
                  >
                    {copiedSecret ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setRevealedSecret(null)}
                className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition"
              >
                Saya Sudah Menyimpan Secret Ini
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};