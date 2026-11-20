// Dimuat PERTAMA oleh worker.test.ts: config dibaca sekali saat impor, jadi env harus sudah siap.
import crypto from 'node:crypto';
process.env.CREDENTIAL_ENCRYPTION_KEYS ??= `1:${crypto.randomBytes(32).toString('base64')}`;
process.env.QUEUE_POLL_MS = '50';
process.env.SESSION_SEND_INTERVAL_MS = '0';
process.env.ENGINE_HEARTBEAT_SECONDS = '1';
process.env.RECONNECT_BASE_MS = '5';
process.env.RECONNECT_MAX_MS = '20';
