import http from 'node:http';
import https from 'node:https';
import { BlockedTargetError, createSafeLookup, parseWebhookUrl, type Resolver, type UrlPolicy } from '../../security/ssrf.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** Galat pengambilan media. `retryable` = sementara (jaringan/5xx/timeout); permanen => pesan langsung FAILED. Terjadi SEBELUM pengiriman. */
export class MediaError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
  }
}

const ALLOWED: Record<Exclude<MediaKind, 'document'>, RegExp> = {
  image: /^image\/(jpeg|png|webp|gif)$/,
  video: /^video\/(mp4|3gpp|quicktime)$/,
  audio: /^audio\/(ogg|mpeg|mp4|aac|amr|wav|x-wav|webm|opus)$/,
};
const DENY_DOC = /^(text\/html|application\/xhtml\+xml)$/;

export interface FetchedMedia { data: Buffer; mimetype: string }
export interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
  policy: UrlPolicy;
  resolve?: Resolver;
  /** Mimetype dari klien; hanya dipakai untuk dokumen. */
  hintMime?: string;
}

/**
 * Unduh media dari URL klien dengan perlindungan SSRF (lookup terverifikasi saat koneksi), tanpa redirect, batas
 * ukuran (Content-Length dan hitungan byte aktual), timeout total, dan validasi tipe konten.
 * Kita yang mengunduh (bukan Baileys) karena Baileys akan mengikuti URL apa pun tanpa proteksi.
 */
export function fetchMedia(rawUrl: string, kind: MediaKind, o: FetchOptions): Promise<FetchedMedia> {
  return new Promise<FetchedMedia>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let req: http.ClientRequest | undefined;
    const fail = (e: MediaError) => { if (settled) return; settled = true; if (deadline) clearTimeout(deadline); req?.destroy(); reject(e); };
    const ok = (v: FetchedMedia) => { if (settled) return; settled = true; if (deadline) clearTimeout(deadline); resolve(v); };

    let u: URL;
    try { u = parseWebhookUrl(rawUrl, o.policy); } catch { return fail(new MediaError('MEDIA_URL_BLOCKED', false)); }
    const lib = u.protocol === 'https:' ? https : http;
    deadline = setTimeout(() => fail(new MediaError('MEDIA_FETCH_TIMEOUT', true)), o.timeoutMs);
    req = lib.request(u, { method: 'GET', headers: { 'user-agent': 'WAZAP-Media/1.0', accept: '*/*' }, lookup: createSafeLookup(o.policy, o.resolve) as any, agent: false }, (res) => {
      const sc = res.statusCode ?? 0;
      if (sc >= 300 && sc < 400) { res.resume(); return fail(new MediaError('MEDIA_REDIRECT_NOT_FOLLOWED', false)); }
      if (sc < 200 || sc >= 300) { res.resume(); return fail(new MediaError(`MEDIA_HTTP_${sc}`, sc >= 500 || sc === 408 || sc === 429)); }
      const mime = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (kind === 'document' ? DENY_DOC.test(mime) : !ALLOWED[kind].test(mime)) { res.resume(); return fail(new MediaError('MEDIA_TYPE_INVALID', false)); }
      const len = Number(res.headers['content-length'] ?? 0);
      if (len > o.maxBytes) { res.resume(); return fail(new MediaError('MEDIA_TOO_LARGE', false)); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (b: Buffer) => {
        size += b.length;
        if (size > o.maxBytes) return fail(new MediaError('MEDIA_TOO_LARGE', false));
        chunks.push(b);
      });
      res.on('error', () => fail(new MediaError('MEDIA_FETCH_FAILED', true)));
      res.on('aborted', () => fail(new MediaError('MEDIA_FETCH_FAILED', true)));
      res.on('end', () => {
        if (size === 0) return fail(new MediaError('MEDIA_EMPTY', false));
        const hint = o.hintMime?.toLowerCase();
        ok({ data: Buffer.concat(chunks), mimetype: kind === 'document' ? hint || (mime && mime !== 'binary/octet-stream' ? mime : 'application/octet-stream') : mime });
      });
    });
    req.on('error', (err: Error & { code?: string }) => {
      if (err instanceof BlockedTargetError) return fail(new MediaError(err.code === 'DNS_FAILED' ? 'MEDIA_FETCH_FAILED' : 'MEDIA_URL_BLOCKED', err.code === 'DNS_FAILED'));
      fail(new MediaError('MEDIA_FETCH_FAILED', true));
    });
    req.end();
  });
}
