import { z } from 'zod';
import { SESSION_STATES } from '../../modules/sessions/lifecycle.js';
import { WEBHOOK_EVENTS } from '../../modules/webhooks/webhooks.service.js';

/**
 * Skema RESPONSE publik. Satu sumber untuk dua hal: (1) dokumen OpenAPI dan (2) validasi response asli di mode kontrak
 * (WAZAP_CONTRACT_CHECK=1, lihat conformance.ts). Objek memakai looseObject: penambahan field kompatibel tidak memecahkan kontrak,
 * tetapi field yang dihapus atau berubah tipe terdeteksi.
 */
export const registry = z.registry();
const named = <T extends z.ZodType>(id: string, s: T): T => { registry.add(s, { id }); return s; };

export const Uuid = z.uuid();
export const Dt = z.iso.datetime({ offset: true });
export const Role = z.enum(['OWNER', 'MEMBER', 'VIEWER']);
export const SessionState = z.enum(SESSION_STATES);
export const MessageStatus = z.enum(['PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'FAILED', 'CANCELLED']);
export const MessageType = z.enum(['text', 'image', 'video', 'audio', 'document']);
const nl = <T extends z.ZodType>(s: T) => s.nullable();
const int = z.number().int();
const bool = z.boolean();
const str = z.string();

export const PageMeta = z.looseObject({ page: int, page_size: int, total: int, total_capped: bool.optional() });
const okEnv = <T extends z.ZodType>(data: T) => z.looseObject({ success: z.literal(true), data });
export const okOf = okEnv;
export const listOf = <T extends z.ZodType, M extends z.ZodType = typeof PageMeta>(item: T, meta?: M) =>
  z.looseObject({ success: z.literal(true), data: z.array(item), meta: (meta ?? PageMeta) as z.ZodType });

export const ErrorBody = named('Error', z.looseObject({
  success: z.literal(false),
  error: z.looseObject({ code: str, message: str, details: z.array(z.unknown()) }),
  request_id: str,
}));

// ---- entitas ----
export const User = named('User', z.looseObject({ id: Uuid, email: str }));
export const Tenant = named('Tenant', z.looseObject({ id: Uuid, name: str, slug: str }));
export const AuthSession = named('AuthSession', z.looseObject({
  access_token: str, token_type: z.literal('Bearer'), expires_in: int, user: User, tenant: Tenant, role: Role,
}));
export const AuthSessionWithCodes = named('AuthSessionWithCodes', AuthSession.extend({ recovery_codes: z.array(str) }));

export const Session = named('WhatsAppSession', z.looseObject({
  id: Uuid, session_name: str, phone_number: nl(str), status: SessionState, status_reason: nl(str),
  desired_state: z.enum(['CONNECTED', 'DISCONNECTED']), adapter: str, created_at: Dt, updated_at: Dt,
}));
export const SessionStatus = z.looseObject({ id: Uuid, status: SessionState, status_reason: nl(str), desired_state: z.enum(['CONNECTED', 'DISCONNECTED']), updated_at: Dt });
export const SessionEvent = z.looseObject({
  id: str, event_type: str, from_status: nl(str), to_status: nl(str), actor: str, payload: z.record(str, z.unknown()), created_at: Dt,
});
export const SessionQr = z.looseObject({ qr: str, qr_data_url: str, expires_at: Dt });

const Media = z.looseObject({ url: str, filename: nl(str), mimetype: nl(str) });
export const Message = named('Message', z.looseObject({
  id: Uuid, session_id: Uuid, to: str, type: MessageType, message: nl(str), media: nl(Media), status: MessageStatus, priority: int,
  attempts: int, max_attempts: int, provider_message_id: nl(str), last_error_code: nl(str), scheduled_at: Dt, completed_at: nl(Dt),
  content_purged: bool, created_at: Dt, updated_at: Dt,
}));
export const MessageDetail = Message.extend({
  attempt_history: z.array(z.looseObject({ attempt_number: int, started_at: Dt, finished_at: nl(Dt), outcome: nl(str), provider_message_id: nl(str), error_code: nl(str) })),
});
export const MessageStatusView = z.looseObject({ id: Uuid, status: MessageStatus, attempts: int, last_error_code: nl(str), provider_message_id: nl(str), updated_at: Dt });
export const Job = z.looseObject({ job_id: Uuid, status: MessageStatus });
export const BulkResult = z.looseObject({ count: int, jobs: z.array(z.looseObject({ index: int, to: str, job_id: Uuid, status: MessageStatus })) });

export const Chat = named('Chat', z.looseObject({ id: Uuid, session_id: Uuid, jid: str, phone: nl(str), name: nl(str), last_message_at: nl(Dt), created_at: Dt }));
export const ChatMessage = z.looseObject({
  id: Uuid, direction: z.enum(['IN', 'OUT']), type: str, text: nl(str), text_purged: bool, status: str, provider_message_id: nl(str), job_id: nl(Uuid), occurred_at: Dt,
});
export const Contact = z.looseObject({ phone: str, name: nl(str), last_message_at: nl(Dt), chats: int });

export const ApiKeyBase = z.looseObject({
  id: Uuid, name: str, key_prefix: str, scopes: z.array(str), expires_at: nl(Dt), created_at: Dt,
});
export const ApiKey = named('ApiKey', ApiKeyBase.extend({
  last_used_at: nl(Dt), revoked_at: nl(Dt), created_by: nl(z.looseObject({ user_id: Uuid, email: str })).optional(),
}));
export const ApiKeyCreated = named('ApiKeyCreated', ApiKeyBase.extend({ key: str }));

export const Webhook = named('Webhook', z.looseObject({
  id: Uuid, url: str, description: nl(str), events: z.array(z.enum(WEBHOOK_EVENTS)), secret_hint: str, active: bool, consecutive_failures: int,
  disabled_at: nl(Dt), disabled_reason: nl(str), created_at: Dt, updated_at: Dt,
}));
export const WebhookWithSecret = Webhook.extend({ secret: str });
export const WebhookDelivery = named('WebhookDelivery', z.looseObject({
  id: Uuid, endpoint_id: Uuid, event: str, event_id: Uuid, status: z.enum(['PENDING', 'DELIVERED', 'DEAD']), attempts: int, max_attempts: int,
  next_attempt_at: nl(Dt), delivered_at: nl(Dt), last_status_code: nl(int), last_error_code: nl(str), last_duration_ms: nl(int), created_at: Dt,
}));

export const Member = named('Member', z.looseObject({ user_id: Uuid, email: str, role: Role, status: z.enum(['ACTIVE', 'SUSPENDED']), joined_at: Dt, is_me: bool }));
export const Invitation = named('Invitation', z.looseObject({
  id: Uuid, email: str, role: Role, status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']), expires_at: Dt, created_at: Dt, accepted_at: nl(Dt),
}));
export const InvitationIssued = Invitation.extend({ token: str, invite_url: nl(str) });
export const JoinRequest = named('JoinRequest', z.looseObject({
  id: Uuid, email: str, user_id: Uuid, status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']), role: nl(Role), requested_at: Dt, expires_at: Dt, decided_at: nl(Dt), decided_by: nl(Uuid),
}));

const Limits = z.looseObject({ max_sessions: int, max_api_keys: int, max_members: int, messages_per_minute: int });
export const TenantSettings = z.looseObject({
  limits: Limits, ceilings: Limits, minimums: Limits, used: z.looseObject({ sessions: int, api_keys: int, members: int }), updated_at: Dt,
});
export const AuditLog = z.looseObject({
  id: str, action: str,
  actor: z.looseObject({ user_id: nl(Uuid), email: nl(str), role: nl(Role) }),
  target: z.looseObject({ type: str, id: nl(Uuid), email: nl(str) }),
  details: z.record(str, z.unknown()), ip: nl(str), request_id: nl(str), created_at: Dt,
});
export const UsageSummary = z.looseObject({
  period: z.looseObject({ from: Dt, to: Dt }),
  sessions: z.looseObject({ total: int, connected: int, by_status: z.record(str, int) }),
  messages: z.looseObject({ total: int, by_status: z.record(str, int), sent: int, delivered: int, read: int, failed: int, unknown: int, cancelled: int }),
  incoming: z.looseObject({ total: int }),
  queue: z.looseObject({ pending: int, processing: int }),
  quotas: z.looseObject({
    sessions: z.looseObject({ used: int, max: int }), api_keys: z.looseObject({ used: int, max: int }),
    members: z.looseObject({ used: int, max: int }), webhooks: z.looseObject({ used: int, max: int }), messages_per_minute: int,
  }),
});
export const UsagePoint = z.looseObject({ bucket: Dt, total: int, sent: int, delivered: int, read: int, failed: int, incoming: int });
export const UsageSession = z.looseObject({ session_id: Uuid, session_name: str, status: SessionState, outgoing: int, failed: int, incoming: int });

export const Me = z.looseObject({
  user: z.looseObject({ id: Uuid, email: str, created_at: Dt }),
  active_tenant_id: Uuid,
  memberships: z.array(z.looseObject({ tenant_id: Uuid, name: str, slug: str, role: Role, status: str })),
  recovery: z.looseObject({ codes_remaining: int, confirmed: bool }),
  role: Role,
});
export const JoinCode = z.looseObject({ enabled: bool, created_at: nl(Dt), created_by: nl(Uuid) });
export const JoinCodeIssued = z.looseObject({ enabled: bool, created_at: Dt, join_code: str, join_url: nl(str) }); // join_url null bila DASHBOARD_BASE_URL belum dikonfigurasi
export const DeletedWorkspace = z.looseObject({ tenant_id: Uuid, name: str, slug: str, deleted_at: Dt, restorable_until: Dt });
export const Health = z.looseObject({ status: str, version: str.optional(), checks: z.looseObject({ database: str, shutting_down: bool }).optional(), timestamp: Dt.optional() });

// ---- response kecil (bentuk dari sampel nyata) ----
export const ChangedEmail = z.looseObject({ user: User });
export const RecoveryCodes = z.looseObject({ recovery_codes: z.array(str) });
export const Confirmed = z.looseObject({ confirmed: bool });
export const ResetResult = z.looseObject({ remaining_recovery_codes: int });
export const KeyRevoked = z.looseObject({ id: Uuid, revoked_at: Dt });
export const Deleted = z.looseObject({ id: Uuid, deleted: bool });
export const MemberRemoved = z.looseObject({ user_id: Uuid, removed: bool });
export const Accepted = z.looseObject({ tenant: Tenant, role: Role });
export const JoinSubmitted = z.looseObject({ request_id: Uuid, status: z.literal('PENDING'), tenant_name: str, expires_at: Dt, existing_account: bool, recovery_codes: z.array(str).optional() });
export const Restored = z.looseObject({ restored: bool, tenant: Tenant, must_recreate: z.array(str) });
export const TenantDeleted = z.looseObject({ deleted: bool, sessions_scheduled: int, purge_after_days: int });
export const JoinCodeState = z.looseObject({ enabled: bool, created_at: nl(Dt).optional(), created_by: nl(Uuid).optional() });
export const UsageSeriesMeta = z.looseObject({ from: Dt, to: Dt, group_by: z.enum(['hour', 'day']), tz: str });
export const ExportPolicy = z.looseObject({
  enabled: bool, max_rows: int, max_span_days: int, per_hour: int, types: z.array(str),
  retention: z.looseObject({ content_days: int, row_days: int, audit_days: int }),
});


const RuleCode = z.string();
export const AlertChannel = named('AlertChannel', z.looseObject({
  id: Uuid, type: z.enum(['TELEGRAM', 'SLACK']), name: str, target_hint: str, active: bool, consecutive_failures: int,
  disabled_at: nl(Dt), disabled_reason: nl(str), created_at: Dt, updated_at: Dt,
}));
export const AlertRule = named('AlertRule', z.looseObject({
  code: RuleCode, enabled: bool, threshold: nl(int), cooldown_minutes: int, channel_ids: z.array(Uuid), updated_at: nl(Dt),
}));
export const AlertCatalog = z.looseObject({
  enabled: bool, max_channels: int, channel_types: z.array(str), cooldown: z.looseObject({ default: int, min: int, max: int }),
  rules: z.array(z.looseObject({ code: RuleCode, label: str, description: str, threshold: nl(z.looseObject({ default: int, min: int, max: int, unit: str })), repeats: bool })),
});
export const AlertTestResult = z.looseObject({ ok: bool, status_code: nl(int), error_code: nl(str), duration_ms: int });
export const AlertDelivery = named('AlertDelivery', z.looseObject({
  id: Uuid, channel_id: Uuid, channel_name: str, rule_code: str, status: z.enum(['PENDING', 'SENT', 'DEAD']), attempts: int,
  last_status_code: nl(int), last_error_code: nl(str), sent_at: nl(Dt), created_at: Dt,
}));
