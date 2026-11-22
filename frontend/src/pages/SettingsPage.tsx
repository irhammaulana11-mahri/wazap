import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import {
  Sliders,
  Smartphone,
  Key,
  Users,
  Activity,
  Check,
  AlertCircle,
  Lock,
  Crown,
  RotateCcw,
  Save,
  ShieldCheck,
  Building2,
  Trash2,
  AlertTriangle,
  Info,
  Layers,
  Sparkles,
  ArrowRight,
  HelpCircle,
  Database,
  Download,
  Clock,
  History,
  MessageSquare,
  Bell,
} from 'lucide-react';
import { ExportType } from '../types';
import { ExportDrawer } from '../components/export/ExportDrawer';
import { AlertsTab } from '../components/alerts/AlertsTab';

export const SettingsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { role, tenant, refetchUser } = useAuth();
  const { showToast } = useToast();
  const isOwner = role === 'OWNER';
  const canExport = isOwner;
  const canManageAlerts = isOwner;

  // Active Tab: 'quota' | 'general' | 'data' | 'danger'
  const activeTab = searchParams.get('tab') || 'quota';
  const setActiveTab = (tab: string) => {
    setSearchParams({ tab });
  };

  // Export drawer state & policy
  const [isExportDrawerOpen, setIsExportDrawerOpen] = useState(false);
  const [exportDrawerType, setExportDrawerType] = useState<ExportType>('messages');
  const openExportDrawer = (type: ExportType) => {
    setExportDrawerType(type);
    setIsExportDrawerOpen(true);
  };

  const { data: exportPolicy } = useQuery({
    queryKey: ['export-policy'],
    queryFn: () => api.getExportPolicy(),
    staleTime: 60_000,
  });

  // Workspace Name State
  const [workspaceName, setWorkspaceName] = useState(tenant?.name || '');
  const [renameSuccess, setRenameSuccess] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);

  // Delete Workspace State
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Fetch settings
  const {
    data: settings,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: api.getTenantSettings,
  });

  useEffect(() => {
    if (tenant?.name) {
      setWorkspaceName(tenant.name);
    }
  }, [tenant]);

  const handleRenameWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceName.trim()) return;
    setRenameLoading(true);
    setRenameError('');
    setRenameSuccess('');

    try {
      await api.renameTenant(workspaceName.trim());
      setRenameSuccess('Nama workspace berhasil diperbarui.');
      await refetchUser();
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] });
      setTimeout(() => setRenameSuccess(''), 4000);
    } catch (err: any) {
      setRenameError(err.message || 'Gagal mengubah nama workspace.');
    } finally {
      setRenameLoading(false);
    }
  };

  const handleDeleteWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (deleteConfirmName.trim() !== tenant?.name) {
      setDeleteError(`Konfirmasi nama workspace harus tepat sesuai "${tenant?.name}".`);
      return;
    }

    setDeleteLoading(true);
    setDeleteError('');

    try {
      const res = await api.deleteTenant(deletePassword, deleteConfirmName.trim());
      showToast(
        'success',
        `Workspace "${res.name}" berhasil dihapus dan dijadwalkan untuk dibersihkan setelah ${res.purged_after_days} hari.`
      );
      setTimeout(() => {
        queryClient.clear();
        window.location.href = '/login';
      }, 1200);
    } catch (err: any) {
      if (err.status === 403 || err.code === 'INVALID_PASSWORD') {
        setDeleteError('Kata sandi pemilik salah.');
      } else {
        setDeleteError(err.message || 'Gagal menghapus workspace.');
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  if (isLoading) return <LoadingState message="Memuat pengaturan kuota dan konfigurasi workspace..." />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const limits = settings?.limits;
  const minimums = settings?.minimums;
  const ceilings = settings?.ceilings;
  const used = settings?.used;

  return (
    <div className="space-y-6">
      {/* Header Banner Card with Tab Navigation */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xs p-6 sm:p-7 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                Pengaturan
              </h1>
              <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                <Crown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>{isOwner ? 'Kewenangan Owner' : 'Kewenangan Admin'}</span>
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              Kelola alokasi kuota gateway, kanal notifikasi alarm, data & privasi, serta identitas workspace <span className="font-semibold text-slate-700 dark:text-slate-200">{tenant?.name}</span>.
            </p>
          </div>

          {/* Quick Info Box */}
          <div className="flex items-center gap-3 p-3 sm:px-4 sm:py-3 bg-slate-50 dark:bg-slate-950/60 rounded-2xl border border-slate-200/80 dark:border-slate-800 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider block">
                Workspace
              </span>
              <span className="text-sm font-bold text-slate-900 dark:text-white block truncate max-w-[180px]">
                {tenant?.name || 'Workspace'}
              </span>
            </div>
          </div>
        </div>

        {/* Tab Segmented Navigation */}
        <div className="flex items-center gap-1.5 mt-7 pt-4 border-t border-slate-100 dark:border-slate-800 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab('quota')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
              activeTab === 'quota'
                ? 'bg-slate-900 dark:bg-emerald-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100/70 dark:hover:bg-slate-800'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Alokasi Kuota Gateway</span>
          </button>

          {isOwner && (
            <button
              type="button"
              onClick={() => setActiveTab('general')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
                activeTab === 'general'
                  ? 'bg-slate-900 dark:bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100/70 dark:hover:bg-slate-800'
              }`}
            >
              <Building2 className="w-4 h-4" />
              <span>Identitas & Nama Workspace</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setActiveTab('data')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
              activeTab === 'data'
                ? 'bg-slate-900 dark:bg-emerald-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100/70 dark:hover:bg-slate-800'
            }`}
          >
            <Database className="w-4 h-4" />
            <span>Data & Privasi</span>
          </button>

          {canManageAlerts && (
            <button
              type="button"
              onClick={() => setActiveTab('notifications')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
                activeTab === 'notifications'
                  ? 'bg-slate-900 dark:bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100/70 dark:hover:bg-slate-800'
              }`}
            >
              <Bell className="w-4 h-4" />
              <span>Notifikasi & Alarm</span>
            </button>
          )}

          {isOwner && (
            <button
              type="button"
              onClick={() => setActiveTab('danger')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
                activeTab === 'danger'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-rose-700 dark:text-rose-400 hover:text-rose-900 dark:hover:text-rose-200 hover:bg-rose-50 dark:hover:bg-rose-950/40'
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
              <span>Zona Bahaya</span>
            </button>
          )}
        </div>
      </div>

      {/* TAB 1: ALOKASI KUOTA GATEWAY */}
      {activeTab === 'quota' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* Read-Only Notice */}
          <div className="p-4 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/50 rounded-2xl text-xs text-blue-900 dark:text-blue-200 flex items-start gap-3 shadow-2xs">
            <ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-blue-100 dark:bg-blue-900/70 text-blue-800 dark:text-blue-300 border border-blue-300 dark:border-blue-700">
                  Dikelola Platform
                </span>
                <span className="font-bold text-slate-900 dark:text-white">Alokasi Kuota Terkunci</span>
              </div>
              <p className="leading-relaxed text-blue-700 dark:text-blue-300/90">
                Kuota diatur oleh pemilik platform. Hubungi pemilik platform untuk menambah atau mengubahnya.
              </p>
            </div>
          </div>

          {/* Quota Usage Cards (Read-Only) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* 1. Max WhatsApp Sessions */}
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-6 shadow-xs space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-800">
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white text-sm">Batas Sesi WhatsApp</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Jumlah sesi perangkat aktif bersamaan</p>
                  </div>
                </div>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 shrink-0">
                  Dipakai: <strong className="text-emerald-700 dark:text-emerald-400">{used?.sessions ?? 0}</strong> / {limits?.max_sessions ?? 5}
                </span>
              </div>

              {/* Progress Bar Usage vs Limit */}
              <div className="space-y-1.5 pt-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  <span>Terpakai saat ini: {used?.sessions ?? 0} dari {limits?.max_sessions ?? 5}</span>
                  <span>{Math.round(((used?.sessions ?? 0) / Math.max(1, limits?.max_sessions ?? 5)) * 100)}%</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      (used?.sessions ?? 0) >= (limits?.max_sessions ?? 5) ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (((used?.sessions ?? 0) / Math.max(1, limits?.max_sessions ?? 5)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 2. Messages Rate Limit Throughput */}
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-6 shadow-xs space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
                    <Activity className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white text-sm">Batas Kecepatan (Rate Limit)</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Throughput pesan keluar per menit</p>
                  </div>
                </div>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800 shrink-0">
                  {limits?.messages_per_minute ?? 60} msg/mnt
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/40 rounded-2xl border border-slate-100 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                Menjaga throughput gateway tetap stabil menggunakan algoritma <em>Token Bucket</em> anti-ban WhatsApp.
              </div>
            </div>

            {/* 3. Max API Keys */}
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-6 shadow-xs space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-800">
                    <Key className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white text-sm">Batas Kunci REST API</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Jumlah token integrasi sistem eksternal</p>
                  </div>
                </div>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 shrink-0">
                  Dipakai: <strong className="text-amber-700 dark:text-amber-400">{used?.api_keys ?? 0}</strong> / {limits?.max_api_keys ?? 5}
                </span>
              </div>

              {/* Progress Bar */}
              <div className="space-y-1.5 pt-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  <span>Terpakai saat ini: {used?.api_keys ?? 0} dari {limits?.max_api_keys ?? 5}</span>
                  <span>{Math.round(((used?.api_keys ?? 0) / Math.max(1, limits?.max_api_keys ?? 5)) * 100)}%</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      (used?.api_keys ?? 0) >= (limits?.max_api_keys ?? 5) ? 'bg-amber-500' : 'bg-amber-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (((used?.api_keys ?? 0) / Math.max(1, limits?.max_api_keys ?? 5)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 4. Max Team Members */}
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-6 shadow-xs space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border border-purple-100 dark:border-purple-800">
                    <Users className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 dark:text-white text-sm">Batas Anggota Tim</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Kapasitas akun staf dalam organisasi</p>
                  </div>
                </div>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 shrink-0">
                  Dipakai: <strong className="text-purple-700 dark:text-purple-400">{used?.members ?? 0}</strong> / {limits?.max_members ?? 5}
                </span>
              </div>

              {/* Progress Bar */}
              <div className="space-y-1.5 pt-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                  <span>Terpakai saat ini: {used?.members ?? 0} dari {limits?.max_members ?? 5}</span>
                  <span>{Math.round(((used?.members ?? 0) / Math.max(1, limits?.max_members ?? 5)) * 100)}%</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      (used?.members ?? 0) >= (limits?.max_members ?? 5) ? 'bg-amber-500' : 'bg-purple-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (((used?.members ?? 0) / Math.max(1, limits?.max_members ?? 5)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: IDENTITAS & NAMA WORKSPACE */}
      {activeTab === 'general' && isOwner && (
        <div className="space-y-6 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xs p-6 sm:p-7 space-y-5">
            <div className="flex items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white text-base">Ubah Nama Workspace</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Perbarui nama organisasi gateway. Nama baru akan segera terlihat oleh seluruh anggota tim dan di header dashboard.
                </p>
              </div>
            </div>

            <form onSubmit={handleRenameWorkspace} className="space-y-4 max-w-lg">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Nama Workspace Resmi
                </label>
                <input
                  type="text"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="Contoh: PT Gateway Nusantara"
                  required
                  minLength={2}
                  maxLength={100}
                  className="w-full px-3.5 py-2.5 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {renameError && (
                <div className="p-3 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{renameError}</span>
                </div>
              )}

              {renameSuccess && (
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{renameSuccess}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={renameLoading || workspaceName.trim() === tenant?.name}
                className="py-2.5 px-5 bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-40"
              >
                {renameLoading ? 'Menyimpan...' : 'Simpan Nama Workspace'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB: DATA & PRIVASI (EKSPOR DATA & RETENSI ADR-048) */}
      {activeTab === 'data' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xs p-6 sm:p-7 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-800">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-base">Kebijakan Retensi & Ekspor Data</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Transparansi masa simpan data dan unduhan arsip resmi untuk kepatuhan privasi (ADR-048).
                  </p>
                </div>
              </div>

              {exportPolicy?.enabled === false && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Ekspor Dinonaktifkan Operator
                </span>
              )}
            </div>

            {/* Retention Stat Cards (Visible for ALL roles: OWNER, MEMBER, VIEWER) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
                  <span>Retensi Isi Pesan</span>
                  <Clock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">
                  {exportPolicy ? exportPolicy.retention.content_days : '—'}{' '}
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Hari</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Isi teks pesan yang lebih tua dari periode ini dibersihkan otomatis demi privasi (kolom teks dikosongkan).
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
                  <span>Retensi Baris Pesan & Chat</span>
                  <History className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">
                  {exportPolicy ? exportPolicy.retention.row_days : '—'}{' '}
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Hari</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Seluruh metadata baris pesan dan chat yang melampaui batas ini dihapus secara permanen dari basis data.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium">
                  <span>Retensi Log Audit</span>
                  <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">
                  {exportPolicy ? exportPolicy.retention.audit_days : '—'}{' '}
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Hari</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Rekaman jejak aktivitas, perubahan setelan, dan tindakan anggota tim disimpan untuk audit kepatuhan.
                </p>
              </div>
            </div>

            {/* Ekspor Bagian: OWNER */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-sm font-bold text-slate-900 dark:text-white">Katalog Ekspor Data Workspace</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Pilih kategori data yang ingin diunduh dalam format CSV Spreadsheet atau NDJSON.
                  </p>
                </div>
                {canExport && exportPolicy && (
                  <span className="text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-1 rounded-lg">
                    Batas: <strong>{exportPolicy.per_hour}x</strong> ekspor / jam per pengguna
                  </span>
                )}
              </div>

              {canExport ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {/* Messages Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3">
                        <MessageSquare className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Pesan Obrolan (Messages)</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Riwayat pesan masuk (inbound) & keluar (outbound), waktu tiba, nomor pengirim, dan status.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">{exportPolicy ? `Rentang s/d ${exportPolicy.max_span_days} hari` : '—'}</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('messages')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>

                  {/* Outbound Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-3">
                        <Activity className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Antrean Pesan Keluar (Outbox)</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Log pengiriman pesan gateway, status antrean (SENT, DELIVERED, READ, FAILED), dan penerima.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">{exportPolicy ? `Rentang s/d ${exportPolicy.max_span_days} hari` : '—'}</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('outbound')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>

                  {/* Chats Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-3">
                        <Layers className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Daftar Obrolan (Chats)</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Daftar percakapan aktif per nomor kontak, sesi WhatsApp terkait, dan timestamp aktivitas terakhir.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">Snapshot total chat</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('chats')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>

                  {/* Contacts Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-3">
                        <Smartphone className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Kontak Pelanggan (Contacts)</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Daftar kontak pelanggan 1:1 unik lintas seluruh sesi WhatsApp dengan nama tampilan dan jumlah obrolan.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">Unik per nomor</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('contacts')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>

                  {/* Audit Logs Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center mb-3">
                        <ShieldCheck className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Log Audit Workspace</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Catatan audit seluruh aktivitas workspace: login, perubahan setelan kuota, rotasi webhook/API key.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">{exportPolicy ? `Rentang s/d ${exportPolicy.max_span_days} hari` : '—'}</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('audit-logs')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>

                  {/* Members Card */}
                  <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-all shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mb-3">
                        <Users className="w-4 h-4" />
                      </div>
                      <h5 className="text-xs font-bold text-slate-900 dark:text-white">Anggota Tim & Hak Akses</h5>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        Daftar seluruh anggota workspace, email terdaftar, peran (OWNER, MEMBER, VIEWER), dan waktu bergabung.
                      </p>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">Snapshot anggota tim</span>
                      <button
                        type="button"
                        onClick={() => openExportDrawer('members')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Ekspor</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-2xl flex items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
                  <Info className="w-5 h-5 text-slate-400 shrink-0" />
                  <span>
                    Fitur pengunduhan ekspor data dibatasi hanya untuk <strong>Pemilik (OWNER)</strong> dan <strong>Administrator</strong> workspace.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB: NOTIFIKASI & ALARM (ADR-049) */}
      {activeTab === 'notifications' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {canManageAlerts ? (
            <AlertsTab />
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-12 text-center space-y-3 shadow-xs">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 flex items-center justify-center mx-auto">
                <Lock className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Akses Dibatasi</h3>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Hanya pemilik workspace (OWNER) yang memiliki wewenang untuk mengelola kanal dan aturan notifikasi alarm.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: DANGER ZONE & WORKSPACE DELETION */}
      {activeTab === 'danger' && isOwner && (
        <div className="space-y-6 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-rose-200 dark:border-rose-900/60 shadow-xs p-6 sm:p-7 space-y-5">
            <div className="flex items-center gap-3 pb-4 border-b border-rose-100 dark:border-rose-900/40">
              <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-rose-950 dark:text-rose-200 text-base">Penghapusan Workspace Permanen</h3>
                <p className="text-xs text-rose-700 dark:text-rose-400 mt-0.5">
                  Tindakan penting yang memicu pencabutan seluruh sesi WhatsApp, API key, webhook, dan riwayat obrolan.
                </p>
              </div>
            </div>

            {/* Recommendation to export data first */}
            <div className="p-4 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900/50 rounded-2xl flex items-start gap-3">
              <Download className="w-5 h-5 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
              <div className="text-xs text-sky-900 dark:text-sky-200 leading-relaxed flex-1">
                <span className="font-bold block mb-0.5">Saran: Ekspor Data Anda Terlebih Dahulu</span>
                Sebelum menghapus workspace, Anda sangat disarankan untuk mengunduh arsip pesan, kontak, antrean pengiriman, dan log audit workspace ini.
                <div className="mt-2.5">
                  <button
                    type="button"
                    onClick={() => setActiveTab('data')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                  >
                    <Database className="w-3.5 h-3.5" />
                    <span>Buka Tab Data & Privasi</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Explanatory Policy Box */}
            <div className="p-4 bg-rose-50/70 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 rounded-2xl space-y-2 text-xs text-rose-900 dark:text-rose-200 leading-relaxed">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-rose-100 dark:bg-rose-900/70 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                  Kebijakan ADR-037
                </span>
                <span className="font-bold text-slate-900 dark:text-white">Ketentuan Penghapusan Workspace</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-rose-800 dark:text-rose-300/90">
                <li>Workspace akan dinonaktifkan seketika dari sistem seluruh anggota tim.</li>
                <li>Data disimpan sementara dalam masa tenggang <strong>30 hari</strong> sebelum dibersihkan permanen oleh database vacuum.</li>
                <li>Selama 30 hari masa tenggang, Pemilik dapat memulihkan workspace melalui menu pemulihan bencana (<em>Disaster Recovery</em>) dengan catatan koneksi QR WhatsApp, API key, dan webhook harus didaftarkan ulang.</li>
              </ul>
            </div>

            <form onSubmit={handleDeleteWorkspace} className="space-y-4 max-w-lg pt-2">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Ketik nama workspace persis (<span className="font-mono text-rose-600 dark:text-rose-400 select-all font-bold">{tenant?.name}</span>) untuk konfirmasi:
                </label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  placeholder={tenant?.name || ''}
                  required
                  className="w-full px-3.5 py-2.5 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Masukkan Kata Sandi Akun Pemilik (Owner)
                </label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  className="w-full px-3.5 py-2.5 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              {deleteError && (
                <div className="p-3 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{deleteError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={deleteLoading || deleteConfirmName !== tenant?.name}
                className="py-3 px-5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>{deleteLoading ? 'Menghapus Workspace...' : 'Hapus Workspace Ini Selamanya'}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Export Drawer */}
      <ExportDrawer
        isOpen={isExportDrawerOpen}
        onClose={() => setIsExportDrawerOpen(false)}
        initialType={exportDrawerType}
      />
    </div>
  );
};
