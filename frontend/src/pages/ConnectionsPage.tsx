import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Smartphone, Key, Webhook, ShieldAlert } from 'lucide-react';
import { SessionsPage } from './SessionsPage';
import { ApiKeysPage } from './ApiKeysPage';
import { WebhooksPage } from './WebhooksPage';
import { useAuth } from '../context/AuthContext';

type TabType = 'sessions' | 'apikeys' | 'webhooks';

export const ConnectionsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { role } = useAuth();
  const isOwner = role === 'OWNER';

  // Read active tab from URL query params (default: 'sessions')
  const initialTab = (searchParams.get('tab') as TabType) || 'sessions';
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  useEffect(() => {
    const tabParam = searchParams.get('tab') as TabType;
    if (tabParam && ['sessions', 'apikeys', 'webhooks'].includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [searchParams]);

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  return (
    <div className="space-y-6">
      {/* Page Title & Navigation Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Koneksi & Integrasi Gateway
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Kelola sesi perangkat WhatsApp fisik, kunci akses REST API, dan endpoint Webhook event dalam satu tempat terpadu.
          </p>
        </div>

        {/* Tab Buttons */}
        <div className="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200 shadow-inner">
          <button
            onClick={() => handleTabChange('sessions')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === 'sessions'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Smartphone className="w-4 h-4 text-emerald-600" />
            <span>Perangkat WhatsApp</span>
          </button>

          <button
            onClick={() => handleTabChange('apikeys')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === 'apikeys'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Key className="w-4 h-4 text-blue-600" />
            <span>Kunci API (REST)</span>
          </button>

          {isOwner && (
            <button
              onClick={() => handleTabChange('webhooks')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
                activeTab === 'webhooks'
                  ? 'bg-white text-emerald-700 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Webhook className="w-4 h-4 text-purple-600" />
              <span>Webhooks</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab Content Display */}
      <div className="pt-1">
        {activeTab === 'sessions' && <SessionsPage />}
        {activeTab === 'apikeys' && <ApiKeysPage />}
        {activeTab === 'webhooks' && <WebhooksPage />}
      </div>
    </div>
  );
};