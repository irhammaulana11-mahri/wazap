import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { Link } from 'react-router-dom';
import {
  Smartphone,
  Send,
  Inbox,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
  Activity,
  Users,
  CheckCircle2,
  Clock,
  RefreshCw,
  Sparkles,
  QrCode,
  Key,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export const DashboardPage: React.FC = () => {
  const [showWizard, setShowWizard] = useState(true);

  const {
    data: sessions = [],
    isLoading: loadingSessions,
    error: sessionError,
    refetch: refetchSessions,
  } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
    refetchInterval: 5000,
  });

  const {
    data: messagesData,
    isLoading: loadingMessages,
    error: messagesError,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: ['messages', 'recent'],
    queryFn: () => api.getMessages({ page: 1, page_size: 5 }),
    refetchInterval: 5000,
  });

  const {
    data: usageRes,
    isLoading: loadingUsage,
    refetch: refetchUsage,
  } = useQuery({
    queryKey: ['usage-summary'],
    queryFn: () => api.getUsageSummary(),
    refetchInterval: 10000,
  });

  if (loadingSessions && loadingMessages && loadingUsage) {
    return <LoadingState message="Memuat ringkasan dashboard..." />;
  }

  if (sessionError) {
    return (
      <ErrorState
        title="Gagal Memuat Dashboard"
        message={(sessionError as Error).message}
        onRetry={() => {
          refetchSessions();
          refetchMessages();
          refetchUsage();
        }}
      />
    );
  }

  const connectedSessions = sessions.filter((s) => s.status === 'CONNECTED');
  const connectingSessions = sessions.filter((s) =>
    ['CONNECTING', 'RECONNECTING', 'INITIALIZING'].includes(s.status)
  );
  const errorSessions = sessions.filter((s) => ['ERROR', 'LOGGED_OUT'].includes(s.status));

  const recentMessages = messagesData?.data || [];
  const quotas = usageRes?.quotas;
  const messagesSummary = usageRes?.messages;

  // Onboarding Step Calculations
  const step1Done = sessions.length > 0;
  const step2Done = connectedSessions.length > 0;
  const step3Done = (messagesSummary?.total ?? 0) > 0;
  const step4Done = (quotas?.api_keys?.used ?? 0) > 0 || (quotas?.webhooks?.used ?? 0) > 0;

  const completedSteps = [step1Done, step2Done, step3Done, step4Done].filter(Boolean).length;
  const progressPercent = Math.round((completedSteps / 4) * 100);

  return (
    <div className="space-y-6">
      {/* Title & Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Dashboard Overview</h1>
          <p className="text-sm text-slate-500">
            Monitoring performa WhatsApp Gateway, penggunaan kuota, dan status sesi aktif.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/sessions"
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition shadow-sm"
          >
            <Smartphone className="w-4 h-4 text-slate-500" />
            Kelola Sesi
          </Link>
          <Link
            to="/chats"
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 rounded-lg text-sm font-medium text-white hover:bg-emerald-700 transition shadow-sm"
          >
            <Send className="w-4 h-4" />
            Buka Obrolan
          </Link>
        </div>
      </div>

      {/* TAHAP 1: Interactive Getting Started Setup Wizard */}
      <div className="bg-gradient-to-r from-emerald-900 to-slate-900 rounded-2xl p-6 text-white shadow-md relative overflow-hidden border border-emerald-800/40">
        <div className="absolute right-0 top-0 translate-x-12 -translate-y-8 opacity-10 pointer-events-none">
          <Sparkles className="w-64 h-64 text-emerald-300" />
        </div>

        <div className="relative z-10 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-emerald-500/20 rounded-xl border border-emerald-400/30 text-emerald-400">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  Panduan Memulai Gateway
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-300 border border-emerald-400/30">
                    {progressPercent}% Selesai
                  </span>
                </h2>
                <p className="text-xs text-slate-300 mt-0.5">
                  Ikuti 4 langkah ini untuk menghubungkan nomor WhatsApp dan mengotomasi pengiriman pesan Anda.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowWizard(!showWizard)}
              className="text-slate-400 hover:text-white p-1.5 transition text-xs flex items-center gap-1 font-medium bg-white/5 hover:bg-white/10 rounded-lg border border-white/10"
            >
              {showWizard ? 'Sembunyikan' : 'Tampilkan'}
              {showWizard ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-white/10">
            <div
              className="bg-emerald-400 h-full rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Wizard Steps Grid */}
          {showWizard && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2">
              {/* Step 1 */}
              <div
                className={`p-4 rounded-xl border transition flex flex-col justify-between ${
                  step1Done
                    ? 'bg-emerald-950/40 border-emerald-500/30'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Langkah 1
                    </span>
                    {step1Done ? (
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="w-5 h-5 rounded-full border border-slate-500 text-slate-400 flex items-center justify-center text-[10px]">
                        1
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-semibold text-white">Buat Sesi WhatsApp</h3>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Daftarkan nama sesi untuk perangkat Anda.
                  </p>
                </div>
                <div className="mt-3 pt-2 border-t border-white/10">
                  {step1Done ? (
                    <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Sesi Dibuat
                    </span>
                  ) : (
                    <Link
                      to="/sessions"
                      className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      Tambah Sesi <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>

              {/* Step 2 */}
              <div
                className={`p-4 rounded-xl border transition flex flex-col justify-between ${
                  step2Done
                    ? 'bg-emerald-950/40 border-emerald-500/30'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Langkah 2
                    </span>
                    {step2Done ? (
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="w-5 h-5 rounded-full border border-slate-500 text-slate-400 flex items-center justify-center text-[10px]">
                        2
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-semibold text-white">Pindai QR Code</h3>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Tautkan perangkat fisik lewat aplikasi WhatsApp HP.
                  </p>
                </div>
                <div className="mt-3 pt-2 border-t border-white/10">
                  {step2Done ? (
                    <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Terhubung
                    </span>
                  ) : (
                    <Link
                      to="/sessions"
                      className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      Scan QR Sekarang <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>

              {/* Step 3 */}
              <div
                className={`p-4 rounded-xl border transition flex flex-col justify-between ${
                  step3Done
                    ? 'bg-emerald-950/40 border-emerald-500/30'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Langkah 3
                    </span>
                    {step3Done ? (
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="w-5 h-5 rounded-full border border-slate-500 text-slate-400 flex items-center justify-center text-[10px]">
                        3
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-semibold text-white">Uji Kirim Pesan</h3>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Kirim pesan perdana untuk memverifikasi jalur antrean.
                  </p>
                </div>
                <div className="mt-3 pt-2 border-t border-white/10">
                  {step3Done ? (
                    <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Berhasil Dikirim
                    </span>
                  ) : (
                    <Link
                      to="/chats"
                      className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      Buka Pesan <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>

              {/* Step 4 */}
              <div
                className={`p-4 rounded-xl border transition flex flex-col justify-between ${
                  step4Done
                    ? 'bg-emerald-950/40 border-emerald-500/30'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Langkah 4
                    </span>
                    {step4Done ? (
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="w-5 h-5 rounded-full border border-slate-500 text-slate-400 flex items-center justify-center text-[10px]">
                        4
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-semibold text-white">Kunci API & Webhook</h3>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Integrasikan gateway ke aplikasi web atau CRM Anda.
                  </p>
                </div>
                <div className="mt-3 pt-2 border-t border-white/10">
                  {step4Done ? (
                    <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Terintegrasi
                    </span>
                  ) : (
                    <Link
                      to="/api-keys"
                      className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      Buat API Key <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Active Sessions */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Sesi Terhubung
            </p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-bold text-slate-900">{connectedSessions.length}</span>
              <span className="text-xs text-slate-400">
                / {quotas ? quotas.sessions.max : sessions.length} maks
              </span>
            </div>
            <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {connectedSessions.length} siap kirim
            </p>
          </div>
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <Smartphone className="w-6 h-6" />
          </div>
        </div>

        {/* Messages Volume */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Volume Pesan
            </p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-bold text-slate-900">
                {messagesSummary ? messagesSummary.total.toLocaleString() : 0}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {messagesSummary ? messagesSummary.sent : 0} terkirim, {messagesSummary ? messagesSummary.failed : 0} gagal
            </p>
          </div>
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
            <Send className="w-6 h-6" />
          </div>
        </div>

        {/* Rate Limit */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Rate Limit
            </p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-bold text-slate-900">
                {quotas ? quotas.messages_per_minute : 60}
              </span>
              <span className="text-xs text-slate-400">msg / mnt</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">Batas throughput tenant</p>
          </div>
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
            <Activity className="w-6 h-6" />
          </div>
        </div>

        {/* Issues / Pending */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Perhatian Sesi
            </p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-bold text-slate-900">
                {errorSessions.length + connectingSessions.length}
              </span>
            </div>
            <p className="text-xs text-amber-600 mt-1">
              {errorSessions.length} error, {connectingSessions.length} proses sambung
            </p>
          </div>
          <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
            <AlertTriangle className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Main Grid: Sessions & Recent Messages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sessions Card */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-slate-600" />
                <h2 className="text-base font-semibold text-slate-900">Status Sesi WhatsApp</h2>
              </div>
              <Link
                to="/sessions"
                className="text-xs font-medium text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
              >
                Lihat Semua <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {sessions.length === 0 ? (
              <div className="text-center py-8 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                <Smartphone className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-600">Belum ada sesi aktif</p>
                <p className="text-xs text-slate-400 mt-0.5 mb-3">
                  Buat sesi baru untuk mulai menghubungkan nomor WhatsApp.
                </p>
                <Link
                  to="/sessions"
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 transition"
                >
                  Tambah Sesi
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {sessions.slice(0, 4).map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          session.status === 'CONNECTED'
                            ? 'bg-emerald-500'
                            : ['CONNECTING', 'RECONNECTING', 'INITIALIZING'].includes(session.status)
                            ? 'bg-blue-500 animate-pulse'
                            : session.status === 'QR_REQUIRED'
                            ? 'bg-amber-500 animate-pulse'
                            : 'bg-slate-300'
                        }`}
                      />
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {session.session_name || session.id}
                        </p>
                        <p className="text-xs text-slate-500">
                          {session.phone_number ? `+${session.phone_number}` : 'Belum tertaut nomor'}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        session.status === 'CONNECTED'
                          ? 'bg-emerald-50 text-emerald-700'
                          : session.status === 'QR_REQUIRED'
                          ? 'bg-amber-50 text-amber-700'
                          : ['CONNECTING', 'RECONNECTING'].includes(session.status)
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {session.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Messages Card */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Send className="w-5 h-5 text-slate-600" />
                <h2 className="text-base font-semibold text-slate-900">Pesan Terakhir</h2>
              </div>
              <Link
                to="/chats"
                className="text-xs font-medium text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
              >
                Lihat Semua <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {recentMessages.length === 0 ? (
              <div className="text-center py-8 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                <Send className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-600">Belum ada riwayat pesan</p>
                <p className="text-xs text-slate-400 mt-0.5 mb-3">
                  Pesan yang dikirim melalui gateway akan muncul di sini.
                </p>
                <Link
                  to="/chats"
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 transition"
                >
                  Buka Obrolan Pertama
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-900 truncate">
                          +{msg.to}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(msg.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {msg.message || (msg.media ? `[Media: ${msg.type}]` : '-')}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                        ['SENT', 'DELIVERED', 'READ'].includes(msg.status)
                          ? 'bg-emerald-50 text-emerald-700'
                          : ['FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(msg.status)
                          ? 'bg-rose-50 text-rose-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {msg.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};