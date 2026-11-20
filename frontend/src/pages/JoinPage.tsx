import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { RecoveryCodeModal } from '../components/auth/RecoveryCodeModal';
import {
  KeyRound,
  Mail,
  Lock,
  ArrowRight,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  Building2,
  Users,
  ShieldCheck,
  Zap,
} from 'lucide-react';

export const JoinPage: React.FC = () => {
  const [joinCode, setJoinCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successData, setSuccessData] = useState<{
    tenant_name: string;
    existing_account: boolean;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const navigate = useNavigate();

  // Read code from URL fragment (#code=...) and immediately purge from address bar (RULE 4.10)
  useEffect(() => {
    if (window.location.hash) {
      try {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        const codeFromHash = hashParams.get('code');
        if (codeFromHash) {
          setJoinCode(codeFromHash.trim());
        }
      } catch {
        // ignore parse errors
      } finally {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setFieldErrors({});

    if (!joinCode.trim()) {
      setError('Kode workspace wajib diisi.');
      setLoading(false);
      return;
    }

    if (password.length < 10) {
      setError('Password minimal harus 10 karakter sesuai standar keamanan.');
      setLoading(false);
      return;
    }

    try {
      const res = await api.joinRequest(joinCode.trim(), email.trim(), password);
      setSuccessData({
        tenant_name: res.tenant_name,
        existing_account: res.existing_account,
      });

      const codes = res.recovery_codes || (res.recovery_code ? [res.recovery_code] : null);
      if (codes && codes.length > 0) {
        setRecoveryCodes(codes);
      }
    } catch (err: any) {
      if (err.code === 'INVALID_JOIN_CODE') {
        setError('Kode workspace tidak valid, telah diganti, atau dinonaktifkan.');
      } else if (err.code === 'INVALID_CREDENTIALS') {
        setError('Email sudah terdaftar. Masukkan kata sandi akun Anda yang sudah ada.');
      } else if (err.code === 'JOIN_REQUEST_EXISTS') {
        setError('Permintaan bergabung Anda untuk workspace ini masih menunggu persetujuan.');
      } else if (err.code === 'JOIN_QUEUE_FULL') {
        setError('Antrean pengajuan untuk workspace ini sedang penuh. Silakan hubungi admin workspace.');
      } else if (err.code === 'ALREADY_MEMBER') {
        setError('Anda sudah menjadi anggota di workspace ini. Silakan langsung masuk di halaman Login.');
      } else {
        setError(err.message || 'Gagal mengajukan permintaan bergabung.');
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
      {/* Left Column: Enterprise Branding */}
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
              Join Workspace Program
            </span>
          </div>
        </div>

        <div className="relative z-10 space-y-8 my-auto py-8">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Users className="w-3.5 h-3.5 text-emerald-400" />
              <span>Kolaborasi Tim Terkelola</span>
            </span>
            <h1 className="text-3xl xl:text-4xl font-extrabold tracking-tight text-white leading-tight">
              Bergabung ke Tim & Workspace dengan Kode Akses
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-lg">
              Daftarkan diri Anda ke workspace organisasi menggunakan kode pendaftaran resmi. Akun akan langsung aktif setelah disetujui oleh Owner atau Admin workspace.
            </p>
          </div>

          <div className="space-y-4 max-w-lg">
            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0 mt-0.5">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Validasi & Persetujuan Berjenjang</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Setiap pengajuan diverifikasi oleh pengelola workspace demi menjamin integritas data dan kepatuhan peran.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3.5 p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xs">
              <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0 mt-0.5">
                <KeyRound className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-white">Kode Pemulihan Mandiri</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Pendaftar baru langsung memperoleh kode pemulihan unik untuk mengamankan akun tanpa ketergantungan email.
                </p>
              </div>
            </div>
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
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Gabung Workspace</h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Masukkan kode workspace dari undangan Anda untuk bergabung
            </p>
          </div>

          {successData ? (
            <div className="space-y-6 text-center animate-in fade-in duration-200">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Permintaan Terkirim!</h3>
                <p className="text-xs sm:text-sm text-slate-600 mt-2 leading-relaxed">
                  Permintaan Anda untuk bergabung ke workspace{' '}
                  <strong className="text-slate-900">{successData.tenant_name}</strong> telah berhasil diajukan.
                </p>
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-800 mt-4 text-left leading-relaxed">
                  Status saat ini adalah <strong>Menunggu Persetujuan</strong> dari Owner atau Admin workspace. Silakan cek berkala atau login setelah akun Anda disetujui.
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
              {/* Join Code */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Kode Akses Workspace
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="WJ-XXXXX-XXXXX-XXXXX-XXXXX"
                    required
                    className="w-full pl-10 pr-3.5 py-2.5 font-mono border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 uppercase focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none transition"
                  />
                </div>
                {fieldErrors.join_code && (
                  <p className="text-xs text-rose-600 mt-1">{fieldErrors.join_code}</p>
                )}
                <p className="text-[11px] text-slate-400 mt-1">
                  Format resmi diawali kode WJ- yang diberikan oleh tim Anda.
                </p>
              </div>

              {/* Email */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Alamat Email Anda
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

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-bold text-slate-700">
                    Kata Sandi Akun
                  </label>
                  <span className="text-[11px] text-slate-400">Min. 10 karakter</span>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimal 10 karakter"
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
                {fieldErrors.password && (
                  <p className="text-xs text-rose-600 mt-1">{fieldErrors.password}</p>
                )}
                <p className="text-[11px] text-slate-400 mt-1">
                  Jika akun sudah terdaftar, gunakan kata sandi yang Anda miliki saat ini.
                </p>
              </div>

              {/* Error Alert */}
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
                <span>{loading ? 'Mengirim Pengajuan...' : 'Ajukan Permintaan Bergabung'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* Footer links */}
          <div className="mt-8 pt-5 border-t border-slate-100 space-y-2 text-center text-xs text-slate-500">
            <div>
              Sudah memiliki akun aktif?{' '}
              <Link to="/login" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                Masuk di sini
              </Link>
            </div>
            <div>
              Ingin membuat workspace sendiri?{' '}
              <Link to="/register" className="font-bold text-emerald-600 hover:text-emerald-700 hover:underline">
                Daftar workspace baru
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Reveal-Once Recovery Code Modal (for brand new accounts) */}
      <RecoveryCodeModal
        isOpen={!!recoveryCodes && recoveryCodes.length > 0}
        codes={recoveryCodes || []}
        title="Simpan Kode Pemulihan Akun Baru Anda"
        description="Akun Anda baru saja dibuat untuk pengajuan workspace ini. Simpan 8 kode pemulihan ini sekarang karena HANYA DITAMPILKAN SEKALI untuk pemulihan kata sandi tanpa email."
        onAcknowledge={() => {
          setRecoveryCodes(null);
        }}
        buttonText="Saya Telah Menyimpan Kode Pemulihan"
      />
    </div>
  );
};
