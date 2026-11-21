import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { AlertTriangle, ShieldAlert, KeyRound, UserPlus, X } from 'lucide-react';

export const SecurityBanners: React.FC = () => {
  const { tenant, role, recovery } = useAuth();
  const [dismissTwoOwnerBanner, setDismissTwoOwnerBanner] = useState(false);

  // Ambil data anggota tim untuk mendeteksi jumlah OWNER aktif
  const { data: teamData } = useQuery({
    queryKey: ['team-members-owners-check', tenant?.id],
    queryFn: () => api.getTeamMembers(1, 100),
    enabled: !!tenant?.id && role === 'OWNER',
    staleTime: 60000,
  });

  const activeOwners = teamData?.data?.filter(
    (m) => m.role === 'OWNER' && m.status === 'ACTIVE'
  ) || [];

  const isSingleOwner = teamData?.data && activeOwners.length === 1;

  // Banner 1: Kode Pemulihan
  // Muncul jika confirmed === false ATAU codes_remaining <= 2
  const showRecoveryNotConfirmed = recovery && recovery.confirmed === false;
  const showLowRecoveryCodes = recovery && recovery.codes_remaining <= 2;

  // Banner 2: 2 OWNER
  const showTwoOwnerWarning = isSingleOwner && !dismissTwoOwnerBanner && role === 'OWNER';

  if (!showRecoveryNotConfirmed && !showLowRecoveryCodes && !showTwoOwnerWarning) {
    return null;
  }

  return (
    <div className="space-y-3 mb-5">
      {/* Banner Kode Pemulihan: Belum Dikonfirmasi */}
      {showRecoveryNotConfirmed && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-900 dark:text-amber-200">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5 sm:mt-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-amber-900 dark:text-amber-100">
                Peringatan: 8 Kode Pemulihan Belum Dikonfirmasi
              </h4>
              <p className="text-[11px] sm:text-xs text-amber-800/90 dark:text-amber-300/90 mt-0.5 leading-relaxed">
                Anda belum mengonfirmasi penyimpanan kode pemulihan akun. Jika lupa kata sandi tanpa kode ini, Anda akan terkunci permanen.
              </p>
            </div>
          </div>
          <Link
            to="/profile?tab=security"
            className="shrink-0 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
          >
            Buka Pengaturan Akun
          </Link>
        </div>
      )}

      {/* Banner Kode Pemulihan: Sisa <= 2 */}
      {!showRecoveryNotConfirmed && showLowRecoveryCodes && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-2xl text-rose-900 dark:text-rose-200">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2 rounded-xl bg-rose-500/20 text-rose-700 dark:text-rose-400 shrink-0 mt-0.5 sm:mt-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-rose-900 dark:text-rose-100">
                Sisa Kode Pemulihan Tinggal {recovery?.codes_remaining}
              </h4>
              <p className="text-[11px] sm:text-xs text-rose-800/90 dark:text-rose-300/90 mt-0.5 leading-relaxed">
                Sisa kode pemulihan akun Anda hampir habis. Segera terbitkan himpunan kode baru di Pengaturan Akun agar tetap dapat memulihkan akses saat darurat.
              </p>
            </div>
          </div>
          <Link
            to="/profile?tab=security"
            className="shrink-0 px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
          >
            Terbitkan Kode Baru
          </Link>
        </div>
      )}

      {/* Banner Anjuran 2 OWNER */}
      {showTwoOwnerWarning && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-blue-500/10 border border-blue-500/30 rounded-2xl text-blue-950 dark:text-blue-200">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2 rounded-xl bg-blue-500/20 text-blue-700 dark:text-blue-400 shrink-0 mt-0.5 sm:mt-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-blue-900 dark:text-blue-100">
                Anjuran Keamanan: Tambahkan Minimal 2 Owner
              </h4>
              <p className="text-[11px] sm:text-xs text-blue-800/90 dark:text-blue-300/90 mt-0.5 leading-relaxed">
                Workspace <strong>{tenant?.name}</strong> saat ini hanya memiliki 1 Owner aktif. Disarankan menambahkan minimal 2 Owner agar workspace tidak kehilangan pengelola bila salah satu akun terkunci atau kehilangan akses.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/team"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Kelola Tim</span>
            </Link>
            <button
              onClick={() => setDismissTwoOwnerBanner(true)}
              className="p-1.5 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 hover:bg-blue-100/60 dark:hover:bg-blue-900/40 rounded-lg transition"
              title="Tutup banner peringatan"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
