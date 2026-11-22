import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, tokenStore, setUnauthorizedHandler } from '../services/api';
import { AuthUser, AuthTenant, Role, TenantMembership, AuthLoginResponseData, RecoveryStatus, RegisterResult } from '../types';
import { useQueryClient } from '@tanstack/react-query';

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  tenant: AuthTenant | null;
  role: Role | null;
  memberships: TenantMembership[];
  recovery: RecoveryStatus | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, tenant_name: string) => Promise<RegisterResult>;
  logout: () => Promise<void>;
  switchTenant: (tenant_id: string) => Promise<void>;
  refetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenant, setTenant] = useState<AuthTenant | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [memberships, setMemberships] = useState<TenantMembership[]>([]);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const queryClient = useQueryClient();

  const fetchProfile = useCallback(async () => {
    try {
      const meData = await api.me();
      setUser(meData.user);
      setRole(meData.role);
      setMemberships(meData.memberships || []);
      setRecovery(meData.recovery || null);

      const currentMembership = meData.memberships.find(
        (m) => m.tenant_id === meData.active_tenant_id
      );
      if (currentMembership) {
        setTenant({
          id: currentMembership.tenant_id,
          name: currentMembership.name,
          slug: currentMembership.slug,
        });
      }
      setIsAuthenticated(true);
    } catch {
      tokenStore.clear();
      setIsAuthenticated(false);
      setUser(null);
      setTenant(null);
      setRole(null);
      setMemberships([]);
      setRecovery(null);
    }
  }, []);

  // Initial check on app startup using refresh token cookie (RULE 2.2)
  useEffect(() => {
    let isMounted = true;

    setUnauthorizedHandler(() => {
      if (isMounted) {
        setIsAuthenticated(false);
        setUser(null);
        setTenant(null);
        setRole(null);
        setMemberships([]);
        setRecovery(null);
      }
    });

    const initAuth = async () => {
      try {
        // Attempt silent refresh via HttpOnly cookie
        await api.refresh();
        if (isMounted) {
          await fetchProfile();
        }
      } catch {
        if (isMounted) {
          setIsAuthenticated(false);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    initAuth();

    return () => {
      isMounted = false;
    };
  }, [fetchProfile]);

  const login = async (email: string, password: string) => {
    const data = await api.login(email, password);
    setUser(data.user);
    setTenant(data.tenant);
    setRole(data.role);
    setIsAuthenticated(true);
    await fetchProfile();
  };

  const register = async (email: string, password: string, tenant_name: string): Promise<RegisterResult> => {
    const res = await api.register(email, password, tenant_name);
    if (res.kind === 'session') {
      setUser(res.data.user);
      setTenant(res.data.tenant);
      setRole(res.data.role);
      setIsAuthenticated(true);
      await fetchProfile();
    }
    return res;
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      queryClient.clear();
      setIsAuthenticated(false);
      setUser(null);
      setTenant(null);
      setRole(null);
      setMemberships([]);
      setRecovery(null);
    }
  };

  const switchTenant = async (tenant_id: string) => {
    const data = await api.switchTenant(tenant_id);
    // Clear entire query cache after workspace switch (RULE 2.4)
    queryClient.clear();
    setUser(data.user);
    setTenant(data.tenant);
    setRole(data.role);
    await fetchProfile();
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        tenant,
        role,
        memberships,
        recovery,
        login,
        register,
        logout,
        switchTenant,
        refetchUser: fetchProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
