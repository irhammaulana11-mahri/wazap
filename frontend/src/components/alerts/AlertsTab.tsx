import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BellOff } from 'lucide-react';
import { api } from '../../services/api';
import { LoadingState } from '../ui/LoadingState';
import { ErrorState } from '../ui/ErrorState';
import { AlertChannelsSection } from './AlertChannelsSection';
import { AlertRulesSection } from './AlertRulesSection';
import { AlertDeliveriesSection } from './AlertDeliveriesSection';

export const AlertsTab: React.FC = () => {
  const queryClient = useQueryClient();

  // 1. Fetch Catalog (Source of truth for rules, bounds, feature status)
  const {
    data: catalog,
    isLoading: isLoadingCatalog,
    isError: isCatalogError,
    error: catalogError,
    refetch: refetchCatalog,
  } = useQuery({
    queryKey: ['alert-catalog'],
    queryFn: () => api.getAlertCatalog(),
    staleTime: 60_000,
  });

  // 2. Fetch Channels
  const {
    data: channels = [],
    isLoading: isLoadingChannels,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: ['alert-channels'],
    queryFn: () => api.listAlertChannels(),
    staleTime: 30_000,
  });

  // 3. Fetch Rules Configuration
  const {
    data: rules = [],
    isLoading: isLoadingRules,
    refetch: refetchRules,
  } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.listAlertRules(),
    staleTime: 30_000,
  });

  // 4. Fetch Deliveries History (limit 50)
  const {
    data: deliveries = [],
    isLoading: isLoadingDeliveries,
    refetch: refetchDeliveries,
  } = useQuery({
    queryKey: ['alert-deliveries'],
    queryFn: () => api.listAlertDeliveries(50),
    staleTime: 15_000,
  });

  // If catalog is in error state: NO fallbacks allowed!
  if (isCatalogError) {
    return (
      <ErrorState
        message={
          (catalogError as Error)?.message ||
          'Gagal memuat katalog aturan notifikasi dari server. Pastikan layanan backend aktif.'
        }
        onRetry={() => refetchCatalog()}
      />
    );
  }

  // Initial loading state while waiting for catalog
  if (isLoadingCatalog) {
    return <LoadingState message="Memuat konfigurasi alarm dan katalog notifikasi..." />;
  }

  const isOperatorDisabled = catalog?.enabled === false;

  const handleRefreshAll = () => {
    refetchCatalog();
    refetchChannels();
    refetchRules();
    refetchDeliveries();
  };

  return (
    <div className="space-y-6">
      {/* Operator Disabled Banner */}
      {isOperatorDisabled && (
        <div
          role="alert"
          className="p-4 bg-amber-50 border border-amber-200 rounded-3xl flex items-start gap-3 text-amber-900 shadow-xs"
        >
          <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
            <BellOff className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-amber-900">
              Notifikasi Dinonaktifkan Sementara oleh Operator
            </h3>
            <p className="text-xs text-amber-800 leading-relaxed">
              Operator sistem sedang menonaktifkan pengiriman alarm secara global. Anda tetap dapat meninjau riwayat dan konfigurasi yang ada, namun penambahan kanal dan perubahan aturan tidak dapat disimpan saat ini.
            </p>
          </div>
        </div>
      )}

      {/* 1. Channels Section */}
      <AlertChannelsSection
        catalog={catalog}
        channels={channels}
        isLoading={isLoadingChannels}
        disabled={isOperatorDisabled}
        onRefresh={() => {
          refetchChannels();
          refetchRules();
        }}
      />

      {/* 2. Rules Section */}
      <AlertRulesSection
        catalog={catalog}
        rules={rules}
        channels={channels}
        isLoading={isLoadingRules}
        disabled={isOperatorDisabled}
        onRefresh={() => {
          refetchRules();
        }}
      />

      {/* 3. Deliveries Section */}
      <AlertDeliveriesSection
        catalog={catalog}
        deliveries={deliveries}
        isLoading={isLoadingDeliveries}
        onRefresh={() => {
          refetchDeliveries();
        }}
      />
    </div>
  );
};
