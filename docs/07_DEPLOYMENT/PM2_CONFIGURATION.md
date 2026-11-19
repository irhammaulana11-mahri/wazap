# PM2 Configuration

## Initial processes

-   `wazap-api`
-   `wazap-engine-01`
-   `wazap-message-worker`
-   `wazap-webhook-worker`
-   `wazap-scheduler`

Actual process count and engine count are set after testing. Do not run
duplicate engine owners for the same session.

## Requirements

-   Separate environment variables per process where appropriate.
-   Graceful shutdown hooks.
-   Startup ordering and readiness checks.
-   Restart limits/backoff to prevent crash loops.
-   Log rotation and bounded logs.
-   Health and heartbeat reporting.
-   Do not store secrets in committed ecosystem files.
