# ERD --- Logical Model

``` mermaid
erDiagram
    TENANTS ||--o{ TENANT_MEMBERSHIPS : has
    USERS ||--o{ TENANT_MEMBERSHIPS : joins
    TENANTS ||--o{ API_KEYS : owns
    TENANTS ||--o{ WA_SESSIONS : owns
    WA_SESSIONS ||--o{ WA_SESSION_EVENTS : records
    WA_SESSIONS ||--o| SESSION_CREDENTIALS : references
    WA_SESSIONS ||--o| SESSION_LEASES : leased
    ENGINE_NODES ||--o{ SESSION_LEASES : owns
    TENANTS ||--o{ WA_CHATS : owns
    WA_SESSIONS ||--o{ WA_CHATS : handles
    WA_CHATS ||--o{ WA_MESSAGES : contains
    TENANTS ||--o{ MESSAGE_QUEUE : owns
    WA_SESSIONS ||--o{ MESSAGE_QUEUE : routes
    MESSAGE_QUEUE ||--o{ MESSAGE_ATTEMPTS : tracks
    TENANTS ||--o{ WEBHOOK_ENDPOINTS : configures
    WEBHOOK_ENDPOINTS ||--o{ WEBHOOK_DELIVERIES : delivers
    TENANTS ||--o{ OUTBOX_EVENTS : generates
    TENANTS ||--o{ AUDIT_LOGS : records
    TENANTS ||--o{ USAGE_EVENTS : tracks
```

## Required invariants

1.  Every tenant-owned record has tenant_id.
2.  A session belongs to exactly one tenant.
3.  A chat belongs to a tenant and session from the same tenant.
4.  A message belongs to a chat from the same tenant.
5.  A queue job belongs to a tenant and session from the same tenant.
6.  One active lease per session.
7.  Fencing token monotonically increases on ownership change.
8.  API key hash is unique; raw secret is never stored.
9.  Credential references never expose credential contents.
10. Deleted sessions follow retention and credential-erasure policy.

## Pembaruan Fase B

Tabel `refresh_tokens` ditambahkan dan composite FK diterapkan:

``` mermaid
erDiagram
    TENANT_MEMBERSHIPS ||--o{ REFRESH_TOKENS : "FK (tenant_id,user_id)"
    TENANT_MEMBERSHIPS ||--o{ API_KEYS : "created_by FK (tenant_id,user_id)"
    TENANTS ||--|| TENANT_SETTINGS : configures
```

Invarian 8 (hash API key unik; raw tidak disimpan) dan 1-2 telah
diterapkan dan diuji di migrasi 0001.

## Pembaruan Fase C

``` mermaid
erDiagram
    WA_SESSIONS ||--|| SESSION_LEASES : "satu baris abadi"
    WA_SESSIONS ||--o| SESSION_CREDENTIALS : references
    ENGINE_NODES ||--o{ SESSION_LEASES : owns
    WA_SESSIONS ||--o{ WA_SESSION_EVENTS : "composite FK (tenant_id,session_id)"
```

Invarian 2, 6, 7 dan 9 (sebagian) kini ditegakkan di DB (composite FK,
trigger fencing monoton, tabel kredensial hanya referensi) dan diuji.

## Pembaruan Fase D

``` mermaid
erDiagram
    WA_SESSIONS ||--o{ SESSION_AUTH_STATE : "composite FK, cascade"
    WA_SESSIONS ||--o| SESSION_QR : "composite FK, cascade"
    WA_SESSIONS ||--o| SESSION_CREDENTIALS : "versi auth"
```

Invarian 9 (kredensial tidak disimpan plaintext) kini ditegakkan di kode
(AES-256-GCM + AAD) dan diuji (tidak ada plaintext di kolom `ciphertext`).

## Pembaruan Fase E

``` mermaid
erDiagram
    WA_SESSIONS ||--o{ MESSAGE_QUEUE : "composite FK (tenant_id,session_id)"
    MESSAGE_QUEUE ||--o{ MESSAGE_ATTEMPTS : "composite FK (tenant_id,job_id), append-only"
```

Invarian 3 (relasi message/session tidak lintas tenant) ditegakkan composite FK
dan diuji (sesi tenant lain => 404 di service; FK di DB).

## Pembaruan Fase F

``` mermaid
erDiagram
    TENANTS ||--o{ OUTBOX_EVENTS : "tenant_id"
    TENANTS ||--o{ WEBHOOK_ENDPOINTS : "tenant_id"
    WEBHOOK_ENDPOINTS ||--o{ WEBHOOK_DELIVERIES : "composite FK (tenant_id,endpoint_id)"
    WEBHOOK_DELIVERIES ||--o{ WEBHOOK_DELIVERY_ATTEMPTS : "composite FK (tenant_id,delivery_id)"
    WA_SESSIONS ||--o{ WA_CHATS : "composite FK (tenant_id,session_id)"
    WA_CHATS ||--o{ WA_MESSAGES : "composite FK (tenant_id,chat_id)"
    MESSAGE_QUEUE ||..o| WA_MESSAGES : "queue_id (cermin OUT, trigger)"
```

`outbox_events` tidak punya FK ke agregat (event harus bertahan lebih lama dari
baris sumber). Invarian lintas-tenant ditegakkan composite FK dan RLS.
