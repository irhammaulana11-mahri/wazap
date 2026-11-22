import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  platformApi,
  PlatformWorkspaceDetail,
} from '../../services/platformApi';
import { ApiError } from '../../services/api';
import {
  Building2,
  ArrowLeft,
  Smartphone,
  Key,
  Users,
  Activity,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Clock,
  KeyRound,
  History,
  Lock,
  RotateCcw,
  Sliders,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';

export const PlatformWorkspaceDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  // Dialog states
  const [isQuotaModalOpen, setIsQuotaModalOpen] = useState(false);
  const [isSuspendModalOpen, setIsSuspendModalOpen] = useState(false);
  const [isActivateModalOpen, setIsActivateModalOpen] = useState(false);
  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);

  // Form states
  const [maxSessions, setMaxSessions] = useState<number | ''>('');
  const [maxApiKeys, setMaxApiKeys] = useState<number | ''>('');
  const [maxMembers, setMaxMembers] = useState<number | ''>('');
  const [messagesPerMinute, setMessagesPerMinute] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  const { data: ws, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['platform-workspace', id],
    queryFn: () => platformApi.getWorkspace(id!),
    enabled: !!id,
  });

  const openQuotaModal = () => {
    if (ws) {
      setMaxSessions(ws.limits.max_sessions);
      setMaxApiKeys(ws.limits.max_api_keys);
      setMaxMembers(ws.limits.max_members);
      setMessagesPerMinute(ws.limits.messages_per_minute);
    }
    setReason('');
    setOtp('');
    setActionError('');
    setIsQuotaModalOpen(true);
  };

  const updateQuotaMutation = useMutation({
    mutationFn: () => {
      const payload: any = {
        reason: reason.trim(),
        otp: otp.trim(),
      };
      if (maxSessions !== '') payload.max_sessions = Number(maxSessions);
      if (maxApiKeys !== '') payload.max_api_keys = Number(maxApiKeys);
      if (maxMembers !== '') payload.max_members = Number(maxMembers);
      if (messagesPerMinute !== '') payload.messages_per_minute = Number(messagesPerMinute);
      return platformApi.updateQuotas(id!, payload);
    },
    onSuccess: () => {
      setIsQuotaModalOpen(false);
      setActionSuccess('Alokasi kuota workspace berhasil diperbarui.');
      queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Gagal mengubah kuota.');
    },
  });

  const suspendMutation = useMutation({
    mutationFn: () => platformApi.suspend(id!, { reason: reason.trim(), otp: otp.trim() }),
    onSuccess: () => {
      setIsSuspendModalOpen(false);
      setActionSuccess('Workspace berhasil ditangguhkan. Seluruh sesi dihentikan.');
      queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Gagal menangguhkan workspace.');
    },
  });

  const activateMutation = useMutation({
    mutationFn: () => platformApi.activate(id!, { reason: reason.trim(), otp: otp.trim() }),
    onSuccess: () => {
      setIsActivateModalOpen(false);
      setActionSuccess('Workspace berhasil diaktifkan kembali.');
      queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Gagal mengaktifkan workspace.');
    },
  });

  const approveMutation = useMutation({
    mutationFn: () =>
      platformApi.approve(id!, {
        reason: reason.trim() ? reason.trim() : undefined,
        otp: otp.trim(),
      }),
    onSuccess: () => {
      setIsApproveModalOpen(false);
      setActionSuccess('Pendaftaran workspace berhasil disetujui. Akun pemilik kini aktif.');
      queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
      queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['platform-workspaces-pending-count'] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      if (err.status === 409 || err.code === 'INVALID_STATE') {
        setActionError('Status workspace telah berubah di sesi/tab lain.');
        queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
        queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
        queryClient.invalidateQueries({ queryKey: ['platform-workspaces-pending-count'] });
      } else {
        setActionError(err.message || 'Gagal menyetujui pendaftaran workspace.');
      }
    },
    onSettled: () => {
      setReason('');
      setOtp('');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      platformApi.reject(id!, {
        reason: reason.trim(),
        otp: otp.trim(),
      }),
    onSuccess: () => {
      setIsRejectModalOpen(false);
      setActionSuccess('Pendaftaran workspace ditolak.');
      queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
      queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['platform-workspaces-pending-count'] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      if (err.status === 409 || err.code === 'INVALID_STATE') {
        setActionError('Status workspace telah berubah di sesi/tab lain.');
        queryClient.invalidateQueries({ queryKey: ['platform-workspace', id] });
        queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
        queryClient.invalidateQueries({ queryKey: ['platform-workspaces-pending-count'] });
      } else {
        setActionError(err.message || 'Gagal menolak pendaftaran workspace.');
      }
    },
    onSettled: () => {
      setReason('');
      setOtp('');
    },
  });

  if (isLoading) {
    return (
      <div className="p-12 text-center text-slate-400 text-xs">
        <span>Memuat detail workspace...</span>
      </div>
    );
  }

  if (isError || !ws) {
    return (
      <div className="p-8 text-center text-rose-400 text-xs">
        <p>{(error as Error)?.message || 'Workspace tidak ditemukan.'}</p>
        <Link to="/platform/workspaces" className="mt-3 inline-block text-purple-400 underline">
          Kembali ke daftar workspace
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back button */}
      <div>
        <Link
          to="/platform/workspaces"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Kembali ke Daftar Workspace</span>
        </Link>
      </div>

      {/* Success Notification */}
      {actionSuccess && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 rounded-2xl text-xs flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-emerald-100 dark:bg-emerald-900/70 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700">
            Berhasil
          </span>
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Workspace Header Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-7 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{ws.name}</h1>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                  ws.status === 'PENDING'
                    ? 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800'
                    : ws.status === 'ACTIVE'
                    ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                    : ws.status === 'SUSPENDED'
                    ? 'bg-orange-50 dark:bg-orange-950 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800'
                    : ws.status === 'REJECTED'
                    ? 'bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800'
                    : ws.status === 'DELETED'
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                }`}
              >
                {ws.status}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400 font-mono">
              <span>ID: {ws.id}</span>
              <span>Slug: {ws.slug}</span>
              <span>Dibuat: {new Date(ws.created_at).toLocaleDateString('id-ID')}</span>
              {ws.decided_at && (
                <span className="text-purple-600 dark:text-purple-400">
                  Diputuskan: {new Date(ws.decided_at).toLocaleString('id-ID')}
                </span>
              )}
              {ws.suspended_at && (
                <span className="text-amber-600 dark:text-amber-400">
                  Ditangguhkan: {new Date(ws.suspended_at).toLocaleString('id-ID')}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={openQuotaModal}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
            >
              Ubah Kuota
            </button>

            {ws.status === 'PENDING' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setReason('');
                    setOtp('');
                    setActionError('');
                    setIsApproveModalOpen(true);
                  }}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm cursor-pointer flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Setujui</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReason('');
                    setOtp('');
                    setActionError('');
                    setIsRejectModalOpen(true);
                  }}
                  className="px-4 py-2 bg-rose-50 dark:bg-rose-600/20 hover:bg-rose-100 dark:hover:bg-rose-600/30 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-500/40 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Tolak</span>
                </button>
              </>
            ) : ws.status === 'REJECTED' ? (
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsApproveModalOpen(true);
                }}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm cursor-pointer flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Setujui (kesempatan kedua)</span>
              </button>
            ) : ws.status === 'ACTIVE' ? (
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsSuspendModalOpen(true);
                }}
                className="px-4 py-2 bg-amber-50 dark:bg-amber-600/20 hover:bg-amber-100 dark:hover:bg-amber-600/30 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/40 rounded-xl text-xs font-bold transition cursor-pointer"
              >
                Tangguhkan Workspace
              </button>
            ) : ws.status === 'SUSPENDED' ? (
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsActivateModalOpen(true);
                }}
                className="px-4 py-2 bg-emerald-50 dark:bg-emerald-600/20 hover:bg-emerald-100 dark:hover:bg-emerald-600/30 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/40 rounded-xl text-xs font-bold transition cursor-pointer"
              >
                Aktifkan Kembali
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Quotas & Usage Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Sessions */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Sesi WhatsApp</span>
            <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
              <Smartphone className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
              {ws.quota_used?.sessions ?? ws.used?.sessions ?? 0}
              <span className="text-xs font-normal text-slate-400 ml-1">/ {ws.limits.max_sessions}</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Aktif: {ws.used?.sessions_connected ?? 0} sesi
            </p>
          </div>
        </div>

        {/* API Keys */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Kunci API</span>
            <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
              <Key className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
              {ws.quota_used?.api_keys ?? ws.used?.api_keys ?? 0}
              <span className="text-xs font-normal text-slate-400 ml-1">/ {ws.limits.max_api_keys}</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Token integrasi aktif</p>
          </div>
        </div>

        {/* Members */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Kapasitas Tim</span>
            <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
              {ws.quota_used?.members ?? ws.used?.members ?? 0}
              <span className="text-xs font-normal text-slate-400 ml-1">/ {ws.limits.max_members}</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Undangan pending: {ws.pending_invitations ?? 0}
            </p>
          </div>
        </div>

        {/* Rate limit */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Throughput Pesan</span>
            <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
              {ws.limits.messages_per_minute}
              <span className="text-xs font-normal text-slate-400 ml-1">msg/m</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Token bucket anti-ban</p>
          </div>
        </div>
      </div>

      {/* Details Sections: Owners, Roles & History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Owner & Members Breakdown */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 space-y-4 shadow-xs">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <span>Akun Pemilik & Distribusi Peran</span>
          </h3>

          <div className="space-y-3">
            <div className="text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-white block mb-1">Akun Pemilik (OWNER):</span>
              {ws.owner_accounts && ws.owner_accounts.length > 0 ? (
                <ul className="space-y-1">
                  {ws.owner_accounts.map((o) => (
                    <li key={o.user_id} className="font-mono text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between">
                      <span>{o.email || o.user_id}</span>
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">{o.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-400">Tidak ada pemilik aktif.</p>
              )}
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <span className="text-xs font-semibold text-slate-900 dark:text-white block mb-2">Anggota per Peran:</span>
              <div className="flex gap-3">
                {Object.entries(ws.members_by_role || {}).map(([roleName, count]) => (
                  <div key={roleName} className="p-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-center flex-1">
                    <span className="block text-[10px] font-mono text-slate-500 dark:text-slate-400">{roleName}</span>
                    <span className="text-base font-bold text-slate-900 dark:text-white">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Audit History Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 space-y-4 shadow-xs">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <History className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <span>Riwayat Perubahan Platform (Audit Log)</span>
          </h3>

          {ws.history && ws.history.length > 0 ? (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {ws.history.map((h) => (
                <div key={h.id} className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-purple-700 dark:text-purple-300 font-mono">{h.action}</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      {new Date(h.created_at).toLocaleString('id-ID')}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                    Oleh: <span className="font-mono text-slate-800 dark:text-slate-200">{h.admin_email}</span>
                  </div>
                  {h.reason && (
                    <div className="text-[11px] text-slate-700 dark:text-slate-300 italic">
                      Alasan: &ldquo;{h.reason}&rdquo;
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-xs text-slate-400">
              Belum ada riwayat perubahan platform pada workspace ini.
            </div>
          )}
        </div>
      </div>

      {/* Drawer Preview: Ubah Kuota */}
      {isQuotaModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsQuotaModalOpen(false)}
          />
          <div className="relative w-full max-w-lg bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800 flex items-center justify-center shrink-0">
                  <Sliders className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">Pratinjau & Ubah Kuota</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Workspace: <strong className="text-slate-800 dark:text-slate-200">{ws.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsQuotaModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                aria-label="Tutup panel ubah kuota"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Form Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {actionError && (
                <div className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Live Quota Comparison Preview Card */}
              <div className="p-4 bg-purple-50/60 dark:bg-purple-950/40 rounded-2xl border border-purple-200/80 dark:border-purple-900/50 space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  <span className="text-xs font-bold text-purple-900 dark:text-purple-200 uppercase tracking-wider">
                    Ringkasan Pratinjau Alokasi
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-purple-100 dark:border-slate-800 space-y-0.5">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Sesi WA:</span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      {ws.limits.max_sessions} → <span className="text-purple-600 dark:text-purple-400">{maxSessions || ws.limits.max_sessions}</span>
                    </span>
                  </div>
                  <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-purple-100 dark:border-slate-800 space-y-0.5">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Kunci API:</span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      {ws.limits.max_api_keys} → <span className="text-purple-600 dark:text-purple-400">{maxApiKeys || ws.limits.max_api_keys}</span>
                    </span>
                  </div>
                  <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-purple-100 dark:border-slate-800 space-y-0.5">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Anggota:</span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      {ws.limits.max_members} → <span className="text-purple-600 dark:text-purple-400">{maxMembers || ws.limits.max_members}</span>
                    </span>
                  </div>
                  <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-purple-100 dark:border-slate-800 space-y-0.5">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Throughput:</span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      {ws.limits.messages_per_minute} → <span className="text-purple-600 dark:text-purple-400">{messagesPerMinute || ws.limits.messages_per_minute}</span> msg/m
                    </span>
                  </div>
                </div>
              </div>

              {/* Form Inputs */}
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Sesi WA</label>
                    <input
                      type="number"
                      value={maxSessions}
                      onChange={(e) => setMaxSessions(e.target.value === '' ? '' : Number(e.target.value))}
                      min={ws.minimums?.max_sessions ?? 1}
                      max={ws.ceilings?.max_sessions ?? 50}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                    />
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      Batas: {ws.minimums?.max_sessions ?? 1}–{ws.ceilings?.max_sessions ?? 50}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Kunci API</label>
                    <input
                      type="number"
                      value={maxApiKeys}
                      onChange={(e) => setMaxApiKeys(e.target.value === '' ? '' : Number(e.target.value))}
                      min={ws.minimums?.max_api_keys ?? 1}
                      max={ws.ceilings?.max_api_keys ?? 20}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                    />
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      Batas: {ws.minimums?.max_api_keys ?? 1}–{ws.ceilings?.max_api_keys ?? 20}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Anggota</label>
                    <input
                      type="number"
                      value={maxMembers}
                      onChange={(e) => setMaxMembers(e.target.value === '' ? '' : Number(e.target.value))}
                      min={ws.minimums?.max_members ?? 1}
                      max={ws.ceilings?.max_members ?? 25}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                    />
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      Batas: {ws.minimums?.max_members ?? 1}–{ws.ceilings?.max_members ?? 25}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Throughput (msg/m)</label>
                    <input
                      type="number"
                      value={messagesPerMinute}
                      onChange={(e) => setMessagesPerMinute(e.target.value === '' ? '' : Number(e.target.value))}
                      min={ws.minimums?.messages_per_minute ?? 10}
                      max={ws.ceilings?.messages_per_minute ?? 300}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                    />
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      Batas: {ws.minimums?.messages_per_minute ?? 10}–{ws.ceilings?.messages_per_minute ?? 300}
                    </span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Alasan Perubahan (Wajib)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Contoh: Upgrade paket bisnis tahunan atas permintaan tiket #1042"
                    rows={2}
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Kode TOTP Operator</label>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6 digit kode autentikator"
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>
            </div>

            {/* Sticky Actions Footer */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setIsQuotaModalOpen(false)}
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={updateQuotaMutation.isPending || !reason.trim() || !otp.trim()}
                onClick={() => updateQuotaMutation.mutate()}
                className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer shadow-xs transition"
              >
                {updateQuotaMutation.isPending ? 'Menyimpan...' : 'Simpan Kuota'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer Preview: Suspend */}
      {isSuspendModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsSuspendModalOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-amber-600 dark:text-amber-400">Pratinjau Penangguhan</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Workspace: <strong className="text-slate-800 dark:text-slate-200">{ws.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSuspendModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                aria-label="Tutup panel penangguhan"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {actionError && (
                <div className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Impact Warning Notice */}
              <div className="p-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-amber-900 dark:text-amber-200 rounded-2xl text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>Dampak Penangguhan Workspace:</span>
                </div>
                <ul className="list-disc list-inside space-y-1 text-amber-800 dark:text-amber-300/90 pl-1 leading-relaxed text-[11px]">
                  <li>Seluruh sesi WhatsApp akan diputus seketika.</li>
                  <li>Token kunci API & webhook gateway akan dibekukan.</li>
                  <li>Akses masuk bagi anggota workspace ditolak sementara.</li>
                </ul>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Alasan Penangguhan (Wajib)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Contoh: Pelanggaran ketentuan layanan spam berulang"
                    rows={3}
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Kode TOTP Operator</label>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6 digit kode autentikator"
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setIsSuspendModalOpen(false)}
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={suspendMutation.isPending || !reason.trim() || !otp.trim()}
                onClick={() => suspendMutation.mutate()}
                className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer shadow-xs transition"
              >
                {suspendMutation.isPending ? 'Menangguhkan...' : 'Tangguhkan Sekarang'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer Preview: Activate */}
      {isActivateModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsActivateModalOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-emerald-600 dark:text-emerald-400">Pratinjau Pengaktifan</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Workspace: <strong className="text-slate-800 dark:text-slate-200">{ws.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsActivateModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                aria-label="Tutup panel pengaktifan"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {actionError && (
                <div className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Recovery Info Notice */}
              <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200 rounded-2xl text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Pemulihan Akses Workspace:</span>
                </div>
                <p className="text-emerald-800 dark:text-emerald-300/90 leading-relaxed text-[11px]">
                  Akses login anggota akan segera dipulihkan normal dan antrean gateway siap digunakan kembali. Sesi WhatsApp yang sebelumnya aktif dapat disambungkan ulang oleh operator workspace.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Alasan Pemulihan (Wajib)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Contoh: Klarifikasi tiket telah diselesaikan"
                    rows={3}
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Kode TOTP Operator</label>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6 digit kode autentikator"
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setIsActivateModalOpen(false)}
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={activateMutation.isPending || !reason.trim() || !otp.trim()}
                onClick={() => activateMutation.mutate()}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer shadow-xs transition"
              >
                {activateMutation.isPending ? 'Mengaktifkan...' : 'Aktifkan Workspace'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Drawer Preview: Approve */}
      {isApproveModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => {
              setReason('');
              setOtp('');
              setActionError('');
              setIsApproveModalOpen(false);
            }}
          />
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-emerald-600 dark:text-emerald-400">Pratinjau Persetujuan</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Workspace: <strong className="text-slate-800 dark:text-slate-200">{ws.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsApproveModalOpen(false);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                aria-label="Tutup panel persetujuan"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {actionError && (
                <div className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Notice */}
              <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200 rounded-2xl text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Persetujuan Pendaftaran Workspace:</span>
                </div>
                <p className="text-emerald-800 dark:text-emerald-300/90 leading-relaxed text-[11px]">
                  Pendaftaran workspace akan disetujui dan statusnya menjadi aktif. Akun pemilik dapat segera masuk ke dashboard dan memulai operasional gateway.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Alasan Persetujuan (Opsional)
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Contoh: Dokumen kepatuhan dan identitas telah diverifikasi"
                    rows={3}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Kode TOTP Operator <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6 digit kode autentikator"
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsApproveModalOpen(false);
                }}
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={approveMutation.isPending || !otp.trim()}
                onClick={() => approveMutation.mutate()}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer shadow-xs transition"
              >
                {approveMutation.isPending ? 'Menyetujui...' : 'Setujui Workspace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer Preview: Reject */}
      {isRejectModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => {
              setReason('');
              setOtp('');
              setActionError('');
              setIsRejectModalOpen(false);
            }}
          />
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 border-l border-slate-200 dark:border-slate-800 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800 flex items-center justify-center shrink-0">
                  <XCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-rose-600 dark:text-rose-400">Pratinjau Penolakan</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Workspace: <strong className="text-slate-800 dark:text-slate-200">{ws.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsRejectModalOpen(false);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                aria-label="Tutup panel penolakan"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {actionError && (
                <div className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}

              {/* Warning Notice */}
              <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-rose-900 dark:text-rose-200 rounded-2xl text-xs space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <ShieldAlert className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                  <span>Dampak Penolakan Workspace:</span>
                </div>
                <p className="text-rose-800 dark:text-rose-300/90 leading-relaxed text-[11px]">
                  Pendaftaran workspace akan ditolak. Pemilik tidak dapat masuk dan akan mendapatkan pesan bahwa pendaftaran ditolak. Anda tetap dapat menyetujui kembali kemudian bila diperlukan.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Alasan Penolakan <span className="text-rose-500">*</span>
                    </label>
                    <span className="text-[10px] text-slate-400">Min. 3 karakter</span>
                  </div>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Wajib diisi (minimal 3 karakter). Contoh: Nama workspace melanggar hak cipta"
                    rows={3}
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-rose-500"
                  />
                  {reason.trim().length > 0 && reason.trim().length < 3 && (
                    <p className="text-[11px] text-rose-600 mt-0.5">Alasan penolakan minimal harus 3 karakter.</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Kode TOTP Operator <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6 digit kode autentikator"
                    required
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider focus:outline-hidden focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setReason('');
                  setOtp('');
                  setActionError('');
                  setIsRejectModalOpen(false);
                }}
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={rejectMutation.isPending || reason.trim().length < 3 || !otp.trim()}
                onClick={() => rejectMutation.mutate()}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer shadow-xs transition"
              >
                {rejectMutation.isPending ? 'Menolak...' : 'Tolak Pendaftaran'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
