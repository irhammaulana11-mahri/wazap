import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Send,
  Trash2,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  Layers,
  Sparkles,
  Info,
  ExternalLink,
  Bot,
  Hash,
  Play,
  Edit2,
  CheckCircle2,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import {
  AlertChannelItem,
  AlertChannelType,
  CreateAlertChannelBody,
  UpdateAlertChannelBody,
} from '../../types';
import { useToast } from '../../context/ToastContext';

export type ChannelModalMode = 'create' | 'target' | 'delete';

interface AlertChannelDrawerProps {
  isOpen: boolean;
  mode: ChannelModalMode;
  channel?: AlertChannelItem | null;
  allowedTypes?: AlertChannelType[];
  onClose: () => void;
  onSuccess: () => void;
}

type SampleAlertCode = 'session.logged_out' | 'session.disconnected_long' | 'webhook.endpoint_disabled';

const SAMPLE_ALERTS: Record<
  SampleAlertCode,
  { label: string; telegramText: string; slackText: string }
> = {
  'session.logged_out': {
    label: 'Sesi Keluar',
    telegramText:
      '[WAZAP] Sesi keluar (LOGGED_OUT)\nSesi: CS Utama (0812xxxx)\nSesi keluar; pindai ulang QR untuk menyambungkan kembali.',
    slackText:
      '*[WAZAP] Sesi keluar (LOGGED_OUT)*\nSesi: *CS Utama (0812xxxx)*\nSesi keluar; pindai ulang QR untuk menyambungkan kembali.',
  },
  'session.disconnected_long': {
    label: 'Sesi Terputus Lama',
    telegramText:
      '[WAZAP] Sesi terputus lama\nSesi: CS Utama (0812xxxx)\nStatus: DISCONNECTED selama sekitar 15 menit.',
    slackText:
      '*[WAZAP] Sesi terputus lama*\nSesi: *CS Utama (0812xxxx)*\nStatus: *DISCONNECTED* selama sekitar 15 menit.',
  },
  'webhook.endpoint_disabled': {
    label: 'Webhook Dinonaktifkan',
    telegramText:
      '[WAZAP] Webhook dinonaktifkan otomatis\nTujuan: api.perusahaan.com\nAlasan: Gagal berturut-turut melebihi batas.',
    slackText:
      '*[WAZAP] Webhook dinonaktifkan otomatis*\nTujuan: `api.perusahaan.com`\nAlasan: *Gagal berturut-turut melebihi batas*.',
  },
};

