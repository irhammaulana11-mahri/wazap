import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { platformApi, PlatformDefaultsResult } from '../../services/platformApi';
import {
  Sliders,
  Smartphone,
  Key,
  Users,
  Activity,
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  Clock,
} from 'lucide-react';

export const PlatformDefaultsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [maxSessions, setMaxSessions] = useState<number | ''>('');
  const [maxApiKeys, setMaxApiKeys] = useState<number | ''>('');
  const [maxMembers, setMaxMembers] = useState<number | ''>('');
  const [messagesPerMinute, setMessagesPerMinute] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  const { data: defaults, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-defaults'],
    queryFn: () => platformApi.getDefaults(),
  });

  const openEditModal = () => {
    if (defaults) {
      setMaxSessions(defaults.limits.max_sessions);
      setMaxApiKeys(defaults.limits.max_api_keys);
      setMaxMembers(defaults.limits.max_members);
      setMessagesPerMinute(defaults.limits.messages_per_minute);
    }
    setReason('');
    setOtp('');
    setActionError('');
    setIsEditModalOpen(true);
  };

  const updateMutation = useMutation({
    mutationFn: () => {
      const payload: any = {
        reason: reason.trim(),
        otp: otp.trim(),
      };
      if (maxSessions !== '') payload.max_sessions = Number(maxSessions);
      if (maxApiKeys !== '') payload.max_api_keys = Number(maxApiKeys);
      if (maxMembers !== '') payload.max_members = Number(maxMembers);
      if (messagesPerMinute !== '') payload.messages_per_minute = Number(messagesPerMinute);
      return platformApi.updateDefaults(payload);
    },
    onSuccess: () => {
      setIsEditModalOpen(false);
      setActionSuccess('Kuota bawaan untuk workspace baru berhasil diperbarui.');
      queryClient.invalidateQueries({ queryKey: ['platform-defaults'] });
      setTimeout(() => setActionSuccess(''), 5000);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Gagal memperbarui kuota bawaan.');
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2.5">
            <Sliders className="w-6 h-6 text-purple-600 dark:text-purple-400" />
            <span>Kuota Bawaan Workspace Baru</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Menentukan batasan kuota awal yang diterapkan secara otomatis saat workspace baru dibuat.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold transition disabled:opacity-50 shadow-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-purple-600 dark:text-purple-400' : ''}`} />
            <span>Segarkan</span>
          </button>

          <button
            type="button"
            onClick={openEditModal}
            disabled={isLoading || isError}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-50 cursor-pointer"
          >
            Ubah Nilai Default
          </button>
        </div>
      </div>

      {actionSuccess && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 rounded-2xl text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {isLoading ? (
        <div className="p-12 text-center text-slate-400 text-xs">
          <span>Memuat data kuota bawaan...</span>
        </div>
      ) : isError ? (
        <div className="p-8 text-center text-rose-500 text-xs flex items-center justify-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{(error as Error)?.message || 'Gagal memuat kuota bawaan.'}</span>
        </div>
      ) : defaults ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Max Sessions */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Sesi WhatsApp</span>
                <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
                  <Smartphone className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-bold font-mono text-slate-900 dark:text-white">
                  {defaults.limits.max_sessions}
                  <span className="text-xs font-normal text-slate-400 ml-1">sesi</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Batas rentang: {defaults.minimums.max_sessions} - {defaults.ceilings.max_sessions}
                </p>
              </div>
            </div>

            {/* Max API Keys */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Kunci API</span>
                <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
                  <Key className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-bold font-mono text-slate-900 dark:text-white">
                  {defaults.limits.max_api_keys}
                  <span className="text-xs font-normal text-slate-400 ml-1">kunci</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Batas rentang: {defaults.minimums.max_api_keys} - {defaults.ceilings.max_api_keys}
                </p>
              </div>
            </div>

            {/* Max Members */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Anggota Tim</span>
                <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
                  <Users className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-bold font-mono text-slate-900 dark:text-white">
                  {defaults.limits.max_members}
                  <span className="text-xs font-normal text-slate-400 ml-1">akun</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Batas rentang: {defaults.minimums.max_members} - {defaults.ceilings.max_members}
                </p>
              </div>
            </div>

            {/* Messages Per Minute */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Rate Limit</span>
                <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400">
                  <Activity className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-bold font-mono text-slate-900 dark:text-white">
                  {defaults.limits.messages_per_minute}
                  <span className="text-xs font-normal text-slate-400 ml-1">msg/m</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Batas rentang: {defaults.minimums.messages_per_minute} - {defaults.ceilings.messages_per_minute}
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 shadow-xs">
            <span className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <span>Terakhir diperbarui: {new Date(defaults.updated_at).toLocaleString('id-ID')}</span>
            </span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              Perubahan hanya berlaku untuk registrasi workspace berikutnya.
            </span>
          </div>
        </div>
      ) : null}

      {/* Modal Edit Defaults */}
      {isEditModalOpen && defaults && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Ubah Kuota Bawaan Sistem</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Nilai yang sama dengan saat ini akan dilewati secara otomatis.
              </p>
            </div>

            {actionError && (
              <div className="p-3 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 rounded-xl text-xs">
                {actionError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Sesi WA</label>
                <input
                  type="number"
                  value={maxSessions}
                  onChange={(e) => setMaxSessions(e.target.value === '' ? '' : Number(e.target.value))}
                  min={defaults.minimums.max_sessions}
                  max={defaults.ceilings.max_sessions}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Kunci API</label>
                <input
                  type="number"
                  value={maxApiKeys}
                  onChange={(e) => setMaxApiKeys(e.target.value === '' ? '' : Number(e.target.value))}
                  min={defaults.minimums.max_api_keys}
                  max={defaults.ceilings.max_api_keys}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Batas Anggota</label>
                <input
                  type="number"
                  value={maxMembers}
                  onChange={(e) => setMaxMembers(e.target.value === '' ? '' : Number(e.target.value))}
                  min={defaults.minimums.max_members}
                  max={defaults.ceilings.max_members}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Throughput (msg/m)</label>
                <input
                  type="number"
                  value={messagesPerMinute}
                  onChange={(e) => setMessagesPerMinute(e.target.value === '' ? '' : Number(e.target.value))}
                  min={defaults.minimums.messages_per_minute}
                  max={defaults.ceilings.messages_per_minute}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Alasan Kebijakan (Wajib)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Contoh: Penyesuaian paket tier gratis platform v2.1"
                rows={2}
                required
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white"
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
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-900 dark:text-white font-mono tracking-wider"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setIsEditModalOpen(false)}
                className="px-4 py-2 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={updateMutation.isPending || !reason.trim() || !otp.trim()}
                onClick={() => updateMutation.mutate()}
                className="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
              >
                {updateMutation.isPending ? 'Menyimpan...' : 'Simpan Perubahan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
