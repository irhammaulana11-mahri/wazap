import { ApiError } from './api';

let memoryToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export const platformSession = {
  get: (): string | null => memoryToken,
  set: (token: string): void => {
    memoryToken = token;
  },
  clear: (): void => {
    memoryToken = null;
  },
};

export const setPlatformUnauthorizedHandler = (handler: () => void): void => {
  unauthorizedHandler = handler;
};

export interface PlatformAdminUser {
  user_id: string;
  email: string;
}

export interface PlatformLoginResult {
  mfa_token: string;
  expires_in: number;
}

export interface PlatformVerifyResult {
  access_token: string;
  expires_in: number;
  admin: PlatformAdminUser;
  recovery_remaining: number;
}

export interface PlatformMeResult {
  userId: string;
  email: string;
}

export interface PlatformWorkspaceLimits {
  max_sessions: number;
  max_api_keys: number;
  max_members: number;
  messages_per_minute: number;
}

export interface PlatformWorkspaceUsed {
  sessions: number;
  sessions_connected: number;
  api_keys: number;
  members: number;
}

export interface PlatformWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'REJECTED' | string;
  created_at: string;
  suspended_at: string | null;
  decided_at: string | null;
  limits: PlatformWorkspaceLimits;
  used: PlatformWorkspaceUsed;
  owners: string[];
}

export interface PlatformWorkspaceDetail extends PlatformWorkspaceSummary {
  members_by_role: Record<string, number>;
  pending_invitations: number;
  owner_accounts: { user_id: string; email: string | null; status: string }[];
  quota_used: { sessions: number; api_keys: number; members: number };
  minimums: PlatformWorkspaceLimits;
  ceilings: PlatformWorkspaceLimits;
  history: Array<{
    id: string;
    admin_email: string;
    action: string;
    details: any;
    reason: string | null;
    created_at: string;
  }>;
}

export interface PlatformDefaultsResult {
  limits: PlatformWorkspaceLimits;
  minimums: PlatformWorkspaceLimits;
  ceilings: PlatformWorkspaceLimits;
  updated_at: string;
}

export interface PlatformAuditItem {
  id: string;
  admin_email: string;
  action: string;
  tenant_id: string | null;
  details: any;
  reason: string | null;
  ip: string | null;
  request_id: string | null;
  created_at: string;
}

export interface PlatformBackupStatusResult {
  configured: boolean;
  available: boolean;
  status: {
    updated_at: string;
    last_success_at: string | null;
    last_failure_at?: string | null;
    last_failure_reason?: string | null;
    last_file?: string | null;
    last_size_bytes?: number | null;
    location: 'offsite' | 'separate_disk' | 'same_disk';
    offsite_ok_at?: string | null;
  } | null;
  age_hours: number | null;
  stale: boolean | null;
  max_age_hours: number;
  reason: string | null;
}

export interface ListWorkspacesParams {
  q?: string;
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'REJECTED' | 'ALL' | string;
  page?: number;
  page_size?: number;
}

export interface ListAuditParams {
  tenant_id?: string;
  action?: string;
  page?: number;
  page_size?: number;
}

export interface PatchQuotasPayload {
  max_sessions?: number;
  max_api_keys?: number;
  max_members?: number;
  messages_per_minute?: number;
  reason: string;
  otp: string;
}

export interface SuspendActivatePayload {
  reason: string;
  otp: string;
}

export interface ApproveWorkspacePayload {
  otp: string;
  reason?: string;
}

export interface RejectWorkspacePayload {
  otp: string;
  reason: string;
}

async function requestPlatform<T>(
  endpoint: string,
  options: {
    method?: string;
    body?: any;
    skipAuth?: boolean;
  } = {}
): Promise<{ data: T; meta?: any }> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (!options.skipAuth) {
    const token = platformSession.get();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (err: any) {
    throw new ApiError(
      0,
      'NETWORK_OR_ACCESS',
      err?.message || 'Koneksi jaringan terputus atau gerbang akses tidak dapat dihubungi.'
    );
  }

  if (response.status === 401 && !options.skipAuth) {
    platformSession.clear();
    if (unauthorizedHandler) {
      unauthorizedHandler();
    }
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'NETWORK_OR_ACCESS',
      'Respons server bukan format JSON yang valid.'
    );
  }

  if (!response.ok) {
    const errObj = json?.error || {};
    const apiError = new ApiError(
      response.status,
      errObj.code || 'UNKNOWN_ERROR',
      errObj.message || 'Terjadi kesalahan pada konsol platform.',
      errObj.details || [],
      json?.request_id
    );
    if (response.status === 429) {
      const retryHeader = response.headers.get('retry-after');
      if (retryHeader) {
        apiError.retryAfterSec = Number(retryHeader) || undefined;
      }
    }
    throw apiError;
  }

  return json;
}

