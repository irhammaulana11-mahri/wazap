import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { ChatItem, ChatMessageItem, MessageItem, MessageStatus } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  MessageSquare,
  Clock,
  Send,
  User,
  Check,
  CheckCheck,
  Search,
  Smartphone,
  ChevronLeft,
  ChevronRight,
  Smile,
  Phone,
  Plus,
  X,
  AlertCircle,
  RotateCcw,
  Ban,
  Info,
  ListFilter,
  Bold,
  Italic,
  Strikethrough,
  Code,
  UserPlus,
} from 'lucide-react';

const COMMON_EMOJIS = ['👍', '🙏', '😀', '❤️', '✅', '🔥', '📦', '🛒', '🚀'];

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

export const ChatsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  // Left View Mode: 'chats' (WhatsApp threads) | 'queue' (Gateway outbox messages log)
  const [leftTab, setLeftTab] = useState<'chats' | 'queue'>('chats');

  // Selected session filter
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [searchChat, setSearchChat] = useState('');
  const [selectedChat, setSelectedChat] = useState<ChatItem | null>(null);
  const [replyText, setReplyText] = useState('');

  // Pagination states
  const [chatPage, setChatPage] = useState(1);
  const [chatPageSize, setChatPageSize] = useState(20);
  const [queuePage, setQueuePage] = useState(1);
  const [queuePageSize, setQueuePageSize] = useState(20);

  // Modal: Chat Baru / Kirim Pesan ke Nomor Baru
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);
  const [newChatCountry, setNewChatCountry] = useState('62');
  const [newChatPhone, setNewChatPhone] = useState('');
  const [newChatMessage, setNewChatMessage] = useState('');
  const [newChatError, setNewChatError] = useState('');

  // Modal: Detail Pesan Gateway
  const [detailMessage, setDetailMessage] = useState<MessageItem | null>(null);

  // Fetch Sessions
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.getSessions(),
  });

  // Auto-select first connected session
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

  // Fetch Chats list
  const {
    data: chatsResult,
    isLoading: loadingChats,
    isError: errorChats,
    error: chatsErrorObj,
    refetch: refetchChats,
  } = useQuery({
    queryKey: ['chats', { selectedSessionId, chatPage, pageSize: chatPageSize }],
    queryFn: () => api.getChats(selectedSessionId || undefined, chatPage, chatPageSize),
    refetchInterval: 5000,
  });

  const chats = chatsResult?.data || [];
  const chatMeta = chatsResult?.meta;
  const totalChatPages =
    chatMeta?.total && chatMeta?.page_size ? Math.ceil(chatMeta.total / chatMeta.page_size) : 1;

  // Filtered chats by search query
  const filteredChats = chats.filter((c) => {
    if (!searchChat.trim()) return true;
    const q = searchChat.toLowerCase();
    return (
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.jid && c.jid.toLowerCase().includes(q))
    );
  });

  // Fetch Chat Messages when a chat is selected
  const {
    data: messagesResult,
    isLoading: loadingMessages,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: ['chat-messages', selectedChat?.id],
    queryFn: () => (selectedChat ? api.getChatMessages(selectedChat.id) : null),
    enabled: !!selectedChat,
    refetchInterval: 3000,
  });

  const chatMessages = messagesResult?.data || [];

  // Fetch Gateway Queue Messages (for Outbox Log Tab)
  const {
    data: queueResult,
    isLoading: loadingQueue,
    refetch: refetchQueue,
  } = useQuery({
    queryKey: ['messages', { queuePage, pageSize: queuePageSize, selectedSessionId }],
    queryFn: () =>
      api.getMessages({
        page: queuePage,
        page_size: queuePageSize,
        session_id: selectedSessionId || undefined,
      }),
    refetchInterval: 5000,
  });

  const queueMessages = queueResult?.data || [];
  const queueMeta = queueResult?.meta;
  const totalQueuePages =
    queueMeta?.total && queueMeta?.page_size
      ? Math.ceil(queueMeta.total / queueMeta.page_size)
      : 1;

  // Send message mutation from chat view
  const sendReplyMutation = useMutation({
    mutationFn: async () => {
      if (!selectedChat || !replyText.trim()) return;
      const targetPhone = selectedChat.phone || selectedChat.jid.replace(/@.+/, '');
      return api.sendMessage(
        selectedChat.session_id,
        targetPhone,
        replyText.trim()
      );
    },
    onSuccess: () => {
      setReplyText('');
      queryClient.invalidateQueries({ queryKey: ['chat-messages', selectedChat?.id] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  // New Chat / First Message Mutation
  const newChatMutation = useMutation({
    mutationFn: async () => {
      let cleanPhone = newChatPhone.trim().replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
      if (!cleanPhone.startsWith(newChatCountry)) {
        cleanPhone = newChatCountry + cleanPhone;
      }

      return api.sendMessage(
        selectedSessionId,
        cleanPhone,
        newChatMessage.trim()
      );
    },
    onSuccess: () => {
      setNewChatPhone('');
      setNewChatMessage('');
      setIsNewChatModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (err: any) => {
      setNewChatError(err.message || 'Gagal mengirim pesan');
    },
  });

  // Cancel & Retry mutations
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
      queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
    },
  });

  const handleSendReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || sendReplyMutation.isPending) return;
    sendReplyMutation.mutate();
  };

  const handleInsertEmoji = (emoji: string) => {
    setReplyText((prev) => prev + emoji);
    if (inputRef.current) inputRef.current.focus();
  };

  const handleInsertFormat = (tag: string) => {
    setReplyText((prev) => `${prev}${tag}teks${tag}`);
    if (inputRef.current) inputRef.current.focus();
  };

  if (errorChats) {
    return <ErrorState message={(chatsErrorObj as Error).message} onRetry={() => refetchChats()} />;
  }

  return (
    <div className="space-y-4">
      {/* Top Bar Filter & Quick Action */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Pesan & Obrolan WhatsApp
          </h1>
          <p className="text-sm text-slate-500">
            Kirim pesan instan dan kelola percakapan pelanggan dengan antarmuka WhatsApp Web terpadu.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Session Selector */}
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-3 py-1.5 shadow-xs">
            <Smartphone className="w-3.5 h-3.5 text-emerald-600" />
            <select
              value={selectedSessionId}
              onChange={(e) => {
                setSelectedSessionId(e.target.value);
                setSelectedChat(null);
              }}
              className="text-xs font-semibold bg-transparent text-slate-800 focus:outline-none cursor-pointer"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.session_name || s.id.slice(0, 8)} ({s.status})
                </option>
              ))}
            </select>
          </div>

          {/* New Chat Button */}
          <button
            onClick={() => {
              setNewChatError('');
              setIsNewChatModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
          >
            <UserPlus className="w-3.5 h-3.5" />
            Chat Baru
          </button>
        </div>
      </div>

      {/* WhatsApp Web 2-Column Split Viewport */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden grid grid-cols-1 md:grid-cols-12 min-h-[660px] max-h-[780px]">
        {/* Left Column (5 Cols): Chat List & Outbox Switcher */}
        <div className="md:col-span-5 lg:col-span-4 border-r border-slate-200 flex flex-col h-full bg-white">
          {/* View Tab Switcher: Obrolan vs Log Antrean */}
          <div className="p-2.5 border-b border-slate-100 bg-slate-50 flex gap-1">
            <button
              onClick={() => setLeftTab('chats')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                leftTab === 'chats'
                  ? 'bg-white text-emerald-700 shadow-xs border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Obrolan ({chatMeta?.total_capped ? `${chatMeta.total}+` : chatMeta?.total || chats.length})
            </button>
            <button
              onClick={() => setLeftTab('queue')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                leftTab === 'queue'
                  ? 'bg-white text-emerald-700 shadow-xs border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5" />
              Log Antrean Gateway
            </button>
          </div>

          {leftTab === 'chats' ? (
            <>
              {/* Search Chat Input */}
              <div className="p-3 border-b border-slate-100 bg-white">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    value={searchChat}
                    onChange={(e) => setSearchChat(e.target.value)}
                    placeholder="Cari obrolan atau nomor kontak..."
                    className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-xl text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
                  />
                </div>
              </div>

              {/* Chat Thread List */}
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {loadingChats ? (
                  <div className="p-8 text-center text-xs text-slate-400">Memuat obrolan...</div>
                ) : filteredChats.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400">
                    Belum ada obrolan. Klik <strong>"Chat Baru"</strong> untuk memulai pesan ke nomor baru.
                  </div>
                ) : (
                  filteredChats.map((chat) => {
                    const isSelected = selectedChat?.id === chat.id;

                    return (
                      <div
                        key={chat.id}
                        onClick={() => setSelectedChat(chat)}
                        className={`p-3.5 cursor-pointer transition flex items-start gap-3 ${
                          isSelected
                            ? 'bg-emerald-50/90 border-l-4 border-emerald-600'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
                          {(chat.name || chat.phone || 'WA').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <h4 className="text-xs font-semibold text-slate-900 truncate">
                              {chat.name || `+${chat.phone}` || chat.jid}
                            </h4>
                            {chat.last_message_at && (
                              <span className="text-[10px] text-slate-400 shrink-0">
                                {new Date(chat.last_message_at).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 font-mono truncate">
                            {chat.phone ? `+${chat.phone}` : chat.jid}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Chat Pagination */}
              {chatMeta && (
                <div className="p-2 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <select
                      value={chatPageSize}
                      onChange={(e) => {
                        setChatPageSize(Number(e.target.value));
                        setChatPage(1);
                      }}
                      className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                    <span className="text-[10px] text-slate-400">/ hal</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium">
                      {chatMeta.page || 1}/{totalChatPages}
                    </span>
                    <button
                      onClick={() => setChatPage((p) => Math.max(1, p - 1))}
                      disabled={chatPage <= 1}
                      className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setChatPage((p) => p + 1)}
                      disabled={chatPage >= totalChatPages}
                      className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Gateway Outbox Messages Tab */
            <>
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-2 space-y-2">
                {loadingQueue ? (
                  <div className="p-8 text-center text-xs text-slate-400">Memuat log antrean...</div>
                ) : queueMessages.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400">Tidak ada pesan di antrean.</div>
                ) : (
                  queueMessages.map((msg) => {
                    const cfg = STATUS_CONFIG[msg.status] || STATUS_CONFIG.PENDING;
                    const canCancel = msg.status === 'PENDING';
                    const canRetry = msg.status === 'FAILED' || msg.status === 'UNKNOWN';

                    return (
                      <div
                        key={msg.id}
                        className="p-2.5 bg-slate-50 hover:bg-slate-100/70 rounded-xl border border-slate-200 text-xs space-y-1 transition"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-slate-900">+{msg.to}</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${cfg.bg} ${cfg.text}`}>
                            {cfg.icon}
                            {cfg.label}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 truncate">
                          {msg.message || '(Media)'}
                        </p>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-100">
                          <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <div className="flex items-center gap-1">
                            {canCancel && (
                              <button
                                onClick={() => cancelMutation.mutate(msg.id)}
                                className="text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-0.5"
                              >
                                <Ban className="w-3 h-3" /> Batal
                              </button>
                            )}
                            {canRetry && (
                              <button
                                onClick={() => retryMutation.mutate(msg.id)}
                                className="text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-0.5"
                              >
                                <RotateCcw className="w-3 h-3" /> Retry
                              </button>
                            )}
                            <button
                              onClick={() => setDetailMessage(msg)}
                              className="text-slate-500 hover:text-slate-800 p-0.5"
                            >
                              <Info className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Queue Pagination */}
              {queueMeta && (
                <div className="p-2 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <select
                      value={queuePageSize}
                      onChange={(e) => {
                        setQueuePageSize(Number(e.target.value));
                        setQueuePage(1);
                      }}
                      className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[11px] font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                    <span className="text-[10px] text-slate-400">/ hal</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium">
                      {queueMeta.page || 1}/{totalQueuePages}
                    </span>
                    <button
                      onClick={() => setQueuePage((p) => Math.max(1, p - 1))}
                      disabled={queuePage <= 1}
                      className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setQueuePage((p) => p + 1)}
                      disabled={queuePage >= totalQueuePages}
                      className="p-1 border border-slate-200 rounded bg-white hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right Column (7-8 Cols): WhatsApp Web Viewport */}
        <div className="md:col-span-7 lg:col-span-8 flex flex-col h-full bg-[#EFEAE2] relative">
          {selectedChat ? (
            <>
              {/* WhatsApp Active Contact Header */}
              <div className="p-3.5 border-b border-slate-200 bg-white flex items-center justify-between shadow-xs z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                    {(selectedChat.name || selectedChat.phone || 'WA').slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm leading-tight">
                      {selectedChat.name || `+${selectedChat.phone}` || selectedChat.jid}
                    </h3>
                    <p className="text-[11px] text-slate-400 font-mono">
                      {selectedChat.phone ? `+${selectedChat.phone}` : selectedChat.jid}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Sesi: {sessions.find((s) => s.id === selectedChat.session_id)?.session_name || 'Aktif'}
                  </span>
                </div>
              </div>

              {/* Message Timeline */}
              <div className="flex-1 p-4 overflow-y-auto space-y-2.5 flex flex-col-reverse">
                {loadingMessages ? (
                  <div className="text-center py-10 text-xs text-slate-400">
                    Memuat riwayat obrolan...
                  </div>
                ) : chatMessages.length === 0 ? (
                  <div className="text-center py-16 text-xs text-slate-400">
                    Belum ada riwayat pesan di obrolan ini. Ketik pesan di bawah untuk membalas.
                  </div>
                ) : (
                  chatMessages.map((msg) => {
                    const isOutbound = msg.direction === 'OUT';

                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isOutbound ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-xs shadow-xs break-words whitespace-pre-wrap relative ${
                            isOutbound
                              ? 'bg-[#DCF8C6] text-slate-900 rounded-tr-none border border-[#d2f3b9]'
                              : 'bg-white text-slate-900 rounded-tl-none border border-slate-200'
                          }`}
                        >
                          <p className="leading-relaxed">
                            {msg.text || (msg.text_purged ? '[Teks dihapus oleh retensi]' : '[Media/Format Khusus]')}
                          </p>
                          <div
                            className={`flex items-center justify-end gap-1 mt-1 text-[9px] ${
                              isOutbound ? 'text-slate-500' : 'text-slate-400'
                            }`}
                          >
                            <span>
                              {new Date(msg.occurred_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            {isOutbound && (
                              <span>
                                {msg.status === 'READ' ? (
                                  <CheckCheck className="w-3.5 h-3.5 text-sky-500" />
                                ) : msg.status === 'DELIVERED' ? (
                                  <CheckCheck className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                  <Check className="w-3.5 h-3.5 text-slate-400" />
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Message Composer Footer with WA Toolbar */}
              <div className="p-3 bg-[#F0F2F5] border-t border-slate-200 space-y-2">
                {/* Format & Emoji Quick Bar */}
                <div className="flex items-center gap-1 text-slate-600 px-1">
                  <button
                    type="button"
                    onClick={() => handleInsertFormat('*')}
                    className="p-1 hover:bg-white rounded transition"
                    title="Tebal (*bold*)"
                  >
                    <Bold className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertFormat('_')}
                    className="p-1 hover:bg-white rounded transition"
                    title="Miring (_italic_)"
                  >
                    <Italic className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertFormat('~')}
                    className="p-1 hover:bg-white rounded transition"
                    title="Coret (~strike~)"
                  >
                    <Strikethrough className="w-3 h-3" />
                  </button>
                  <div className="h-3 w-[1px] bg-slate-300 mx-1" />
                  {COMMON_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => handleInsertEmoji(emoji)}
                      className="p-0.5 hover:bg-white rounded transition text-xs"
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>

                <form onSubmit={handleSendReply} className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Ketik balasan pesan WhatsApp... (Tekan Enter untuk langsung kirim)"
                    className="flex-1 px-4 py-2.5 bg-white border border-slate-200 rounded-full text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none shadow-xs"
                  />
                  <button
                    type="submit"
                    disabled={sendReplyMutation.isPending || !replyText.trim()}
                    className="w-10 h-10 rounded-full bg-[#00A884] hover:bg-[#008f6f] text-white flex items-center justify-center transition shadow-sm disabled:opacity-50 shrink-0"
                    title="Kirim Pesan"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-400">
              <div className="w-16 h-16 rounded-full bg-white shadow-sm flex items-center justify-center mb-3">
                <MessageSquare className="w-8 h-8 text-emerald-600" />
              </div>
              <h3 className="text-sm font-bold text-slate-800">WhatsApp Gateway Messenger</h3>
              <p className="text-xs text-slate-400 max-w-sm mt-1">
                Pilih obrolan dari daftar sebelah kiri, atau ketuk tombol <strong>"Chat Baru"</strong> di atas untuk mengirim pesan ke nomor baru.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Drawer: Chat Baru / Kirim Pesan ke Nomor Baru */}
      {isNewChatModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsNewChatModalOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                  <UserPlus className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-slate-900 text-sm">Mulai Chat / Kirim Pesan Baru</h3>
              </div>
              <button
                onClick={() => setIsNewChatModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setNewChatError('');
                newChatMutation.mutate();
              }}
              className="flex-1 flex flex-col justify-between overflow-y-auto"
            >
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nomor WhatsApp Tujuan
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={newChatCountry}
                      onChange={(e) => setNewChatCountry(e.target.value)}
                      className="px-2.5 py-2 border border-slate-300 rounded-xl text-xs bg-slate-50 font-mono"
                    >
                      <option value="62">🇮🇩 +62</option>
                      <option value="60">🇲🇾 +60</option>
                      <option value="65">🇸🇬 +65</option>
                      <option value="1">🇺🇸 +1</option>
                    </select>
                    <input
                      type="text"
                      value={newChatPhone}
                      onChange={(e) => setNewChatPhone(e.target.value)}
                      placeholder="8123456789 atau 08123456789"
                      required
                      className="flex-1 px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Isi Pesan Pembuka
                  </label>
                  <textarea
                    value={newChatMessage}
                    onChange={(e) => setNewChatMessage(e.target.value)}
                    placeholder="Ketik pesan pertama Anda di sini..."
                    rows={5}
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                {newChatError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{newChatError}</span>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsNewChatModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={newChatMutation.isPending || !newChatPhone.trim() || !newChatMessage.trim()}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition disabled:opacity-50"
                >
                  {newChatMutation.isPending ? 'Mengirim...' : 'Kirim Sekarang'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: Detail Pesan Gateway */}
      {detailMessage && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setDetailMessage(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm">Detail Teknis Pesan Gateway</h3>
              <button
                onClick={() => setDetailMessage(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">ID Pesan:</span>
                  <span className="font-mono text-slate-800 text-[11px]">{detailMessage.id}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Nomor Tujuan:</span>
                  <span className="font-medium text-slate-800">+{detailMessage.to}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Status Gateway:</span>
                  <span className="font-bold text-slate-800">{detailMessage.status}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-50">
                  <span className="text-slate-500">Waktu Dibuat:</span>
                  <span className="text-slate-800">
                    {new Date(detailMessage.created_at).toLocaleString('id-ID')}
                  </span>
                </div>
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[11px] font-semibold text-slate-500 block mb-1">
                  Konten Pesan:
                </span>
                <p className="text-xs text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {detailMessage.message || '(Pesan kosong)'}
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setDetailMessage(null)}
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