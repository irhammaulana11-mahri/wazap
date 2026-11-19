import crypto from 'node:crypto';

/** Format tanda tangan: HMAC-SHA256 hex atas `${timestamp}.${rawBody}`, dikirim sebagai `v1=<hex>`. */
export function signWebhook(secret: string, timestamp: number | string, rawBody: string): string {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Verifikasi sisi penerima (dipakai tes & dokumentasi). Membandingkan secara constant-time dan menolak timestamp basi. */
export function verifyWebhook(secret: string, timestamp: string, rawBody: string, signature: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const a = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const newWebhookSecret = () => 'whsec_' + crypto.randomBytes(32).toString('base64url');
export const webhookSecretAad = (tenantId: string, endpointId: string) => `wazap:webhook-secret:v1|${tenantId}|${endpointId}`;