export const AlertChannelDrawer: React.FC<AlertChannelDrawerProps> = ({
  isOpen,
  mode,
  channel,
  allowedTypes = ['TELEGRAM', 'SLACK'],
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();

  // Form states (TRANSIENT - NEVER PERSISTED)
  const [channelType, setChannelType] = useState<AlertChannelType>('TELEGRAM');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Status and error states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [rateLimitWait, setRateLimitWait] = useState<number | null>(null);
  const [isCopiedReqId, setIsCopiedReqId] = useState(false);

  // Preview tab state
  const [selectedSample, setSelectedSample] = useState<SampleAlertCode>('session.logged_out');

  // Refs for accessibility & focus trap
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Initialize and save trigger element
  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement | null;
      setErrorMessage(null);
      setErrorRequestId(null);
      setRateLimitWait(null);
      setPassword('');
      setToken('');
      setChatId('');
      setUrl('');
      setShowPassword(false);
      setSelectedSample('session.logged_out');

      if (mode === 'create') {
        setName('');
        setChannelType(allowedTypes[0] || 'TELEGRAM');
        setTimeout(() => firstInputRef.current?.focus(), 80);
      } else if (mode === 'target' && channel) {
        setName(channel.name);
        setChannelType(channel.type);
        setTimeout(() => firstInputRef.current?.focus(), 80);
      } else if (mode === 'delete') {
        setTimeout(() => passwordInputRef.current?.focus(), 80);
      }
    } else {
      if (triggerElementRef.current) {
        triggerElementRef.current.focus();
      }
    }
  }, [isOpen, mode, channel, allowedTypes]);

  // Rate limit countdown effect
  useEffect(() => {
    if (!rateLimitWait || rateLimitWait <= 0) return;
    const timer = setInterval(() => {
      setRateLimitWait((prev) => (prev && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitWait]);

  if (!isOpen) return null;

  // Keyboard trap: Tab & Escape
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose();
      return;
    }

    if (e.key === 'Tab') {
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }
  };

  const handleCopyRequestId = () => {
    if (errorRequestId) {
      navigator.clipboard.writeText(errorRequestId);
      setIsCopiedReqId(true);
      setTimeout(() => setIsCopiedReqId(false), 2000);
    }
  };

  // Derive target hint for live preview (last 4 characters)
  const computeTargetHint = (): string => {
    if (mode === 'create') {
      if (channelType === 'TELEGRAM') {
        const trimmed = token.trim();
        return trimmed.length >= 4 ? trimmed.slice(-4) : '••••';
      } else {
        const trimmed = url.trim().replace(/\/+$/, '');
        return trimmed.length >= 4 ? trimmed.slice(-4) : '••••';
      }
    } else if (mode === 'target') {
      if (channel?.type === 'TELEGRAM') {
        const trimmed = token.trim();
        return trimmed.length >= 4 ? trimmed.slice(-4) : channel.target_hint;
      } else {
        const trimmed = url.trim().replace(/\/+$/, '');
        return trimmed.length >= 4 ? trimmed.slice(-4) : channel?.target_hint || '••••';
      }
    }
    return channel?.target_hint || '••••';
  };

  const previewHint = computeTargetHint();
  const previewName = (name.trim() || channel?.name || 'Nama Kanal Belum Diisi');
  const effectiveType = mode === 'create' ? channelType : channel?.type || 'TELEGRAM';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setErrorRequestId(null);

    if (!password) {
      setErrorMessage('Kata sandi akun wajib diisi untuk konfirmasi keamanan.');
      passwordInputRef.current?.focus();
      return;
    }

    if (mode === 'create') {
      if (!name.trim()) {
        setErrorMessage('Nama kanal wajib diisi.');
        return;
      }
      if (channelType === 'TELEGRAM') {
        if (!token.trim() || !chatId.trim()) {
          setErrorMessage('Token bot dan ID obrolan Telegram wajib diisi.');
          return;
        }
      } else {
        if (!url.trim()) {
          setErrorMessage('URL Webhook Slack / Discord wajib diisi.');
          return;
        }
      }
    }

    if (mode === 'target') {
      if (channel?.type === 'TELEGRAM') {
        if (!token.trim() || !chatId.trim()) {
          setErrorMessage('Token bot baru dan ID obrolan Telegram baru wajib diisi bersama.');
          return;
        }
      } else {
        if (!url.trim()) {
          setErrorMessage('URL Webhook baru wajib diisi.');
          return;
        }
      }
    }

    setIsSubmitting(true);

    try {
      if (mode === 'create') {
        const body: CreateAlertChannelBody =
          channelType === 'TELEGRAM'
            ? {
                type: 'TELEGRAM',
                name: name.trim(),
                token: token.trim(),
                chat_id: chatId.trim(),
                password,
              }
            : {
                type: 'SLACK',
                name: name.trim(),
                url: url.trim(),
                password,
              };

        await api.createAlertChannel(body);
        showToast('success', `Kanal notifikasi "${name.trim()}" berhasil dibuat.`);
      } else if (mode === 'target' && channel) {
        const body: UpdateAlertChannelBody =
          channel.type === 'TELEGRAM'
            ? {
                token: token.trim(),
                chat_id: chatId.trim(),
                password,
              }
            : {
                url: url.trim(),
                password,
              };

        await api.updateAlertChannel(channel.id, body);
        showToast('success', `Target kanal notifikasi "${channel.name}" berhasil diperbarui.`);
      } else if (mode === 'delete' && channel) {
        await api.deleteAlertChannel(channel.id, password);
        showToast('success', `Kanal notifikasi "${channel.name}" berhasil dihapus.`);
      }

      onSuccess();
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorRequestId(err.requestId || null);

        if (err.status === 403 && err.code === 'INVALID_PASSWORD') {
          setErrorMessage('Kata sandi yang Anda masukkan salah. Harap periksa kembali.');
          passwordInputRef.current?.focus();
        } else if (err.status === 422 && err.code === 'INVALID_ALERT_TARGET') {
          setErrorMessage(err.message || 'Target kanal tidak valid (token salah atau URL ditolak).');
        } else if (err.status === 409 && err.code === 'QUOTA_EXCEEDED') {
          setErrorMessage('Batas jumlah kanal notifikasi pada workspace ini telah tercapai.');
        } else if (err.status === 429) {
          const waitSec = err.retryAfterSec;
          setRateLimitWait(waitSec ?? null);
          setErrorMessage(
            waitSec
              ? `Terlalu banyak percobaan salah. Silakan coba lagi dalam ${waitSec} detik.`
              : 'Terlalu banyak percobaan verifikasi. Silakan coba kembali nanti.'
          );
        } else if (err.status === 503 && err.code === 'NOT_CONFIGURED') {
          setErrorMessage(
            err.message || 'Enkripsi kredensial belum dikonfigurasi atau notifikasi dinonaktifkan oleh operator.'
          );
        } else {
          setErrorMessage(err.message || `Terjadi galat (${err.code}).`);
        }
      } else {
        setErrorMessage((err as Error)?.message || 'Terjadi galat jaringan.');
      }
    } finally {
      // CLEAR ALL SECRETS IMMEDIATELY
      setPassword('');
      setToken('');
      setChatId('');
      setUrl('');
      setIsSubmitting(false);
    }
  };

  const titles = {
    create: 'Tambah Kanal Notifikasi',
    target: 'Ganti Target Notifikasi',
    delete: 'Hapus Kanal Notifikasi',
  };

  const currentSample = SAMPLE_ALERTS[selectedSample];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="alert-drawer-title"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={() => {
          if (!isSubmitting) onClose();
        }}
      />

      {/* Slide-Over Drawer Panel */}
      <div
        ref={drawerRef}
        className="relative w-full max-w-xl md:max-w-2xl bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200 dark:border-slate-800 text-left"
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                mode === 'delete'
                  ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'
                  : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
              }`}
            >
              {mode === 'delete' ? (
                <Trash2 className="w-4 h-4" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </div>
            <div>
              <h2 id="alert-drawer-title" className="text-base font-bold text-slate-900 dark:text-white">
                {titles[mode]}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {mode === 'create' && 'Konfigurasikan bot Telegram atau webhook Slack dengan pratinjau live.'}
                {mode === 'target' && `Perbarui kredensial tujuan untuk kanal "${channel?.name}".`}
                {mode === 'delete' && 'Konfirmasi penghapusan permanen kanal notifikasi.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
            aria-label="Tutup panel kanal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Body Form */}
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col justify-between overflow-hidden">
          <div className="p-6 space-y-6 overflow-y-auto flex-1">
            {/* Error Banner */}
            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 rounded-2xl text-xs text-rose-800 dark:text-rose-300 space-y-2 animate-in fade-in"
              >
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-rose-900 dark:text-rose-200 leading-snug">{errorMessage}</p>
                    {rateLimitWait && rateLimitWait > 0 && (
                      <p className="mt-1 text-rose-700 dark:text-rose-400 font-mono">
                        Waktu tunggu tersisa: <span className="font-bold">{rateLimitWait}</span> detik
                      </p>
                    )}
                  </div>
                </div>
                {errorRequestId && (
                  <div className="flex items-center justify-between pt-2 border-t border-rose-200/70 dark:border-rose-800/70 text-[11px] text-rose-600 dark:text-rose-400">
                    <span className="font-mono truncate">ID Permintaan: {errorRequestId}</span>
                    <button
                      type="button"
                      onClick={handleCopyRequestId}
                      className="inline-flex items-center gap-1 font-semibold text-rose-700 dark:text-rose-300 hover:text-rose-900 dark:hover:text-white hover:underline shrink-0 ml-2 cursor-pointer"
                    >
                      {isCopiedReqId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      <span>{isCopiedReqId ? 'Tersalin' : 'Salin'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 1: FORM INPUTS */}
            {mode === 'create' && (
              <div className="space-y-4">
                {/* Channel Type Selector */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                    Tipe Integrasi Kanal
                  </label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setChannelType('TELEGRAM')}
                      className={`flex items-center justify-center gap-2 p-3 rounded-2xl border text-xs font-bold transition cursor-pointer ${
                        channelType === 'TELEGRAM'
                          ? 'border-sky-500 bg-sky-50/80 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 shadow-xs ring-2 ring-sky-500/20'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 text-slate-600 dark:text-slate-300 hover:bg-slate-100/70 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Bot className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                      <span>Telegram Bot</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setChannelType('SLACK')}
                      className={`flex items-center justify-center gap-2 p-3 rounded-2xl border text-xs font-bold transition cursor-pointer ${
                        channelType === 'SLACK'
                          ? 'border-emerald-500 bg-emerald-50/80 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 shadow-xs ring-2 ring-emerald-500/20'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 text-slate-600 dark:text-slate-300 hover:bg-slate-100/70 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Hash className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>Slack / Discord Webhook</span>
                    </button>
                  </div>
                </div>

                {/* Channel Name Input */}
                <div>
                  <label
                    htmlFor="drawer-channel-name"
                    className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1.5"
                  >
                    Nama Kanal <span className="text-rose-500">*</span>
                  </label>
                  <input
                    ref={firstInputRef}
                    id="drawer-channel-name"
                    type="text"
                    required
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Misal: Tim DevOps / Grup Notifikasi Gateway"
                    className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white dark:focus:bg-slate-900 text-slate-900 dark:text-white transition"
                  />
                </div>

                {/* Telegram Credentials */}
                {channelType === 'TELEGRAM' && (
                  <div className="space-y-3.5 p-4 bg-slate-50/80 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800">
                    <div>
                      <label
                        htmlFor="drawer-telegram-token"
                        className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        Token Bot Telegram <span className="text-rose-500">*</span>
                      </label>
                      <input
                        id="drawer-telegram-token"
                        type="text"
                        required
                        autoComplete="off"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="123456789:AAHdqTcvCH1vGWJxf..."
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 text-slate-900 dark:text-white transition"
                      />
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        Buat bot baru melalui <span className="font-semibold text-slate-700 dark:text-slate-300">@BotFather</span> di Telegram via perintah <code className="bg-slate-200/80 dark:bg-slate-800 px-1 py-0.5 rounded text-[10px]">/newbot</code>.
                      </p>
                    </div>

                    <div>
                      <label
                        htmlFor="drawer-telegram-chatid"
                        className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        ID Obrolan Penerima (Chat ID) <span className="text-rose-500">*</span>
                      </label>
                      <input
                        id="drawer-telegram-chatid"
                        type="text"
                        required
                        autoComplete="off"
                        value={chatId}
                        onChange={(e) => setChatId(e.target.value)}
                        placeholder="Misal: -1001234567890 (grup) atau 12345678 (pribadi)"
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 text-slate-900 dark:text-white transition"
                      />
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        Kirim pesan ke bot, lalu buka <code className="bg-slate-200/80 dark:bg-slate-800 px-1 py-0.5 rounded text-[10px]">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> untuk melihat ID obrolan penerima.
                      </p>
                    </div>
                  </div>
                )}

                {/* Slack Credentials */}
                {channelType === 'SLACK' && (
                  <div className="space-y-2 p-4 bg-slate-50/80 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800">
                    <label
                      htmlFor="drawer-slack-url"
                      className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                    >
                      URL Webhook Slack / Discord <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="drawer-slack-url"
                      type="url"
                      required
                      autoComplete="off"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://hooks.slack.com/services/T00/B00/XXXX"
                      className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-emerald-500 text-slate-900 dark:text-white transition"
                    />
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Incoming Webhook dari Slack atau Discord (pada Discord, tambahkan <code className="bg-slate-200/80 dark:bg-slate-800 px-1 py-0.5 rounded text-[10px]">/slack</code> di ujung URL webhook).
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* SECTION: TARGET MODE */}
            {mode === 'target' && channel && (
              <div className="space-y-4">
                <div className="p-3.5 bg-slate-50 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-slate-900 dark:text-white block text-sm">{channel.name}</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      Tipe: <span className="font-semibold text-slate-800 dark:text-slate-200">{channel.type}</span> (tipe permanen)
                    </span>
                  </div>
                  <span className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">Saat ini: ••••{channel.target_hint}</span>
                </div>

                {channel.type === 'TELEGRAM' ? (
                  <div className="space-y-3.5 p-4 bg-slate-50/80 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800">
                    <div>
                      <label
                        htmlFor="drawer-target-token"
                        className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        Token Bot Baru <span className="text-rose-500">*</span>
                      </label>
                      <input
                        ref={firstInputRef}
                        id="drawer-target-token"
                        type="text"
                        required
                        autoComplete="off"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Masukkan token bot Telegram baru"
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 text-slate-900 dark:text-white transition"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="drawer-target-chatid"
                        className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        ID Obrolan Baru <span className="text-rose-500">*</span>
                      </label>
                      <input
                        id="drawer-target-chatid"
                        type="text"
                        required
                        autoComplete="off"
                        value={chatId}
                        onChange={(e) => setChatId(e.target.value)}
                        placeholder="Masukkan ID chat obrolan baru"
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 text-slate-900 dark:text-white transition"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 p-4 bg-slate-50/80 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800">
                    <label
                      htmlFor="drawer-target-slackurl"
                      className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                    >
                      URL Webhook Baru <span className="text-rose-500">*</span>
                    </label>
                    <input
                      ref={firstInputRef}
                      id="drawer-target-slackurl"
                      type="url"
                      required
                      autoComplete="off"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://hooks.slack.com/services/..."
                      className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-emerald-500 text-slate-900 dark:text-white transition"
                    />
                  </div>
                )}
              </div>
            )}

            {/* SECTION: DELETE MODE */}
            {mode === 'delete' && channel && (
              <div className="p-4 bg-rose-50/80 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 rounded-2xl space-y-2">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-rose-900 dark:text-rose-200 leading-relaxed">
                    <p className="font-bold text-sm">Hapus Kanal &ldquo;{channel.name}&rdquo;?</p>
                    <p className="mt-1 text-rose-700 dark:text-rose-300">
                      Kanal notifikasi ini akan segera dicabut dari database dan otomatis dilepas dari seluruh aturan alarm yang terhubung.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* SECTION 2: INTERACTIVE DRAWER PREVIEW */}
            <div className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    Pratinjau Langsung (Live Preview)
                  </h3>
                </div>
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  {effectiveType === 'TELEGRAM' ? 'Tampilan Bot Telegram' : 'Tampilan Slack Webhook'}
                </span>
              </div>

              {/* 2A: Channel Card Preview */}
              <div
                className={`p-4 rounded-2xl border transition relative overflow-hidden ${
                  mode === 'delete'
                    ? 'border-rose-300 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/40 border-dashed'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 shadow-2xs'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                        effectiveType === 'TELEGRAM'
                          ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-800'
                          : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                      }`}
                    >
                      <Send className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {previewName}
                        </span>
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${
                            effectiveType === 'TELEGRAM'
                              ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-800'
                              : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          }`}
                        >
                          {effectiveType === 'TELEGRAM' ? 'Telegram' : 'Slack / Discord'}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                        Target: berakhiran <span className="font-bold text-slate-700 dark:text-slate-300">••••{previewHint}</span>
                      </p>
                    </div>
                  </div>

                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${
                      mode === 'delete'
                        ? 'bg-rose-100 dark:bg-rose-900/70 text-rose-800 dark:text-rose-300 border-rose-300 dark:border-rose-700'
                        : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        mode === 'delete' ? 'bg-rose-500' : 'bg-emerald-500'
                      }`}
                    />
                    <span>{mode === 'delete' ? 'Akan Dihapus' : 'Aktif'}</span>
                  </span>
                </div>
              </div>

              {/* 2B: Message Mockup Preview */}
              {mode !== 'delete' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      Simulasi Notifikasi Masuk:
                    </span>
                    <div className="flex items-center gap-1">
                      {(['session.logged_out', 'session.disconnected_long', 'webhook.endpoint_disabled'] as SampleAlertCode[]).map(
                        (code) => (
                          <button
                            key={code}
                            type="button"
                            onClick={() => setSelectedSample(code)}
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition cursor-pointer ${
                              selectedSample === code
                                ? 'bg-slate-900 dark:bg-emerald-600 text-white shadow-2xs'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            {SAMPLE_ALERTS[code].label}
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Telegram Mockup */}
                  {effectiveType === 'TELEGRAM' ? (
                    <div className="rounded-2xl border border-sky-200 dark:border-sky-900/60 bg-[#E7EBF0] dark:bg-[#18222d] p-3 text-xs shadow-inner overflow-hidden">
                      <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-sky-200/60 dark:border-sky-800/60 text-slate-600 dark:text-slate-300 text-[11px]">
                        <Bot className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                        <span className="font-bold text-slate-800 dark:text-slate-200 truncate">{previewName}</span>
                        <span className="text-[9px] bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300 px-1 py-0.2 rounded font-mono">
                          bot
                        </span>
                      </div>

                      <div className="bg-white dark:bg-[#202c33] rounded-2xl rounded-tl-xs p-3 shadow-2xs max-w-sm space-y-1 text-slate-800 dark:text-slate-100 border border-slate-100 dark:border-slate-700/60">
                        <div className="font-bold text-sky-900 dark:text-sky-400 text-[11px] flex items-center gap-1.5">
                          <span>🔔</span>
                          <span>{currentSample.telegramText.split('\n')[0]}</span>
                        </div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-line leading-relaxed">
                          {currentSample.telegramText.split('\n').slice(1).join('\n')}
                        </div>
                        <div className="text-[9px] text-slate-400 dark:text-slate-500 text-right pt-0.5">
                          05:24 ✓✓
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Slack Mockup */
                    <div className="rounded-2xl border border-emerald-200 dark:border-emerald-900/60 bg-[#F8F8F8] dark:bg-[#1a232a] p-3 text-xs shadow-inner overflow-hidden">
                      <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 text-[11px]">
                        <Hash className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span className="font-bold text-slate-800 dark:text-slate-200">notifikasi-gateway</span>
                      </div>

                      <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0">
                          WZ
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900 dark:text-white text-[11px]">
                              {previewName}
                            </span>
                            <span className="text-[9px] bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1 py-0.2 rounded font-bold uppercase tracking-wider">
                              APP
                            </span>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">Hari ini pukul 05:24</span>
                          </div>

                          <div className="pl-2.5 border-l-2 border-emerald-500 text-[11px] text-slate-800 dark:text-slate-200 space-y-0.5">
                            <div className="font-bold text-slate-900 dark:text-white">
                              {currentSample.slackText.split('\n')[0].replace(/\*/g, '')}
                            </div>
                            <div className="text-slate-600 dark:text-slate-300 whitespace-pre-line leading-relaxed">
                              {currentSample.slackText.split('\n').slice(1).join('\n').replace(/\*/g, '')}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* SECTION 3: PASSWORD CONFIRMATION */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
              <label
                htmlFor="drawer-password-input"
                className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1.5"
              >
                Kata Sandi Akun Anda <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <input
                  ref={passwordInputRef}
                  id="drawer-password-input"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Masukkan kata sandi untuk konfirmasi keamanan..."
                  className="w-full pl-3.5 pr-10 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white dark:focus:bg-slate-900 text-slate-900 dark:text-white transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                  aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                Wajib diisi untuk memverifikasi hak administratif (Owner/Admin) sebelum kredensial disimpan.
              </p>
            </div>
          </div>

          {/* Drawer Sticky Footer Actions */}
          <div className="p-4 px-6 bg-slate-50 dark:bg-slate-950/70 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              Batal
            </button>

            <button
              type="submit"
              disabled={isSubmitting || (rateLimitWait !== null && rateLimitWait > 0)}
              className={`inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs sm:text-sm font-bold text-white shadow-xs transition cursor-pointer ${
                mode === 'delete'
                  ? 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-400'
                  : 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400'
              }`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Memproses...</span>
                </>
              ) : mode === 'create' ? (
                <>
                  <Send className="w-4 h-4" />
                  <span>Buat Kanal</span>
                </>
              ) : mode === 'target' ? (
                <>
                  <Send className="w-4 h-4" />
                  <span>Simpan Target Baru</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span>Hapus Kanal</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
