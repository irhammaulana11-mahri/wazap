import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { ThemeProvider } from './context/ThemeContext';
import { MainLayout } from './components/layout/MainLayout';

import { DashboardPage } from './pages/DashboardPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { SessionsPage } from './pages/SessionsPage';
import { MessagesPage } from './pages/MessagesPage';
import { WebhooksPage } from './pages/WebhooksPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { ContactsPage } from './pages/ContactsPage';
import { ChatsPage } from './pages/ChatsPage';
import { UsagePage } from './pages/UsagePage';
import { TeamPage } from './pages/TeamPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { ProfilePage } from './pages/ProfilePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { InviteAcceptPage } from './pages/InviteAcceptPage';
import { JoinPage } from './pages/JoinPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { RestoreWorkspacePage } from './pages/RestoreWorkspacePage';

// Platform Admin Modules (ADR-054)
import { platformSession } from './services/platformApi';
import { PlatformLayout } from './components/platform/PlatformLayout';
import { PlatformLoginPage } from './pages/platform/PlatformLoginPage';
import { PlatformWorkspacesPage } from './pages/platform/PlatformWorkspacesPage';
import { PlatformWorkspaceDetailPage } from './pages/platform/PlatformWorkspaceDetailPage';
import { PlatformDefaultsPage } from './pages/platform/PlatformDefaultsPage';
import { PlatformAuditPage } from './pages/platform/PlatformAuditPage';
import { PlatformBackupPage } from './pages/platform/PlatformBackupPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 3000,
    },
  },
});

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 text-slate-500 text-sm">
        Memverifikasi sesi gateway...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const PlatformProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isPlatformAuth = !!platformSession.get();

  if (!isPlatformAuth) {
    return <Navigate to="/platform/login" replace />;
  }

  return <>{children}</>;
};

const AppRoutes: React.FC = () => {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      {/* Public routes */}
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage />}
      />
      <Route path="/invite" element={<InviteAcceptPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/restore-workspace" element={<RestoreWorkspacePage />} />

      {/* Platform Admin Routes */}
      <Route path="/platform/login" element={<PlatformLoginPage />} />
      <Route
        path="/platform"
        element={
          <PlatformProtectedRoute>
            <PlatformLayout />
          </PlatformProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/platform/workspaces" replace />} />
        <Route path="workspaces" element={<PlatformWorkspacesPage />} />
        <Route path="workspaces/:id" element={<PlatformWorkspaceDetailPage />} />
        <Route path="defaults" element={<PlatformDefaultsPage />} />
        <Route path="audit" element={<PlatformAuditPage />} />
        <Route path="backup" element={<PlatformBackupPage />} />
      </Route>

      {/* Protected customer routes */}
      <Route
        element={
          <ProtectedRoute>
            <SocketProvider>
              <MainLayout />
            </SocketProvider>
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/sessions" element={<Navigate to="/connections?tab=sessions" replace />} />
        <Route path="/api-keys" element={<Navigate to="/connections?tab=apikeys" replace />} />
        <Route path="/webhooks" element={<Navigate to="/connections?tab=webhooks" replace />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/messages" element={<Navigate to="/chats" replace />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/audit-logs" element={<AuditLogsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ConfirmProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
