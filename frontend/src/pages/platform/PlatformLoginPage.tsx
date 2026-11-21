import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { platformApi, platformSession } from '../../services/platformApi';
import { ApiError } from '../../services/api';
import {
  Server,
  KeyRound,
  Mail,
  Lock,
  ArrowRight,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';

export const PlatformLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
          setErrorMsg(err.message || 'Email atau kata sandi platform admin tidak valid.');
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
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4 font-sans antialiased text-slate-100">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-purple-600/20 text-purple-400 border border-purple-500/30 flex items-center justify-center mx-auto">
            <Server className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-extrabold text-white tracking-tight">Konsol Platform Admin</h1>
          <p className="text-xs text-slate-400">
            Akses tingkat operator untuk manajemen workspace, kuota sistem, dan jejak audit.
          </p>
        </div>

        {errorMsg && (
          <div className="p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-xs text-rose-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <span>{errorMsg}</span>
              {retrySec !== null && (
                <div className="mt-1 font-mono text-[11px] text-rose-400">
                  Coba lagi dalam {retrySec} detik.
                </div>
              )}
            </div>
          </div>
        )}

        {step === 1 ? (
          <form onSubmit={handleStep1Submit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">Email Platform Admin</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@platform.internal"
                  required
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">Kata Sandi</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-2.5 px-4 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
            >
              <span>{loading ? 'Memvalidasi...' : 'Lanjutkan ke Langkah 2'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <form onSubmit={handleStep2Submit} className="space-y-4">
            <div className="p-3 bg-purple-950/40 border border-purple-800/50 rounded-2xl text-xs text-purple-300 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400 shrink-0" />
              <span>Kredensial valid. Masukkan kode 2FA untuk menyelesaikan login.</span>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">Kode TOTP / Kode Pemulihan</label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="123456 atau xxxx-xxxx-xxxx"
                  required
                  autoFocus
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 font-mono tracking-wider focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Gunakan aplikasi autentikator (Google Authenticator / 1Password) atau kode pemulihan sekali pakai.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setOtpCode('');
                  setErrorMsg('');
                }}
                className="w-1/3 py-2.5 px-3 border border-slate-800 hover:bg-slate-800/60 text-slate-400 rounded-xl text-xs font-semibold transition"
              >
                Kembali
              </button>
              <button
                type="submit"
                disabled={loading}
                className="w-2/3 py-2.5 px-4 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
              >
                <span>{loading ? 'Memverifikasi...' : 'Masuk Konsol'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
