// API Contract Types matching docs/02_BACKEND/API_CONTRACT.md and docs/04_INTEGRATION/FRONTEND_HANDOFF.md

export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

export interface ApiResponseMeta {
  page?: number;
  page_size?: number;
  total?: number;
  total_capped?: boolean;
}

export type UserRole = Role;
export type Session = WhatsAppSession;
export type TeamMember = TeamMemberItem;
export type TeamInvitation = TeamInvitationItem;
export type QrResponse = SessionQrResponse;
export type MessagePriority = 'HIGH' | 'NORMAL' | 'LOW';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: ApiResponseMeta;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: ApiFieldError[];
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
  request_id?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  created_at?: string;
}

export interface AuthTenant {
  id: string;
  name: string;
  slug: string;
}

export interface TenantMembership {
  tenant_id: string;
  name: string;
  slug: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface AuthLoginResponseData {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
  tenant: AuthTenant;
  role: Role;
  recovery_code?: string;
  recovery_codes?: string[];
}

export interface AuthJoinRequestResponseData {
  request_id: string;
  status: 'PENDING';
  tenant_name: string;
  expires_at: string;
  existing_account: boolean;
  recovery_code?: string;
  recovery_codes?: string[];
}

export interface ResetPasswordResponseData {
  remaining_recovery_codes: number;
}

export interface RecoveryCodeResponseData {
  recovery_codes: string[];
}

export type RegisterResult =
  | {
      kind: 'session';
      data: AuthLoginResponseData;
    }
  | {
      kind: 'pending';
      data: {
        status: 'PENDING_APPROVAL';
        user: { id: string; email: string };
        tenant: { id: string; name: string; slug: string };
        recovery_codes: string[];
      };
    };

export interface TeamJoinCodeResponseData {
  enabled: boolean;
  created_at: string | null;
  created_by: { user_id: string; email: string } | null;
  join_code?: string;
  join_url?: string | null;
}

export interface TeamJoinRequestItem {
  id: string;
  email: string;
  user_id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  role: Role | null;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: { user_id: string; email: string } | null;
}

export interface TenantRenameResponseData {
  id: string;
  name: string;
  slug: string;
  updated_at: string;
}

export interface TenantDeleteResponseData {
  tenant_id: string;
  name: string;
  purged_after_days: number;
}

export interface DeletedWorkspaceItem {
  tenant_id: string;
  name: string;
  slug: string;
  deleted_at: string;
  restorable_until: string;
}

export interface RestoreWorkspaceResponseData {
  restored: true;
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
  must_recreate: string[];
}

export interface RecoveryStatus {
  codes_remaining: number;
  confirmed: boolean;
}

export interface AuthMeResponseData {
  user: AuthUser;
  active_tenant_id: string;
  role: Role;
  memberships: TenantMembership[];
  recovery?: RecoveryStatus;
}

// 13 Session Statuses per backend contract
export type SessionStatus =
  | 'CREATED'
  | 'PENDING_ASSIGNMENT'
  | 'INITIALIZING'
  | 'QR_REQUIRED'
  | 'CONNECTING'
  | 'RECONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'DISCONNECTED'
  | 'LOGGED_OUT'
  | 'ERROR'
  | 'DELETING'
  | 'DELETED';

export interface WhatsAppSession {
  id: string;
  session_name: string;
  phone_number: string | null;
  status: SessionStatus;
  status_reason?: string | null;
  desired_state?: string;
  adapter?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionStatusResponse {
  id: string;
  status: SessionStatus;
  status_reason?: string | null;
  desired_state?: string;
  updated_at: string;
}

export interface SessionQrResponse {
  qr: string;
  qr_data_url: string;
  expires_at: string;
}

// Message statuses per backend contract
export type MessageStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'CANCELLED';

export interface MessageItem {
  id: string;
  session_id: string;
  to: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  message: string | null;
  media?: any;
  status: MessageStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  provider_message_id?: string | null;
  last_error_code?: string | null;
  scheduled_at: string;
  completed_at?: string | null;
  content_purged: boolean;
  created_at: string;
  updated_at: string;
  attempt_history?: any[];
}

export interface ChatItem {
  id: string;
  session_id: string;
  jid: string;
  phone: string | null;
  name: string;
  last_message_at: string | null;
  created_at: string;
}

export interface ChatMessageItem {
  id: string;
  direction: 'IN' | 'OUT';
  type: string;
  text: string | null;
  text_purged: boolean;
  status: string;
  provider_message_id?: string | null;
  job_id?: string | null;
  occurred_at: string;
}

export interface ContactItem {
  phone: string | null;
  name: string;
  last_message_at: string | null;
  chats: number;
}

export interface WebhookItem {
  id: string;
  url: string;
  description?: string | null;
  events: string[];
  secret_hint: string;
  active: boolean;
  consecutive_failures: number;
  disabled_at?: string | null;
  disabled_reason?: string | null;
  created_at: string;
  updated_at: string;
  secret?: string; // Only returned on creation
}

export const VALID_API_KEY_SCOPES = [
  'sessions:read',
  'sessions:write',
  'messages:send',
  'messages:read',
  'contacts:read',
  'webhooks:manage',
  'usage:read',
] as const;

export type ApiKeyScope = (typeof VALID_API_KEY_SCOPES)[number];

export interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  key?: string; // Only returned on creation
}

export interface TeamMemberItem {
  user_id: string;
  email: string | null;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  joined_at: string;
  is_me: boolean;
}

export interface TeamInvitationItem {
  id: string;
  email: string;
  role: Role;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  token?: string; // Only returned on create/reissue
  invite_url?: string | null;
}

export interface UsageSummaryData {
  period: { from: string; to: string };
  sessions: {
    total: number;
    connected: number;
    by_status: Record<string, number>;
  };
  messages: {
    total: number;
    by_status: Record<string, number>;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    unknown: number;
    cancelled: number;
  };
  incoming: { total: number };
  queue: { pending: number; processing: number };
  quotas: {
    sessions: { used: number; max: number };
    api_keys: { used: number; max: number };
    members: { used: number; max: number };
    webhooks: { used: number; max: number };
    messages_per_minute: number;
  };
}

export interface UsageMessageBucket {
  bucket: string;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  incoming: number;
}

export interface UsageSessionStat {
  session_id: string;
  session_name: string;
  status: string;
  outgoing: number;
  failed: number;
  incoming: number;
}

export interface TenantSettingsLimits {
  max_sessions: number;
  max_api_keys: number;
  max_members: number;
  messages_per_minute: number;
}

export interface TenantSettingsData {
  limits: TenantSettingsLimits;
  ceilings: TenantSettingsLimits;
  minimums: TenantSettingsLimits;
  used: { sessions: number; api_keys: number; members: number };
  editable?: boolean;
  managed_by?: string;
  updated_at: string;
}

export interface AuditLogItem {
  id: string;
  action: string;
  actor: { user_id: string; email: string | null; role: Role };
  target: { type: string; id: string; email?: string | null };
  details: any;
  ip: string | null;
  request_id: string;
  created_at: string;
}

// ==========================================
// DATA EXPORT (ADR-048)
// ==========================================
export type ExportType = 'messages' | 'outbound' | 'chats' | 'contacts' | 'audit-logs' | 'members';
export type ExportFormat = 'csv' | 'ndjson';

export interface ExportRetentionPolicy {
  content_days: number;
  row_days: number;
  audit_days: number;
}

export interface ExportPolicyData {
  enabled: boolean;
  max_rows: number;
  max_span_days: number;
  per_hour: number;
  types: ExportType[];
  retention: ExportRetentionPolicy;
}

export interface ExportRequestBody {
  password: string;
  format?: ExportFormat;
  from?: string;
  to?: string;
  session_id?: string;
  direction?: 'IN' | 'OUT';
  status?: string;
}

export interface ExportTooLargeDetails {
  max_rows: number;
  estimated_rows: number;
  capped: boolean;
}

// ==========================================
// ALERTS (ADR-049)
// ==========================================
export type AlertChannelType = 'TELEGRAM' | 'SLACK';

export interface AlertCatalogRuleThreshold {
  default: number;
  min: number;
  max: number;
  unit: string;
}

export interface AlertCatalogRule {
  code: string;
  label: string;
  description: string;
  threshold: AlertCatalogRuleThreshold | null;
  repeats: boolean;
}

export interface AlertCatalogCooldown {
  default: number;
  min: number;
  max: number;
}

export interface AlertCatalogData {
  enabled: boolean;
  max_channels: number;
  channel_types: AlertChannelType[];
  cooldown: AlertCatalogCooldown;
  rules: AlertCatalogRule[];
}

export interface AlertChannelItem {
  id: string;
  type: AlertChannelType;
  name: string;
  target_hint: string;
  active: boolean;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type CreateAlertChannelBody =
  | { type: 'TELEGRAM'; name: string; token: string; chat_id: string; password: string }
  | { type: 'SLACK'; name: string; url: string; password: string };

export interface UpdateAlertChannelBody {
  name?: string;
  active?: boolean;
  password?: string;
  token?: string;
  chat_id?: string;
  url?: string;
}

export interface AlertTestResult {
  ok: boolean;
  status_code: number | null;
  error_code: string | null;
  duration_ms: number;
}

export interface AlertRuleItem {
  code: string;
  enabled: boolean;
  threshold: number | null;
  cooldown_minutes: number;
  channel_ids: string[];
  updated_at: string | null;
}

export interface PutAlertRuleBody {
  enabled: boolean;
  threshold?: number;
  cooldown_minutes?: number;
  channel_ids: string[];
}

export type AlertDeliveryStatus = 'PENDING' | 'SENT' | 'DEAD';

export interface AlertDeliveryItem {
  id: string;
  channel_id: string | null;
  channel_name: string | null;
  rule_code: string;
  status: AlertDeliveryStatus;
  attempts: number;
  last_status_code: number | null;
  last_error_code: string | null;
  sent_at: string | null;
  created_at: string;
}

