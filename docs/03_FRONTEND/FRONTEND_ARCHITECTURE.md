# Frontend Architecture

## Stack

React, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query,
Socket.IO Client.

## Application areas

-   Public: landing, register, login, password recovery.
-   Workspace: dashboard, sessions, QR/pairing, messages,
    contacts/chats, templates, webhooks, API keys, usage, members,
    settings.
-   Platform admin: tenant overview, engine health, operational metrics,
    audit, configuration.

## Rules

-   Frontend never accesses PostgreSQL or engine storage directly.
-   All data comes from documented REST API.
-   All live updates use documented Socket.IO events.
-   Tenant context is derived from authenticated session; do not trust
    tenant_id from UI state.
-   API errors and loading/empty states must be handled.
-   Paginate message and chat histories.
-   QR and secrets must not be persisted in local storage.
-   Use route guards for UX, while backend remains the authorization
    authority.
-   Keep API types synchronized with API contract; prefer generated
    OpenAPI types where available.
