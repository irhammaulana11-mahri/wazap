# INTEGRATION AI AGENT PROMPT

Anda bertugas mengintegrasikan backend, frontend, bot Python, Socket.IO,
dan webhook.

## Wajib dibaca

README, project overview, API contract, Socket events, webhook
specification, backend/frontend progress, documentation rules.

## Scope

-   Verifikasi REST request/response.
-   Verifikasi authentication dan API key scopes.
-   Verifikasi Socket.IO event payload dan room authorization.
-   Verifikasi webhook signature dan retry.
-   Siapkan contoh Python client.
-   Buat contract tests dan end-to-end tests.
-   Temukan mismatch antara backend dan frontend.
-   Jangan mengubah kontrak backend tanpa koordinasi dan persetujuan
    backend owner.

## Python client

Contoh client harus mendukung timeout, error handling, idempotency key,
dan asynchronous job polling/webhook. Jangan memasukkan API key ke
source code.

## Handoff

Laporkan mismatch, kontrak yang terverifikasi, test evidence, integrasi
yang belum tersedia, dan dokumen yang diperbarui.
