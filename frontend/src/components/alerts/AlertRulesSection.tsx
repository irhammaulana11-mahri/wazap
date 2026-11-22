import React, { useState, useEffect } from 'react';
import {
  Bell,
  Check,
  AlertTriangle,
  Info,
  Save,
  Loader2,
  Clock,
  Sliders,
  Send,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import {
  AlertCatalogData,
  AlertCatalogRule,
  AlertChannelItem,
  AlertRuleItem,
  PutAlertRuleBody,
} from '../../types';
import { useToast } from '../../context/ToastContext';

interface AlertRulesSectionProps {
  catalog?: AlertCatalogData;
  rules: AlertRuleItem[];
  channels: AlertChannelItem[];
  isLoading: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}

interface RuleFormState {
  enabled: boolean;
  threshold?: number;
  cooldown_minutes?: number;
  channel_ids: string[];
}

export const AlertRulesSection: React.FC<AlertRulesSectionProps> = ({
  catalog,
  rules,
  channels,
  isLoading,
  disabled = false,
  onRefresh,
}) => {
  const { showToast } = useToast();

  // Local draft state for each rule code
  const [formStates, setFormStates] = useState<Record<string, RuleFormState>>({});
  const [savingCodes, setSavingCodes] = useState<Record<string, boolean>>({});
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});

  // Active channels list for selection
  const activeChannels = channels.filter((c) => c.active);

  // Sync draft states from server rules and catalog
  useEffect(() => {
    if (!catalog?.rules) return;

    const newStates: Record<string, RuleFormState> = {};
    const rulesByCode = new Map(rules.map((r) => [r.code, r]));

    for (const catRule of catalog.rules) {
      const serverRule = rulesByCode.get(catRule.code);
      newStates[catRule.code] = {
        enabled: serverRule?.enabled ?? false,
        threshold: catRule.threshold
          ? serverRule?.threshold ?? catRule.threshold.default
          : undefined,
        cooldown_minutes: catRule.repeats
          ? serverRule?.cooldown_minutes ?? catalog.cooldown.default
          : undefined,
        channel_ids: serverRule?.channel_ids ?? [],
      };
    }

    setFormStates(newStates);
  }, [catalog, rules]);

  const handleToggleRule = (code: string) => {
    if (disabled) return;
    setFormStates((prev) => {
      const current = prev[code];
      if (!current) return prev;
      return {
        ...prev,
        [code]: { ...current, enabled: !current.enabled },
      };
    });
    setRuleErrors((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });
  };

  const handleThresholdChange = (code: string, val: number) => {
    setFormStates((prev) => {
      const current = prev[code];
      if (!current) return prev;
      return {
        ...prev,
        [code]: { ...current, threshold: val },
      };
    });
  };

  const handleCooldownChange = (code: string, val: number) => {
    setFormStates((prev) => {
      const current = prev[code];
      if (!current) return prev;
      return {
        ...prev,
        [code]: { ...current, cooldown_minutes: val },
      };
    });
  };

  const handleToggleChannel = (code: string, channelId: string) => {
    if (disabled) return;
    setFormStates((prev) => {
      const current = prev[code];
      if (!current) return prev;
      const exists = current.channel_ids.includes(channelId);
      let updatedIds: string[];
      if (exists) {
        updatedIds = current.channel_ids.filter((id) => id !== channelId);
      } else {
        if (current.channel_ids.length >= 5) {
          showToast('error', 'Maksimal 5 kanal per aturan.');
          return prev;
        }
        updatedIds = [...current.channel_ids, channelId];
      }
      return {
        ...prev,
        [code]: { ...current, channel_ids: updatedIds },
      };
    });
    setRuleErrors((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });
  };

  const handleSaveRule = async (catRule: AlertCatalogRule) => {
    if (disabled) return;
    const state = formStates[catRule.code];
    if (!state) return;

    setRuleErrors((prev) => {
      const next = { ...prev };
      delete next[catRule.code];
      return next;
    });

    // Validasi: bila diaktifkan, minimal 1 kanal wajib dipilih
    if (state.enabled && state.channel_ids.length === 0) {
      setRuleErrors((prev) => ({
        ...prev,
        [catRule.code]: 'Pilih minimal 1 kanal untuk mengaktifkan aturan notifikasi ini.',
      }));
      return;
    }

    // Validasi threshold bila ada
    if (catRule.threshold && state.threshold !== undefined) {
      if (
        state.threshold < catRule.threshold.min ||
        state.threshold > catRule.threshold.max
      ) {
        setRuleErrors((prev) => ({
          ...prev,
          [catRule.code]: `Nilai ambang harus antara ${catRule.threshold?.min} dan ${catRule.threshold?.max} ${catRule.threshold?.unit}.`,
        }));
        return;
      }
    }

    // Validasi cooldown bila repeats
    if (catRule.repeats && catalog && state.cooldown_minutes !== undefined) {
      if (
        state.cooldown_minutes < catalog.cooldown.min ||
        state.cooldown_minutes > catalog.cooldown.max
      ) {
        setRuleErrors((prev) => ({
          ...prev,
          [catRule.code]: `Jeda ulang harus antara ${catalog.cooldown.min} dan ${catalog.cooldown.max} menit.`,
        }));
        return;
      }
    }

    setSavingCodes((prev) => ({ ...prev, [catRule.code]: true }));

    try {
      const body: PutAlertRuleBody = {
        enabled: state.enabled,
        channel_ids: state.channel_ids,
      };

      if (catRule.threshold && state.threshold !== undefined) {
        body.threshold = state.threshold;
      }

      if (catRule.repeats && state.cooldown_minutes !== undefined) {
        body.cooldown_minutes = state.cooldown_minutes;
      }

      await api.putAlertRule(catRule.code, body);
      showToast('success', `Aturan "${catRule.label}" berhasil disimpan.`);
      onRefresh();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setRuleErrors((prev) => ({
          ...prev,
          [catRule.code]: err.message || `Galat saat menyimpan (${err.code}).`,
        }));
      } else {
        setRuleErrors((prev) => ({
          ...prev,
          [catRule.code]: 'Koneksi gagal saat menyimpan aturan.',
        }));
      }
    } finally {
      setSavingCodes((prev) => ({ ...prev, [catRule.code]: false }));
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xs p-6 sm:p-7 space-y-6">
      {/* Header */}
      <div className="pb-5 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
            Aturan Notifikasi & Ambang Batas
          </h2>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
            <Bell className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span>{catalog?.rules.length ?? '—'} Aturan</span>
          </span>
        </div>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
          Tentukan kondisi pemicu, batas toleransi, dan kanal penerima untuk masing-masing jenis kejadian gateway.
        </p>
      </div>

      {/* Honest Disclaimer Alert */}
      <div className="p-4 bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-2xl flex items-start gap-3 text-xs text-amber-900 dark:text-amber-200">
        <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
              Informasi Penting
            </span>
            <p className="font-bold text-slate-900 dark:text-white">Bantuan Operasional, Bukan Garansi Mutlak</p>
          </div>
          <p className="text-amber-800 dark:text-amber-300/90 leading-relaxed">
            Layanan Telegram atau Slack dapat mengalami keterlambatan atau tidak tersedia sewaktu-waktu. Kejadian yang terjadi saat layanan sistem berhenti lama mungkin tidak dikirimkan. Tetap pantau dashboard operasional secara berkala.
          </p>
        </div>
      </div>

      {/* No active channels alert */}
      {channels.length > 0 && activeChannels.length === 0 && (
        <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 rounded-2xl flex items-center gap-2.5 text-xs text-rose-800 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-rose-100 dark:bg-rose-900/70 text-rose-800 dark:text-rose-300 border border-rose-300 dark:border-rose-700">
            Peringatan
          </span>
          <span>
            Semua kanal notifikasi saat ini nonaktif. Aktifkan minimal satu kanal di bagian atas agar aturan dapat mengirimkan pesan.
          </span>
        </div>
      )}

      {/* Rules List */}
      {isLoading ? (
        <div className="py-12 text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-600 dark:text-emerald-400 mx-auto" />
          <p className="text-xs text-slate-500 dark:text-slate-400">Memuat konfigurasi aturan notifikasi...</p>
        </div>
      ) : (
        <div className="space-y-4">
          {catalog?.rules.map((catRule) => {
            const state = formStates[catRule.code] || {
              enabled: false,
              channel_ids: [],
            };
            const isSaving = savingCodes[catRule.code] || false;
            const error = ruleErrors[catRule.code];

            return (
              <div
                key={catRule.code}
                className={`p-5 rounded-2xl border transition space-y-4 ${
                  state.enabled
                    ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-2xs hover:border-slate-300 dark:hover:border-slate-700'
                    : 'bg-slate-50/60 dark:bg-slate-950/40 border-slate-200/80 dark:border-slate-800 opacity-80'
                }`}
              >
                {/* Title & switch row */}
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">{catRule.label}</h3>
                      <code className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        {catRule.code}
                      </code>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-2xl">{catRule.description}</p>
                  </div>

                  {/* Switch */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {state.enabled ? 'Aktif' : 'Nonaktif'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={state.enabled}
                      disabled={disabled || isSaving}
                      onClick={() => handleToggleRule(catRule.code)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:cursor-not-allowed ${
                        state.enabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                      }`}
                      aria-label={`Ubah status aturan ${catRule.label}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${
                          state.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Error message */}
                {error && (
                  <div className="p-3 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-800 dark:text-rose-300 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {/* Inputs Row (Threshold & Cooldown & Channel Selector) */}
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
                  {/* Threshold Input (if supported) */}
                  {catRule.threshold && (
                    <div className="md:col-span-3">
                      <label
                        htmlFor={`threshold-${catRule.code}`}
                        className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        Ambang Toleransi
                      </label>
                      <div className="relative">
                        <input
                          id={`threshold-${catRule.code}`}
                          type="number"
                          disabled={disabled || !state.enabled}
                          min={catRule.threshold.min}
                          max={catRule.threshold.max}
                          value={state.threshold ?? catRule.threshold.default}
                          onChange={(e) =>
                            handleThresholdChange(catRule.code, parseInt(e.target.value, 10))
                          }
                          className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white dark:focus:bg-slate-900 disabled:opacity-50 text-slate-900 dark:text-white transition"
                        />
                        <span className="absolute right-2.5 top-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 pointer-events-none">
                          {catRule.threshold.unit}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 block">
                        Rentang: {catRule.threshold.min}–{catRule.threshold.max} {catRule.threshold.unit}
                      </span>
                    </div>
                  )}

                  {/* Cooldown Input (if repeats) */}
                  {catRule.repeats && catalog && (
                    <div className="md:col-span-3">
                      <label
                        htmlFor={`cooldown-${catRule.code}`}
                        className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1"
                      >
                        Jeda Ulang (Cooldown)
                      </label>
                      <div className="relative">
                        <input
                          id={`cooldown-${catRule.code}`}
                          type="number"
                          disabled={disabled || !state.enabled}
                          min={catalog.cooldown.min}
                          max={catalog.cooldown.max}
                          value={state.cooldown_minutes ?? catalog.cooldown.default}
                          onChange={(e) =>
                            handleCooldownChange(catRule.code, parseInt(e.target.value, 10))
                          }
                          className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white dark:focus:bg-slate-900 disabled:opacity-50 text-slate-900 dark:text-white transition"
                        />
                        <span className="absolute right-2.5 top-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 pointer-events-none">
                          menit
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 block">
                        Rentang: {catalog.cooldown.min}–{catalog.cooldown.max} menit
                      </span>
                    </div>
                  )}

                  {/* Channels Selector */}
                  <div
                    className={`${
                      catRule.threshold && catRule.repeats
                        ? 'md:col-span-4'
                        : catRule.threshold || catRule.repeats
                        ? 'md:col-span-7'
                        : 'md:col-span-10'
                    }`}
                  >
                    <label className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1">
                      Kanal Tujuan ({state.channel_ids.length}/5 terpilih)
                    </label>

                    {channels.length === 0 ? (
                      <p className="text-xs text-slate-400 dark:text-slate-500 italic py-1.5">
                        Belum ada kanal dibuat. Buat kanal terlebih dahulu di atas.
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {channels.map((ch) => {
                          const isSelected = state.channel_ids.includes(ch.id);
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              disabled={disabled || !state.enabled}
                              onClick={() => handleToggleChannel(catRule.code, ch.id)}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-medium border transition disabled:opacity-50 cursor-pointer ${
                                isSelected
                                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800 font-bold'
                                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                              }`}
                            >
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  ch.type === 'TELEGRAM' ? 'bg-sky-500' : 'bg-emerald-500'
                                }`}
                              />
                              <span>{ch.name}</span>
                              {isSelected && <Check className="w-3 h-3 text-emerald-700" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Save Button */}
                  <div className="md:col-span-2 flex justify-end">
                    <button
                      type="button"
                      disabled={disabled || isSaving}
                      onClick={() => handleSaveRule(catRule)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold rounded-xl shadow-xs transition"
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Simpan...</span>
                        </>
                      ) : (
                        <>
                          <Save className="w-3.5 h-3.5" />
                          <span>Simpan</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
