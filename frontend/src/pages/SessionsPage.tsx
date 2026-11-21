import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { Session, SessionStatus, QrResponse } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  Smartphone,
  Plus,
  QrCode,
  Trash2,
  RefreshCw,
  CheckCircle2,
  X,
  AlertCircle,
  Power,
  RotateCcw,
  Wifi,
  WifiOff,
  Pencil,
} from 'lucide-react';

const STATUS_BADGES: Record<
  SessionStatus,
  { label: string; bg: string; text: string; dot: string; isAnimated?: boolean }
> = {
  CREATED: { label: 'Created', bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-400' },
  PENDING_ASSIGNMENT: {
    label: 'Pending Assignment',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    dot: 'bg-amber-400',
    isAnimated: true,
  },
  INITIALIZING: {
    label: 'Inisialisasi',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dot: 'bg-blue-400',
    isAnimated: true,
  },
  QR_REQUIRED: {
    label: 'Scan QR Diperlukan',
    bg: 'bg-purple-50',
    text: 'text-purple-700',
    dot: 'bg-purple-500',
    isAnimated: true,
  },
  CONNECTING: {
    label: 'Menghubungkan',
    bg: 'bg-sky-50',
    text: 'text-sky-700',
    dot: 'bg-sky-500',
    isAnimated: true,
  },
  RECONNECTING: {
    label: 'Menyambung Ulang',
    bg: 'bg-yellow-50',
    text: 'text-yellow-700',
    dot: 'bg-yellow-500',
    isAnimated: true,
  },
  CONNECTED: {
    label: 'Terhubung',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
  },
  DISCONNECTING: {
    label: 'Memutus...',
    bg: 'bg-slate-100',
    text: 'text-slate-600',
    dot: 'bg-slate-400',
    isAnimated: true,
  },
  DISCONNECTED: {
    label: 'Terputus',
    bg: 'bg-slate-100',
    text: 'text-slate-600',
    dot: 'bg-slate-400',
  },
  LOGGED_OUT: {
    label: 'Logged Out',
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    dot: 'bg-orange-500',
  },
  ERROR: { label: 'Error', bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
  DELETING: {
    label: 'Menghapus...',
    bg: 'bg-rose-50',
    text: 'text-rose-600',
    dot: 'bg-rose-400',
    isAnimated: true,
  },
  DELETED: {
    label: 'Terhapus',
    bg: 'bg-slate-200',
    text: 'text-slate-500',
    dot: 'bg-slate-400',
  },
};

export const SessionsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { role } = useAuth();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const isViewer = role === 'VIEWER';

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [formError, setFormError] = useState('');

  // Active QR Modal state (ephemeral, not persisted)
  const [activeQrSession, setActiveQrSession] = useState<Session | null>(null);
  const [qrData, setQrData] = useState<QrResponse | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');
  const [isSessionConnected, setIsSessionConnected] = useState(false);
  const [isConnectingEngine, setIsConnectingEngine] = useState(false);

  // Rename Session state
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editSessionName, setEditSessionName] = useState('');

  // Sesi Query
  const {
    data: sessions = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
    refetchInterval: 3000,
  });

  // Ephemeral QR fetching & auto-cleanup
  useEffect(() => {
    if (!activeQrSession) {
      setQrData(null);
      setQrError('');
      setIsSessionConnected(false);
      setIsConnectingEngine(false);
      return;
    }

    let isMounted = true;
    let timer: any = null;

    const fetchQr = async () => {
      try {
        // 1. Cek status sesi terlebih dahulu secara aman
        const statusRes = await api.getSessionStatus(activeQrSession.id).catch(() => null);
        const currentStatus = statusRes?.status;

        // Jika sesi sudah berhasil CONNECTED
        if (currentStatus === 'CONNECTED') {
          if (isMounted) {
            setIsSessionConnected(true);
            setIsConnectingEngine(false);
            setQrError('');
            setQrData(null);
            queryClient.invalidateQueries({ queryKey: ['sessions'] });
            if (timer) clearInterval(timer);
            setTimeout(() => {
              if (isMounted) {
                setActiveQrSession(null);
                setIsSessionConnected(false);
              }
            }, 2500);
          }
          return;
        }

        // Jika sedang dalam proses negosiasi handshake / reconnecting
        if (currentStatus === 'CONNECTING' || currentStatus === 'INITIALIZING' || currentStatus === 'RECONNECTING') {
          if (isMounted) {
            setIsConnectingEngine(true);
            setQrError('');
          }
          return;
        }

        if (isMounted) {
          setIsConnectingEngine(false);
        }

        // 2. Jika status QR_REQUIRED atau belum siap, minta QR
        if (currentStatus === 'QR_REQUIRED' || !currentStatus) {
          try {
            setQrLoading(true);
            const res = await api.getSessionQr(activeQrSession.id);
            if (isMounted) {
              setQrData(res);
              setQrError('');
            }
          } catch (qrErr: any) {
            const msg = (qrErr?.message || '').toLowerCase();
            // Jika backend membalas "QR tidak tersedia pada status CONNECTED"
            if (msg.includes('connected')) {
              if (isMounted) {
                setIsSessionConnected(true);
                setQrError('');
                setQrData(null);
                queryClient.invalidateQueries({ queryKey: ['sessions'] });
                if (timer) clearInterval(timer);
                setTimeout(() => {
                  if (isMounted) {
                    setActiveQrSession(null);
                    setIsSessionConnected(false);
                  }
                }, 2500);
              }
              return;
            }
            if (isMounted) {
              setQrError(qrErr.message || 'QR code belum siap dari engine Baileys');
            }
          } finally {
            if (isMounted) setQrLoading(false);
          }
        } else if (currentStatus === 'ERROR') {
          if (isMounted) {
            setQrError(statusRes?.status_reason || 'Sesi mengalami kegagalan koneksi. Silakan minta sambung ulang.');
          }
        }
      } catch (err: any) {
        if (isMounted) {
          const msg = (err?.message || '').toLowerCase();
          if (msg.includes('connected')) {
            setIsSessionConnected(true);
            setQrError('');
            queryClient.invalidateQueries({ queryKey: ['sessions'] });
          } else {
            setQrError(err.message || 'Gagal memuat status sesi');
          }
        }
      }
    };

    fetchQr();
    timer = setInterval(fetchQr, 2500);

    return () => {
      isMounted = false;
      if (timer) clearInterval(timer);
    };
  }, [activeQrSession, queryClient]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (name: string) => api.createSession(name),
    onSuccess: (newSession) => {
      setAlias('');
      setPhoneNumber('');
      setIsCreateModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      api.connectSession(newSession.id).catch(() => {});
      setActiveQrSession(newSession);
    },
    onError: (err: any) => {
      setFormError(err.message || 'Gagal menambahkan sesi baru');
    },
  });

  const connectMutation = useMutation({
    mutationFn: (id: string) => api.connectSession(id),
    onSuccess: (_, id) => {
      showToast('info', 'Meminta koneksi sesi gateway...', 'Menghubungkan');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      const target = sessions.find((s) => s.id === id);
      if (target) {
        setActiveQrSession(target);
      }
    },
    onError: (err: any) => {
      showToast('error', err.message || 'Gagal memulai koneksi sesi', 'Galat Koneksi');
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => api.disconnectSession(id),
    onSuccess: (_, id) => {
      showToast('info', 'Permintaan pemutusan sesi berhasil dikirim. Sesi sedang diputus...', 'Putus Sesi');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
      if (activeQrSession?.id === id) {
        setActiveQrSession(null);
      }
    },
    onError: (err: any) => {
      showToast('error', err.message || 'Gagal memutuskan sesi WhatsApp', 'Galat Pemutusan Sesi');
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: (id: string) => api.reconnectSession(id),
    onSuccess: () => {
      showToast('info', 'Permintaan penyambungan ulang terkirim.', 'Sambung Ulang');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err: any) => {
      showToast('error', err.message || 'Gagal menyambung ulang sesi', 'Galat Koneksi');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_, deletedId) => {
      showToast('success', 'Sesi WhatsApp berhasil dihapus.', 'Hapus Sesi');
      if (activeQrSession?.id === deletedId) {
        setActiveQrSession(null);
      }
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    },
    onError: (err: any) => {
      showToast('error', err.message || 'Gagal menghapus sesi', 'Galat Hapus');
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameSession(id, name),
    onSuccess: () => {
      showToast('success', 'Nama sesi WhatsApp berhasil diubah.');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setEditingSession(null);
    },
    onError: (err: any) => {
      showToast('error', err.message || 'Gagal mengubah nama sesi');
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!alias.trim()) return;
    setFormError('');
    createMutation.mutate(alias.trim());
  };

  const handleDisconnect = async (s: Session) => {
    if (isViewer) {
      showToast('error', 'Akses Viewer hanya baca-saja dan tidak dapat memutuskan sesi.');
      return;
    }
    const label = s.session_name || (s.phone_number ? `+${s.phone_number}` : s.id.slice(0, 8));
    const ok = await confirm({
      title: 'Putuskan Koneksi Sesi WhatsApp',
      message: `Yakin ingin memutuskan koneksi WhatsApp untuk sesi "${label}"? Sesi akan terputus dari server WhatsApp.`,
      confirmLabel: 'Putuskan Sesi',
      variant: 'warning',
    });
    if (ok) {
      disconnectMutation.mutate(s.id);
    }
  };

  const handleDelete = async (s: Session) => {
    if (isViewer) {
      showToast('error', 'Akses Viewer hanya baca-saja dan tidak dapat menghapus sesi.');
      return;
    }
    const label = s.session_name || s.phone_number || s.id;
    const ok = await confirm({
      title: 'Hapus Sesi WhatsApp',
      message: `Yakin ingin menghapus sesi "${label}"? Sesi WhatsApp dan data kredensialnya akan diputus serta dihapus permanen.`,
      confirmLabel: 'Hapus Sesi Permanen',
      variant: 'danger',
    });
    if (ok) {
      deleteMutation.mutate(s.id);
    }
  };

  if (isLoading) return <LoadingState message="Memuat daftar sesi WhatsApp..." />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">WhatsApp Sessions</h1>
          <p className="text-sm text-slate-500">
            Kelola sesi WhatsApp, pasangkan perangkat melalui QR ephemeral, dan pantau status koneksi.
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
          Tambah Sesi Baru
        </button>
      </div>

      {/* Grid */}
      {sessions.length === 0 ? (
        <EmptyState
          title="Belum ada sesi WhatsApp"
          description="Tambahkan sesi baru untuk mulai menghubungkan nomor WhatsApp Anda ke Gateway."
          actionText="Tambah Sesi Baru"
          onAction={() => setIsCreateModalOpen(true)}
          icon={<Smartphone className="w-8 h-8" />}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {sessions.map((session) => {
            const badge = STATUS_BADGES[session.status] || STATUS_BADGES.CREATED;
            const isConnected = session.status === 'CONNECTED';
            const isQrRequired = session.status === 'QR_REQUIRED';
            const isConnecting = ['CONNECTING', 'RECONNECTING', 'INITIALIZING'].includes(
              session.status
            );

            return (
              <div
                key={session.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col justify-between hover:border-slate-300 transition"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-600">
                        <Smartphone className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <h3 className="font-semibold text-slate-900 text-sm truncate max-w-[130px]">
                            {session.session_name || 'Tanpa Alias'}
                          </h3>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingSession(session);
                              setEditSessionName(session.session_name || '');
                            }}
                            className="text-slate-400 hover:text-emerald-600 transition p-0.5 rounded"
                            title="Ubah Nama Sesi"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-slate-400 font-mono">
                          {session.id.slice(0, 8)}...
                        </p>
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 ${badge.bg} ${badge.text}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${badge.dot} ${
                          badge.isAnimated ? 'animate-pulse' : ''
                        }`}
                      />
                      {badge.label}
                    </span>
                  </div>

                  <div className="space-y-1.5 py-3 border-y border-slate-100 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>Nomor Telepon:</span>
                      <span className="font-medium text-slate-800">
                        {session.phone_number ? `+${session.phone_number}` : 'Belum Ditautkan'}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-500">
                      <span>Dibuat:</span>
                      <span className="font-medium text-slate-700">
                        {new Date(session.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions Footer */}
                <div className="flex items-center gap-2 mt-4 pt-2">
                  {/* 1. Sesi dalam proses DELETING */}
                  {session.status === 'DELETING' ? (
                    <button
                      disabled
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-rose-50 text-rose-500 border border-rose-200 rounded-xl text-xs font-semibold cursor-wait"
                    >
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Menghapus...
                    </button>
                  ) : session.status === 'DISCONNECTING' || (disconnectMutation.isPending && disconnectMutation.variables === session.id) ? (
                    /* 2. Sesi dalam proses DISCONNECTING */
                    <button
                      disabled
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-600 border border-slate-200 rounded-xl text-xs font-semibold cursor-wait"
                    >
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-500" />
                      Memutuskan Sesi...
                    </button>
                  ) : isConnected ? (
                    /* 3. Sesi CONNECTED */
                    <button
                      type="button"
                      onClick={() => handleDisconnect(session)}
                      disabled={isViewer || disconnectMutation.isPending}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-50 text-slate-700 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300 border border-slate-200 rounded-xl text-xs font-bold transition shadow-2xs group"
                      title={isViewer ? 'Akses baca-saja' : 'Putuskan koneksi perangkat WhatsApp'}
                    >
                      <Power className="w-3.5 h-3.5 text-slate-400 group-hover:text-rose-600 transition" />
                      <span>Putuskan Sesi</span>
                    </button>
                  ) : isQrRequired ? (
                    /* 4. Sesi butuh Scan QR Pairing */
                    <div className="flex-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setActiveQrSession(session)}
                        disabled={isViewer}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 rounded-xl text-xs font-bold transition animate-pulse"
                      >
                        <QrCode className="w-3.5 h-3.5" />
                        Scan QR Pairing
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDisconnect(session)}
                        disabled={isViewer || (disconnectMutation.isPending && disconnectMutation.variables === session.id)}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition border border-slate-200"
                        title="Batalkan / Putuskan Sesi"
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : isConnecting ? (
                    /* 5. Sesi sedang inisialisasi / handshake */
                    <div className="flex-1 flex items-center gap-1.5">
                      <button
                        disabled
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-sky-50 text-sky-700 border border-sky-200 rounded-xl text-xs font-medium cursor-wait"
                      >
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Menghubungkan...
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDisconnect(session)}
                        disabled={isViewer || (disconnectMutation.isPending && disconnectMutation.variables === session.id)}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition border border-slate-200"
                        title="Batalkan Koneksi"
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : session.status === 'ERROR' ? (
                    /* 6. Sesi ERROR -> Sambung Ulang & opsi Reset Putus */
                    <div className="flex-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => reconnectMutation.mutate(session.id)}
                        disabled={isViewer || reconnectMutation.isPending}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-xl text-xs font-bold transition"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Sambung Ulang
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDisconnect(session)}
                        disabled={isViewer || (disconnectMutation.isPending && disconnectMutation.variables === session.id)}
                        className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition border border-slate-200"
                        title="Tandai Putus / Reset Sesi"
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    /* 7. DISCONNECTED / CREATED / LOGGED_OUT -> Hubungkan */
                    <button
                      type="button"
                      onClick={() => connectMutation.mutate(session.id)}
                      disabled={isViewer || connectMutation.isPending}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-xl text-xs font-bold transition"
                    >
                      <Wifi className="w-3.5 h-3.5" />
                      Hubungkan
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleDelete(session)}
                    disabled={isViewer || deleteMutation.isPending || session.status === 'DELETING'}
                    className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition border border-transparent hover:border-rose-200"
                    title={isViewer ? 'Akses baca-saja' : 'Hapus Sesi'}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Drawer: Tambah Sesi */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsCreateModalOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Tambah Sesi WhatsApp Baru</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="flex-1 flex flex-col justify-between overflow-y-auto">
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Alias Sesi (Opsional)
                  </label>
                  <input
                    type="text"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="Misal: CS Sales Utama"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nomor WhatsApp (Opsional, E.164 tanpa +)
                  </label>
                  <input
                    type="text"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="Misal: 628123456789"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Jika dikosongkan, nomor akan otomatis didapat saat proses scan QR.
                  </p>
                </div>

                {formError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Menambahkan...' : 'Simpan & Hubungkan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: Ephemeral QR Code with 3-Step Visual Guide */}
      {activeQrSession && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setActiveQrSession(null)}
          />
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            {/* Drawer Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                  <QrCode className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">
                    Tautkan Sesi WhatsApp:{' '}
                    <span className="text-emerald-600 font-mono">
                      {activeQrSession.session_name || activeQrSession.id.slice(0, 8)}
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400">Pindai kode QR menggunakan WhatsApp di ponsel Anda</p>
                </div>
              </div>
              <button
                onClick={() => setActiveQrSession(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Visual 3 Steps Guide */}
              <div className="grid grid-cols-3 gap-2 bg-slate-50 p-3 rounded-2xl border border-slate-100 text-center">
                <div className="space-y-1">
                  <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 font-bold text-xs inline-flex items-center justify-center">
                    1
                  </span>
                  <p className="text-[11px] font-semibold text-slate-800">Buka WhatsApp</p>
                  <p className="text-[10px] text-slate-400 leading-tight">Di ponsel Android / iPhone</p>
                </div>

                <div className="space-y-1">
                  <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 font-bold text-xs inline-flex items-center justify-center">
                    2
                  </span>
                  <p className="text-[11px] font-semibold text-slate-800">Perangkat Tertaut</p>
                  <p className="text-[10px] text-slate-400 leading-tight">Titik 3 &gt; Tautkan Perangkat</p>
                </div>

                <div className="space-y-1">
                  <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 font-bold text-xs inline-flex items-center justify-center">
                    3
                  </span>
                  <p className="text-[11px] font-semibold text-slate-800">Scan QR Ini</p>
                  <p className="text-[10px] text-slate-400 leading-tight">Arahkan kamera ke layar</p>
                </div>
              </div>

              {/* QR Box */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col items-center justify-center min-h-[290px]">
                {isSessionConnected ? (
                  <div className="flex flex-col items-center gap-3 text-center py-6 animate-in fade-in zoom-in duration-300">
                    <div className="w-16 h-16 rounded-full bg-emerald-100 border-2 border-emerald-300 flex items-center justify-center text-emerald-600 shadow-sm animate-bounce">
                      <CheckCircle2 className="w-10 h-10" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-base font-bold text-slate-900">Perangkat WhatsApp Terhubung!</p>
                      <p className="text-xs text-slate-500 max-w-xs">
                        Sesi <span className="font-semibold text-emerald-700">{activeQrSession.session_name}</span> berhasil diautentikasi dan siap digunakan.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setActiveQrSession(null);
                        setIsSessionConnected(false);
                      }}
                      className="mt-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
                    >
                      Selesai & Tutup Jendela
                    </button>
                  </div>
                ) : isConnectingEngine ? (
                  <div className="flex flex-col items-center gap-3 text-center py-8">
                    <div className="relative">
                      <RefreshCw className="w-10 h-10 animate-spin text-emerald-600" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-slate-800">Menghubungkan ke WhatsApp...</p>
                      <p className="text-xs text-slate-500 max-w-xs">
                        Handshake autentikasi sesi sedang diproses. Mohon tunggu beberapa detik.
                      </p>
                    </div>
                  </div>
                ) : qrLoading && !qrData ? (
                  <div className="flex flex-col items-center gap-2 text-slate-400 py-8">
                    <RefreshCw className="w-8 h-8 animate-spin text-emerald-600" />
                    <p className="text-xs font-medium">Menghubungkan ke engine Baileys & menyiapkan QR...</p>
                  </div>
                ) : qrError ? (
                  <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex flex-col items-center gap-2 text-center max-w-xs">
                    <AlertCircle className="w-7 h-7 text-rose-500" />
                    <p className="font-semibold">Pemberitahuan Sesi</p>
                    <p className="text-[11px] text-rose-600">{qrError}</p>
                    {qrError.includes('CONNECTED') ? (
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => handleDisconnect(activeQrSession)}
                          className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
                        >
                          Putuskan Sesi Ini
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveQrSession(null)}
                          className="px-3.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-semibold transition"
                        >
                          Tutup
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => api.connectSession(activeQrSession.id)}
                        className="mt-2 px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
                      >
                        Minta Sambung Ulang
                      </button>
                    )}
                  </div>
                ) : qrData?.qr_data_url ? (
                  <div className="space-y-3 text-center">
                    <div className="p-2 bg-white rounded-2xl shadow-md border border-slate-200 inline-block relative group">
                      <img
                        src={qrData.qr_data_url}
                        alt="WhatsApp QR Code"
                        className="w-56 h-56 mx-auto rounded-xl"
                      />
                    </div>
                    <div className="flex items-center justify-center gap-2 text-[11px] text-slate-500">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span>QR diperbarui otomatis setiap beberapa detik</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-slate-500 py-8">
                    <CheckCircle2 className="w-12 h-12 text-emerald-500" />
                    <p className="text-sm font-bold text-slate-800">Perangkat Berhasil Terhubung!</p>
                    <p className="text-xs text-slate-400">Menutup jendela otomatis...</p>
                  </div>
                )}
              </div>
            </div>

            {/* Drawer Footer */}
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => api.connectSession(activeQrSession.id)}
                className="text-emerald-600 hover:text-emerald-700 font-semibold flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Segarkan QR Manual
              </button>
              <div className="flex items-center gap-2">
                {activeQrSession.status === 'CONNECTED' && (
                  <button
                    type="button"
                    onClick={() => handleDisconnect(activeQrSession)}
                    className="px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl font-bold transition flex items-center gap-1.5"
                  >
                    <Power className="w-3.5 h-3.5" />
                    <span>Putuskan Sesi</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveQrSession(null)}
                  className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-semibold transition"
                >
                  Tutup Jendela
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drawer: Ubah Nama Sesi */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setEditingSession(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Ubah Nama Sesi WhatsApp</h2>
              <button
                onClick={() => setEditingSession(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (editSessionName.trim()) {
                  renameMutation.mutate({ id: editingSession.id, name: editSessionName.trim() });
                }
              }}
              className="flex-1 flex flex-col justify-between overflow-y-auto"
            >
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama / Alias Sesi Baru
                  </label>
                  <input
                    type="text"
                    value={editSessionName}
                    onChange={(e) => setEditSessionName(e.target.value)}
                    placeholder="contoh: CS-Utama-2"
                    required
                    minLength={2}
                    maxLength={50}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Panjang 2-50 karakter (huruf, angka, spasi, titik, garis bawah, tanda hubung).
                  </p>
                </div>
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditingSession(null)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={renameMutation.isPending || !editSessionName.trim()}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {renameMutation.isPending ? 'Menyimpan...' : 'Simpan Nama Sesi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};