export interface Session {
  id: string;
  session_name: string;
  phone_number: string | null;
  status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
}

export interface QrInfo {
  id: string;
  sessionName: string;
  status: Session['status'];
  phoneNumber: string | null;
  qrCode: string | null;
}

export interface Message {
  id: string;
  session_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  remote_jid: string;
  content: { text?: string };
  status: string;
  timestamp: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

const TOKEN_KEY = 'wazap_token';

export const auth = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

// Dipanggil saat server menjawab 401 agar UI kembali ke halaman login.
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = auth.get();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/v1/auth/login') {
    auth.clear();
    onUnauthorized();
  }
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  login: (username: string, password: string) =>
    req<{ token: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  health: () => req<{ status: string; database: string }>('/health'),
  listSessions: () => req<{ data: Session[] }>('/api/v1/sessions').then((r) => r.data),
  createSession: (sessionName: string) =>
    req<{ data: { id: string } }>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionName }),
    }).then((r) => r.data),
  getQr: (id: string) => req<{ data: QrInfo }>(`/api/v1/sessions/${id}/qr`).then((r) => r.data),
  deleteSession: (id: string) => req(`/api/v1/sessions/${id}`, { method: 'DELETE' }),
  sendMessage: (sessionId: string, to: string, text: string) =>
    req<{ data: { messageId?: string } }>('/api/v1/messages/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, to, text }),
    }),
  history: () => req<{ data: Message[] }>('/api/v1/messages/history').then((r) => r.data),
  listWebhooks: () => req<{ data: Webhook[] }>('/api/v1/webhooks').then((r) => r.data),
  createWebhook: (url: string, events: string[]) =>
    req<{ data: Webhook }>('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url, events }),
    }).then((r) => r.data),
  deleteWebhook: (id: string) => req(`/api/v1/webhooks/${id}`, { method: 'DELETE' }),
  testWebhook: () => req('/api/v1/webhooks/test', { method: 'POST' }),
  listKeys: () => req<{ data: ApiKeyRow[] }>('/api/v1/auth/api-keys').then((r) => r.data),
  createKey: (name: string) =>
    req<{ data: { key: string; prefix: string } }>('/api/v1/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((r) => r.data),
  revokeKey: (id: string) => req(`/api/v1/auth/api-keys/${id}`, { method: 'DELETE' }),
};
