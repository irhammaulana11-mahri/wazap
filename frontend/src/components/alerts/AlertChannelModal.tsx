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
  ExternalLink,
  ShieldAlert,
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

interface AlertChannelModalProps {
  isOpen: boolean;
  mode: ChannelModalMode;
  channel?: AlertChannelItem | null;
  allowedTypes?: AlertChannelType[];
  onClose: () => void;
  onSuccess: () => void;
}

export const AlertChannelModal: React.FC<AlertChannelModalProps> = ({
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

  // Refs for accessibility & focus trap
  const modalRef = useRef<HTMLDivElement>(null);
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

      if (mode === 'create') {
        setName('');
        setChannelType(allowedTypes[0] || 'TELEGRAM');
        setTimeout(() => firstInputRef.current?.focus(), 50);
      } else if (mode === 'target' && channel) {
        setName(channel.name);
        setChannelType(channel.type);
        setTimeout(() => firstInputRef.current?.focus(), 50);
      } else if (mode === 'delete') {
        setTimeout(() => passwordInputRef.current?.focus(), 50);
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
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
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
          setErrorMessage('URL Webhook Slack wajib diisi.');
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
          setErrorMessage('URL Webhook Slack baru wajib diisi.');
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

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={modalRef}
        className="bg-white rounded-3xl border border-slate-200/90 shadow-2xl max-w-lg w-full overflow-hidden transition-all text-left"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                mode === 'delete'
                  ? 'bg-rose-50 text-rose-600 border border-rose-200'
                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              }`}
            >
              {mode === 'delete' ? (
                <Trash2 className="w-5 h-5" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 id="modal-title" className="text-lg font-bold text-slate-900">
                {titles[mode]}
              </h2>
              <p className="text-xs text-slate-500">
                {mode === 'create' && 'Kirim alarm penting langsung ke bot Telegram atau webhook Slack.'}
                {mode === 'target' && `Perbarui kredensial tujuan untuk kanal "${channel?.name}".`}
                {mode === 'delete' && 'Tindakan ini memerlukan konfirmasi kata sandi akun.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition"
            aria-label="Tutup dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Error Banner */}
          {errorMessage && (
            <div
              role="alert"
              className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 space-y-2"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold text-rose-900 leading-snug">{errorMessage}</p>
                  {rateLimitWait && rateLimitWait > 0 && (
                    <p className="mt-1 text-rose-700 font-mono">
                      Waktu tunggu tersisa: <span className="font-bold">{rateLimitWait}</span> detik
                    </p>
                  )}
                </div>
              </div>
              {errorRequestId && (
                <div className="flex items-center justify-between pt-2 border-t border-rose-200/70 text-[11px] text-rose-600">
                  <span className="font-mono truncate">ID Permintaan: {errorRequestId}</span>
                  <button
                    type="button"
                    onClick={handleCopyRequestId}
                    className="inline-flex items-center gap-1 font-semibold text-rose-700 hover:text-rose-900 hover:underline shrink-0 ml-2"
                  >
                    {isCopiedReqId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{isCopiedReqId ? 'Tersalin' : 'Salin'}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Mode 1: CREATE */}
          {mode === 'create' && (
            <>
              {/* Type selector */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Tipe Kanal
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setChannelType('TELEGRAM')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-2xl border text-xs font-bold transition ${
                      channelType === 'TELEGRAM'
                        ? 'border-sky-500 bg-sky-50/80 text-sky-900 shadow-xs'
                        : 'border-slate-200 bg-slate-50/50 text-slate-600 hover:bg-slate-100/70'
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
                    <span>Telegram Bot</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setChannelType('SLACK')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-2xl border text-xs font-bold transition ${
                      channelType === 'SLACK'
                        ? 'border-emerald-500 bg-emerald-50/80 text-emerald-900 shadow-xs'
                        : 'border-slate-200 bg-slate-50/50 text-slate-600 hover:bg-slate-100/70'
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span>Slack / Discord</span>
                  </button>
                </div>
              </div>

              {/* Name input */}
              <div>
                <label
                  htmlFor="channel-name-input"
                  className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  Nama Kanal <span className="text-rose-500">*</span>
                </label>
                <input
                  ref={firstInputRef}
                  id="channel-name-input"
                  type="text"
                  required
                  maxLength={60}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Misal: Tim DevOps / Notifikasi Server"
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
                />
              </div>

              {/* Telegram inputs */}
              {channelType === 'TELEGRAM' && (
                <div className="space-y-3 p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80">
                  <div>
                    <label
                      htmlFor="telegram-token-input"
                      className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                    >
                      Token Bot Telegram <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="telegram-token-input"
                      type="text"
                      required
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="123456789:AAHdqTcvCH1vGWJxf..."
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 transition"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Dapatkan dari <span className="font-semibold text-slate-700">@BotFather</span> di Telegram dengan perintah <code className="bg-slate-200/70 px-1 py-0.5 rounded text-[10px]">/newbot</code>.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="telegram-chat-id-input"
                      className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                    >
                      ID Obrolan (Chat ID) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="telegram-chat-id-input"
                      type="text"
                      required
                      autoComplete="off"
                      value={chatId}
                      onChange={(e) => setChatId(e.target.value)}
                      placeholder="Misal: -1001234567890 atau 12345678"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 transition"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Kirim pesan ke bot Anda, lalu periksa <code className="bg-slate-200/70 px-1 py-0.5 rounded text-[10px]">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> untuk menemukan <code className="text-slate-700">chat.id</code> (grup berawalan tanda minus -).
                    </p>
                  </div>
                </div>
              )}

              {/* Slack inputs */}
              {channelType === 'SLACK' && (
                <div className="space-y-2 p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80">
                  <label
                    htmlFor="slack-url-input"
                    className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                  >
                    URL Webhook Slack / Discord <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="slack-url-input"
                    type="url"
                    required
                    autoComplete="off"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-emerald-500 transition"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Incoming Webhook dari Slack atau Discord (pada Discord, tambahkan <code className="bg-slate-200/70 px-1 py-0.5 rounded text-[10px]">/slack</code> di ujung tautan URL webhook).
                  </p>
                </div>
              )}
            </>
          )}

          {/* Mode 2: TARGET */}
          {mode === 'target' && channel && (
            <>
              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/70 text-xs text-slate-600 flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-900 block">{channel.name}</span>
                  <span className="text-slate-500">
                    Tipe: <span className="font-semibold text-slate-700">{channel.type}</span> (tipe tidak dapat diubah)
                  </span>
                </div>
                <span className="text-slate-400 font-mono text-[11px]">••••{channel.target_hint}</span>
              </div>

              {channel.type === 'TELEGRAM' ? (
                <div className="space-y-3 p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80">
                  <div>
                    <label
                      htmlFor="target-telegram-token"
                      className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                    >
                      Token Bot Baru <span className="text-rose-500">*</span>
                    </label>
                    <input
                      ref={firstInputRef}
                      id="target-telegram-token"
                      type="text"
                      required
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Token bot baru (tidak menampilkan nilai lama demi keamanan)"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 transition"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="target-telegram-chatid"
                      className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                    >
                      ID Obrolan Baru <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="target-telegram-chatid"
                      type="text"
                      required
                      autoComplete="off"
                      value={chatId}
                      onChange={(e) => setChatId(e.target.value)}
                      placeholder="ID chat baru"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-sky-500 transition"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-2 p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80">
                  <label
                    htmlFor="target-slack-url"
                    className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                  >
                    URL Webhook Baru <span className="text-rose-500">*</span>
                  </label>
                  <input
                    ref={firstInputRef}
                    id="target-slack-url"
                    type="url"
                    required
                    autoComplete="off"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-emerald-500 transition"
                  />
                </div>
              )}
            </>
          )}

          {/* Mode 3: DELETE */}
          {mode === 'delete' && channel && (
            <div className="p-4 bg-rose-50/70 border border-rose-200/80 rounded-2xl space-y-2">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <div className="text-xs text-rose-800 leading-relaxed">
                  <p className="font-bold text-rose-900 text-sm">
                    Hapus kanal notifikasi &ldquo;{channel.name}&rdquo;?
                  </p>
                  <p className="mt-1">
                    Kanal ini akan segera dihapus permanen dan otomatis dilepas dari seluruh konfigurasi aturan alarm yang menggunakannya.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Password confirmation for all modes */}
          <div className="pt-2">
            <label
              htmlFor="modal-password-input"
              className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5"
            >
              Kata Sandi Akun <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                id="modal-password-input"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Masukkan kata sandi Anda..."
                className="w-full pl-3.5 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Diperlukan untuk memverifikasi hak akses administratif (Owner/Admin).
            </p>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
            >
              Batal
            </button>

            <button
              type="submit"
              disabled={isSubmitting || (rateLimitWait !== null && rateLimitWait > 0)}
              className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold text-white shadow-xs transition ${
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
                  <span>Simpan Target</span>
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
