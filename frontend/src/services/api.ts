import {
  ApiResponse,
  ApiErrorPayload,
  AuthLoginResponseData,
  RegisterResult,
  AuthMeResponseData,
  AuthJoinRequestResponseData,
  ResetPasswordResponseData,
  RecoveryCodeResponseData,
  TeamJoinCodeResponseData,
  TeamJoinRequestItem,
  TenantRenameResponseData,
  TenantDeleteResponseData,
  DeletedWorkspaceItem,
  RestoreWorkspaceResponseData,
  WhatsAppSession,
  SessionStatusResponse,
  SessionQrResponse,
  MessageItem,
  ChatItem,
  ChatMessageItem,
  ContactItem,
  WebhookItem,
  ApiKeyItem,
  ApiKeyScope,
  TeamMemberItem,
  TeamInvitationItem,
  UsageSummaryData,
  UsageMessageBucket,
  UsageSessionStat,
  TenantSettingsData,
  AuditLogItem,
  Role,
  ExportType,
  ExportPolicyData,
  ExportRequestBody,
  AlertCatalogData,
  AlertChannelItem,
  CreateAlertChannelBody,
  UpdateAlertChannelBody,
  AlertTestResult,
  AlertRuleItem,
  PutAlertRuleBody,
  AlertDeliveryItem,
} from '../types';

// RULE 2.2: Access token disimpan DI MEMORI (variabel modul), BUKAN localStorage/sessionStorage
let inMemoryAccessToken: string | null = null;

export const tokenStore = {
  get: (): string | null => inMemoryAccessToken,
  set: (token: string | null): void => {
    inMemoryAccessToken = token;
  },
  clear: (): void => {
    inMemoryAccessToken = null;
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[] | any,
    public requestId?: string,
    public retryAfterSec?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorizedCallback: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorizedCallback = fn;
}

// Single-flight refresh token lock (RULE 2.3)
let refreshPromise: Promise<string | null> | null = null;

async function executeRefresh(): Promise<string | null> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      tokenStore.clear();
      return null;
    }

    const json = (await res.json()) as ApiResponse<AuthLoginResponseData>;
    if (json.success && json.data.access_token) {
      tokenStore.set(json.data.access_token);
      return json.data.access_token;
    }
    tokenStore.clear();
    return null;
  } catch {
    tokenStore.clear();
    return null;
  }
}

async function request<T>(
  path: string,
  options?: RequestInit,
  isRetry = false,
  retryCount503 = 0
): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(options?.headers || {});

  if (!headers.has('Content-Type') && !(options?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Auth endpoints always need cookie credentials
  const credentials = path.startsWith('/api/v1/auth/') ? 'include' : options?.credentials || 'same-origin';

  const response = await fetch(path, {
    ...options,
    headers,
    credentials,
  });

  // Handle 401: single-flight refresh token (kecuali untuk auth endpoint itu sendiri)
  if (response.status === 401 && !path.startsWith('/api/v1/auth/')) {
    if (!isRetry) {
      if (!refreshPromise) {
        refreshPromise = executeRefresh().finally(() => {
          refreshPromise = null;
        });
      }

      const newToken = await refreshPromise;
      if (newToken) {
        // Ulangi permintaan asli satu kali dengan token baru
        return request<T>(path, options, true, retryCount503);
      }
    }

    // Refresh gagal atau retry tetap 401
    tokenStore.clear();
    if (onUnauthorizedCallback) {
      onUnauthorizedCallback();
    }
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sesi telah berakhir. Silakan login kembali.');
  }

  // Handle 503 SERVICE_UNAVAILABLE (ADR-038): auto-retry dengan backoff (maks 3x) untuk GET atau POST pesan idempotence
  if (response.status === 503) {
    const method = (options?.method || 'GET').toUpperCase();
    const isIdempotentOrGet =
      method === 'GET' ||
      (method === 'POST' && path.includes('/messages/send') && headers.has('Idempotency-Key'));

    if (isIdempotentOrGet && retryCount503 < 3) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retrySeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
      const baseDelay = isNaN(retrySeconds) ? 2000 : retrySeconds * 1000;
      const delayMs = Math.min(baseDelay * Math.pow(2, retryCount503), 8000);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return request<T>(path, options, isRetry, retryCount503 + 1);
    }
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null as unknown as T;
  }

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json().catch(() => ({})) : null;

  if (!response.ok) {
    const errorPayload: ApiErrorPayload = body?.error || {
      code: response.status === 503 ? 'SERVICE_UNAVAILABLE' : 'API_ERROR',
      message: response.status === 503 ? 'Layanan database sedang sibuk. Silakan coba kembali.' : `HTTP ${response.status}`,
    };

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

    throw new ApiError(
      response.status,
      errorPayload.code,
      errorPayload.message,
      errorPayload.details,
      body?.request_id,
      !isNaN(retryAfterSec as number) ? retryAfterSec : undefined
    );
  }

  return body as T;
}

