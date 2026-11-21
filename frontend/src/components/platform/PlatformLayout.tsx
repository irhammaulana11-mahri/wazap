import React from 'react';
import { Link, NavLink, useNavigate, Outlet } from 'react-router-dom';
import { platformSession } from '../../services/platformApi';
import {
  Server,
  Building2,
  Sliders,
  ShieldAlert,
  Database,
  LogOut,
  Shield,
} from 'lucide-react';

export const PlatformLayout: React.FC = () => {
  const navigate = useNavigate();

  const handleLogout = () => {
    platformSession.clear();
    navigate('/platform/login');
  };

  const navLinks = [
    { to: '/platform/workspaces', label: 'Workspaces', icon: <Building2 className="w-4 h-4" /> },
    { to: '/platform/defaults', label: 'Kuota Bawaan', icon: <Sliders className="w-4 h-4" /> },
    { to: '/platform/audit', label: 'Audit Log', icon: <ShieldAlert className="w-4 h-4" /> },
    { to: '/platform/backup', label: 'Status Cadangan', icon: <Database className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 font-sans antialiased">
      {/* Platform Header */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/platform/workspaces" className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-purple-600/20 text-purple-400 border border-purple-500/30">
                <Server className="w-5 h-5" />
              </div>
              <div>
                <span className="font-bold text-white text-sm tracking-tight block">
                  WAZAP PLATFORM
                </span>
                <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider block">
                  Operator Console
                </span>
              </div>
            </Link>

            <nav className="hidden md:flex items-center gap-1 pl-4 border-l border-slate-800">
              {navLinks.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                      isActive
                        ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                    }`
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-slate-900 border border-slate-800 text-slate-400">
              <Shield className="w-3.5 h-3.5 text-purple-400" />
              <span>Kredensial Memori</span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold text-rose-400 hover:text-white hover:bg-rose-950/60 border border-rose-900/50 transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 text-center text-xs text-slate-500">
        Konsol Platform Admin &bull; Akses Terbatas Operator &bull; Tanpa Penyimpanan Kredensial di Disk
      </footer>
    </div>
  );
};
