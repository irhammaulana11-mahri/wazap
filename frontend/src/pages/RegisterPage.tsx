import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RecoveryCodeModal } from '../components/auth/RecoveryCodeModal';
import {
  Lock,
  Mail,
  Building2,
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  ShieldCheck,
  Zap,
  Cpu,
  CheckCircle2,
} from 'lucide-react';

export const RegisterPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setFieldErrors({});

    if (password.length < 10) {
      setError('Password minimal harus 10 karakter sesuai standar keamanan.');
      setLoading(false);
      return;
    }

    try {
      const data = await register(email.trim(), password, tenantName.trim());
      const codes = data?.recovery_codes || (data?.recovery_code ? [data.recovery_code] : null);
      if (codes && codes.length > 0) {
        setRecoveryCodes(codes);
      } else {
        navigate('/');
      }
    } catch (err: any) {
      setError(err.message || 'Pendaftaran gagal.');
      if (err.details && Array.isArray(err.details)) {
        const fieldMap: Record<string, string> = {};
        for (const item of err.details) {
          fieldMap[item.path] = item.message;
        }
        setFieldErrors(fieldMap);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-950 font-sans antialiased">
      {/* Left Column: Enterprise Hero Branding (Visible on lg screens) */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-between p-12 bg-slate-950 text-white overflow-hidden border-r border-slate-800">
        {/* Ambient Glow Effects */}
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-teal-500/15 rounded-full blur-3xl pointer-events-none" />

        {/* Top: Logo & Title */}
        <div className="relative z-10 flex items-center gap-3">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Gateway Logo"
            className="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-emerald-500/30 border border-emerald-500/40"
          />
          <div>
            <span className="font-bold text-white text-base tracking-tight block">WAZAP GATEWAY</span>
            <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider block">
              Multi-Tenant Engine
            </span>
          </div>
        </div>

        {/* Middle: Feature Highlights */}
        <div className="relative z-10 space-y-8 my-auto py-8">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span>Registrasi Cepat 1-Langkah</span>
            </span>
            <h1 className="text-3xl xl:text-4xl font-extrabold tracking-tight text-white leading-tight">
              Mulai Otomasi WhatsApp Bisnis Anda dalam Hitungan Menit
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-lg">
              Daftarkan organisasi Anda untuk mendapatkan workspace terisolasi dengan akses dashboard messenger, integrasi API key, dan monitoring antrean pesan.
            </p>
          </div>

          <div className="space-y-4 max-w-lg">
            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0 mt-0.5">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Workspace Mandiri Otomatis</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Workspace baru langsung diinisialisasi lengkap dengan alokasi sesi WhatsApp, rate-limit, dan kunci akses API.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0 mt-0.5">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Peran Pemilik Penuh (Workspace Owner)</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Akun pendaftar otomatis menjadi Owner dengan hak akses mengundang tim, mengatur kuota, dan menerbitkan webhook.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: Footer info */}
        <div className="relative z-10 flex items-center justify-between text-xs text-slate-500 pt-6 border-t border-slate-800/60">
          <span>© 2026 WAZAP Gateway Enterprise</span>
          <span className="font-mono text-[11px]">v1.0.0-H2</span>
        </div>
      </div>

      {/* Right Column: Modern Registration Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-12 bg-slate-950 lg:bg-slate-50 relative">
        {/* Mobile Background Ambient Glow */}
        <div className="lg:hidden absolute -top-24 -left-24 w-72 h-72 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />

        <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 sm:p-10 border border-slate-100 relative z-10">
          {/* Form Header */}
          <div className="text-center mb-6">
            <div className="flex justify-center mb-3">
              <img
                src="/logo-wazap.jpeg"
                alt="WAZAP Logo"
                className="w-14 h-14 rounded-2xl object-cover shadow-lg shadow-emerald-500/20 border-2 border-emerald-500/30"
              />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Daftar Akun Baru</h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Buat workspace WhatsApp Gateway untuk bisnis Anda
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Workspace / Tenant Name */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Nama Workspace / Perusahaan
              </label>
              <div className="relative">
                <Building2 className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                <input
                  type="text"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  placeholder="Misal: Toko Berkah, PT Digital Solusi"
                  required
                  minLength={2}
                  maxLength={100}
                  className="w-full pl-10 pr-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                />
              </div>
              {fieldErrors.tenant_name && (
                <p className="text-xs text-rose-600 mt-1">{fieldErrors.tenant_name}</p>
              )}
            </div>

            {/* Email Field */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Alamat Email Pengguna
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@perusahaan.com"
                  required
                  className="w-full pl-10 pr-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                />
              </div>
              {fieldErrors.email && (
                <p className="text-xs text-rose-600 mt-1">{fieldErrors.email}</p>
              )}
            </div>

            {/* Password Field */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-bold text-slate-700">
                  Kata Sandi
                </label>
                <span className="text-[10px] text-slate-400 font-medium">Min. 10 karakter</span>
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 10 karakter..."
                  required
                  minLength={10}
                  className="w-full pl-10 pr-10 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600 transition"
                  title={showPassword ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="text-xs text-rose-600 mt-1">{fieldErrors.password}</p>
              )}
            </div>

            {/* Error Notification */}
            {error && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2.5 animate-in fade-in duration-150">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span className="leading-relaxed font-medium">{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs sm:text-sm font-bold text-white transition shadow-lg shadow-emerald-600/25 disabled:opacity-50 mt-2"
            >
              <span>{loading ? 'Mendaftarkan Workspace...' : 'Daftar & Mulai Sekarang'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Login & Join Links */}
          <div className="mt-8 pt-5 border-t border-slate-100 space-y-2 text-center text-xs text-slate-500">
            <div>
              Sudah memiliki akun?{' '}
              <Link to="/login" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                Masuk di sini
              </Link>
            </div>
            <div>
              Punya kode workspace?{' '}
              <Link to="/join" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                Gabung Workspace
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Reveal-Once Recovery Code Modal */}
      <RecoveryCodeModal
        isOpen={!!recoveryCodes && recoveryCodes.length > 0}
        codes={recoveryCodes || []}
        onAcknowledge={() => navigate('/')}
      />
    </div>
  );
};
