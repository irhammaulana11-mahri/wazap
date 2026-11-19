import crypto from 'crypto';
import { config } from '../../config/env.js';

export const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Domain separation: kunci turunan khusus access token (bukan JWT_SECRET mentah).
const key = () => crypto.createHmac('sha256', config.JWT_SECRET).update('wazap:access-token:v1').digest();

export interface AccessClaims {
  sub: string; // user id
  tid: string; // tenant aktif (diverifikasi ulang terhadap membership di DB setiap request)
  exp: number;
}

const sig = (body: string) => crypto.createHmac('sha256', key()).update(body).digest('base64url');

export function signAccessToken(userId: string, tenantId: string, ttlSeconds = config.ACCESS_TOKEN_TTL_SECONDS) {
  const claims: AccessClaims & { typ: 'access' } = {
    typ: 'access',
    sub: userId,
    tid: tenantId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sig(body)}`;
}

export function verifyAccessToken(token: string): AccessClaims | null {
  const [body, s, extra] = token.split('.');
  if (!body || !s || extra !== undefined) return null;
  const a = Buffer.from(s);
  const b = Buffer.from(sig(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (c.typ !== 'access' || typeof c.sub !== 'string' || typeof c.tid !== 'string') return null;
    if (typeof c.exp !== 'number' || c.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: c.sub, tid: c.tid, exp: c.exp };
  } catch {
    return null;
  }
}
