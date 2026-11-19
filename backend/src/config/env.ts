import dotenv from 'dotenv';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Database: DB_* ; DATABASE_URL opsional dan menimpa DB_* bila diisi.
  DATABASE_URL: z.string().default(''),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_DATABASE: z.string().default('wazap_db'),
  DB_USERNAME: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('gateway'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET wajib diisi (minimal 32 karakter)'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // Engine/lease/control-plane
  ENGINE_LEASE_TTL_SECONDS: z.coerce.number().int().min(5).default(30),
  ENGINE_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).default(10),
  ENGINE_SUSPECT_AFTER_SECONDS: z.coerce.number().int().min(5).default(30),
  ENGINE_UNHEALTHY_AFTER_SECONDS: z.coerce.number().int().min(10).default(60),
  CONTROL_PLANE_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  ENABLE_EMBEDDED_CONTROL_PLANE: z.enum(['true', 'false']).default('true'),
  // Fase D: engine + kredensial
  ENABLE_EMBEDDED_ENGINE: z.enum(['true', 'false']).default('true'),
  ENGINE_NODE_NAME: z.string().min(1).max(100).optional(),
  ENGINE_MAX_SESSIONS: z.coerce.number().int().min(1).default(10),
  ENGINE_WEIGHT: z.coerce.number().positive().default(1),
  ENGINE_MIN_FREE_MEM_MB: z.coerce.number().int().min(0).optional(),
  ENGINE_SYNC_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  RECONNECT_BASE_MS: z.coerce.number().int().min(1).default(1000),
  RECONNECT_MAX_MS: z.coerce.number().int().min(1).default(60000),
  RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  QR_TTL_SECONDS: z.coerce.number().int().min(5).default(60),
  // Format "versi:base64(32 byte)", dipisah koma. Diperlukan bila engine aktif. Generate: openssl rand -base64 32
  CREDENTIAL_ENCRYPTION_KEYS: z.string().optional(),
  CREDENTIAL_ACTIVE_KEY_VERSION: z.coerce.number().int().min(1).optional(),
  // Fase E: antrean & pengiriman
  MESSAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MESSAGE_RETRY_BASE_MS: z.coerce.number().int().min(1).default(5000),
  MESSAGE_RETRY_MAX_MS: z.coerce.number().int().min(1).default(300000),
  MESSAGE_PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(120),
  MESSAGE_TTL_SECONDS: z.coerce.number().int().min(10).default(86400),
  MESSAGE_MAX_LENGTH: z.coerce.number().int().min(1).max(65000).default(4096),
  MAX_PENDING_PER_TENANT: z.coerce.number().int().min(1).default(1000),
  SEND_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  SESSION_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(1500),
  QUEUE_POLL_MS: z.coerce.number().int().min(50).default(1000),
  VERIFY_RECIPIENT: z.enum(['true', 'false']).default('true'),
  // Fase F1: webhook
  ENABLE_EMBEDDED_WEBHOOK_WORKER: z.enum(['true', 'false']).default('true'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(500),
  WEBHOOK_POLL_MS: z.coerce.number().int().min(50).default(1000),
  WEBHOOK_BATCH: z.coerce.number().int().min(1).max(200).default(20),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).default(10000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(1).default(10000),
  WEBHOOK_RETRY_MAX_MS: z.coerce.number().int().min(1).default(3600000),
  // Nonaktifkan endpoint otomatis setelah N delivery DEAD berturut-turut (0 = mati). Aktifkan ulang lewat PATCH active=true.
  WEBHOOK_AUTO_DISABLE_AFTER: z.coerce.number().int().min(0).default(10),
  WEBHOOK_MAX_ENDPOINTS: z.coerce.number().int().min(1).default(10),
  // Default AMAN: hanya https ke alamat publik. Aktifkan hanya untuk dev/lab internal.
  WEBHOOK_ALLOW_HTTP: z.enum(['true', 'false']).default('false'),
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z.enum(['true', 'false']).default('false'),
  // Fase F2: realtime
  REALTIME_MAX_SOCKETS_PER_TENANT: z.coerce.number().int().min(1).default(50),
  REALTIME_REVALIDATE_SECONDS: z.coerce.number().int().min(1).default(30),
  // Fase F4: media & bulk
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(16 * 1024 * 1024),
  MEDIA_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  MEDIA_ALLOW_HTTP: z.enum(['true', 'false']).default('false'),
  MEDIA_ALLOW_PRIVATE_TARGETS: z.enum(['true', 'false']).default('false'),
  BULK_MAX_MESSAGES: z.coerce.number().int().min(1).max(1000).default(100),
  // Fase F5: retensi (ADR-019). CONTENT <= ROW dipaksakan saat job dibuat.
  ENABLE_EMBEDDED_RETENTION: z.enum(['true', 'false']).default('true'),
  RETENTION_CONTENT_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_ROW_DAYS: z.coerce.number().int().min(1).default(180),
  RETENTION_OUTBOX_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_WEBHOOK_DELIVERY_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
  RETENTION_BATCH: z.coerce.number().int().min(10).max(5000).default(500),
  // Fase G: pemisahan role DB. Bila DB_MIGRATE_USERNAME diisi, migrasi memakai kredensial ini (pemilik schema)
  // sedangkan runtime memakai DB_USERNAME (hak DML saja). Lihat docs/07_DEPLOYMENT/DB_ROLES.md.
  DB_MIGRATE_USERNAME: z.string().optional(),
  DB_MIGRATE_PASSWORD: z.string().optional(),
  // false di produksi: migrasi dijalankan terpisah (`npm run migrate:prod`) sebelum deploy.
  AUTO_MIGRATE: z.enum(['true', 'false']).default('true'),
  // enforce = tolak start bila role runtime superuser/BYPASSRLS; warn = hanya peringatan. Default: enforce di production.
  DB_ROLE_CHECK: z.enum(['enforce', 'warn', 'off']).optional(),
  // Fase G: pembatasan laju API (per menit; 0 = mati). IP dinilai sebelum autentikasi, tenant sesudahnya.
  API_RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(0).default(600),
  API_RATE_LIMIT_TENANT_PER_MINUTE: z.coerce.number().int().min(0).default(1200),
  // true hanya bila di belakang reverse proxy tepercaya (agar req.ip = IP klien sebenarnya, bukan IP proxy).
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  // Batas hitungan `meta.total` pada daftar besar (pesan, chat): count eksak O(n) per halaman tidak skalabel. Di atas batas: total = batas + total_capped=true.
  LIST_COUNT_CAP: z.coerce.number().int().min(100).default(10000),
  CORS_ORIGINS: z.string().default(''),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

export type AppConfig = z.infer<typeof schema>;

/** Parse + validasi environment. Fail fast dengan pesan yang tidak membocorkan nilai. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Konfigurasi environment tidak valid: ${issues}`);
  }
  return result.data;
}

dotenv.config({ quiet: true });
export const config: AppConfig = loadConfig(process.env);
