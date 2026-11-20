import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { CheckCircle2, AlertCircle, ArrowRight, LogIn, UserPlus } from 'lucide-react';

export const InviteAcceptPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, user, switchTenant } = useAuth();

  const [inviteToken, setInviteToken] = useState<string>(() => {
    // 1. Check memory router state
    if (location.state?.inviteToken) {
      return location.state.inviteToken;
    }
    // 2. Check URL fragment (#token=...) per RULE 4.6
    if (typeof window !== 'undefined' && window.location.hash) {
      try {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        const t = hashParams.get('token');
        if (t) return t.trim();
      } catch {
        // ignore
      }
    }
    // 3. Fallback query string
    try {
      const qParams = new URLSearchParams(window.location.search);
      return qParams.get('token')?.trim() || '';
    } catch {
      return '';
    }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  // Immediately purge token from address bar (RULE 4.6)
  useEffect(() => {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const handleAccept = async () => {
    if (!inviteToken) {
      setError('Token undangan tidak ditemukan. Silakan klik ulang tautan undangan Anda.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await api.acceptInvitation(inviteToken);
      setSuccess(`Selamat! Anda telah bergabung ke workspace "${res.tenant.name}" sebagai ${res.role}.`);
      // Automatically switch to the newly accepted tenant
      await switchTenant(res.tenant.id);
      setTimeout(() => {
        navigate('/');
      }, 2000);
    } catch (err: any) {
      if (err.status === 404 || err.code === 'INVALID_INVITATION') {
        setError('Undangan tidak valid atau sudah tidak berlaku.');
      } else if (err.status === 409 && err.code === 'ALREADY_MEMBER') {
        setError('Anda sudah menjadi anggota di workspace ini.');
      } else {
        setError(err.message || 'Gagal menerima undangan.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4 font-sans antialiased">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 sm:p-10 border border-slate-100 text-center relative z-10">
        <div className="flex justify-center mb-4">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Logo"
            className="w-14 h-14 rounded-2xl object-cover shadow-lg shadow-emerald-500/20 border-2 border-emerald-500/30"
          />
        </div>

        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Undangan Bergabung Tim</h1>
        <p className="text-xs text-slate-500 mt-1 mb-6">
          Anda diundang untuk bergabung ke workspace WhatsApp Gateway.
        </p>

        {!inviteToken ? (
          <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 space-y-2 text-left">
            <div className="flex items-center gap-2 font-bold text-rose-900">
              <AlertCircle className="w-4 h-4 text-rose-600" />
              <span>Token Undangan Tidak Ditemukan</span>
            </div>
            <p className="leading-relaxed">
              Tautan undangan tidak memuat token yang valid atau telah dibersihkan. Silakan buka kembali tautan lengkap yang diberikan oleh administrator tim Anda.
            </p>
          </div>
        ) : !isAuthenticated ? (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-3 text-left">
            <p className="text-xs text-amber-900 font-medium leading-relaxed">
              Untuk menerima undangan ini, Anda harus masuk atau mendaftar menggunakan alamat email yang diundang.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => navigate('/login', { state: { inviteToken } })}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition shadow-xs"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Masuk (Login)</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/register', { state: { inviteToken } })}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 border border-slate-300 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-50 transition"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Daftar Akun Baru</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 text-left">
              Masuk sebagai: <span className="font-semibold text-slate-800 font-mono">{user?.email}</span>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2 text-left">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {success ? (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-800 space-y-2">
                <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
                <p className="text-xs font-bold">{success}</p>
                <p className="text-[11px] text-emerald-600">Mengalihkan ke dashboard workspace...</p>
              </div>
            ) : (
              <button
                onClick={handleAccept}
                disabled={loading || !inviteToken}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl text-xs sm:text-sm font-bold text-white hover:from-emerald-700 hover:to-teal-700 transition shadow-lg shadow-emerald-600/25 disabled:opacity-50"
              >
                <span>{loading ? 'Memproses...' : 'Terima Undangan & Gabung'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
