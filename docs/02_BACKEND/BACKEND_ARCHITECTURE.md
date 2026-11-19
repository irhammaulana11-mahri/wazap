# Backend Architecture

## Module boundaries

-   `identity`: registration, login, memberships, roles, API keys.
-   `tenants`: tenant settings, quotas, tenant context.
-   `sessions`: session commands, lifecycle, ownership.
-   `engine-registry`: engine heartbeat, capacity, leases.
-   `whatsapp-adapters`: adapter interface and Baileys implementation.
-   `messaging`: send request, message history, status.
-   `queue`: enqueue, claim, fair scheduling, retry.
-   `webhooks`: endpoint management, signing, delivery.
-   `realtime`: authenticated Socket.IO rooms/events.
-   `usage`: usage events and summaries.
-   `audit`: security and administrative events.

## Rules

-   Route handlers are thin; business rules belong in services.
-   Database access is parameterized.
-   Tenant context is mandatory for tenant-owned operations.
-   Validate all inputs and outputs.
-   Never return auth state, API secret hash, webhook secret, or
    internal engine credentials.
-   Use transactions for related writes.
-   Use transactional outbox for events that must survive process
    restart.
-   Use graceful shutdown.
-   Separate adapter-specific types from domain types.

## WhatsApp adapter contract

Define connect, disconnect, sendText, sendMedia, getStatus and event
subscription methods. Adapter results must distinguish accepted, sent,
delivered (if confirmed), failed, and unknown. Do not claim delivery
where the underlying protocol provides no reliable confirmation.

## Baileys requirements

-   Pin tested version.
-   Implement persistent auth state carefully.
-   Serialize credential writes.
-   Keep one active owner per session.
-   Handle QR refresh, logout, reconnect and credential update.
-   Do not log secrets or QR payloads.
-   Verify current Baileys documentation and supported Node.js version
    before implementation.
