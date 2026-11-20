import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import {
  ShieldAlert,
  Mail,
  KeyRound,
  Lock,
  ArrowRight,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';

export const ForgotPasswordPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [remainingCodes, setRemainingCodes] = useState<number | null>(null);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setFieldErrors({});

    if (newPassword.length < 10) {
      setError('Kata sandi baru minimal harus 10 karakter.');
      setLoading(false);
      return;
    }

    try {
      const res = await api.resetPassword(
        email.trim(),
        recoveryCodeInput.trim(),
        newPassword
      );

      // Server returns remaining recovery codes
      setRemainingCodes(res.remaining_recovery_codes);
    } catch (err: any) {
      if (err.code === 'INVALID_RECOVERY' || err.status === 400) {
        setError('Email atau kode pemulihan tidak valid.');
      } else {
        setError(err.message || 'Gagal mereset kata sandi.');
      }

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
      {/* Left Column: Branding */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-between p-12 bg-slate-950 text-white overflow-hidden border-r border-slate-800">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-teal-500/15 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex items-center gap-3">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Gateway Logo"
            className="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-emerald-500/30 border border-emerald-500/40"
          />
          <div>
            <span className="font-bold text-white text-base tracking-tight block">WAZAP GATEWAY</span>
            <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider block">
              Pemulihan Akun Mandiri
            </span>
          </div>
        </div>

        <div className="relative z-10 space-y-8 my-auto py-8">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>Sistem Pemulihan Tanpa Email</span>
            </span>
            <h1 className="text-3xl xl:text-4xl font-extrabold tracking-tight text-white leading-tight">
              Reset Kata Sandi dengan Aman via Kode Pemulihan
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-lg">
              Arsitektur keamanan WAZAP tidak mengirimkan tautan reset via email publik. Gunakan kode pemulihan resmi (awalan RC-) yang Anda peroleh saat pertama kali mendaftar.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs max-w-lg space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-white">
              <HelpCircle className="w-4 h-4 text-emerald-400" />
              <span>Bagaimana jika Kode Pemulihan Hilang?</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Jika Anda kehilangan kode pemulihan, hubungi administrator atau operator server Anda untuk menerbitkan kode pemulihan darurat melalui konsol sistem.
            </p>
          </div>
        </div>

        <div className="relative z-10 flex items-center justify-between text-xs text-slate-500 pt-6 border-t border-slate-800/60">
          <span>© 2026 WAZAP Gateway Enterprise</span>
          <span className="font-mono text-[11px]">v1.0.0-H3</span>
        </div>
      </div>

      {/* Right Column: Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-12 bg-slate-950 lg:bg-slate-50 relative">
        <div className="lg:hidden absolute -top-24 -left-24 w-72 h-72 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />

        <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 sm:p-10 border border-slate-100 relative z-10">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-3">
              <img
                src="/logo-wazap.jpeg"
                alt="WAZAP Logo"
                className="w-14 h-14 rounded-2xl object-cover shadow-lg shadow-emerald-500/20 border-2 border-emerald-500/30"
              />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Atur Ulang Kata Sandi</h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Masukkan email terdaftar dan kode pemulihan rahasia Anda
            </p>
          </div>

          {remainingCodes !== null ? (
            <div className="space-y-6 text-center animate-in fade-in duration-200">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Kata Sandi Berhasil Direset!</h3>
                <p className="text-xs sm:text-sm text-slate-600 mt-2 leading-relaxed">
                  Kata sandi baru Anda telah aktif. Seluruh sesi login pada perangkat lain telah dicabut secara otomatis.
                </p>
                <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-800 mt-4 text-center leading-relaxed">
                  Sisa kode pemulihan akun Anda:{' '}
                  <strong className="text-emerald-950 font-mono text-sm">{remainingCodes} kode</strong> tersisa.
                </div>
              </div>

              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs sm:text-sm font-bold text-white transition shadow-lg shadow-emerald-600/25"
              >
                <span>Menuju Halaman Login</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Alamat Email Akun
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

              {/* Recovery Code */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Kode Pemulihan (Salah Satu Kode RC Anda)
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={recoveryCodeInput}
                    onChange={(e) => setRecoveryCodeInput(e.target.value.toUpperCase())}
                    placeholder="RC-XXXXX-XXXXX-XXXXX-XXXXX"
                    required
                    className="w-full pl-10 pr-3.5 py-2.5 font-mono border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 uppercase focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                  />
                </div>
                {fieldErrors.recovery_code && (
                  <p className="text-xs text-rose-600 mt-1">{fieldErrors.recovery_code}</p>
                )}
              </div>

              {/* New Password */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-bold text-slate-700">
                    Kata Sandi Baru
                  </label>
                  <span className="text-[11px] text-slate-400">Min. 10 karakter</span>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimal 10 karakter baru"
                    required
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
                {fieldErrors.new_password && (
                  <p className="text-xs text-rose-600 mt-1">{fieldErrors.new_password}</p>
                )}
              </div>

              {/* Error Notification */}
              {error && (
                <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2.5 animate-in fade-in duration-150">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span className="leading-relaxed font-medium">{error}</span>
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs sm:text-sm font-bold text-white transition shadow-lg shadow-emerald-600/25 disabled:opacity-50 mt-2"
              >
                <span>{loading ? 'Mereset Sandi...' : 'Reset Kata Sandi Sekarang'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* Back to Login */}
          <div className="mt-8 pt-5 border-t border-slate-100 text-center text-xs text-slate-500">
            Ingat kata sandi Anda?{' '}
            <Link to="/login" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
              Kembali ke Login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
