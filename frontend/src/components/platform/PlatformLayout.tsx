import React, { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, Outlet, useLocation, Link } from 'react-router-dom';
import { platformSession } from '../../services/platformApi';
import { useTheme } from '../../context/ThemeContext';
import {
  Server,
  Building2,
  Sliders,
  ShieldAlert,
  Database,
  LogOut,
  Shield,
  Sun,
  Moon,
  Menu,
  X,
  ChevronRight,
  Home,
  User,
  Radio,
} from 'lucide-react';

export const PlatformLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme, toggleTheme } = useTheme();

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

  const handleLogout = () => {
    setIsUserMenuOpen(false);
    platformSession.clear();
    navigate('/platform/login');
  };

  const navGroups = [
    {
      title: 'Tata Kelola Tenant',
      items: [
        {
          to: '/platform/workspaces',
          label: 'Daftar Workspace',
          icon: <Building2 className="w-4 h-4" />,
        },
      ],
    },
    {
      title: 'Kebijakan & Sistem',
      items: [
        {
          to: '/platform/defaults',
          label: 'Kuota Bawaan',
          icon: <Sliders className="w-4 h-4" />,
        },
        {
          to: '/platform/backup',
          label: 'Status Cadangan DB',
          icon: <Database className="w-4 h-4" />,
        },
      ],
    },
    {
      title: 'Audit & Kepatuhan',
      items: [
        {
          to: '/platform/audit',
          label: 'Jejak Audit Platform',
          icon: <ShieldAlert className="w-4 h-4" />,
        },
      ],
    },
  ];

  const getBreadcrumbTitle = () => {
    const path = location.pathname;
    if (path.includes('/platform/workspaces/')) return 'Detail Workspace';
    if (path.includes('/platform/workspaces')) return 'Daftar Workspace';
    if (path.includes('/platform/defaults')) return 'Kuota Bawaan';
    if (path.includes('/platform/backup')) return 'Status Cadangan';
    if (path.includes('/platform/audit')) return 'Log Audit';
    return 'Dashboard';
  };

  const renderSidebarContent = () => (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-900 text-slate-300">
      {/* Brand Header */}
      <div className="h-16 flex items-center justify-between px-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-purple-600 flex items-center justify-center text-white font-bold shadow-md shadow-purple-600/30">
            <Server className="w-4 h-4" />
          </div>
          <div>
            <span className="font-bold text-white tracking-tight text-sm block">
              WAZAP GATEWAY
            </span>
            <span className="text-[10px] block font-semibold uppercase text-purple-400 tracking-wider">
              Platform Operator
            </span>
          </div>
        </div>

        {mobileMenuOpen && (
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Operator Session RAM Badge */}
      <div className="px-3 pt-3.5">
        <div className="p-3 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-400 font-medium">Sesi Memori (RAM):</span>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div className="text-xs font-mono font-bold text-white flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-purple-400" />
              <span>TERVERIFIKASI</span>
            </span>
            <span className="text-purple-300">AKTIF</span>
          </div>
        </div>
      </div>

      {/* Nav List */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {group.title}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition ${
                    isActive
                      ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                  }`
                }
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Logout Footer */}
      <div className="p-3 border-t border-slate-800">
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950/80 hover:bg-rose-950/60 text-xs font-semibold text-slate-300 hover:text-rose-300 border border-slate-800 transition cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-purple-900/60 text-purple-300 flex items-center justify-center font-bold text-[10px]">
              OP
            </div>
            <span>Keluar Sesi</span>
          </div>
          <LogOut className="w-4 h-4 text-slate-500" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50/70 dark:bg-slate-950 font-sans text-slate-900 dark:text-slate-100 antialiased selection:bg-purple-100 selection:text-purple-900 transition-colors">
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col shrink-0 min-h-screen border-r border-slate-800 shadow-xl">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative flex flex-col w-72 max-w-[82vw] h-full shadow-2xl border-r border-slate-800 z-10 animate-in slide-in-from-left duration-200">
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      {/* Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header (Disamakan dengan header aplikasi utama) */}
        <header className="h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 shadow-xs transition-colors">
          <div className="h-full w-full px-3.5 sm:px-5 lg:px-6 flex items-center justify-between">
            {/* Left: Mobile Hamburger & Breadcrumb */}
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-1.5 -ml-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                title="Buka Menu Navigasi"
              >
                <Menu className="w-5 h-5" />
              </button>

              <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 sm:gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                <Link
                  to="/platform/workspaces"
                  className="flex items-center gap-1.5 text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 transition"
                  title="Kembali ke Konsol Utama"
                >
                  <Home className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Konsol Platform</span>
                </Link>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 shrink-0" />
                <span className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm tracking-tight truncate max-w-[170px] sm:max-w-none">
                  {getBreadcrumbTitle()}
                </span>
              </nav>
            </div>

            {/* Right: Status Indicators, Theme Toggle & User Avatar Dropdown */}
            <div className="flex items-center gap-2 sm:gap-3 text-xs">
              {/* RAM Session Indicator (Desktop) */}
              <div className="hidden md:flex items-center gap-2 border-r border-slate-200 dark:border-slate-800 pr-3">
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800"
                  title="Sesi memori browser terverifikasi aktif"
                >
                  <Radio className="w-3 h-3 text-purple-600 dark:text-purple-400 animate-pulse" />
                  <span>Sesi:</span>
                  <span className="font-semibold">RAM Terverifikasi</span>
                </div>
              </div>

              {/* Dark / Light Theme Toggle */}
              <button
                type="button"
                onClick={toggleTheme}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer"
                title={resolvedTheme === 'dark' ? 'Beralih ke Mode Terang' : 'Beralih ke Mode Gelap'}
              >
                {resolvedTheme === 'dark' ? (
                  <Sun className="w-4 h-4 text-amber-400" />
                ) : (
                  <Moon className="w-4 h-4 text-slate-600" />
                )}
              </button>

              {/* User Avatar with Dropdown (Menggantikan tombol Keluar langsung) */}
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                  className="relative flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-600 text-white font-bold text-xs shadow-xs hover:ring-2 hover:ring-purple-500/30 transition focus:outline-none select-none cursor-pointer"
                  title="Operator Platform Sesi"
                >
                  OP
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900" />
                </button>

                {/* Dropdown Menu */}
                {isUserMenuOpen && (
                  <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150 divide-y divide-slate-100 dark:divide-slate-800">
                    {/* User Info Header Summary */}
                    <div className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl bg-purple-600 text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
                          OP
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-slate-900 dark:text-slate-100 text-xs truncate">
                            Operator Platform
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded border bg-purple-50 dark:bg-purple-950/60 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-800">
                              OPERATOR
                            </span>
                            <span className="text-[10px] text-slate-400 truncate">Sesi RAM Aktif</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Navigation Shortcut Menu Items */}
                    <div className="py-1">
                      <Link
                        to="/platform/workspaces"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-purple-700 dark:hover:text-purple-400 transition"
                      >
                        <Building2 className="w-4 h-4 text-purple-600 shrink-0" />
                        <span className="font-medium text-slate-800 dark:text-slate-200">Daftar Workspace</span>
                      </Link>

                      <Link
                        to="/platform/defaults"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-purple-700 dark:hover:text-purple-400 transition"
                      >
                        <Sliders className="w-4 h-4 text-slate-500 shrink-0" />
                        <span className="font-medium text-slate-800 dark:text-slate-200">Kuota Bawaan</span>
                      </Link>

                      <Link
                        to="/platform/backup"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-purple-700 dark:hover:text-purple-400 transition"
                      >
                        <Database className="w-4 h-4 text-slate-500 shrink-0" />
                        <span className="font-medium text-slate-800 dark:text-slate-200">Status Cadangan DB</span>
                      </Link>

                      <Link
                        to="/platform/audit"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-purple-700 dark:hover:text-purple-400 transition"
                      >
                        <ShieldAlert className="w-4 h-4 text-slate-500 shrink-0" />
                        <span className="font-medium text-slate-800 dark:text-slate-200">Jejak Audit</span>
                      </Link>
                    </div>

                    {/* Logout Action */}
                    <div className="p-1.5">
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                      >
                        <LogOut className="w-4 h-4 shrink-0" />
                        <span>Keluar</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Main Canvas */}
        <main className="flex-1 w-full px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
