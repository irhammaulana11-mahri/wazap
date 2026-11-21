import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { RecoveryCodeModal } from '../components/auth/RecoveryCodeModal';
import {
  User,
  Building2,
  Crown,
  ShieldCheck,
  Shield,
  Eye,
  EyeOff,
  Sliders,
  Smartphone,
  Key,
  Users,
  Activity,
  Copy,
  Check,
  Lock,
  ExternalLink,
  ShieldAlert,
  Calendar,
  Layers,
  Cpu,
  LogOut,
  KeyRound,
  Mail,
  AlertTriangle,
  AlertCircle,
  HelpCircle,
  CheckCircle2,
  Info,
} from 'lucide-react';

export const ProfilePage: React.FC = () => {
  const { user, tenant, role, memberships, recovery, refetchUser, logout } = useAuth();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Active Tab: 'overview' | 'security' | 'quota'
  const activeTab = searchParams.get('tab') || 'overview';
  const setActiveTab = (tab: string) => {
    setSearchParams({ tab });
  };

  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Account Security States
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState('');

  const [rcPassword, setRcPassword] = useState('');
  const [rcLoading, setRcLoading] = useState(false);
  const [rcError, setRcError] = useState('');
  const [newlyIssuedRcs, setNewlyIssuedRcs] = useState<string[] | null>(null);

  const [logoutAllLoading, setLogoutAllLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwLoading(true);
    setPwError('');
    setPwSuccess('');

    if (newPassword.length < 10) {
      setPwError('Kata sandi baru minimal harus 10 karakter.');
      setPwLoading(false);
      return;
    }

    try {
      await api.changePassword(currentPassword, newPassword);
      setPwSuccess('Kata sandi berhasil diperbarui! Sesi login pada perangkat lain telah dicabut.');
      setCurrentPassword('');
      setNewPassword('');
      showToast('success', 'Kata sandi berhasil diubah.');
    } catch (err: any) {
      if (err.status === 403 || err.code === 'INVALID_PASSWORD') {
        setPwError('Kata sandi saat ini salah.');
      } else {
        setPwError(err.message || 'Gagal mengubah kata sandi.');
      }
    } finally {
      setPwLoading(false);
    }
  };

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailLoading(true);
    setEmailError('');
    setEmailSuccess('');

    try {
      await api.changeEmail(emailPassword, newEmail.trim());
      setEmailSuccess('Alamat email berhasil diperbarui!');
      setEmailPassword('');
      setNewEmail('');
      await refetchUser();
      showToast('success', 'Alamat email akun berhasil diubah.');
    } catch (err: any) {
      if (err.status === 403 || err.code === 'INVALID_PASSWORD') {
        setEmailError('Kata sandi saat ini salah.');
      } else if (err.code === 'EMAIL_TAKEN' || err.status === 409) {
        setEmailError('Alamat email ini sudah terdaftar pada akun lain.');
      } else {
        setEmailError(err.message || 'Gagal mengubah email.');
      }
    } finally {
      setEmailLoading(false);
    }
  };

  const handleIssueRecoveryCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setRcLoading(true);
    setRcError('');

    try {
      const res = await api.issueRecoveryCodes(rcPassword);
      setNewlyIssuedRcs(res.recovery_codes);
      setRcPassword('');
    } catch (err: any) {
      if (err.status === 403 || err.code === 'INVALID_PASSWORD') {
        setRcError('Kata sandi saat ini salah.');
      } else {
        setRcError(err.message || 'Gagal membuat kode pemulihan baru.');
      }
    } finally {
      setRcLoading(false);
    }
  };

  const handleLogoutAll = async () => {
    const ok = await confirm({
      title: 'Logout Semua Perangkat',
      message:
        'Yakin ingin keluar dari semua perangkat? Token autentikasi di seluruh peramban dan perangkat aktif lain akan dicabut seketika.',
      confirmLabel: 'Logout Semua Perangkat',
      variant: 'danger',
    });
    if (ok) {
      try {
        setLogoutAllLoading(true);
        await api.logoutAll();
        navigate('/login');
      } catch (err: any) {
        showToast('error', `Gagal logout semua perangkat: ${err.message || 'Terjadi galat.'}`);
      } finally {
        setLogoutAllLoading(false);
      }
    }
  };

  const isOwner = role === 'OWNER';

  // Role display metadata
  const roleMetadata = {
    OWNER: {
      label: 'Owner (Pemilik Workspace)',
      badge: 'bg-amber-50 text-amber-800 border-amber-300',
      icon: <Crown className="w-4 h-4 text-amber-600" />,
      desc: 'Memiliki wewenang mutlak atas alokasi kuota workspace, tim staf & admin, kunci API & webhooks, serta audit log.',
    },
    ADMIN: {
      label: 'Administrator Workspace',
      badge: 'bg-blue-50 text-blue-800 border-blue-300',
      icon: <ShieldCheck className="w-4 h-4 text-blue-600" />,
      desc: 'Wewenang administratif untuk mengelola anggota tim, kunci API, webhooks, dan memantau sesi serta jejak log audit.',
    },
    MEMBER: {
      label: 'Anggota Operasional (Member)',
      badge: 'bg-emerald-50 text-emerald-800 border-emerald-300',
      icon: <Shield className="w-4 h-4 text-emerald-600" />,
      desc: 'Wewenang operasional untuk menghubungkan sesi WhatsApp, mengirim dan membalas obrolan pesan, serta mengelola kontak.',
    },
    VIEWER: {
      label: 'Pengamat (Viewer / Read-Only)',
      badge: 'bg-slate-100 text-slate-700 border-slate-300',
      icon: <Eye className="w-4 h-4 text-slate-600" />,
      desc: 'Wewenang baca-saja untuk memantau aktivitas dasbor dan riwayat obrolan tanpa izin mengubah konfigurasi atau mengirim pesan.',
    },
  };

  const roleInfo = role ? roleMetadata[role] : roleMetadata.MEMBER;

  // Fetch current tenant quota settings & usage
  const { data: settings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: api.getTenantSettings,
    retry: 1,
  });

  const { data: usageSummary } = useQuery({
    queryKey: ['usage-summary'],
    queryFn: api.getUsageSummary,
    retry: 1,
  });

  const handleCopyId = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(label);
    showToast('success', `${label} berhasil disalin ke clipboard`);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const userInitial = user?.email ? user.email.slice(0, 2).toUpperCase() : 'WA';

  // Security warning indicator for Tab pill
  const hasSecurityAlert = recovery && (recovery.confirmed === false || (recovery.codes_remaining != null && recovery.codes_remaining <= 2));

  return (
    <div className="space-y-6">
      {/* Page Header with User Profile Summary Card */}
      <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs p-6 sm:p-7 relative overflow-hidden">
        {/* Decorative Top Accent */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          {/* User Avatar & Info */}
          <div className="flex items-start sm:items-center gap-4 sm:gap-5">
            <div className="relative">
              <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-black text-xl sm:text-2xl flex items-center justify-center shadow-md shadow-emerald-600/20">
                {userInitial}
              </div>
              <span
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white ring-1 ring-emerald-600/20"
                title="Sesi Aktif"
              />
            </div>

            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
                  {user?.email}
                </h1>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border ${roleInfo.badge}`}
                >
                  {roleInfo.icon}
                  <span>{roleInfo.label}</span>
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-500 flex items-center gap-2">
                <span>Pusat Kendali Profil & Keamanan Akun</span>
                <span className="text-slate-300">•</span>
                <span className="text-emerald-700 font-medium">Sesi HttpOnly Terlindungi</span>
              </p>
            </div>
          </div>

          {/* Active Workspace Pill */}
          <div className="flex items-center gap-3 p-3 sm:px-4 sm:py-3 bg-slate-50 rounded-2xl border border-slate-200/80 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                Workspace Aktif
              </span>
              <span className="text-sm font-bold text-slate-900 block truncate max-w-[180px]">
                {tenant?.name || 'Workspace'}
              </span>
            </div>
          </div>
        </div>

        {/* Tab Navigation Menu */}
        <div className="flex items-center gap-1.5 mt-7 pt-4 border-t border-slate-100 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
              activeTab === 'overview'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Profil & Identitas</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('security')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap relative ${
              activeTab === 'security'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Keamanan & Kredensial</span>
            {hasSecurityAlert && (
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse ml-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('quota')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap ${
              activeTab === 'quota'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Kuota Workspace</span>
          </button>
        </div>
      </div>

      {/* TAB 1: OVERVIEW & IDENTITAS */}
      {activeTab === 'overview' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* Identity Grid Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* User ID */}
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                User ID (Sistem)
              </span>
              <div className="flex items-center justify-between font-mono font-bold text-xs text-slate-800 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                <span className="truncate pr-2">{user?.id || '-'}</span>
                <button
                  type="button"
                  onClick={() => user?.id && handleCopyId(user.id, 'User ID')}
                  className="text-slate-400 hover:text-emerald-600 transition p-1"
                  title="Salin User ID"
                >
                  {copiedId === 'User ID' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
              <p className="text-[10px] text-slate-400">Pengidentifikasi unik akun di seluruh gateway</p>
            </div>

            {/* Tenant ID */}
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Tenant ID (Workspace)
              </span>
              <div className="flex items-center justify-between font-mono font-bold text-xs text-slate-800 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                <span className="truncate pr-2">{tenant?.id || '-'}</span>
                <button
                  type="button"
                  onClick={() => tenant?.id && handleCopyId(tenant.id, 'Tenant ID')}
                  className="text-slate-400 hover:text-emerald-600 transition p-1"
                  title="Salin Tenant ID"
                >
                  {copiedId === 'Tenant ID' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
              <p className="text-[10px] text-slate-400">Isolasi basis data dan partisi sesi</p>
            </div>

            {/* Sesi Keamanan */}
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Arsitektur Sesi
              </span>
              <div className="flex items-center gap-2 bg-emerald-50/60 p-2.5 rounded-xl border border-emerald-100 text-xs font-bold text-emerald-800">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>In-Memory Token</span>
              </div>
              <p className="text-[10px] text-slate-400">Refresh via HttpOnly cookie tanpa localStorage</p>
            </div>

            {/* Keanggotaan Workspace */}
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Jumlah Workspace
              </span>
              <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-100 text-xs font-bold text-slate-800">
                <Building2 className="w-4 h-4 text-slate-600 shrink-0" />
                <span>{memberships.length} Terdaftar</span>
              </div>
              <p className="text-[10px] text-slate-400 truncate">
                {memberships.map((m) => m.name).join(', ')}
              </p>
            </div>
          </div>

          {/* Role Description Card */}
          <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-slate-100 text-slate-700">
                {roleInfo.icon}
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Tanggung Jawab Peran: {roleInfo.label}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{roleInfo.desc}</p>
              </div>
            </div>
          </div>

          {/* Permissions Matrix Table */}
          <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  Matriks Hak Akses & Kewenangan Peran
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Tabel perbandingan izin operasional berdasarkan peran di workspace.
                </p>
              </div>
              <span className="text-xs font-bold px-3 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 self-start sm:self-auto">
                Peran Aktif: {role}
              </span>
            </div>

            <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">Fitur & Kemampuan Sistem</th>
                    <th className="py-3 px-3 text-center">OWNER</th>
                    <th className="py-3 px-3 text-center">ADMIN</th>
                    <th className="py-3 px-3 text-center">MEMBER</th>
                    <th className="py-3 px-3 text-center">VIEWER</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  <tr className={role === 'OWNER' ? 'bg-amber-50/30' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Kirim & Balas Pesan WhatsApp
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                  <tr className={role === 'MEMBER' ? 'bg-emerald-50/30' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Hubungkan Sesi & Scan QR WA
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                  <tr className={role === 'ADMIN' ? 'bg-blue-50/30' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Manajemen Kunci API & Webhook
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                  <tr className={role === 'ADMIN' ? 'bg-blue-50/30' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Undang & Atur Anggota Tim
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                  <tr className={role === 'OWNER' ? 'bg-amber-50/30' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Ubah Batas Alokasi Kuota Tenant
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                  <tr className={role === 'VIEWER' ? 'bg-slate-50' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      Pantau Log Audit & Analitik
                    </td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                    <td className="py-3 px-3 text-center text-slate-300">-</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SECURITY & CREDENTIALS */}
      {activeTab === 'security' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* Status Kode Pemulihan Banner */}
          <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-600">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Status Kode Pemulihan Akun (Zero-Email Recovery)
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Pengganti fitur lupa sandi tanpa pengiriman email untuk privasi dan isolasi data penuh.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {recovery?.confirmed ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Terkonfirmasi Tersimpan</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>Belum Dikonfirmasi</span>
                  </span>
                )}

                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
                  {recovery?.codes_remaining != null ? `${recovery.codes_remaining} Kode Aktif` : '-'}
                </span>
              </div>
            </div>

            <div className="pt-4 text-xs text-slate-600 leading-relaxed space-y-1">
              <p>
                • Setiap kode pemulihan diawali format <code className="font-mono bg-slate-100 px-1 py-0.5 rounded text-slate-800">RC-XXXXX-...</code> dan hanya berlaku <strong>satu kali pakai</strong>.
              </p>
              <p>
                • Jika sisa kode Anda tinggal 2 atau kurang, disarankan menerbitkan himpunan kode baru di bawah agar akun tidak terkunci permanen jika lupa kata sandi.
              </p>
            </div>
          </div>

          {/* Grid Security Forms */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Card: Ganti Kata Sandi */}
            <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-4">
              <div className="flex items-center gap-2 text-slate-900 pb-2 border-b border-slate-100">
                <Lock className="w-4 h-4 text-emerald-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider">Perbarui Kata Sandi</h3>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Kata Sandi Saat Ini
                  </label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-slate-700">
                      Kata Sandi Baru
                    </label>
                    <span className="text-[11px] text-slate-400">Min. 10 karakter</span>
                  </div>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Minimal 10 karakter"
                      required
                      className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {pwError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{pwError}</span>
                  </div>
                )}

                {pwSuccess && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center gap-2">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>{pwSuccess}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={pwLoading}
                  className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-50"
                >
                  {pwLoading ? 'Memperbarui...' : 'Simpan Kata Sandi Baru'}
                </button>
              </form>
            </div>

            {/* Card: Ganti Email */}
            <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-4">
              <div className="flex items-center gap-2 text-slate-900 pb-2 border-b border-slate-100">
                <Mail className="w-4 h-4 text-blue-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider">Perbarui Alamat Email</h3>
              </div>

              <form onSubmit={handleChangeEmail} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Alamat Email Baru
                  </label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="email.baru@perusahaan.com"
                    required
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Konfirmasi Kata Sandi Akun
                  </label>
                  <input
                    type="password"
                    value={emailPassword}
                    onChange={(e) => setEmailPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {emailError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{emailError}</span>
                  </div>
                )}

                {emailSuccess && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center gap-2">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>{emailSuccess}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={emailLoading}
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-50"
                >
                  {emailLoading ? 'Menyimpan...' : 'Perbarui Alamat Email'}
                </button>
              </form>
            </div>

            {/* Card: Buat Kode Pemulihan Baru */}
            <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-4">
              <div className="flex items-center gap-2 text-slate-900 pb-2 border-b border-slate-100">
                <KeyRound className="w-4 h-4 text-amber-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider">Terbitkan Kode Pemulihan Baru</h3>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Menerbitkan himpunan baru akan otomatis <strong>menghanguskan</strong> 8 kode lama Anda. Pastikan menyalin atau mengunduh kode baru di tempat aman.
              </p>

              <form onSubmit={handleIssueRecoveryCode} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Masukkan Kata Sandi Anda
                  </label>
                  <input
                    type="password"
                    value={rcPassword}
                    onChange={(e) => setRcPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {rcError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{rcError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={rcLoading}
                  className="w-full py-2.5 px-4 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-50"
                >
                  {rcLoading ? 'Menerbitkan...' : 'Terbitkan 8 Kode Pemulihan Baru'}
                </button>
              </form>
            </div>

            {/* Card: Keluar Dari Semua Perangkat */}
            <div className="bg-white rounded-3xl border border-rose-200 p-6 sm:p-7 shadow-xs space-y-4 flex flex-col justify-between">
              <div className="space-y-2 pb-2 border-b border-rose-100">
                <div className="flex items-center gap-2 text-rose-900">
                  <LogOut className="w-4 h-4 text-rose-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Keluar dari Semua Perangkat</h3>
                </div>
                <p className="text-xs text-rose-700 leading-relaxed">
                  Tindakan ini akan mencabut seluruh token sesi aktif akun Anda di seluruh perangkat (browser, HP, laptop). Anda akan langsung dikeluarkan dari sesi saat ini.
                </p>
              </div>

              <button
                type="button"
                onClick={handleLogoutAll}
                disabled={logoutAllLoading}
                className="w-full py-2.5 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs sm:text-sm font-bold transition shadow-xs disabled:opacity-50"
              >
                {logoutAllLoading ? 'Mengeluarkan...' : 'Keluar dari Semua Perangkat (Logout All)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: QUOTA & CAPACITY */}
      {activeTab === 'quota' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* Quota Overview Card */}
          <div className="bg-white rounded-3xl border border-slate-200/90 p-6 sm:p-7 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <Sliders className="w-5 h-5 text-emerald-600" />
                  <h2 className="text-base font-bold text-slate-900">
                    Status Alokasi Kuota Workspace
                  </h2>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Batas kapasitas sumber daya gateway dan pemakaian riil saat ini.
                </p>
              </div>

              {isOwner ? (
                <Link
                  to="/settings"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Buka Pengaturan</span>
                </Link>
              ) : (
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold border border-slate-200">
                  <Lock className="w-3.5 h-3.5 text-slate-400" />
                  <span>Mode Baca-Saja (Read-Only)</span>
                </div>
              )}
            </div>

            {/* Informative Banner */}
            {!isOwner ? (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl text-xs text-blue-800 flex items-start gap-3">
                <Lock className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Kewenangan Pengaturan Kuota</span>
                  <p className="text-blue-700 mt-0.5 leading-relaxed">
                    Pengaturan batas kuota dikelola secara terpusat oleh <strong>Pemilik Workspace (Owner)</strong>. Peran Anda saat ini (<strong>{role}</strong>) dapat memantau batas kapasitas dan pemakaian di bawah ini.
                  </p>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-900 flex items-start gap-3">
                <Crown className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Status Pemilik Workspace (Owner)</span>
                  <p className="text-amber-800 mt-0.5 leading-relaxed">
                    Anda memiliki hak penuh untuk mengubah dan mengalokasikan batas kuota kapan saja melalui menu{' '}
                    <Link to="/settings" className="font-bold underline hover:text-amber-950">
                      Pengaturan
                    </Link>
                    .
                  </p>
                </div>
              </div>
            )}

            {/* Quota Indicators Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Max WhatsApp Sessions */}
              <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between text-slate-500">
                  <span className="text-xs font-bold uppercase tracking-wider">Sesi WhatsApp</span>
                  <Smartphone className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="text-2xl font-black text-slate-900">
                  {settings?.used?.sessions ?? usageSummary?.sessions?.connected ?? 0}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">
                    / {settings?.limits?.max_sessions ?? 5} maks
                  </span>
                </div>
                <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        (((settings?.used?.sessions ?? 0) / (settings?.limits?.max_sessions || 1)) * 100)
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Rate Limit Throughput */}
              <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between text-slate-500">
                  <span className="text-xs font-bold uppercase tracking-wider">Batas Kirim (Rate Limit)</span>
                  <Activity className="w-4 h-4 text-blue-600" />
                </div>
                <div className="text-2xl font-black text-slate-900">
                  {settings?.limits?.messages_per_minute ?? 60}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">pesan / menit</span>
                </div>
                <p className="text-[11px] text-slate-400">Proteksi antrean anti-ban WhatsApp</p>
              </div>

              {/* Max Team Members */}
              <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between text-slate-500">
                  <span className="text-xs font-bold uppercase tracking-wider">Anggota Tim</span>
                  <Users className="w-4 h-4 text-purple-600" />
                </div>
                <div className="text-2xl font-black text-slate-900">
                  {settings?.used?.members ?? memberships.length}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">
                    / {settings?.limits?.max_members ?? 5} maks
                  </span>
                </div>
                <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-purple-500 h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        (((settings?.used?.members ?? 1) / (settings?.limits?.max_members || 1)) * 100)
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Max API Keys */}
              <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between text-slate-500">
                  <span className="text-xs font-bold uppercase tracking-wider">Kunci Akses API</span>
                  <Key className="w-4 h-4 text-amber-600" />
                </div>
                <div className="text-2xl font-black text-slate-900">
                  {settings?.used?.api_keys ?? 0}
                  <span className="text-xs font-normal text-slate-400 ml-1.5">
                    / {settings?.limits?.max_api_keys ?? 5} maks
                  </span>
                </div>
                <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-amber-500 h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        (((settings?.used?.api_keys ?? 0) / (settings?.limits?.max_api_keys || 1)) * 100)
                      )}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reveal-Once Recovery Code Modal */}
      <RecoveryCodeModal
        isOpen={!!newlyIssuedRcs && newlyIssuedRcs.length > 0}
        codes={newlyIssuedRcs || []}
        title="Daftar Kode Pemulihan Baru Anda Berhasil Diterbitkan"
        description="Seluruh kode pemulihan lama Anda telah hangus. Simpan 8 kode pemulihan baru ini sekarang karena HANYA DITAMPILKAN SEKALI."
        onAcknowledge={async () => {
          try {
            await api.confirmRecoveryCodes();
            await refetchUser();
          } catch {
            // ignore
          }
          setNewlyIssuedRcs(null);
        }}
        buttonText="Saya Telah Menyimpan Kode-Kode Ini"
      />
    </div>
  );
};
