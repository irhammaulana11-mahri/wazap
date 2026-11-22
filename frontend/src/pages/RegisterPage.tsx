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
  Clock,
  ShieldAlert,
  Copy,
  Check,
  Download,
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
  const [pendingData, setPendingData] = useState<{ tenant_name: string; recovery_codes: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleCopyCodes = async () => {
    if (!pendingData) return;
    try {
      await navigator.clipboard.writeText(pendingData.recovery_codes.join('\n'));
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopyFailed(true);
    }
  };

  const handleDownloadCodes = () => {
    if (!pendingData) return;
    const element = document.createElement('a');
    const file = new Blob(
      [
        `WAZAP GATEWAY - KODE PEMULIHAN AKUN\n`,
        `===================================\n\n`,
        `Workspace: ${pendingData.tenant_name}\n`,
        `Email: ${email}\n\n`,
        `Daftar Kode Pemulihan (Sekali Pakai):\n`,
        `${pendingData.recovery_codes.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n`,
        `PERINGATAN PENTING:\n`,
        `- Simpan berkas ini di tempat yang aman dan terlindungi.\n`,
        `- Setiap kode hanya dapat digunakan satu kali untuk mereset kata sandi.\n`,
        `- Tanggal Dibuat: ${new Date().toLocaleString('id-ID')}\n`,
      ],
      { type: 'text/plain' }
    );
    element.href = URL.createObjectURL(file);
    element.download = `wazap-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

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
      const res = await register(email.trim(), password, tenantName.trim());
      if (res.kind === 'pending') {
        const codes = res.data?.recovery_codes || [];
        setPendingData({
          tenant_name: res.data.tenant.name || tenantName.trim(),
          recovery_codes: codes,
        });
        return;
      }
      const codes = res.data?.recovery_codes || (res.data?.recovery_code ? [res.data.recovery_code] : null);
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
          {pendingData ? (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div className="text-center space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/15 text-amber-600 border border-amber-500/30 flex items-center justify-center mx-auto mb-2">
                  <Clock className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Pendaftaran Diterima</h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Workspace <strong className="font-semibold text-slate-900">{pendingData.tenant_name}</strong> menunggu persetujuan pemilik platform. Anda dapat masuk setelah disetujui.
                </p>
              </div>

              {/* Warning Notice */}
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-900 space-y-1.5">
                <div className="flex items-center gap-2 font-bold">
                  <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Simpan Kode Pemulihan Akun Anda</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  Kode pemulihan ini <strong>HANYA DITAMPILKAN SEKALI</strong>. Simpan kode ini di tempat yang aman untuk memulihkan akun atau mereset kata sandi jika diperlukan.
                </p>
              </div>

              {/* Recovery Codes Grid */}
              <div className="space-y-2">
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  8 Kode Pemulihan Rahasia Anda (Sekali Pakai)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-2.5 bg-slate-950 rounded-2xl border border-slate-800">
                  {pendingData.recovery_codes.map((code, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2 rounded-xl bg-slate-900 text-emerald-400 font-mono text-xs font-bold"
                    >
                      <span className="text-slate-500 font-normal mr-1">{idx + 1}.</span>
                      <span className="truncate select-all">{code}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions: Copy & Download */}
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={handleCopyCodes}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition shadow-xs cursor-pointer"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  <span>{copied ? 'Tersalin ke Clipboard' : 'Salin Semua Kode'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCodes}
                  className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition shadow-xs cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Unduh (.txt)</span>
                </button>
              </div>

              {copyFailed && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Gagal menyalin otomatis. Silakan salin daftar kode secara manual di atas.</span>
                </div>
              )}

              {/* Confirmation Checkbox */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200/80 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={savedConfirmed}
                  onChange={(e) => setSavedConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-xs text-slate-700 font-medium leading-relaxed">
                  Saya sudah menyimpan 8 kode pemulihan ini di tempat yang aman.
                </span>
              </label>

              {/* Link to Login */}
              <div className="pt-2">
                <Link
                  to="/login"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs sm:text-sm font-bold text-white transition shadow-lg shadow-emerald-600/25"
                >
                  <span>Ke halaman masuk</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          ) : (
            <>
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
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs sm:text-sm font-bold text-white transition shadow-lg shadow-emerald-600/25 disabled:opacity-50 mt-2 cursor-pointer"
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
            </>
          )}
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
