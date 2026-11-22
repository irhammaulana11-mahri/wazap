import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { ApiKeyScope, VALID_API_KEY_SCOPES } from '../types';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  ShieldCheck,
  ShieldAlert,
  X,
  Code2,
  Terminal,
  ExternalLink,
  Pencil,
} from 'lucide-react';

const SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  'messages:send': 'Kirim pesan teks, media, dan bulk',
  'messages:read': 'Baca riwayat dan status pesan',
  'sessions:read': 'Baca daftar dan status sesi WhatsApp',
  'sessions:write': 'Buat, hubungkan, dan putus sesi',
  'webhooks:manage': 'Kelola endpoint dan secret webhook',
  'contacts:read': 'Baca daftar kontak tersinkronisasi',
  'usage:read': 'Baca data metrik dan kuota penggunaan',
};

type CodeLang = 'curl' | 'node' | 'php' | 'python';

export const ApiKeysPage: React.FC = () => {
  const queryClient = useQueryClient();

  // Create form state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([
    'messages:send',
    'messages:read',
  ]);
  const [formError, setFormError] = useState('');

  // Reveal-once plain API key state (ephemeral)
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Playground state
  const [snippetLang, setSnippetLang] = useState<CodeLang>('curl');
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Edit API Key state
  const [editingApiKey, setEditingApiKey] = useState<any>(null);
  const [editKeyName, setEditKeyName] = useState('');
  const [editSelectedScopes, setEditSelectedScopes] = useState<ApiKeyScope[]>([]);
  const [editFormError, setEditFormError] = useState('');
  const [revokeInfoMessage, setRevokeInfoMessage] = useState('');
  const { confirm } = useConfirm();
  const { showToast } = useToast();

  // Fetch API keys
  const {
    data: apiKeys = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: api.getApiKeys,
  });

  // Filter out revoked keys defensively (revoked_at)
  const activeApiKeys = (apiKeys || []).filter((k) => !k.revoked_at);

  // Create Mutation
  const createMutation = useMutation({
    mutationFn: () => api.createApiKey(keyName.trim(), selectedScopes),
    onSuccess: (data) => {
      setKeyName('');
      setSelectedScopes(['messages:send', 'messages:read']);
      setFormError('');
      setIsCreateModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });

      if (data.key) {
        setRevealedKey(data.key);
      }
    },
    onError: (err: any) => {
      setFormError(err.message || 'Gagal membuat API Key');
    },
  });

  // Revoke Mutation
  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      showToast('success', 'API Key berhasil dicabut.');
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err: any) => {
      // Tangani 404 / NOT_FOUND bila kunci sudah terhapus permanen atau dicabut dari tab lain
      const isNotFound =
        err?.status === 404 ||
        err?.code === 'NOT_FOUND' ||
        err?.message?.includes('404') ||
        err?.message?.includes('NOT_FOUND');
      if (isNotFound) {
        setRevokeInfoMessage('Kunci ini sudah dicabut atau dihapus');
        showToast('info', 'Kunci ini sudah dicabut atau dihapus');
        queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        setTimeout(() => setRevokeInfoMessage(''), 5000);
      } else {
        showToast('error', err.message || 'Gagal mencabut API Key');
      }
    },
  });

  // Update Mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; scopes?: ApiKeyScope[] } }) =>
      api.updateApiKey(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setEditingApiKey(null);
    },
    onError: (err: any) => {
      setEditFormError(err.message || 'Gagal memperbarui API Key');
    },
  });

  const handleToggleEditScope = (scope: ApiKeyScope) => {
    setEditSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleToggleScope = (scope: ApiKeyScope) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) return;
    if (selectedScopes.length === 0) {
      setFormError('Pilih minimal satu hak akses (scope)');
      return;
    }
    setFormError('');
    createMutation.mutate();
  };

  const copyKey = async () => {
    if (revealedKey) {
      try {
        await navigator.clipboard.writeText(revealedKey);
        setCopiedKey(true);
        setTimeout(() => setCopiedKey(false), 2000);
      } catch {
        showToast('error', 'Gagal menyalin otomatis. Silakan salin kunci secara manual.');
      }
    }
  };

  // Generate code snippets for quick copy
  const getCodeSnippet = (lang: CodeLang) => {
    const activeKeyHint = revealedKey || 'gwk_PASTE_KUNCI_LENGKAP_DI_SINI';
    const baseUrl = window.location.origin;

    switch (lang) {
      case 'curl':
        return `# Kunci lengkap (gwk_...) hanya ditampilkan sekali saat dibuat, simpan di variabel lingkungan sisi server (bukan di browser).
# session_id: Salin ID lengkap dari kartu sesi di menu Koneksi & API -> Sesi WhatsApp.
curl -X POST "${baseUrl}/api/v1/messages/send" \\
  -H "Authorization: Bearer ${activeKeyHint}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "session_id": "SALIN_ID_LENGKAP_DARI_KARTU_SESI",
    "to": "628123456789",
    "type": "text",
    "message": "Halo dari aplikasi saya via WhatsApp Gateway!"
  }'`;

      case 'node':
        return `// Kunci lengkap (gwk_...) hanya ditampilkan sekali saat dibuat, simpan di variabel lingkungan sisi server (bukan di browser).
// session_id: Salin ID lengkap dari kartu sesi di menu Koneksi & API -> Sesi WhatsApp.
// Node.js (Fetch API)
const response = await fetch("${baseUrl}/api/v1/messages/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${activeKeyHint}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    session_id: "SALIN_ID_LENGKAP_DARI_KARTU_SESI",
    to: "628123456789",
    type: "text",
    message: "Halo dari Node.js via WhatsApp Gateway!"
  })
});
const data = await response.json();
console.log(data);`;

      case 'php':
        return `<?php
// Kunci lengkap (gwk_...) hanya ditampilkan sekali saat dibuat, simpan di variabel lingkungan sisi server (bukan di browser).
// session_id: Salin ID lengkap dari kartu sesi di menu Koneksi & API -> Sesi WhatsApp.
// PHP cURL
$ch = curl_init("${baseUrl}/api/v1/messages/send");
curl_setopt($ch, CURLOPT_POST, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    "session_id" => "SALIN_ID_LENGKAP_DARI_KARTU_SESI",
    "to" => "628123456789",
    "type" => "text",
    "message" => "Halo dari PHP via WhatsApp Gateway!"
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer ${activeKeyHint}",
    "Content-Type: application/json"
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
curl_close($ch);
echo $response;`;

      case 'python':
        return `# Kunci lengkap (gwk_...) hanya ditampilkan sekali saat dibuat, simpan di variabel lingkungan sisi server (bukan di browser).
# session_id: Salin ID lengkap dari kartu sesi di menu Koneksi & API -> Sesi WhatsApp.
import requests

url = "${baseUrl}/api/v1/messages/send"
headers = {
    "Authorization": "Bearer ${activeKeyHint}",
    "Content-Type": "application/json"
}
payload = {
    "session_id": "SALIN_ID_LENGKAP_DARI_KARTU_SESI",
    "to": "628123456789",
    "type": "text",
    "message": "Halo dari Python via WhatsApp Gateway!"
}

response = requests.post(url, json=payload, headers=headers)
print(response.json())`;
    }
  };

  const copySnippet = () => {
    navigator.clipboard.writeText(getCodeSnippet(snippetLang));
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  if (isLoading) return <LoadingState message="Memuat daftar API Key..." />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Manajemen API Key</h1>
          <p className="text-sm text-slate-500">
            Kunci akses REST API untuk integrasi aplikasi pihak ketiga dengan batasan hak akses (scopes).
          </p>
        </div>
        <button
          onClick={() => {
            setFormError('');
            setIsCreateModalOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 rounded-lg text-sm font-medium text-white hover:bg-emerald-700 transition shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Buat API Key Baru
        </button>
      </div>

      {/* Revoke Info Banner */}
      {revokeInfoMessage && (
        <div className="p-3.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/50 text-blue-800 dark:text-blue-300 rounded-xl text-xs flex items-center gap-2.5 animate-in fade-in duration-150">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-blue-100 dark:bg-blue-900/70 text-blue-800 dark:text-blue-300 border border-blue-300 dark:border-blue-700 shrink-0">
            Informasi
          </span>
          <span>{revokeInfoMessage}</span>
        </div>
      )}

      {/* API Keys List */}
      {activeApiKeys.length === 0 ? (
        <EmptyState
          title="Belum ada API Key aktif"
          description="Buat API Key baru untuk mengintegrasikan backend Anda dengan WhatsApp Gateway tanpa perlu login browser."
          actionText="Buat API Key"
          onAction={() => setIsCreateModalOpen(true)}
          icon={<Key className="w-8 h-8" />}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activeApiKeys.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600">
                      <Key className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-900 text-sm">{item.name}</h3>
                      <p className="text-xs text-slate-400 font-mono">
                        {item.key_prefix || 'gwk_********'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setEditingApiKey(item);
                        setEditKeyName(item.name);
                        setEditSelectedScopes([...item.scopes]);
                        setEditFormError('');
                      }}
                      className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                      title="Edit API Key"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Cabut Kunci API',
                          message: `Yakin ingin mencabut API Key "${item.name}"? Kunci akan langsung berhenti berlaku dan hilang dari daftar. Kunci yang dicabut akan dihapus permanen dalam sekitar 1 hari dan tidak dapat dipulihkan. Bila ingin akses lagi, buat kunci baru.`,
                          confirmLabel: 'Cabut Kunci API',
                          variant: 'danger',
                        });
                        if (ok) {
                          revokeMutation.mutate(item.id);
                        }
                      }}
                      disabled={revokeMutation.isPending}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                      title="Cabut Kunci (Revoke)"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 mt-3 space-y-2">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                    Hak Akses (Scopes):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {item.scopes.map((s) => (
                      <span
                        key={s}
                        className="bg-slate-100 text-slate-700 text-[10px] font-mono px-2 py-0.5 rounded-md"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Dibuat: {new Date(item.created_at).toLocaleDateString()}</span>
                {item.last_used_at && (
                  <span>Terakhir dipakai: {new Date(item.last_used_at).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TAHAP 5: Developer Quick Integration Code Playground */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-md p-6 text-white space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg border border-emerald-500/30">
              <Code2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-white text-sm">Contoh Kode Integrasi API (Quick Start)</h2>
              <p className="text-xs text-slate-400">
                Salin dan tempel ke kode backend Anda untuk mulai mengirim pesan otomatis
              </p>
            </div>
          </div>

          {/* Language Selector */}
          <div className="flex items-center gap-1.5 bg-slate-800 p-1 rounded-xl border border-slate-700 text-xs">
            {(['curl', 'node', 'php', 'python'] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setSnippetLang(lang)}
                className={`px-3 py-1 rounded-lg font-mono font-medium transition ${
                  snippetLang === lang
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {lang === 'curl' ? 'cURL' : lang === 'node' ? 'Node.js' : lang === 'php' ? 'PHP' : 'Python'}
              </button>
            ))}
          </div>
        </div>

        {/* Code Box */}
        <div className="relative group">
          <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-emerald-300 overflow-x-auto border border-slate-800/80 leading-relaxed">
            {getCodeSnippet(snippetLang)}
          </pre>

          <button
            onClick={copySnippet}
            className="absolute top-3 right-3 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-sm"
          >
            {copiedSnippet ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSnippet ? 'Tersalin!' : 'Salin Kode'}
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
          <span>Endpoint: <code className="text-emerald-400 font-mono">POST /api/v1/messages/send</code></span>
          <span>Header: <code className="text-slate-300 font-mono">Authorization: Bearer &lt;API_KEY&gt;</code></span>
        </div>
      </div>

      {/* Drawer: Buat API Key */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setIsCreateModalOpen(false)}
          />
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Buat API Key Baru</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="flex-1 flex flex-col justify-between overflow-y-auto">
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama Kunci / Label Integrasi
                  </label>
                  <input
                    type="text"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    placeholder="Misal: Laravel Backend Server, Bot Notifikasi"
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Pilih Scopes Akses (Minimal 1)
                  </label>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {VALID_API_KEY_SCOPES.map((scope) => {
                      const isChecked = selectedScopes.includes(scope);
                      return (
                        <div
                          key={scope}
                          onClick={() => handleToggleScope(scope)}
                          className={`p-3 rounded-xl border text-xs cursor-pointer transition flex items-center justify-between ${
                            isChecked
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <div>
                            <p className="font-mono font-semibold">{scope}</p>
                            <p className="text-[11px] text-slate-500">{SCOPE_DESCRIPTIONS[scope]}</p>
                          </div>
                          {isChecked && <Check className="w-4 h-4 text-emerald-600 shrink-0 ml-2" />}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {formError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Membuat...' : 'Buat Kunci Sekarang'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: Reveal-Once Plain Key */}
      {revealedKey && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setRevealedKey(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2 text-emerald-600">
                <ShieldCheck className="w-5 h-5 shrink-0" />
                <h3 className="font-bold text-slate-900 text-sm">Salin API Key Baru Anda</h3>
              </div>
              <button
                onClick={() => setRevealedKey(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-xl text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 shrink-0 mt-0.5">
                  Tampil Sekali
                </span>
                <span>
                  Demi standar keamanan tinggi, plain text API Key ini tidak disimpan di database. Salin sekarang dan simpan di <code className="font-mono font-bold">.env</code> aplikasi Anda.
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Token API Key:</label>
                <div className="p-3 bg-slate-900 rounded-xl text-emerald-400 font-mono text-xs flex items-center justify-between gap-2 break-all">
                  <span>{revealedKey}</span>
                  <button
                    onClick={copyKey}
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg shrink-0 transition"
                    title="Salin ke clipboard"
                  >
                    {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setRevealedKey(null)}
                className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition"
              >
                Saya Telah Menyimpan Kunci Ini
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer: Edit API Key */}
      {editingApiKey && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
            onClick={() => setEditingApiKey(null)}
          />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200 border-l border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 text-sm">Edit API Key</h2>
              <button
                onClick={() => setEditingApiKey(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!editKeyName.trim()) return;
                if (editSelectedScopes.length === 0) {
                  setEditFormError('Pilih minimal satu hak akses (scope)');
                  return;
                }
                setEditFormError('');
                updateMutation.mutate({
                  id: editingApiKey.id,
                  patch: { name: editKeyName.trim(), scopes: editSelectedScopes },
                });
              }}
              className="flex-1 flex flex-col justify-between overflow-y-auto"
            >
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama / Deskripsi API Key
                  </label>
                  <input
                    type="text"
                    value={editKeyName}
                    onChange={(e) => setEditKeyName(e.target.value)}
                    placeholder="mis. Backend Server Prod"
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Hak Akses Terbatas (Scopes)
                  </label>
                  <div className="space-y-2 border border-slate-200 rounded-xl p-3 bg-slate-50 max-h-60 overflow-y-auto">
                    {VALID_API_KEY_SCOPES.map((scope) => {
                      const isChecked = editSelectedScopes.includes(scope);
                      return (
                        <label
                          key={scope}
                          className="flex items-start gap-2.5 cursor-pointer text-xs p-1.5 hover:bg-white rounded-lg transition"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleEditScope(scope)}
                            className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                          />
                          <div>
                            <span className="font-mono font-semibold text-slate-900 block">
                              {scope}
                            </span>
                            <span className="text-[11px] text-slate-500 leading-tight block">
                              {SCOPE_DESCRIPTIONS[scope] || 'Akses endpoint spesifik'}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {editFormError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{editFormError}</span>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditingApiKey(null)}
                  className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Menyimpan...' : 'Simpan Perubahan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};