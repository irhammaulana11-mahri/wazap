import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { MessageItem, MessageStatus } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  Send,
  Inbox,
  Filter,
  CheckCheck,
  Check,
  AlertCircle,
  Smartphone,
  RotateCcw,
  Ban,
  ChevronLeft,
  ChevronRight,
  Info,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Smile,
  Phone,
  Eye,
  Sparkles,
  X,
} from 'lucide-react';

const STATUS_CONFIG: Record<
  MessageStatus,
  { label: string; bg: string; text: string; icon?: React.ReactNode }
> = {
  PENDING: { label: 'Pending', bg: 'bg-slate-100', text: 'text-slate-600' },
  PROCESSING: { label: 'Processing', bg: 'bg-indigo-50', text: 'text-indigo-700' },
  SENT: {
    label: 'Sent',
    bg: 'bg-sky-50',
    text: 'text-sky-700',
    icon: <Check className="w-3.5 h-3.5" />,
  },
  DELIVERED: {
    label: 'Delivered',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    icon: <CheckCheck className="w-3.5 h-3.5" />,
  },
  READ: {
    label: 'Read',
    bg: 'bg-emerald-100',
    text: 'text-emerald-800',
    icon: <CheckCheck className="w-3.5 h-3.5 text-blue-600" />,
  },
  FAILED: { label: 'Failed', bg: 'bg-rose-50', text: 'text-rose-700' },
  CANCELLED: { label: 'Cancelled', bg: 'bg-slate-100', text: 'text-slate-500' },
  UNKNOWN: { label: 'Unknown', bg: 'bg-amber-50', text: 'text-amber-700' },
  RECONCILIATION_REQUIRED: {
    label: 'Reconciliation',
    bg: 'bg-purple-50',
    text: 'text-purple-700',
  },
};

const COMMON_EMOJIS = ['😀', '👍', '🙏', '❤️', '🔥', '📢', '📦', '🛒', '🚀', '✅'];

