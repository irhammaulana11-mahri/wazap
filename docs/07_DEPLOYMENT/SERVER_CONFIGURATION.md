# Server Configuration

## Initial host

Ubuntu server, 4-core Intel i5 Gen 6, 16 GB RAM, SSD 512 GB, HDD 500 GB.
Existing services must be measured before assigning resources.

## Layout

-   `/var/www/wazap`: application code.
-   `/var/lib/wazap`: private auth state and secrets
    references.
-   `/mnt/data/wazap/media`: media.
-   `/mnt/data/wazap/backups`: encrypted backups.
-   Logs managed through journald or bounded log rotation.

## Network

-   Nginx exposes HTTPS dashboard/API.
-   Engine control endpoints remain private.
-   PostgreSQL should not be publicly exposed.
-   Python bots on same host can use localhost/private network.
-   CORS allowlist must be explicit.

## Database

Create a dedicated database and least-privilege role. Do not reuse
application credentials or modify other application databases.
