import React, { useState } from 'react';
import { ShieldAlert, Copy, Check, Download, AlertTriangle } from 'lucide-react';

interface RecoveryCodeModalProps {
  isOpen: boolean;
  code?: string;
  codes?: string[];
  title?: string;
  description?: string;
  onAcknowledge: () => void;
  buttonText?: string;
}

export const RecoveryCodeModal: React.FC<RecoveryCodeModalProps> = ({
  isOpen,
  code,
  codes,
  title = 'Simpan Kode Pemulihan Akun Anda',
  description = 'Kode pemulihan ini HANYA DITAMPILKAN SEKALI. Karena gateway beroperasi tanpa email otomatis, kode ini merupakan satu-satunya cara untuk memulihkan akun atau mereset kata sandi jika Anda lupa.',
  onAcknowledge,
  buttonText = 'Saya Sudah Menyimpan, Lanjutkan',
}) => {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  if (!isOpen) return null;

  const codeList = codes && codes.length > 0 ? codes : code ? [code] : [];
  const allCodesText = codeList.join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(allCodesText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const element = document.createElement('a');
    const file = new Blob(
      [
        `WAZAP GATEWAY - KODE PEMULIHAN AKUN\n`,
        `===================================\n\n`,
        `Daftar Kode Pemulihan (Sekali Pakai):\n`,
        `${codeList.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n`,
        `PERINGATAN PENTING:\n`,
        `- Simpan berkas ini di tempat yang aman dan terlindungi.\n`,
        `- Setiap kode hanya dapat digunakan satu kali untuk mereset kata sandi.\n`,
        `- Kode ini digunakan pada halaman /forgot-password.\n`,
        `- Tanggal Dibuat: ${new Date().toLocaleString('id-ID')}\n`,
      ],
      { type: 'text/plain' }
    );
    element.href = URL.createObjectURL(file);
    element.download = `wazap-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden">
        {/* Header Warning */}
        <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-6 py-5 text-white flex items-center gap-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <ShieldAlert className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="font-extrabold text-base tracking-tight">{title}</h3>
            <p className="text-xs text-amber-100 mt-0.5">Tindakan penting sebelum melanjutkan</p>
          </div>
        </div>

        <div className="p-6 sm:p-8 space-y-6">
          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
            {description}
          </p>

          {/* Recovery Code Display */}
          <div className="space-y-2">
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              {codeList.length > 1
                ? `Daftar ${codeList.length} Kode Pemulihan Rahasia Anda (Sekali Pakai)`
                : 'Kode Pemulihan Rahasia Anda'}
            </label>

            {codeList.length > 1 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-2 bg-slate-950 rounded-2xl border border-slate-800">
                {codeList.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-xl bg-slate-900 text-emerald-400 font-mono text-xs font-bold"
                  >
                    <span className="text-slate-500 font-normal mr-1">{i + 1}.</span>
                    <span className="truncate select-all">{c}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3.5 bg-slate-900 text-emerald-400 font-mono text-sm sm:text-base font-bold rounded-2xl border border-slate-800 shadow-inner">
                <span className="flex-1 tracking-wider text-center select-all">{codeList[0] || code}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-2 rounded-xl bg-slate-800 text-slate-200 hover:text-white hover:bg-slate-700 transition"
                  title="Salin kode"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}
          </div>

          {/* Actions: Copy & Download */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-slate-500" />}
              <span>{copied ? 'Tersalin!' : codeList.length > 1 ? 'Salin Semua Kode' : 'Salin ke Clipboard'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition"
            >
              <Download className="w-4 h-4 text-slate-500" />
              <span>Unduh Berkas (.txt)</span>
            </button>
          </div>

          {/* Warning banner */}
          <div className="flex items-start gap-3 p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              <strong>Jangan simpan kode ini di penyimpanan daring publik.</strong> Jika seluruh kode hilang, administrator sistem harus meresetnya secara manual melalui konsol server.
            </p>
          </div>

          {/* Mandatory Checkbox */}
          <div className="pt-2 border-t border-slate-100">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-700 font-semibold leading-relaxed">
                Saya telah mencatat atau mengunduh kode pemulihan ini dan menyimpannya di tempat yang aman.
              </span>
            </label>
          </div>

          {/* Continue Button */}
          <button
            type="button"
            disabled={!acknowledged}
            onClick={onAcknowledge}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-bold text-xs sm:text-sm hover:from-emerald-700 hover:to-teal-700 transition shadow-lg shadow-emerald-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
};
