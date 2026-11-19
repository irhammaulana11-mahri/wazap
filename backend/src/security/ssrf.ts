import dns from 'node:dns';
import net from 'node:net';

/**
 * Perlindungan SSRF untuk tujuan webhook. Tiga lapis:
 *  1) validasi URL (skema, tanpa kredensial, port),
 *  2) pengecekan IP hasil resolusi DNS saat endpoint dibuat/diubah,
 *  3) pengecekan IP SAAT KONEKSI (lookup kustom) agar DNS rebinding tidak lolos; redirect tidak diikuti.
 */
export class BlockedTargetError extends Error {
  constructor(readonly code: 'BLOCKED_TARGET' | 'DNS_FAILED' | 'INVALID_URL', message: string) {
    super(message);
  }
}

const blocked = new net.BlockList();
const v4 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, 'ipv4');
const v6 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, 'ipv6');
v4('0.0.0.0', 8); v4('10.0.0.0', 8); v4('100.64.0.0', 10); v4('127.0.0.0', 8); v4('169.254.0.0', 16);
v4('172.16.0.0', 12); v4('192.0.0.0', 24); v4('192.0.2.0', 24); v4('192.88.99.0', 24); v4('192.168.0.0', 16);
v4('198.18.0.0', 15); v4('198.51.100.0', 24); v4('203.0.113.0', 24); v4('224.0.0.0', 4); v4('240.0.0.0', 4);
v6('::', 128); v6('::1', 128); v6('fc00::', 7); v6('fe80::', 10); v6('ff00::', 8); v6('2001:db8::', 32);
v6('2001::', 32); v6('2002::', 16); v6('64:ff9b::', 96); v6('100::', 64);

/** Alamat IPv4-mapped (::ffff:a.b.c.d atau ::ffff:hhhh:hhhh) => bentuk IPv4-nya; selain itu null. */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1]!;
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) {
    const a = parseInt(h[1]!, 16), b = parseInt(h[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** true bila IP bukan alamat publik yang boleh dituju. Format tidak valid dianggap diblokir. */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 4) return blocked.check(ip, 'ipv4');
  const mapped = mappedV4(ip);
  if (mapped) return isBlockedIp(mapped);
  return blocked.check(ip, 'ipv6');
}

export interface UrlPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

/** Validasi sintaks URL tujuan. Mengembalikan URL ter-parse. */
export function parseWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedTargetError('INVALID_URL', 'URL tidak valid'); }
  if (u.protocol !== 'https:' && !(policy.allowHttp && u.protocol === 'http:')) {
    throw new BlockedTargetError('INVALID_URL', policy.allowHttp ? 'hanya http/https' : 'URL harus https');
  }
  if (u.username || u.password) throw new BlockedTargetError('INVALID_URL', 'URL tidak boleh memuat kredensial');
  if (!u.hostname) throw new BlockedTargetError('INVALID_URL', 'host kosong');
  if (u.port && !/^\d+$/.test(u.port)) throw new BlockedTargetError('INVALID_URL', 'port tidak valid');
  if (!policy.allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new BlockedTargetError('BLOCKED_TARGET', 'host internal tidak diizinkan');
    }
    if (net.isIP(host) && isBlockedIp(host)) throw new BlockedTargetError('BLOCKED_TARGET', 'alamat jaringan internal tidak diizinkan');
  }
  return u;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Resolusi + pemeriksaan: SEMUA alamat harus publik (satu alamat privat saja => ditolak). */
export async function assertPublicHost(host: string, policy: UrlPolicy, resolve: Resolver = defaultResolver): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try { addrs = await resolve(h); } catch { throw new BlockedTargetError('DNS_FAILED', 'host tidak dapat di-resolve'); }
    if (!addrs.length) throw new BlockedTargetError('DNS_FAILED', 'host tidak dapat di-resolve');
  }
  if (!policy.allowPrivate && addrs.some(isBlockedIp)) throw new BlockedTargetError('BLOCKED_TARGET', 'host mengarah ke jaringan internal');
}

/**
 * `lookup` untuk http(s).request: resolusi lalu cek IP YANG AKAN DIPAKAI untuk koneksi (menutup celah DNS rebinding).
 * Bila ada alamat privat di hasil resolusi, seluruh koneksi ditolak.
 */
export function createSafeLookup(policy: UrlPolicy, resolve: Resolver = defaultResolver) {
  return (hostname: string, opts: dns.LookupOptions | undefined, cb: (err: Error | null, address?: any, family?: number) => void) => {
    void (async () => {
      try {
        const h = hostname.replace(/^\[|\]$/g, '');
        const addrs = net.isIP(h) ? [h] : await resolve(h);
        if (!addrs.length) throw new BlockedTargetError('DNS_FAILED', 'host tidak dapat di-resolve');
        if (!policy.allowPrivate && addrs.some(isBlockedIp)) throw new BlockedTargetError('BLOCKED_TARGET', 'host mengarah ke jaringan internal');
        const first = addrs[0]!;
        if (opts && (opts as { all?: boolean }).all) cb(null, addrs.map((a) => ({ address: a, family: net.isIP(a) })));
        else cb(null, first, net.isIP(first));
      } catch (e) {
        cb(e as Error);
      }
    })();
  };
}
