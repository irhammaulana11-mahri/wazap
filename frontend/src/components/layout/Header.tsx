import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { useToast } from '../../context/ToastContext';
import {
  Activity,
  Database,
  Radio,
  Volume2,
  VolumeX,
  User,
  Settings,
  LogOut,
  ChevronRight,
  Home,
  Menu,
} from 'lucide-react';

interface HeaderProps {
  onOpenMobileMenu?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenMobileMenu }) => {
  const { tenant, role, user, logout } = useAuth();
  const { isConnected: socketConnected } = useSocket();
  const { soundEnabled, toggleSound } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    refetchInterval: 10000,
  });

  const isDbUp = health?.checks?.database === 'UP';

  // Role metadata
  const roleConfig = {
    OWNER: {
      label: 'Owner',
      badge: 'bg-amber-50 text-amber-800 border-amber-300',
    },
    ADMIN: {
      label: 'Admin',
      badge: 'bg-blue-50 text-blue-800 border-blue-300',
    },
    MEMBER: {
      label: 'Member',
      badge: 'bg-emerald-50 text-emerald-800 border-emerald-300',
    },
    VIEWER: {
      label: 'Viewer',
      badge: 'bg-slate-100 text-slate-700 border-slate-300',
    },
  };

  const currentRoleInfo = role ? roleConfig[role] : roleConfig.MEMBER;

  // Breadcrumb mapping based on active route
  const getBreadcrumbTitle = (pathname: string) => {
    if (pathname === '/') return 'Dashboard Overview';
    if (pathname.startsWith('/chats')) return 'Pesan & Obrolan';
    if (pathname.startsWith('/contacts')) return 'Kontak WhatsApp';
    if (pathname.startsWith('/connections')) return 'Koneksi & API Gateway';
    if (pathname.startsWith('/usage')) return 'Penggunaan & Kuota';
    if (pathname.startsWith('/team')) return 'Anggota Tim';
    if (pathname.startsWith('/settings')) return 'Pengaturan Kuota Workspace';
    if (pathname.startsWith('/audit-logs')) return 'Log Audit Keamanan';
    if (pathname.startsWith('/profile')) return 'Profil & Status Kuota';
    return 'Dashboard';
  };

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch {
      navigate('/login');
    }
  };

  // User initial avatar
  const userInitial = user?.email ? user.email.slice(0, 2).toUpperCase() : 'WA';

  return (
    <header className="h-16 bg-white/95 backdrop-blur-md border-b border-slate-200 sticky top-0 z-30 shadow-xs">
      <div className="h-full w-full px-3.5 sm:px-5 lg:px-6 flex items-center justify-between">
        {/* Left: Mobile Menu Hamburger & Breadcrumbs */}
        <div className="flex items-center gap-2 sm:gap-3">
          {onOpenMobileMenu && (
            <button
              type="button"
              onClick={onOpenMobileMenu}
              className="lg:hidden p-1.5 -ml-1 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition"
              title="Buka Menu Navigasi"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 sm:gap-2 text-xs font-medium text-slate-500">
            <Link
              to="/"
              className="flex items-center gap-1.5 text-slate-400 hover:text-emerald-600 transition"
              title="Kembali ke Dashboard Utama"
            >
              <Home className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Home</span>
            </Link>
            <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
            <span className="font-bold text-slate-800 text-xs sm:text-sm tracking-tight truncate max-w-[170px] sm:max-w-none">
              {getBreadcrumbTitle(location.pathname)}
            </span>
          </nav>
        </div>

        {/* Center / Right: System Status & User Inisial Logo */}
        <div className="flex items-center gap-2 sm:gap-3 text-xs">
          {/* System Status Indicators (Desktop) */}
          <div className="hidden lg:flex items-center gap-2 border-r border-slate-200 pr-3">
            {/* Realtime Status */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                socketConnected
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-slate-100 text-slate-600 border border-slate-200'
              }`}
              title={socketConnected ? 'Realtime Socket.IO terhubung' : 'Realtime offline'}
            >
              <Radio className={`w-3 h-3 ${socketConnected ? 'animate-pulse text-emerald-600' : ''}`} />
              <span>Socket:</span>
              <span className="font-semibold">{socketConnected ? 'Online' : 'Offline'}</span>
            </div>

            {/* Database Status */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                isDbUp
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-200'
              }`}
              title="Status database PostgreSQL backend"
            >
              <Database className="w-3 h-3" />
              <span>DB:</span>
              <span className="font-semibold">{health?.checks?.database || 'UP'}</span>
            </div>

            {/* API Status */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                health?.status === 'READY'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}
              title="Status REST API Gateway"
            >
              <Activity className="w-3 h-3" />
              <span>API:</span>
              <span className="font-semibold">{health?.status || 'READY'}</span>
            </div>

            {/* Audio Notification Toggle */}
            <button
              onClick={toggleSound}
              className={`p-1.5 rounded-lg border transition ${
                soundEnabled
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200'
              }`}
              title={soundEnabled ? 'Suara Notifikasi: Aktif' : 'Suara Notifikasi: Senyap'}
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* User Logo (Inisial Only) with 3-Menu Dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              className="relative flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold text-xs shadow-xs hover:ring-2 hover:ring-emerald-500/30 transition focus:outline-none select-none"
              title={`Akun: ${user?.email || 'Pengguna'}`}
            >
              {userInitial}
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
            </button>

            {/* Dropdown Menu (HANYA 3 Menu: Profil, Pengaturan, Logout) */}
            {isUserMenuOpen && (
              <div className="absolute right-0 mt-2 w-64 bg-white rounded-2xl shadow-xl border border-slate-200 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150 divide-y divide-slate-100">
                {/* User Info Header Summary */}
                <div className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      {userInitial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-900 text-xs truncate">{user?.email}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${currentRoleInfo.badge}`}
                        >
                          {currentRoleInfo.label}
                        </span>
                        <span className="text-[10px] text-slate-400 truncate">{tenant?.name}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3 Menu Items Only */}
                <div className="py-1">
                  {/* Menu 1: Profil */}
                  <Link
                    to="/profile"
                    onClick={() => setIsUserMenuOpen(false)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-emerald-700 transition"
                  >
                    <User className="w-4 h-4 text-emerald-600 shrink-0" />
                    <div className="text-left flex-1 min-w-0">
                      <span className="font-semibold block text-slate-800">Profil</span>
                      <span className="text-[10px] text-slate-400 block truncate">
                        Data akun & status kuota
                      </span>
                    </div>
                  </Link>

                  {/* Menu 2: Pengaturan */}
                  <Link
                    to={role === 'OWNER' ? '/settings' : '/profile?tab=quota'}
                    onClick={() => setIsUserMenuOpen(false)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-emerald-700 transition"
                  >
                    <Settings className="w-4 h-4 text-slate-600 shrink-0" />
                    <div className="text-left flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold block text-slate-800">Pengaturan</span>
                        {role === 'OWNER' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-100 text-amber-800">
                            Owner
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 block truncate">
                        {role === 'OWNER' ? 'Atur alokasi kuota workspace' : 'Status kuota (Read-Only)'}
                      </span>
                    </div>
                  </Link>
                </div>

                {/* Menu 3: Logout */}
                <div className="p-1.5">
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50 transition"
                  >
                    <LogOut className="w-4 h-4 shrink-0" />
                    <span>Logout</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
