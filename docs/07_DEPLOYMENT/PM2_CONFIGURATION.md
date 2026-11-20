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

## Contoh `ecosystem.config.cjs` (ADR-039; tanpa rahasia: nilai rahasia dari berkas env di luar repo)

```js
module.exports = { apps: [
  { name: 'wazap-api', script: 'dist/server.js', cwd: '/srv/wazap/backend', instances: 1, exec_mode: 'fork', // JANGAN cluster (batas laju in-memory)
    env_file: '/etc/wazap/api.env', kill_timeout: 20000, max_restarts: 10, min_uptime: '20s', restart_delay: 3000 },
  { name: 'wazap-engine-01', script: 'dist/worker.js', cwd: '/srv/wazap/backend', instances: 1, exec_mode: 'fork', // JANGAN cluster: nama node harus unik
    env_file: '/etc/wazap/worker.env', kill_timeout: 30000, max_restarts: 10, min_uptime: '20s', restart_delay: 3000 },
] };
```

-   `api.env`: `ENABLE_EMBEDDED_CONTROL_PLANE=false`, `ENABLE_EMBEDDED_ENGINE=false`, `ENABLE_EMBEDDED_WEBHOOK_WORKER=false`, `ENABLE_EMBEDDED_RETENTION=false`.
-   `worker.env`: `ENGINE_NODE_NAME=engine-01`, `WORKER_ROLES=engine,control-plane,webhook,retention`, `WORKER_HEALTH_PORT=8001`, plus kredensial DB dan `CREDENTIAL_ENCRYPTION_KEYS`.
-   Engine tambahan: salin entri dengan `ENGINE_NODE_NAME=engine-02`, `WORKER_HEALTH_PORT=8002`, dan `WORKER_ROLES=engine`.
-   `kill_timeout` HARUS lebih besar dari `SHUTDOWN_TIMEOUT_MS` (default 15 dtk) agar shutdown rapi (sesi dikembalikan ke antrean) selesai sebelum SIGKILL.
-   Keluar kode 1 yang berulang (loop crash) berarti kegagalan start (DB mati, schema belum dimigrasi, nama node ganda): baca log, jangan naikkan `max_restarts`.

