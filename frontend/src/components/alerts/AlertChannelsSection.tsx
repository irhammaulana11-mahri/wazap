import React, { useState } from 'react';
import {
  Send,
  Plus,
  Trash2,
  Edit2,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Clock,
  Radio,
  Layers,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import {
  AlertCatalogData,
  AlertChannelItem,
  AlertTestResult,
} from '../../types';
import { AlertChannelDrawer, ChannelModalMode } from './AlertChannelDrawer';
import { useToast } from '../../context/ToastContext';

interface AlertChannelsSectionProps {
  catalog?: AlertCatalogData;
  channels: AlertChannelItem[];
  isLoading: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}

interface TestFeedback {
  channelId: string;
  result?: AlertTestResult;
  error?: string;
  rateLimitWait?: number;
}

export const AlertChannelsSection: React.FC<AlertChannelsSectionProps> = ({
  catalog,
  channels,
  isLoading,
  disabled = false,
  onRefresh,
}) => {
  const { showToast } = useToast();

  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ChannelModalMode>('create');
  const [selectedChannel, setSelectedChannel] = useState<AlertChannelItem | null>(null);

  // Testing states per channel
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [testFeedbacks, setTestFeedbacks] = useState<Record<string, TestFeedback>>({});

  // Toggle active loading state
  const [togglingChannelId, setTogglingChannelId] = useState<string | null>(null);

  const handleOpenCreate = () => {
    setSelectedChannel(null);
    setModalMode('create');
    setIsModalOpen(true);
  };

  const handleOpenTarget = (channel: AlertChannelItem) => {
    setSelectedChannel(channel);
    setModalMode('target');
    setIsModalOpen(true);
  };

  const handleOpenDelete = (channel: AlertChannelItem) => {
    setSelectedChannel(channel);
    setModalMode('delete');
    setIsModalOpen(true);
  };

  const handleToggleActive = async (channel: AlertChannelItem) => {
    if (disabled) return;
    setTogglingChannelId(channel.id);
    try {
      await api.updateAlertChannel(channel.id, { active: !channel.active });
      showToast(
        'success',
        `Kanal "${channel.name}" berhasil ${!channel.active ? 'diaktifkan' : 'dinonaktifkan'}.`
      );
      onRefresh();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        showToast('error', err.message || 'Gagal mengubah status kanal.');
      } else {
        showToast('error', 'Terjadi galat saat mengubah status kanal.');
      }
    } finally {
      setTogglingChannelId(null);
    }
  };

  const handleTestChannel = async (channel: AlertChannelItem) => {
    if (disabled) return;
    setTestingChannelId(channel.id);
    setTestFeedbacks((prev) => ({
      ...prev,
      [channel.id]: { channelId: channel.id },
    }));

    try {
      const res = await api.testAlertChannel(channel.id);
      setTestFeedbacks((prev) => ({
        ...prev,
        [channel.id]: {
          channelId: channel.id,
          result: res,
        },
      }));

      if (res.ok) {
        showToast('success', `Pesan uji terkirim ke kanal "${channel.name}".`);
      } else {
        showToast('error', `Uji kirim gagal ke kanal "${channel.name}".`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const waitSec = err.retryAfterSec;
          setTestFeedbacks((prev) => ({
            ...prev,
            [channel.id]: {
              channelId: channel.id,
              error: waitSec
                ? `Batas uji per jam tercapai; coba lagi dalam ${waitSec} detik.`
                : 'Batas uji per jam tercapai; coba lagi nanti.',
              rateLimitWait: waitSec,
            },
          }));
        } else {
          setTestFeedbacks((prev) => ({
            ...prev,
            [channel.id]: {
              channelId: channel.id,
              error: err.message || `Galat ${err.code}`,
            },
          }));
        }
      } else {
        setTestFeedbacks((prev) => ({
          ...prev,
          [channel.id]: {
            channelId: channel.id,
            error: (err as Error)?.message || 'Koneksi jaringan gagal saat uji kirim.',
          },
        }));
      }
    } finally {
      setTestingChannelId(null);
    }
  };

  const maxChannels = catalog?.max_channels;
  const isQuotaFull = maxChannels !== undefined && channels.length >= maxChannels;

  return (
    <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs p-6 sm:p-7 space-y-6">
      {/* Header & Quota Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-base sm:text-lg font-bold text-slate-900">
              Kanal Notifikasi Tujuan
            </h2>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
              <Layers className="w-3.5 h-3.5 text-slate-500" />
              <span>
                {channels.length} dari {maxChannels !== undefined ? maxChannels : '—'} kanal
              </span>
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Konfigurasikan bot Telegram atau webhook Slack untuk menerima pemberitahuan kejadian penting gateway.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreate}
          disabled={disabled || isQuotaFull || isLoading}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-xs sm:text-sm font-bold rounded-xl shadow-xs transition shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Tambah Kanal</span>
        </button>
      </div>

      {/* Quota Full Notice */}
      {isQuotaFull && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-2xl flex items-center gap-2.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
            Batas Kuota
          </span>
          <span>
            Batas maksimal alokasi kanal ({maxChannels} kanal) telah tercapai. Hapus kanal yang tidak terpakai untuk menambahkan kanal baru.
          </span>
        </div>
      )}

      {/* Channels List */}
      {isLoading ? (
        <div className="py-12 text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-600 mx-auto" />
          <p className="text-xs text-slate-500">Memuat daftar kanal notifikasi...</p>
        </div>
      ) : channels.length === 0 ? (
        <div className="py-12 px-4 text-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 text-slate-400 flex items-center justify-center mx-auto shadow-2xs">
            <Send className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-slate-900">Belum Ada Kanal Notifikasi</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Tambahkan bot Telegram atau webhook Slack agar tim Anda dapat langsung menerima peringatan saat sesi terputus atau webhook dinonaktifkan.
          </p>
          <button
            type="button"
            onClick={handleOpenCreate}
            disabled={disabled}
            className="inline-flex items-center gap-2 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-xl border border-slate-200 shadow-2xs transition"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-600" />
            <span>Mulai Tambah Kanal</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {channels.map((channel) => {
            const feedback = testFeedbacks[channel.id];
            const isTesting = testingChannelId === channel.id;
            const isToggling = togglingChannelId === channel.id;
            const isAutoDisabled = channel.disabled_reason === 'AUTO_CONSECUTIVE_FAILURES';

            return (
              <div
                key={channel.id}
                className={`p-5 rounded-2xl border transition space-y-4 relative overflow-hidden ${
                  !channel.active
                    ? 'bg-slate-50/70 border-slate-200 opacity-90'
                    : 'bg-white border-slate-200 shadow-2xs hover:border-slate-300'
                }`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                        channel.type === 'TELEGRAM'
                          ? 'bg-sky-50 text-sky-600 border-sky-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      <Send className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-slate-900 truncate">
                          {channel.name}
                        </h3>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            channel.type === 'TELEGRAM'
                              ? 'bg-sky-50 text-sky-800 border-sky-200'
                              : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          }`}
                        >
                          {channel.type === 'TELEGRAM' ? 'Telegram' : 'Slack / Discord'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">
                        Target: berakhiran <span className="font-bold text-slate-700">••••{channel.target_hint}</span>
                      </p>
                    </div>
                  </div>

                  {/* Active Switch */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-medium text-slate-500">
                      {channel.active ? 'Aktif' : 'Nonaktif'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={channel.active}
                      disabled={disabled || isToggling}
                      onClick={() => handleToggleActive(channel)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed ${
                        channel.active ? 'bg-emerald-600' : 'bg-slate-300'
                      }`}
                      aria-label={`Ubah status aktif kanal ${channel.name}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                          channel.active ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Auto Disabled Alert */}
                {isAutoDisabled && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between gap-2 text-xs text-rose-800">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                      <span>
                        Dinonaktifkan otomatis karena gagal berturut-turut ({channel.consecutive_failures}x gagal).
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleActive(channel)}
                      disabled={disabled || isToggling}
                      className="px-2.5 py-1 bg-white hover:bg-rose-100 text-rose-900 border border-rose-300 rounded-lg font-bold text-[11px] shrink-0 transition"
                    >
                      Aktifkan Ulang
                    </button>
                  </div>
                )}

                {/* Live Test Feedback Banner */}
                {feedback && (
                  <div
                    aria-live="polite"
                    className={`p-3 rounded-xl border text-xs space-y-1 ${
                      feedback.result?.ok
                        ? 'bg-emerald-50/80 border-emerald-200 text-emerald-900'
                        : 'bg-rose-50/80 border-rose-200 text-rose-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {feedback.result?.ok ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                          <span>Pesan uji terkirim; periksa chat Anda ({feedback.result.duration_ms} ms).</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                          <span>
                            Uji kirim gagal
                            {feedback.result?.status_code ? ` (HTTP ${feedback.result.status_code})` : ''}
                            {feedback.result?.error_code ? ` (${feedback.result.error_code})` : ''}
                          </span>
                        </>
                      )}
                    </div>

                    {!feedback.result?.ok && (
                      <p className="text-[11px] text-rose-700 pl-6 leading-relaxed">
                        {feedback.result?.status_code === 401 ||
                        feedback.result?.status_code === 403 ||
                        feedback.result?.status_code === 404
                          ? 'Token bot telah dicabut atau chat ID penerima tidak ditemukan/dilarang.'
                          : feedback.result?.error_code === 'TIMEOUT' ||
                            feedback.result?.error_code === 'DNS_FAILED' ||
                            feedback.result?.error_code === 'TLS_ERROR'
                          ? 'Masalah jaringan atau domain webhook tidak dapat dijangkau.'
                          : feedback.error || 'Server menolak pesan uji. Periksa kredensial target kanal.'}
                      </p>
                    )}
                  </div>
                )}

                {/* Actions Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
                  <button
                    type="button"
                    onClick={() => handleTestChannel(channel)}
                    disabled={disabled || isTesting}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold transition disabled:opacity-50"
                  >
                    {isTesting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />
                        <span>Menguji...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Uji Kirim</span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleOpenTarget(channel)}
                      disabled={disabled}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition"
                      title="Ganti Target Kredensial"
                      aria-label={`Ganti kredensial target untuk ${channel.name}`}
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleOpenDelete(channel)}
                      disabled={disabled}
                      className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition"
                      title="Hapus Kanal"
                      aria-label={`Hapus kanal ${channel.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Channel Slide-Over Drawer with Live Preview */}
      <AlertChannelDrawer
        isOpen={isModalOpen}
        mode={modalMode}
        channel={selectedChannel}
        allowedTypes={catalog?.channel_types}
        onClose={() => setIsModalOpen(false)}
        onSuccess={onRefresh}
      />
    </div>
  );
};
