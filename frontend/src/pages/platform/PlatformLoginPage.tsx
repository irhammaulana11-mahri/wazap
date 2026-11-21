import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { platformApi } from '../../services/platformApi';
import { ApiError } from '../../services/api';
import {
  Server,
  KeyRound,
  Mail,
  Lock,
  ArrowRight,
  AlertCircle,
  ShieldCheck,
  Eye,
  EyeOff,
  Cpu,
  Layers,
  Shield,
  Zap,
} from 'lucide-react';

export const PlatformLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [retrySec, setRetrySec] = useState<number | null>(null);

  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setRetrySec(null);
    setLoading(true);

    try {
      const res = await platformApi.login(email.trim(), password);
      setMfaToken(res.mfa_token);
      setStep(2);
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setRetrySec(err.retryAfterSec || 60);
          setErrorMsg(err.message || 'Terlalu banyak percobaan. Silakan tunggu.');
        } else {
          setErrorMsg(err.message || 'Email atau kata sandi operator platform tidak valid.');
        }
      } else {
        setErrorMsg('Terjadi kesalahan jaringan saat menghubungi server platform.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setRetrySec(null);
    setLoading(true);

    try {
      await platformApi.verify(mfaToken, otpCode.trim());
      navigate('/platform/workspaces');
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setRetrySec(err.retryAfterSec || 60);
          setErrorMsg(err.message || 'Terlalu banyak percobaan kode verifikasi.');
        } else if (err.code === 'INVALID_MFA_TOKEN') {
          setErrorMsg('Sesi verifikasi telah kedaluwarsa. Silakan masuk kembali.');
          setStep(1);
          setMfaToken('');
        } else {
          setErrorMsg(err.message || 'Kode TOTP atau kode pemulihan salah.');
        }
      } else {
        setErrorMsg('Gagal memverifikasi kode.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-950 font-sans antialiased text-slate-100">
      {/* Left Column: Platform Enterprise Hero Branding (Visible on lg screens) */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-between p-12 bg-slate-950 text-white overflow-hidden border-r border-slate-800">
        {/* Ambient Glow Effects */}
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />

        {/* Top: Logo & Title */}
        <div className="relative z-10 flex items-center gap-3">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Gateway Logo"
            className="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-purple-600/30 border border-purple-500/40"
          />
          <div>
            <span className="font-bold text-white text-base tracking-tight block">WAZAP GATEWAY</span>
            <span className="text-[11px] font-semibold text-purple-400 uppercase tracking-wider block">
              Platform Control Plane
            </span>
          </div>
        </div>

        {/* Middle: Feature Highlights */}
        <div className="relative z-10 space-y-8 my-auto py-8">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <Shield className="w-3.5 h-3.5 text-purple-400" />
              <span>Konsol Operasional Terisolasi</span>
            </span>
            <h1 className="text-3xl xl:text-4xl font-extrabold tracking-tight text-white leading-tight">
              Pusat Kendali Infrastruktur & Tata Kelola Tenant Gateway
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-lg">
              Akses khusus operator untuk manajemen alokasi kuota multi-workspace, penangguhan tenant, pengawasan berkala cadangan database, dan jejak audit sistem.
            </p>
          </div>

          <div className="space-y-4 max-w-lg">
            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0 mt-0.5">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Autentikasi Dua Faktor (TOTP) & Sesi RAM</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Sesi operator terisolasi murni di memori browser tanpa penyimpanan persistent, dilindungi verifikasi TOTP 6-digit dan proteksi rate limit ketat.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shrink-0 mt-0.5">
                <Layers className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Tata Kelola Kuota & Penangguhan Instan</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Kontrol mutlak batas sesi, kunci API, anggota, throughput pesan per tenant, serta penangguhan darurat dengan jejak audit permanen.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: Footer info */}
        <div className="relative z-10 flex items-center justify-between text-xs text-slate-500 pt-6 border-t border-slate-800/60">
          <span>© 2026 WAZAP Gateway Enterprise • Platform Console</span>
          <span className="font-mono text-[11px]">v1.0.0-OPERATOR</span>
        </div>
      </div>

      {/* Right Column: Modern Authentication Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-12 bg-slate-950 lg:bg-slate-50 dark:lg:bg-slate-950 relative">
        {/* Mobile Background Ambient Glow */}
        <div className="lg:hidden absolute -top-24 -left-24 w-72 h-72 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

        <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-8 sm:p-10 border border-slate-100 dark:border-slate-800 relative z-10 transition-colors">
          {/* Form Header */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-3">
              <div className="w-14 h-14 rounded-2xl bg-purple-600/10 dark:bg-purple-600/20 text-purple-600 dark:text-purple-400 border-2 border-purple-500/30 flex items-center justify-center shadow-lg shadow-purple-600/20">
                <Server className="w-7 h-7" />
              </div>
            </div>
            <h2 className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              Konsol Platform Operator
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
              {step === 1
                ? 'Masukkan kredensial akun operator untuk memulai autentikasi'
                : 'Verifikasi identitas dengan kode 2FA / TOTP Anda'}
            </p>
          </div>

          {errorMsg && (
            <div className="mb-5 p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800/80 rounded-2xl text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span>{errorMsg}</span>
                {retrySec !== null && (
                  <div className="mt-1 font-mono text-[11px] text-rose-600 dark:text-rose-400 font-semibold">
                    Coba lagi dalam {retrySec} detik.
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 1 ? (
            <form onSubmit={handleStep1Submit} className="space-y-4">
              {/* Email Field */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Alamat Email Operator
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@platform.internal"
                    required
                    className="w-full pl-10 pr-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none transition"
                  />
                </div>
              </div>

              {/* Password Field */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Kata Sandi
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full pl-10 pr-10 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-3.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-3 px-4 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-md shadow-purple-600/20 disabled:opacity-50 cursor-pointer"
              >
                <span>{loading ? 'Memvalidasi Kredensial...' : 'Lanjutkan ke Verifikasi TOTP'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <form onSubmit={handleStep2Submit} className="space-y-4">
              <div className="p-3.5 bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/50 rounded-2xl text-xs text-purple-800 dark:text-purple-300 flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                <span>Kredensial valid. Masukkan kode 2FA untuk menyelesaikan login.</span>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Kode TOTP 6-Digit / Kode Pemulihan
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                  <input
                    type="text"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    placeholder="123456 atau xxxx-xxxx-xxxx"
                    required
                    autoFocus
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 font-mono tracking-wider focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none transition"
                  />
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                  Buka aplikasi autentikator (Google Authenticator / Authy) atau gunakan kode pemulihan sekali pakai.
                </p>
              </div>

              <div className="flex items-center gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setOtpCode('');
                    setErrorMsg('');
                  }}
                  className="w-1/3 py-2.5 px-3 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
                >
                  Kembali
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-2/3 py-3 px-4 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-md shadow-purple-600/20 disabled:opacity-50 cursor-pointer"
                >
                  <span>{loading ? 'Memverifikasi...' : 'Masuk Konsol'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