export const api = {
  // ==========================================
  // AUTH
  // ==========================================
  register: async (email: string, password: string, tenant_name: string): Promise<RegisterResult> => {
    // STRICT CONTRACT: body { email, password, tenant_name }
    const res = await request<ApiResponse<any>>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, tenant_name }),
    });
    if (res.data?.status === 'PENDING_APPROVAL') {
      return { kind: 'pending', data: res.data };
    }
    if (res.data?.access_token) {
      tokenStore.set(res.data.access_token);
      return { kind: 'session', data: res.data };
    }
    return { kind: 'session', data: res.data };
  },

  login: async (email: string, password: string, tenant_id?: string) => {
    const res = await request<ApiResponse<AuthLoginResponseData>>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(tenant_id ? { tenant_id } : {}) }),
    });
    tokenStore.set(res.data.access_token);
    return res.data;
  },

  refresh: async () => {
    const res = await request<ApiResponse<AuthLoginResponseData>>('/api/v1/auth/refresh', {
      method: 'POST',
    });
    tokenStore.set(res.data.access_token);
    return res.data;
  },

  logout: async () => {
    try {
      await request('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      tokenStore.clear();
    }
  },

  me: async () => {
    const res = await request<ApiResponse<AuthMeResponseData>>('/api/v1/auth/me');
    return res.data;
  },

  switchTenant: async (tenant_id: string) => {
    const res = await request<ApiResponse<AuthLoginResponseData>>('/api/v1/auth/switch-tenant', {
      method: 'POST',
      body: JSON.stringify({ tenant_id }),
    });
    tokenStore.set(res.data.access_token);
    return res.data;
  },

  joinRequest: async (join_code: string, email: string, password: string) => {
    const res = await request<ApiResponse<AuthJoinRequestResponseData>>('/api/v1/auth/join-requests', {
      method: 'POST',
      body: JSON.stringify({ join_code, email, password }),
    });
    return res.data;
  },

  resetPassword: async (email: string, recovery_code: string, new_password: string) => {
    const res = await request<ApiResponse<ResetPasswordResponseData>>('/api/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, recovery_code, new_password }),
    });
    return res.data;
  },

  changePassword: async (current_password: string, new_password: string) => {
    const res = await request<ApiResponse<AuthLoginResponseData>>('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    });
    tokenStore.set(res.data.access_token);
    return res.data;
  },

  changeEmail: async (password: string, new_email: string) => {
    const res = await request<ApiResponse<{ user: { id: string; email: string } }>>('/api/v1/auth/change-email', {
      method: 'POST',
      body: JSON.stringify({ password, new_email }),
    });
    return res.data;
  },

  issueRecoveryCodes: async (password: string) => {
    const res = await request<ApiResponse<RecoveryCodeResponseData>>('/api/v1/auth/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return res.data;
  },

  confirmRecoveryCodes: async () => {
    const res = await request<ApiResponse<{ confirmed: boolean }>>('/api/v1/auth/recovery-codes/confirm', {
      method: 'POST',
    });
    return res.data;
  },

  issueRecoveryCode: async (password: string) => {
    const res = await request<ApiResponse<RecoveryCodeResponseData>>('/api/v1/auth/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return res.data;
  },

  logoutAll: async () => {
    try {
      await request('/api/v1/auth/logout-all', { method: 'POST' });
    } finally {
      tokenStore.clear();
    }
  },

  health: async () => {
    // Response: { status: "READY", checks: { database: "UP", shutting_down: false }, timestamp: "..." }
    return request<{ status: string; checks?: { database: string }; timestamp: string }>('/health');
  },

  // ==========================================
  // SESSIONS
  // ==========================================
  getSessions: async (status?: any) => {
    const query = typeof status === 'string' ? `?status=${encodeURIComponent(status)}` : '';
    const res = await request<ApiResponse<WhatsAppSession[]>>(`/api/v1/sessions${query}`);
    return res.data;
  },

  createSession: async (session_name: string, auto_connect = true) => {
    const res = await request<ApiResponse<WhatsAppSession>>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ session_name, auto_connect }),
    });
    return res.data;
  },

  getSession: async (sessionId: string) => {
    const res = await request<ApiResponse<WhatsAppSession>>(`/api/v1/sessions/${sessionId}`);
    return res.data;
  },

  getSessionStatus: async (sessionId: string) => {
    const res = await request<ApiResponse<SessionStatusResponse>>(`/api/v1/sessions/${sessionId}/status`);
    return res.data;
  },

  getSessionQr: async (sessionId: string) => {
    const res = await request<ApiResponse<SessionQrResponse>>(`/api/v1/sessions/${sessionId}/qr`);
    return res.data;
  },

  connectSession: async (sessionId: string) => {
    return request<ApiResponse<{ session_id: string; status: string }>>(`/api/v1/sessions/${sessionId}/connect`, {
      method: 'POST',
    });
  },

  disconnectSession: async (sessionId: string) => {
    return request<ApiResponse<{ session_id: string; status: string }>>(`/api/v1/sessions/${sessionId}/disconnect`, {
      method: 'POST',
    });
  },

  reconnectSession: async (sessionId: string) => {
    return request<ApiResponse<{ session_id: string; status: string }>>(`/api/v1/sessions/${sessionId}/reconnect`, {
      method: 'POST',
    });
  },

  deleteSession: async (sessionId: string) => {
    return request<ApiResponse<{ session_id: string }>>(`/api/v1/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  },

  renameSession: async (sessionId: string, session_name: string) => {
    const res = await request<ApiResponse<WhatsAppSession>>(`/api/v1/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ session_name }),
    });
    return res.data;
  },

  // ==========================================
  // MESSAGES
  // ==========================================
  sendMessage: async (session_id: string, to: string, message: string) => {
    // Generate unique Idempotency-Key
    const idempotencyKey = crypto.randomUUID();

    const res = await request<ApiResponse<{ job_id: string; status: string }>>(
      '/api/v1/messages/send',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          session_id,
          to,
          type: 'text',
          message,
        }),
      }
    );
    return res.data;
  },

  getMessages: async (params?: {
    page?: number;
    page_size?: number;
    status?: string;
    session_id?: string;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.page_size) q.set('page_size', String(params.page_size));
    if (params?.status) q.set('status', params.status);
    if (params?.session_id) q.set('session_id', params.session_id);
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);

    const queryStr = q.toString() ? `?${q.toString()}` : '';
    const res = await request<ApiResponse<MessageItem[]>>(`/api/v1/messages${queryStr}`);
    return { data: res.data, meta: res.meta };
  },

  cancelMessage: async (messageId: string) => {
    return request<ApiResponse<{ message_id: string; status: string }>>(
      `/api/v1/messages/${messageId}/cancel`,
      { method: 'POST' }
    );
  },

  retryMessage: async (messageId: string, confirmDuplicateRisk = false) => {
    const body = confirmDuplicateRisk ? JSON.stringify({ confirm_duplicate_risk: true }) : undefined;
    return request<ApiResponse<{ message_id: string; status: string }>>(
      `/api/v1/messages/${messageId}/retry`,
      {
        method: 'POST',
        body,
      }
    );
  },

  // ==========================================
  // CHATS & CONTACTS
  // ==========================================
  getChats: async (session_id?: string, page = 1, page_size = 20) => {
    const q = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (session_id) q.set('session_id', session_id);
    const res = await request<ApiResponse<ChatItem[]>>(`/api/v1/chats?${q.toString()}`);
    return { data: res.data, meta: res.meta };
  },

  getChatMessages: async (chatId: string, page = 1, page_size = 20) => {
    const q = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    const res = await request<ApiResponse<ChatMessageItem[]>>(`/api/v1/chats/${chatId}/messages?${q.toString()}`);
    return { data: res.data, meta: res.meta };
  },

  getContacts: async (page = 1, page_size = 20) => {
    const q = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    const res = await request<ApiResponse<ContactItem[]>>(`/api/v1/contacts?${q.toString()}`);
    return { data: res.data, meta: res.meta };
  },

  // ==========================================
  // WEBHOOKS
  // ==========================================
  getWebhooks: async () => {
    const res = await request<ApiResponse<WebhookItem[]>>('/api/v1/webhooks');
    return res.data;
  },

  createWebhook: async (url: string, events: string[], description?: string) => {
    // STRICT CONTRACT: do NOT send secret parameter!
    const res = await request<ApiResponse<WebhookItem>>('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url,
        events,
        ...(description ? { description } : {}),
      }),
    });
    return res.data;
  },

  updateWebhook: async (id: string, patch: { url?: string; description?: string; events?: string[]; active?: boolean }) => {
    const res = await request<ApiResponse<WebhookItem>>(`/api/v1/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return res.data;
  },

  deleteWebhook: async (id: string) => {
    return request<void>(`/api/v1/webhooks/${id}`, {
      method: 'DELETE',
    });
  },

  testWebhook: async (id: string) => {
    return request<ApiResponse<{ status: string }>>(`/api/v1/webhooks/${id}/test`, {
      method: 'POST',
    });
  },

  rotateWebhookSecret: async (id: string) => {
    const res = await request<ApiResponse<{ secret: string }>>(`/api/v1/webhooks/${id}/rotate-secret`, {
      method: 'POST',
    });
    return res.data;
  },

  // ==========================================
  // API KEYS
  // ==========================================
  getApiKeys: async () => {
    let page = 1;
    const pageSize = 100;
    const allKeys: ApiKeyItem[] = [];

    while (true) {
      const res = await request<ApiResponse<ApiKeyItem[]> & { meta?: { page: number; page_size: number; total: number } }>(
        `/api/v1/api-keys?page=${page}&page_size=${pageSize}`
      );
      if (Array.isArray(res.data)) {
        allKeys.push(...res.data);
      }
      const total = res.meta?.total ?? allKeys.length;
      if (allKeys.length >= total || !res.data || res.data.length === 0) {
        break;
      }
      page++;
    }

    return allKeys;
  },

  createApiKey: async (name: string, scopes: ApiKeyScope[], expires_at?: string) => {
    const res = await request<ApiResponse<ApiKeyItem>>('/api/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        scopes,
        ...(expires_at ? { expires_at } : {}),
      }),
    });
    return res.data;
  },

  revokeApiKey: async (id: string) => {
    return request<void>(`/api/v1/api-keys/${id}`, {
      method: 'DELETE',
    });
  },

  updateApiKey: async (id: string, patch: { name?: string; scopes?: ApiKeyScope[] }) => {
    const res = await request<ApiResponse<ApiKeyItem>>(`/api/v1/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return res.data;
  },

  // ==========================================
  // TEAM (MEMBERS & INVITATIONS)
  // ==========================================
  getTeamMembers: async (page = 1, page_size = 20) => {
    const res = await request<ApiResponse<TeamMemberItem[]>>(
      `/api/v1/team/members?page=${page}&page_size=${page_size}`
    );
    return { data: res.data, meta: res.meta };
  },

  updateTeamMember: async (userId: string, patch: { role?: Role; status?: 'ACTIVE' | 'SUSPENDED' }) => {
    const res = await request<ApiResponse<TeamMemberItem>>(`/api/v1/team/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return res.data;
  },

  removeTeamMember: async (userId: string) => {
    return request<ApiResponse<{ user_id: string; removed: boolean }>>(`/api/v1/team/members/${userId}`, {
      method: 'DELETE',
    });
  },

  getInvitations: async (status?: string) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await request<ApiResponse<TeamInvitationItem[]>>(`/api/v1/team/invitations${query}`);
    return res.data;
  },

  createInvitation: async (email: string, role: Role = 'MEMBER') => {
    const res = await request<ApiResponse<TeamInvitationItem>>('/api/v1/team/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    return res.data;
  },

  reissueInvitation: async (id: string) => {
    const res = await request<ApiResponse<TeamInvitationItem>>(`/api/v1/team/invitations/${id}/reissue`, {
      method: 'POST',
    });
    return res.data;
  },

  revokeInvitation: async (id: string) => {
    return request<void>(`/api/v1/team/invitations/${id}`, {
      method: 'DELETE',
    });
  },

  acceptInvitation: async (token: string) => {
    const res = await request<ApiResponse<{ tenant: { id: string; name: string; slug: string }; role: Role }>>(
      '/api/v1/team/invitations/accept',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      }
    );
    return res.data;
  },

  // Team Join Code & Join Requests (Fase H3 / ADR-036)
  getJoinCode: async () => {
    const res = await request<ApiResponse<TeamJoinCodeResponseData>>('/api/v1/team/join-code');
    return res.data;
  },

  rotateJoinCode: async () => {
    const res = await request<ApiResponse<TeamJoinCodeResponseData>>('/api/v1/team/join-code', {
      method: 'PUT',
    });
    return res.data;
  },

  disableJoinCode: async () => {
    const res = await request<ApiResponse<{ enabled: boolean }>>('/api/v1/team/join-code', {
      method: 'DELETE',
    });
    return res.data;
  },

  getJoinRequests: async (params?: { page?: number; page_size?: number; status?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.page_size) q.set('page_size', String(params.page_size));
    if (params?.status) q.set('status', params.status);
    const queryStr = q.toString() ? `?${q.toString()}` : '';
    const res = await request<ApiResponse<TeamJoinRequestItem[]>>(`/api/v1/team/join-requests${queryStr}`);
    return { data: res.data, meta: res.meta };
  },

  approveJoinRequest: async (requestId: string, role: Role = 'MEMBER') => {
    const res = await request<ApiResponse<TeamJoinRequestItem>>(`/api/v1/team/join-requests/${requestId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    return res.data;
  },

  rejectJoinRequest: async (requestId: string) => {
    const res = await request<ApiResponse<TeamJoinRequestItem>>(`/api/v1/team/join-requests/${requestId}/reject`, {
      method: 'POST',
    });
    return res.data;
  },

  // ==========================================
  // USAGE & METRICS
  // ==========================================
  getUsageSummary: async (from?: any, to?: any) => {
    const q = new URLSearchParams();
    if (typeof from === 'string') q.set('from', from);
    if (typeof to === 'string') q.set('to', to);
    const queryStr = q.toString() ? `?${q.toString()}` : '';
    const res = await request<ApiResponse<UsageSummaryData>>(`/api/v1/usage/summary${queryStr}`);
    return res.data;
  },

  getUsageMessages: async (from?: any, to?: any, group_by: 'hour' | 'day' = 'day', tz = 'Asia/Jakarta', session_id?: string) => {
    const q = new URLSearchParams({
      group_by: typeof group_by === 'string' ? group_by : 'day',
      tz: typeof tz === 'string' ? tz : 'Asia/Jakarta',
    });
    if (typeof from === 'string') q.set('from', from);
    if (typeof to === 'string') q.set('to', to);
    if (typeof session_id === 'string') q.set('session_id', session_id);
    const res = await request<ApiResponse<UsageMessageBucket[]>>(`/api/v1/usage/messages?${q.toString()}`);
    return res.data;
  },

  getUsageSessions: async (from?: any, to?: any) => {
    const q = new URLSearchParams();
    if (typeof from === 'string') q.set('from', from);
    if (typeof to === 'string') q.set('to', to);
    const queryStr = q.toString() ? `?${q.toString()}` : '';
    const res = await request<ApiResponse<UsageSessionStat[]>>(`/api/v1/usage/sessions${queryStr}`);
    return res.data;
  },

  // ==========================================
  // AUDIT LOGS
  // ==========================================
  getAuditLogs: async (params?: { page?: number; page_size?: number; action?: string; from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.page_size) q.set('page_size', String(params.page_size));
    if (params?.action) q.set('action', params.action);
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);
    const queryStr = q.toString() ? `?${q.toString()}` : '';
    const res = await request<ApiResponse<AuditLogItem[]>>(`/api/v1/audit-logs${queryStr}`);
    return { data: res.data, meta: res.meta };
  },

  // ==========================================
  // TENANT SETTINGS / QUOTAS
  // ==========================================
  getTenantSettings: async () => {
    const res = await request<ApiResponse<TenantSettingsData>>('/api/v1/tenant/settings');
    return res.data;
  },

  renameTenant: async (name: string) => {
    const res = await request<ApiResponse<TenantRenameResponseData>>('/api/v1/tenant', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return res.data;
  },

  deleteTenant: async (password: string, confirm_name: string) => {
    const res = await request<ApiResponse<TenantDeleteResponseData>>('/api/v1/tenant', {
      method: 'DELETE',
      body: JSON.stringify({ password, confirm_name }),
    });
    return res.data;
  },

  listDeletedWorkspaces: async (cred: { email: string; password: string }) => {
    const res = await request<ApiResponse<DeletedWorkspaceItem[]>>('/api/v1/auth/deleted-workspaces', {
      method: 'POST',
      body: JSON.stringify(cred),
    });
    return res.data;
  },

  restoreWorkspace: async (cred: { email: string; password: string; tenant_id: string }) => {
    const res = await request<ApiResponse<RestoreWorkspaceResponseData>>('/api/v1/auth/restore-workspace', {
      method: 'POST',
      body: JSON.stringify(cred),
    });
    return res.data;
  },

  // ==========================================
  // DATA EXPORT (ADR-048)
  // ==========================================
  getExportPolicy: async () => {
    const res = await request<ApiResponse<ExportPolicyData>>('/api/v1/exports/policy', {
      method: 'GET',
    });
    return res.data;
  },

  exportData: async (
    type: ExportType,
    body: ExportRequestBody,
    opts?: { signal?: AbortSignal; onProgress?: (bytes: number) => void },
    isRetry = false
  ): Promise<{ blob: Blob; filename: string; rows?: number }> => {
    let exportPath: string;
    switch (type) {
      case 'messages':
        exportPath = '/api/v1/exports/messages';
        break;
      case 'outbound':
        exportPath = '/api/v1/exports/outbound';
        break;
      case 'chats':
        exportPath = '/api/v1/exports/chats';
        break;
      case 'contacts':
        exportPath = '/api/v1/exports/contacts';
        break;
      case 'audit-logs':
        exportPath = '/api/v1/exports/audit-logs';
        break;
      case 'members':
        exportPath = '/api/v1/exports/members';
        break;
      default:
        throw new Error(`Tipe ekspor tidak dikenal: ${type}`);
    }

    // Clean body per Zod strictObject in backend routes
    const cleanPayload: Record<string, unknown> = {
      password: body.password,
      format: body.format || 'csv',
    };

    if (type === 'messages' || type === 'outbound' || type === 'audit-logs') {
      if (body.from) cleanPayload.from = body.from;
      if (body.to) cleanPayload.to = body.to;
    }
    if (type === 'messages' || type === 'outbound' || type === 'chats') {
      if (body.session_id) cleanPayload.session_id = body.session_id;
    }
    if (type === 'messages' && body.direction) {
      cleanPayload.direction = body.direction;
    }
    if (type === 'outbound' && body.status) {
      cleanPayload.status = body.status;
    }

    const token = tokenStore.get();
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(exportPath, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(cleanPayload),
      signal: opts?.signal,
    });

    // Handle 401: single-flight refresh token
    if (res.status === 401 && !isRetry) {
      if (!refreshPromise) {
        refreshPromise = executeRefresh().finally(() => {
          refreshPromise = null;
        });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        return api.exportData(type, body, opts, true);
      }
      tokenStore.clear();
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback();
      }
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sesi telah berakhir. Silakan login kembali.');
    }

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const errBody = isJson ? await res.json().catch(() => ({})) : null;
      const errorPayload: ApiErrorPayload = errBody?.error || {
        code: res.status === 503 ? 'SERVICE_UNAVAILABLE' : res.status === 429 ? 'RATE_LIMITED' : 'API_ERROR',
        message:
          res.status === 503
            ? 'Layanan sedang tidak tersedia. Silakan coba kembali.'
            : `Terjadi galat (HTTP ${res.status})`,
      };

      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

      throw new ApiError(
        res.status,
        errorPayload.code,
        errorPayload.message,
        errorPayload.details,
        errBody?.request_id,
        !isNaN(retryAfterSec as number) ? retryAfterSec : undefined
      );
    }

    const disp = res.headers.get('content-disposition') || '';
    const filenameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `wazap-export-${type}.${body.format || 'csv'}`;
    const rowsHeader = res.headers.get('x-export-rows');
    const rowsCount = rowsHeader ? parseInt(rowsHeader, 10) : undefined;

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Aliran pembaca (ReadableStream) tidak didukung pada browser ini.');
    }

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        receivedBytes += value.length;
        opts?.onProgress?.(receivedBytes);
      }
    }

    const blob = new Blob(chunks as BlobPart[], {
      type: res.headers.get('content-type') || (body.format === 'ndjson' ? 'application/x-ndjson' : 'text/csv; charset=utf-8'),
    });

    return {
      blob,
      filename,
      rows: rowsCount,
    };
  },

  // ==========================================
  // ALERTS (ADR-049)
  // ==========================================
  getAlertCatalog: async () => {
    const res = await request<ApiResponse<AlertCatalogData>>('/api/v1/alerts/catalog');
    return res.data;
  },

  listAlertChannels: async () => {
    const res = await request<ApiResponse<AlertChannelItem[]>>('/api/v1/alerts/channels');
    return res.data;
  },

  createAlertChannel: async (body: CreateAlertChannelBody) => {
    const res = await request<ApiResponse<{ id: string }>>('/api/v1/alerts/channels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.data;
  },

  updateAlertChannel: async (id: string, body: UpdateAlertChannelBody) => {
    const res = await request<ApiResponse<{ id: string }>>(`/api/v1/alerts/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res.data;
  },

  deleteAlertChannel: async (id: string, password: string) => {
    const res = await request<ApiResponse<{ id: string; deleted?: boolean }>>(`/api/v1/alerts/channels/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    return res.data;
  },

  testAlertChannel: async (id: string) => {
    const res = await request<ApiResponse<AlertTestResult>>(`/api/v1/alerts/channels/${id}/test`, {
      method: 'POST',
    });
    return res.data;
  },

  listAlertRules: async () => {
    const res = await request<ApiResponse<AlertRuleItem[]>>('/api/v1/alerts/rules');
    return res.data;
  },

  putAlertRule: async (code: string, body: PutAlertRuleBody) => {
    const res = await request<ApiResponse<AlertRuleItem>>(`/api/v1/alerts/rules/${code}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return res.data;
  },

  listAlertDeliveries: async (limit?: number) => {
    const path = limit !== undefined ? `/api/v1/alerts/deliveries?limit=${limit}` : '/api/v1/alerts/deliveries';
    const res = await request<ApiResponse<AlertDeliveryItem[]>>(path);
    return res.data;
  },
};

export const apiClient = api;
