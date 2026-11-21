import crypto from 'crypto';
import { config } from '../../config/env.js';

/**
 * Token platform admin (ADR-054). Dua jenis, masing-masing dengan kunci turunan SENDIRI (domain separation dari JWT_SECRET) dan klaim `typ` sendiri, sehingga:
 *  - token workspace (typ 'access', kunci lain) TIDAK PERNAH sah sebagai token platform dan sebaliknya (diuji silang);
 *  - token MFA (kata sandi benar, belum TOTP) TIDAK dapat dipakai untuk memanggil rute apa pun selain /platform/auth/verify.
 * Tanpa refresh token: umur pendek (PLATFORM_TOKEN_TTL_SECONDS); setelah itu login ulang dengan kata sandi + TOTP.
 */
type Typ = 'platform' | 'platform_mfa';
const key = (typ: Typ) => crypto.createHmac('sha256', config.JWT_SECRET).update(`wazap:${typ === 'platform' ? 'platform-token' : 'platform-mfa'}:v1`).digest();
const sig = (typ: Typ, body: string) => crypto.createHmac('sha256', key(typ)).update(body).digest('base64url');

export interface PlatformClaims { sub: string; tv: number; exp: number }

function sign(typ: Typ, userId: string, tokenVersion: number, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ typ, sub: userId, tv: tokenVersion, exp: Math.floor(Date.now() / 1000) + ttlSeconds, jti: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${sig(typ, body)}`;
}

function verify(typ: Typ, token: string): PlatformClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, s, extra] = token.split('.');
  if (!body || !s || extra !== undefined) return null;
  const a = Buffer.from(s), b = Buffer.from(sig(typ, body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (c.typ !== typ || typeof c.sub !== 'string' || typeof c.exp !== 'number' || c.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: c.sub, tv: typeof c.tv === 'number' ? c.tv : 0, exp: c.exp };
  } catch { return null; }
}

export const signMfaToken = (userId: string, tokenVersion: number, ttl = config.PLATFORM_MFA_TOKEN_TTL_SECONDS) => sign('platform_mfa', userId, tokenVersion, ttl);
export const verifyMfaToken = (t: string) => verify('platform_mfa', t);
export const signPlatformToken = (userId: string, tokenVersion: number, ttl = config.PLATFORM_TOKEN_TTL_SECONDS) => sign('platform', userId, tokenVersion, ttl);
export const verifyPlatformToken = (t: string) => verify('platform', t);
