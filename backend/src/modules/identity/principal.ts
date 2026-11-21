export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

export const API_KEY_SCOPES = [
  'sessions:read',
  'sessions:write',
  'messages:send',
  'messages:read',
  'contacts:read',
  'webhooks:manage',
  'usage:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Principal terverifikasi. tenantId SELALU berasal dari sini, bukan dari request klien. */
export type Principal =
  | { type: 'user'; userId: string; tenantId: string; role: Role }
  | { type: 'apikey'; apiKeyId: string; tenantId: string; scopes: string[] }
