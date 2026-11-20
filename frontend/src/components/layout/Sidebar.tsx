import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Network,
  BarChart3,
  ShieldCheck,
  Sliders,
  ClipboardList,
  User,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const { role } = useAuth();
  const isOwner = role === 'OWNER';
  const isOwnerOrAdmin = role === 'OWNER' || role === 'ADMIN';

  const primaryItems = [
    { to: '/', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
    { to: '/chats', label: 'Pesan & Obrolan', icon: <MessageSquare className="w-4 h-4" /> },
    { to: '/contacts', label: 'Kontak WhatsApp', icon: <Users className="w-4 h-4" /> },
  ];

  const integrationItems = [
    { to: '/connections', label: 'Koneksi & API', icon: <Network className="w-4 h-4" /> },
    { to: '/usage', label: 'Penggunaan & Kuota', icon: <BarChart3 className="w-4 h-4" /> },
    { to: '/team', label: 'Anggota Tim', icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  const configurationItems = [
    { to: '/profile', label: 'Profil Saya', icon: <User className="w-4 h-4" /> },
    ...(isOwnerOrAdmin
      ? [{ to: '/audit-logs', label: 'Log Audit', icon: <ClipboardList className="w-4 h-4" /> }]
      : []),
    ...(isOwner
      ? [{ to: '/settings', label: 'Pengaturan Kuota', icon: <Sliders className="w-4 h-4" /> }]
      : []),
  ];

  const renderNavContent = () => (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Brand Header */}
      <div className="h-16 flex items-center justify-between px-5 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo-wazap.jpeg"
            alt="WAZAP Logo"
            className="w-8 h-8 rounded-xl object-cover shadow-md shadow-emerald-500/20 border border-emerald-500/30"
          />
          <div>
            <span className="font-bold text-white tracking-tight text-sm">WAZAP GATEWAY</span>
            <span className="text-[10px] block font-medium uppercase text-emerald-400 tracking-wider">
              v1.0 Enterprise
            </span>
          </div>
        </div>

        {/* Mobile Close Button */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav List */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {/* Group 1: Aktivitas Utama */}
        <div className="space-y-1">
          <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Aktivitas Utama
          </div>
          {primaryItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`
              }
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </NavLink>
          ))}
        </div>

        {/* Group 2: Integrasi & Gateway */}
        <div className="space-y-1">
          <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Integrasi & Gateway
          </div>
          {integrationItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`
              }
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </NavLink>
          ))}
        </div>

        {/* Group 3: Konfigurasi & Akun */}
        <div className="space-y-1">
          <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Konfigurasi & Akun
          </div>
          {configurationItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`
              }
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden lg:flex w-64 bg-slate-900 text-slate-300 flex-col shrink-0 min-h-screen border-r border-slate-800">
        {renderNavContent()}
      </aside>

      {/* Mobile Drawer (Visible on screens < lg when isOpen is true) */}
      {isOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={onClose}
          />
          {/* Drawer Sidebar */}
          <aside className="relative flex flex-col w-72 max-w-[82vw] bg-slate-900 text-slate-300 h-full shadow-2xl border-r border-slate-800 z-10 animate-in slide-in-from-left duration-200">
            {renderNavContent()}
          </aside>
        </div>
      )}
    </>
  );
};