export const platformApi = {
  login: async (email: string, password: string): Promise<PlatformLoginResult> => {
    const res = await requestPlatform<PlatformLoginResult>('/api/v1/platform/auth/login', {
      method: 'POST',
      body: { email, password },
      skipAuth: true,
    });
    return res.data;
  },

  verify: async (mfa_token: string, code: string): Promise<PlatformVerifyResult> => {
    const res = await requestPlatform<PlatformVerifyResult>('/api/v1/platform/auth/verify', {
      method: 'POST',
      body: { mfa_token, code },
      skipAuth: true,
    });
    if (res.data?.access_token) {
      platformSession.set(res.data.access_token);
    }
    return res.data;
  },

  me: async (): Promise<PlatformMeResult> => {
    const res = await requestPlatform<PlatformMeResult>('/api/v1/platform/me');
    return res.data;
  },

  listWorkspaces: async (
    params?: ListWorkspacesParams
  ): Promise<{ items: PlatformWorkspaceSummary[]; meta?: any }> => {
    const qs = new URLSearchParams();
    if (params) {
      if (params.q !== undefined && params.q !== null && params.q !== '') {
        qs.set('q', params.q);
      }
      if (params.status !== undefined && params.status !== null) {
        qs.set('status', params.status);
      }
      if (params.page !== undefined && params.page !== null) {
        qs.set('page', String(params.page));
      }
      if (params.page_size !== undefined && params.page_size !== null) {
        qs.set('page_size', String(params.page_size));
      }
    }
    const qStr = qs.toString();
    const endpoint = `/api/v1/platform/workspaces${qStr ? `?${qStr}` : ''}`;
    const res = await requestPlatform<PlatformWorkspaceSummary[]>(endpoint);
    return {
      items: res.data || [],
      meta: res.meta,
    };
  },

  getWorkspace: async (id: string): Promise<PlatformWorkspaceDetail> => {
    const res = await requestPlatform<PlatformWorkspaceDetail>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}`,
      { method: 'GET' }
    );
    return res.data;
  },

  updateQuotas: async (
    id: string,
    payload: PatchQuotasPayload
  ): Promise<any> => {
    const cleanBody: Record<string, any> = {
      reason: payload.reason,
      otp: payload.otp,
    };
    if (payload.max_sessions !== undefined) cleanBody.max_sessions = payload.max_sessions;
    if (payload.max_api_keys !== undefined) cleanBody.max_api_keys = payload.max_api_keys;
    if (payload.max_members !== undefined) cleanBody.max_members = payload.max_members;
    if (payload.messages_per_minute !== undefined) cleanBody.messages_per_minute = payload.messages_per_minute;

    const res = await requestPlatform<any>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}/quotas`,
      {
        method: 'PATCH',
        body: cleanBody,
      }
    );
    return res.data;
  },

  suspend: async (id: string, payload: SuspendActivatePayload): Promise<any> => {
    const cleanBody = {
      reason: payload.reason,
      otp: payload.otp,
    };
    const res = await requestPlatform<any>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}/suspend`,
      {
        method: 'POST',
        body: cleanBody,
      }
    );
    return res.data;
  },

  activate: async (id: string, payload: SuspendActivatePayload): Promise<any> => {
    const cleanBody = {
      reason: payload.reason,
      otp: payload.otp,
    };
    const res = await requestPlatform<any>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}/activate`,
      {
        method: 'POST',
        body: cleanBody,
      }
    );
    return res.data;
  },

  approve: async (id: string, payload: ApproveWorkspacePayload): Promise<any> => {
    const cleanBody: Record<string, any> = {
      otp: payload.otp,
    };
    if (payload.reason && payload.reason.trim()) {
      cleanBody.reason = payload.reason.trim();
    }
    const res = await requestPlatform<any>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: cleanBody,
      }
    );
    return res.data;
  },

  reject: async (id: string, payload: RejectWorkspacePayload): Promise<any> => {
    const cleanBody: Record<string, any> = {
      otp: payload.otp,
      reason: payload.reason.trim(),
    };
    const res = await requestPlatform<any>(
      `/api/v1/platform/workspaces/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: cleanBody,
      }
    );
    return res.data;
  },

  getDefaults: async (): Promise<PlatformDefaultsResult> => {
    const res = await requestPlatform<PlatformDefaultsResult>('/api/v1/platform/defaults');
    return res.data;
  },

  updateDefaults: async (payload: PatchQuotasPayload): Promise<PlatformDefaultsResult> => {
    const cleanBody: Record<string, any> = {
      reason: payload.reason,
      otp: payload.otp,
    };
    if (payload.max_sessions !== undefined) cleanBody.max_sessions = payload.max_sessions;
    if (payload.max_api_keys !== undefined) cleanBody.max_api_keys = payload.max_api_keys;
    if (payload.max_members !== undefined) cleanBody.max_members = payload.max_members;
    if (payload.messages_per_minute !== undefined) cleanBody.messages_per_minute = payload.messages_per_minute;

    const res = await requestPlatform<PlatformDefaultsResult>('/api/v1/platform/defaults', {
      method: 'PATCH',
      body: cleanBody,
    });
    return res.data;
  },

  listAudit: async (
    params?: ListAuditParams
  ): Promise<{ items: PlatformAuditItem[]; meta?: any }> => {
    const qs = new URLSearchParams();
    if (params) {
      if (params.tenant_id !== undefined && params.tenant_id !== null && params.tenant_id !== '') {
        qs.set('tenant_id', params.tenant_id);
      }
      if (params.action !== undefined && params.action !== null && params.action !== '') {
        qs.set('action', params.action);
      }
      if (params.page !== undefined && params.page !== null) {
        qs.set('page', String(params.page));
      }
      if (params.page_size !== undefined && params.page_size !== null) {
        qs.set('page_size', String(params.page_size));
      }
    }
    const qStr = qs.toString();
    const endpoint = `/api/v1/platform/audit${qStr ? `?${qStr}` : ''}`;
    const res = await requestPlatform<PlatformAuditItem[]>(endpoint);
    return {
      items: res.data || [],
      meta: res.meta,
    };
  },

  backupStatus: async (): Promise<PlatformBackupStatusResult> => {
    const res = await requestPlatform<PlatformBackupStatusResult>('/api/v1/platform/backup-status');
    return res.data;
  },
};
