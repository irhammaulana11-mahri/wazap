# Technology Stack

## Backend

-   Node.js LTS yang kompatibel dengan dependency WhatsApp yang dipilih.
-   TypeScript strict mode.
-   Fastify.
-   `pg` untuk PostgreSQL.
-   SQL migration tool yang dipilih dan didokumentasikan.
-   Zod atau validator konsisten untuk schema request/response.
-   Socket.IO.
-   Pino atau logger terstruktur sejenis.

## Frontend

-   React.
-   Vite.
-   TypeScript.
-   Tailwind CSS.
-   React Router.
-   TanStack Query untuk server state.
-   Form library dan schema validation yang konsisten.
-   Socket.IO Client.

## WhatsApp

-   Baileys di belakang interface adapter.
-   Pin versi dependency dan commit lockfile.
-   Isolasi Baileys-specific types di package adapter.
-   Evaluasi dokumentasi dan lisensi dependency sebelum dipakai.

## Infrastructure

-   Ubuntu.
-   Nginx.
-   PM2.
-   PostgreSQL existing dengan database dan role khusus.
-   Private storage dengan permission ketat.
-   Backup terenkripsi.

## Engineering rules

-   Jangan menambahkan Redis, Docker, Kubernetes, atau microservices
    penuh tanpa kebutuhan terukur dan persetujuan.
-   Jangan menggunakan ORM sebagai alasan mengabaikan constraint, index,
    transaksi, dan RLS PostgreSQL.
-   Semua dependency harus memiliki versi terkunci.
