import { assertPublicHost, BlockedTargetError, parseWebhookUrl, type Resolver, type UrlPolicy } from './ssrf.js';

export const alertTargetAad = (tenantId: string, channelId: string) => `wazap:alert-target:v1|${tenantId}|${channelId}`;

export type ChannelType = 'TELEGRAM' | 'SLACK';
export interface TelegramTarget { token: string; chat_id: string }
export const TELEGRAM_HOST = 'api.telegram.org';
/** Hanya host ini yang diizinkan untuk kanal Slack-compatible (anti-SSRF berlapis di atas asersi host publik). */
export const SLACK_HOSTS = ['hooks.slack.com', 'discord.com', 'discordapp.com'];

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export class InvalidTargetError extends Error {}

export function validateTelegram(t: { token?: unknown; chat_id?: unknown }): TelegramTarget {
  const token = typeof t.token === 'string' ? t.token.trim() : '', chat_id = typeof t.chat_id === 'string' ? t.chat_id.trim() : '';
  if (!TOKEN_RE.test(token)) throw new InvalidTargetError('Token bot Telegram tidak valid');
  if (!CHAT_RE.test(chat_id)) throw new InvalidTargetError('chat_id Telegram tidak valid (angka, atau @namakanal)');
  return { token, chat_id };
}

/** URL webhook Slack-compatible: https, tanpa kredensial, host dalam daftar izin, dan host harus publik (DNS dicek). Mengembalikan URL ternormalisasi. */
export async function validateSlackUrl(raw: string, policy: UrlPolicy, resolve?: Resolver): Promise<string> {
  try {
    const u = parseWebhookUrl(raw.trim(), { ...policy, allowHttp: false });
    if (!SLACK_HOSTS.includes(u.hostname.toLowerCase())) throw new InvalidTargetError(`Host webhook harus salah satu dari: ${SLACK_HOSTS.join(', ')}`);
    if (u.port && u.port !== '443') throw new InvalidTargetError('Port webhook harus 443');
    await assertPublicHost(u.hostname, policy, resolve);
    return u.toString();
  } catch (e) {
    if (e instanceof BlockedTargetError) throw new InvalidTargetError(e.message);
    throw e;
  }
}

/** Petunjuk 4 karakter terakhir (tidak cukup untuk menebak rahasia). */
export const hintOf = (secret: string) => secret.slice(-4);