// Helper formatting WA text to HTML preview
const formatWhatsAppText = (text: string) => {
  if (!text) return '';
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code block ```code```
  formatted = formatted.replace(/```([^`]+)```/g, '<code class="bg-black/10 px-1.5 py-0.5 rounded font-mono text-xs">$1</code>');
  // Bold *bold*
  formatted = formatted.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  // Italic _italic_
  formatted = formatted.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Strikethrough ~strike~
  formatted = formatted.replace(/~([^~]+)~/g, '<del class="line-through">$1</del>');
  // Linebreaks
  formatted = formatted.replace(/\n/g, '<br/>');

  return formatted;
};

export const MessagesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Send message form state
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [countryCode, setCountryCode] = useState('62');
  const [recipient, setRecipient] = useState('');
  const [textContent, setTextContent] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [formError, setFormError] = useState('');

  // Tab view on mobile: 'form' | 'preview'
  const [mobileTab, setMobileTab] = useState<'form' | 'preview'>('form');

  // Filters & Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [filterSessionId, setFilterSessionId] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [selectedMessageDetail, setSelectedMessageDetail] = useState<MessageItem | null>(null);

  // Fetch Sessions
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
  });

  // Auto select first connected session
  React.useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      const connected = sessions.find((s) => s.status === 'CONNECTED');
      if (connected) {
        setSelectedSessionId(connected.id);
      } else {
        setSelectedSessionId(sessions[0].id);
      }
    }
  }, [sessions, selectedSessionId]);

  // Fetch Messages with pagination and filters
  const {
    data: messagesResponse,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['messages', { page, pageSize, filterSessionId, filterStatus }],
    queryFn: () =>
      api.getMessages({
        page,
        page_size: pageSize,
        session_id: filterSessionId || undefined,
        status: filterStatus || undefined,
      }),
    refetchInterval: 5000,
  });

  const messages = messagesResponse?.data || [];
  const meta = messagesResponse?.meta;
  const totalPages = meta?.total && meta?.page_size ? Math.ceil(meta.total / meta.page_size) : 1;

  // Insert formatting wrap into textarea
  const insertFormatting = (wrapper: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;
    const selected = text.substring(start, end);

    let nextText = '';
    if (selected) {
      nextText = text.substring(0, start) + wrapper + selected + wrapper + text.substring(end);
    } else {
      nextText = text.substring(0, start) + wrapper + 'teks' + wrapper + text.substring(end);
    }
    setTextContent(nextText);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + wrapper.length, start + wrapper.length + (selected ? selected.length : 4));
    }, 50);
  };

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setTextContent((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart;
    const text = el.value;
    const nextText = text.substring(0, start) + emoji + text.substring(start);
    setTextContent(nextText);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 50);
  };

  // Target full phone number calculation
  const getFullTargetNumber = () => {
    let clean = recipient.trim().replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
      clean = clean.slice(1);
    }
    if (clean.startsWith(countryCode)) {
      return clean;
    }
    return countryCode + clean;
  };

  // Send Mutation
  const sendMutation = useMutation({
    mutationFn: () => {
      const fullNumber = getFullTargetNumber();
      return api.sendMessage(selectedSessionId, fullNumber, textContent.trim());
    },
    onSuccess: () => {
      setFormSuccess('Pesan berhasil masuk antrean gateway!');
      setTextContent('');
      setRecipient('');
      setFormError('');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      setTimeout(() => setFormSuccess(''), 4000);
    },
    onError: (err: any) => {
      setFormError(err.message || 'Gagal mengirim pesan');
      setFormSuccess('');
    },
  });

  // Cancel & Retry Mutations
  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelMessage(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.retryMessage(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSessionId || !recipient.trim() || !textContent.trim()) return;
    setFormError('');
    setFormSuccess('');
    sendMutation.mutate();
  };

  const handleRetry = (msg: MessageItem) => {
    if (msg.status === 'UNKNOWN' || msg.status === 'RECONCILIATION_REQUIRED') {
      if (
        !confirm(
          'Status pesan ini belum dapat dipastikan. Mengirim ulang berpotensi mengirim pesan ganda ke penerima. Lanjutkan?'
        )
      ) {
        return;
      }
    }
    retryMutation.mutate(msg.id);
  };

  const activeSessionObj = sessions.find((s) => s.id === selectedSessionId);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pesan WhatsApp</h1>
        <p className="text-sm text-slate-500">
          Kirim pesan teks dengan kontrol idempotensi, preview layar WhatsApp langsung, dan riwayat pesan.
        </p>
      </div>

      {/* Main Composer & Interactive Live Phone Preview Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Message Composer Form (7 Cols) */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
                <Send className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-900 text-sm">Composer Pesan Baru</h2>
                <p className="text-xs text-slate-400">Pilih sesi pengirim dan tentukan nomor tujuan</p>
              </div>
            </div>

            {/* Mobile Tab Switcher */}
            <div className="lg:hidden flex border border-slate-200 rounded-lg p-0.5 bg-slate-50 text-xs">
              <button
                type="button"
                onClick={() => setMobileTab('form')}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  mobileTab === 'form' ? 'bg-white shadow text-slate-900' : 'text-slate-500'
                }`}
              >
                Form
              </button>
              <button
                type="button"
                onClick={() => setMobileTab('preview')}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  mobileTab === 'preview' ? 'bg-white shadow text-slate-900' : 'text-slate-500'
                }`}
              >
                Preview WA
              </button>
            </div>
          </div>

          <form onSubmit={handleSend} className={`space-y-4 ${mobileTab === 'preview' ? 'hidden lg:block' : ''}`}>
            {/* Session selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Sesi Perangkat WhatsApp Pengirim
              </label>
              <select
                value={selectedSessionId}
                onChange={(e) => setSelectedSessionId(e.target.value)}
                required
                className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-xs bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.session_name || s.id.slice(0, 8)} ({s.status}
                    {s.phone_number ? ` - +${s.phone_number}` : ''})
                  </option>
                ))}
              </select>
            </div>

            {/* Recipient phone */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Nomor Telepon Tujuan (WhatsApp)
              </label>
              <div className="flex gap-2">
                <select
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value)}
                  className="px-3 py-2 border border-slate-300 rounded-xl text-xs bg-slate-50 font-mono font-medium focus:outline-none shrink-0"
                >
                  <option value="62">🇮🇩 +62 (ID)</option>
                  <option value="60">🇲🇾 +60 (MY)</option>
                  <option value="65">🇸🇬 +65 (SG)</option>
                  <option value="1">🇺🇸 +1 (US)</option>
                </select>
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="8123456789 atau 08123456789"
                    required
                    className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none font-mono"
                  />
                </div>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Akan dikirim ke format internasional:{' '}
                <strong className="text-slate-700 font-mono">+{getFullTargetNumber() || countryCode}</strong>
              </p>
            </div>

            {/* Text message with formatting bar */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold text-slate-700">
                  Isi Pesan Teks
                </label>
                <span className="text-[11px] text-slate-400">
                  {textContent.length} karakter
                </span>
              </div>

              {/* Formatting Toolbar */}
              <div className="flex flex-wrap items-center gap-1 p-1.5 bg-slate-50 border border-slate-200 border-b-0 rounded-t-xl text-slate-600">
                <button
                  type="button"
                  onClick={() => insertFormatting('*')}
                  className="p-1.5 hover:bg-white hover:text-slate-900 rounded transition"
                  title="Tebal (*bold*)"
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('_')}
                  className="p-1.5 hover:bg-white hover:text-slate-900 rounded transition"
                  title="Miring (_italic_)"
                >
                  <Italic className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('~')}
                  className="p-1.5 hover:bg-white hover:text-slate-900 rounded transition"
                  title="Coret (~strike~)"
                >
                  <Strikethrough className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('```')}
                  className="p-1.5 hover:bg-white hover:text-slate-900 rounded transition"
                  title="Monospace (```code```)"
                >
                  <Code className="w-3.5 h-3.5" />
                </button>
                <div className="h-4 w-[1px] bg-slate-200 mx-1" />
                {COMMON_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => insertEmoji(emoji)}
                    className="p-1 hover:bg-white rounded transition text-xs"
                    title={`Sisipkan ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              <textarea
                ref={textareaRef}
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder="Ketik pesan Anda di sini... gunakan tombol di atas untuk menebalkan (*teks*) atau menyisipkan emoji."
                rows={5}
                required
                className="w-full px-3 py-2.5 border border-slate-300 rounded-b-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>

            {formSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{formSuccess}</span>
              </div>
            )}

            {formError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={sendMutation.isPending || !selectedSessionId}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-emerald-600 rounded-xl text-xs font-bold text-white hover:bg-emerald-700 transition shadow-sm disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {sendMutation.isPending ? 'Mengirim ke Antrean...' : 'Kirim Pesan WhatsApp Sekarang'}
            </button>
          </form>
        </div>

        {/* Right: Live Interactive WhatsApp Smartphone Preview (5 Cols) */}
        <div className={`lg:col-span-5 ${mobileTab === 'form' ? 'hidden lg:block' : ''}`}>
          <div className="bg-slate-900 rounded-[32px] p-3 shadow-2xl border-4 border-slate-800 max-w-sm mx-auto">
            {/* Phone Speaker & Camera Notch */}
            <div className="w-24 h-4 bg-slate-800 rounded-full mx-auto mb-2 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-slate-900 mr-2" />
              <div className="w-8 h-1 bg-slate-700 rounded-full" />
            </div>

            {/* WhatsApp App Screen Container */}
            <div className="bg-[#EFEAE2] rounded-[24px] overflow-hidden flex flex-col h-[460px] relative border border-slate-700/50">
              {/* WhatsApp App Header */}
              <div className="bg-[#075E54] text-white px-3 py-2.5 flex items-center justify-between shadow">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-slate-700 font-bold text-xs shrink-0">
                    WA
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate leading-tight">
                      +{getFullTargetNumber() || 'Nomor Tujuan'}
                    </p>
                    <p className="text-[10px] text-emerald-200 leading-tight">online</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-white/80">
                  <Phone className="w-3.5 h-3.5" />
                </div>
              </div>

              {/* Chat Message Wallpaper Feed */}
              <div className="flex-1 p-3 overflow-y-auto space-y-2 flex flex-col justify-end">
                {/* Simulated timestamp banner */}
                <div className="text-center my-1">
                  <span className="bg-white/80 text-slate-500 text-[9px] font-semibold px-2 py-0.5 rounded shadow-xs uppercase">
                    Hari Ini
                  </span>
                </div>

                {/* Simulated Outgoing Bubble */}
                <div className="flex justify-end">
                  <div className="bg-[#DCF8C6] text-slate-800 rounded-2xl rounded-tr-none px-3 py-2 max-w-[85%] shadow-sm text-xs leading-relaxed space-y-1">
                    {textContent.trim() ? (
                      <div
                        className="break-words"
                        dangerouslySetInnerHTML={{ __html: formatWhatsAppText(textContent) }}
                      />
                    ) : (
                      <span className="text-slate-400 italic text-[11px]">
                        Preview pesan akan muncul di sini saat Anda mengetik...
                      </span>
                    )}

                    <div className="flex items-center justify-end gap-1 text-[9px] text-slate-400">
                      <span>
                        {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <CheckCheck className="w-3 h-3 text-sky-500" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Simulated Input Bottom Bar */}
              <div className="bg-[#F0F2F5] px-2 py-2 flex items-center gap-2 border-t border-slate-200">
                <div className="flex-1 bg-white rounded-full px-3 py-1 text-[11px] text-slate-400 border border-slate-200 truncate">
                  Ketik pesan
                </div>
                <div className="w-7 h-7 rounded-full bg-[#00A884] text-white flex items-center justify-center shadow-sm">
                  <Send className="w-3 h-3" />
                </div>
              </div>
            </div>

            {/* Bottom Indicator */}
            <div className="text-center text-[10px] text-slate-500 mt-2 font-medium flex items-center justify-center gap-1">
              <Eye className="w-3 h-3 text-emerald-400" />
              Live WhatsApp Screen Preview
            </div>
          </div>
        </div>
      </div>

      {/* Message History & List Card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <h2 className="font-bold text-slate-900 text-sm">Riwayat Antrean & Pesan Terkirim</h2>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterSessionId}
              onChange={(e) => {
                setFilterSessionId(e.target.value);
                setPage(1);
              }}
              className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-700 focus:outline-none"
            >
              <option value="">Semua Sesi</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.session_name || s.id.slice(0, 8)}
                </option>
              ))}
            </select>

            <select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
              className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-700 focus:outline-none"
            >
              <option value="">Semua Status</option>
              <option value="SENT">Sent</option>
              <option value="DELIVERED">Delivered</option>
              <option value="READ">Read</option>
              <option value="PENDING">Pending</option>
              <option value="PROCESSING">Processing</option>
              <option value="FAILED">Failed</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="UNKNOWN">Unknown</option>
              <option value="RECONCILIATION_REQUIRED">Reconciliation</option>
            </select>
          </div>
        </div>

        {isLoading ? (
          <LoadingState message="Memuat riwayat pesan..." />
        ) : isError ? (
          <ErrorState message={(error as Error).message} onRetry={() => refetch()} />
        ) : messages.length === 0 ? (
          <EmptyState
            title="Tidak ada pesan"
            description="Belum ada pesan yang cocok dengan filter yang dipilih."
            icon={<Inbox className="w-8 h-8" />}
          />
        ) : (
          <div className="space-y-2">
            <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto pr-1">
              {messages.map((msg) => {
                const cfg = STATUS_CONFIG[msg.status] || STATUS_CONFIG.PENDING;
                const canCancel = msg.status === 'PENDING';
                const canRetry =
                  msg.status === 'FAILED' ||
                  msg.status === 'UNKNOWN' ||
                  msg.status === 'RECONCILIATION_REQUIRED';

                return (
                  <div
                    key={msg.id}
                    className="py-3 px-2 space-y-1.5 hover:bg-slate-50 rounded-lg transition"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 font-mono">
                          +{msg.to}
                        </span>
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${cfg.bg} ${cfg.text}`}
                        >
                          {cfg.icon}
                          {cfg.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-400">
                          {new Date(msg.created_at).toLocaleString('id-ID')}
                        </span>

                        {/* Quick Actions */}
                        {canCancel && (
                          <button
                            onClick={() => cancelMutation.mutate(msg.id)}
                            disabled={cancelMutation.isPending}
                            className="text-[11px] text-rose-600 hover:text-rose-800 font-medium flex items-center gap-0.5"
                            title="Batalkan antrean pesan"
                          >
                            <Ban className="w-3 h-3" />
                            Batal
                          </button>
                        )}

                        {canRetry && (
                          <button
                            onClick={() => handleRetry(msg)}
                            disabled={retryMutation.isPending}
                            className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-0.5"
                            title="Coba kirim ulang"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Kirim Ulang
                          </button>
                        )}

                        <button
                          onClick={() => setSelectedMessageDetail(msg)}
                          className="text-slate-400 hover:text-slate-600 p-1"
                          title="Detail pesan"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-xs text-slate-800 break-words whitespace-pre-wrap">
                      {msg.message || (msg.media ? `[Media: ${msg.type}]` : '(Pesan kosong)')}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {meta && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span>Tampilkan:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    <option value={10}>10</option>
                    <option value={15}>15</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span>pesan per halaman</span>
                  <span className="text-slate-300 mx-1">•</span>
                  <span>
                    Hal {meta.page || 1} dari {totalPages} ({meta.total_capped ? `${meta.total}+` : meta.total} pesan)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="px-2.5 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition flex items-center gap-1 font-medium"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelumnya</span>
                  </button>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages}
                    className="px-2.5 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition flex items-center gap-1 font-medium"
                  >
                    <span>Selanjutnya</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Drawer: Detail Pesan Gateway */}
      {selectedMessageDetail && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setSelectedMessageDetail(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm">Detail Teknis Pesan Gateway</h3>
              <button
                onClick={() => setSelectedMessageDetail(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Message ID:</span>
                  <span className="font-mono text-slate-800 text-[11px]">{selectedMessageDetail.id}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Session ID:</span>
                  <span className="font-mono text-slate-800 text-[11px]">{selectedMessageDetail.session_id}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Nomor Tujuan:</span>
                  <span className="font-medium text-slate-800">+{selectedMessageDetail.to}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Status:</span>
                  <span className="font-bold text-slate-800">{selectedMessageDetail.status}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Waktu Dibuat:</span>
                  <span className="text-slate-800">
                    {new Date(selectedMessageDetail.created_at).toLocaleString('id-ID')}
                  </span>
                </div>
                {selectedMessageDetail.provider_message_id && (
                  <div className="flex justify-between py-1.5 border-b border-slate-50">
                    <span className="text-slate-500">WA Message ID:</span>
                    <span className="font-mono text-slate-800 text-[11px]">
                      {selectedMessageDetail.provider_message_id}
                    </span>
                  </div>
                )}
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[11px] font-semibold text-slate-500 block mb-1">
                  Konten Pesan:
                </span>
                <p className="text-xs text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {selectedMessageDetail.message || '(Tidak ada konten teks)'}
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setSelectedMessageDetail(null)}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-semibold transition"
              >
                Tutup Drawer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};