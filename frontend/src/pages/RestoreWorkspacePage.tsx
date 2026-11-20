import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { DeletedWorkspaceItem, RestoreWorkspaceResponseData } from '../types';
import {
  ArchiveRestore,
  Mail,
  Lock,
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  CheckCircle2,
  Calendar,
  AlertCircle,
  HelpCircle,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';

export const RestoreWorkspacePage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // States
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);
  const [workspaces, setWorkspaces] = useState<DeletedWorkspaceItem[]>([]);

  // Selection & Restore
  const [selectedWorkspace, setSelectedWorkspace] = useState<DeletedWorkspaceItem | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState<RestoreWorkspaceResponseData | null>(null);

  const navigate = useNavigate();

  const handleSearchWorkspaces = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError('');
    setLoadingSearch(true);
    setSearched(false);
    setSelectedWorkspace(null);

    try {
      const data = await api.listDeletedWorkspaces({
        email: email.trim(),
        password,
      });
      setWorkspaces(data || []);
      setSearched(true);
    } catch (err: any) {
      setSearchError(err.message || 'Gagal mencari daftar workspace yang terhapus.');
    } finally {
      setLoadingSearch(false);
    }
  };

  const handleExecuteRestore = async () => {
    if (!selectedWorkspace) return;
    setRestoring(true);
    setRestoreError('');

    try {
      const data = await api.restoreWorkspace({
        email: email.trim(),
        password,
        tenant_id: selectedWorkspace.tenant_id,
      });
      setRestoreSuccess(data);
      setConfirmModalOpen(false);
    } catch (err: any) {
      setRestoreError(err.message || 'Gagal memulihkan workspace.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-950 font-sans antialiased text-slate-900">
      {/* Left Column: Branding info */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-between p-12 bg-slate-950 text-white overflow-hidden border-r border-slate-800">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-teal-500/15 rounded-full blur-3xl pointer-events-none" />

        {/* Top: Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Logo"
            className="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-emerald-500/30 border border-emerald-500/40"
          />
          <div>
            <span className="font-bold text-white text-base tracking-tight block">WAZAP GATEWAY</span>
            <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider block">
              Disaster Recovery & Workspace Restore
            </span>
          </div>
        </div>

        {/* Middle: Content */}
        <div className="relative z-10 space-y-6 my-auto py-8 max-w-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <ArchiveRestore className="w-4 h-4 text-amber-400" />
            <span>Masa Tenggang 30 Hari</span>
          </div>

          <h1 className="text-3xl xl:text-4xl font-extrabold tracking-tight text-white leading-tight">
            Pemulihan Workspace yang Telah Dihapus
          </h1>

          <p className="text-slate-400 text-sm leading-relaxed">
            Workspace yang dihapus oleh Pemilik (Owner) disimpan sementara selama 30 hari sebelum dihapus permanen dari sistem. Anda dapat memulihkan kembali seluruh keanggotaan dan kuota dalam masa tenggang tersebut.
          </p>

          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2 text-xs text-slate-300">
            <h4 className="font-bold text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              Catatan Penting Setelah Pemulihan:
            </h4>
            <ul className="list-disc list-inside space-y-1 text-slate-400 leading-relaxed text-[11px]">
              <li>Koneksi sesi WhatsApp harus dipasangkan (scan QR) ulang.</li>
              <li>Kunci API (API Keys) dan endpoint Webhook harus didaftarkan ulang demi keamanan.</li>
              <li>Tautan undangan yang belum sempat diterima harus diterbitkan ulang.</li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="relative z-10 flex items-center justify-between text-xs text-slate-500 pt-6 border-t border-slate-800/60">
          <span>© 2026 WAZAP Gateway Enterprise</span>
          <span className="font-mono text-[11px]">ADR-037 Compliant</span>
        </div>
      </div>

      {/* Right Column: Restore Workflow */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-12 bg-slate-950 lg:bg-slate-50 relative overflow-y-auto">
        <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl p-8 sm:p-10 border border-slate-100 relative z-10 my-auto">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center mx-auto mb-3 shadow-xs">
              <ArchiveRestore className="w-6 h-6" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">
              Pulihkan Workspace
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Masukkan kredensial akun Owner Anda untuk mencari workspace yang dapat dipulihkan
            </p>
          </div>

          {/* Success Result View */}
          {restoreSuccess ? (
            <div className="space-y-6">
              <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl text-center space-y-3">
                <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
                <h3 className="text-base font-bold text-emerald-950">
                  Workspace Berhasil Dipulihkan!
                </h3>
                <p className="text-xs text-emerald-800 leading-relaxed">
                  Workspace <strong>{restoreSuccess.tenant.name}</strong> telah aktif kembali. Silakan login menggunakan akun Anda untuk mulai menggunakannya.
                </p>

                {restoreSuccess.must_recreate && restoreSuccess.must_recreate.length > 0 && (
                  <div className="mt-4 p-3 bg-white/80 rounded-xl border border-emerald-200 text-left text-[11px] text-emerald-900">
                    <span className="font-bold block mb-1">Perlu Dibuat / Dikonfigurasi Ulang:</span>
                    <ul className="list-disc list-inside space-y-0.5 text-slate-700">
                      {restoreSuccess.must_recreate.map((item, idx) => (
                        <li key={idx} className="capitalize">{item.replace(/_/g, ' ')}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-lg shadow-emerald-600/25"
              >
                <span>Masuk Sekarang</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Form Search Credential */}
              <form onSubmit={handleSearchWorkspaces} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Email Akun Owner
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="owner@perusahaan.com"
                      required
                      className="w-full pl-10 pr-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Kata Sandi Akun
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      className="w-full pl-10 pr-10 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600 transition"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {searchError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>{searchError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loadingSearch}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs sm:text-sm font-bold transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingSearch ? 'animate-spin' : ''}`} />
                  <span>{loadingSearch ? 'Mencari Workspace...' : 'Cari Workspace Terhapus'}</span>
                </button>
              </form>

              {/* Workspaces List Result */}
              {searched && (
                <div className="pt-4 border-t border-slate-100 space-y-3">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Daftar Workspace Terhapus ({workspaces.length})
                  </h3>

                  {workspaces.length === 0 ? (
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-center text-xs text-slate-500">
                      Tidak ditemukan workspace terhapus dalam masa tenggang untuk akun ini.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {workspaces.map((ws) => (
                        <div
                          key={ws.tenant_id}
                          className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 hover:bg-emerald-50/30 hover:border-emerald-200 transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                        >
                          <div>
                            <h4 className="text-sm font-bold text-slate-900">{ws.name}</h4>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 mt-1">
                              <span>Slug: <code className="text-slate-700">{ws.slug}</code></span>
                              <span>•</span>
                              <span className="flex items-center gap-1 text-amber-700 font-medium">
                                <Calendar className="w-3.5 h-3.5" />
                                Hingga: {new Date(ws.restorable_until).toLocaleDateString('id-ID')}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedWorkspace(ws);
                              setConfirmModalOpen(true);
                            }}
                            className="shrink-0 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
                          >
                            Pulihkan
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Navigation Back */}
              <div className="pt-4 border-t border-slate-100 text-center text-xs text-slate-500">
                Kembali ke halaman{' '}
                <Link to="/login" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                  Masuk Akun
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmModalOpen && selectedWorkspace && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-3xl p-6 sm:p-7 shadow-2xl border border-slate-100 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center mx-auto">
              <ArchiveRestore className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-lg font-bold text-slate-900">
                Konfirmasi Pemulihan Workspace
              </h3>
              <p className="text-xs text-slate-500">
                Anda akan mengaktifkan kembali workspace: <strong>{selectedWorkspace.name}</strong>
              </p>
            </div>

            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl text-[11px] text-amber-900 space-y-1.5 leading-relaxed">
              <div className="font-bold flex items-center gap-1.5 text-amber-800">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
                <span>Peringatan Wajib Diketahui:</span>
              </div>
              <p>
                Setelah pemulihan, sesi WhatsApp, Kunci API, dan Webhook harus dibuat atau dikonfigurasi ulang secara manual untuk alasan keamanan integritas gateway.
              </p>
            </div>

            {restoreError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{restoreError}</span>
              </div>
            )}

            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setConfirmModalOpen(false)}
                disabled={restoring}
                className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 transition"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteRestore}
                disabled={restoring}
                className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-50"
              >
                {restoring ? 'Memulihkan...' : 'Ya, Pulihkan Sekarang'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
