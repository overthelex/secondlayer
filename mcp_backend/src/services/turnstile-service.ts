/**
 * Cloudflare Turnstile verification for the password login and registration forms.
 *
 * - TURNSTILE_SECRET_KEY unset  -> checks are disabled (local dev, tests).
 * - Native mobile app (Dart/Dio, no widget) is exempt by User-Agent; browsers must send a token.
 * - siteverify unreachable      -> fail open with a loud log line; an outage must not lock
 *                                  every user out, and the auth rate limit still applies.
 */
import type { Request } from 'express';
import { logger } from '../utils/logger.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileRejection {
  status: number;
  body: { error: string; code: string; message: string };
}

export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export function isMobileAppRequest(req: Request): boolean {
  const ua = String(req.headers['user-agent'] || '');
  return /^Dart\//.test(ua);
}

export function turnstileRequired(req: Request): boolean {
  if (!turnstileEnabled()) return false;
  return !isMobileAppRequest(req);
}

export function extractTurnstileToken(req: Request): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const candidate = body.turnstileToken ?? body['cf-turnstile-response'] ?? req.headers['cf-turnstile-response'];
  if (typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > MAX_TOKEN_LENGTH) return null;
  return candidate;
}

export async function verifyTurnstileToken(
  token: string,
  remoteip?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; codes: string[] }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, codes: [] };

  const params = new URLSearchParams({ secret, response: token });
  if (remoteip) params.set('remoteip', remoteip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body: params, signal: controller.signal });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return { ok: data.success === true, codes: data['error-codes'] ?? [] };
  } catch (error: any) {
    logger.error('Turnstile siteverify unreachable, letting the request through', { error: error.message });
    return { ok: true, codes: ['siteverify-unreachable'] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gate for login/register handlers. Returns null when the request may proceed,
 * otherwise the HTTP response to send.
 */
export async function requireTurnstile(req: Request): Promise<TurnstileRejection | null> {
  if (!turnstileRequired(req)) return null;

  const ip = (req.headers['cf-connecting-ip'] as string | undefined) || req.ip;
  const token = extractTurnstileToken(req);
  if (!token) {
    logger.warn('Turnstile token missing on auth request', { ip, path: req.path });
    return {
      status: 403,
      body: { error: 'Forbidden', code: 'TURNSTILE_REQUIRED', message: 'Підтвердіть, що ви не робот, і спробуйте ще раз' },
    };
  }

  const verdict = await verifyTurnstileToken(token, ip);
  if (!verdict.ok) {
    logger.warn('Turnstile rejected auth request', { ip, path: req.path, codes: verdict.codes });
    return {
      status: 403,
      body: { error: 'Forbidden', code: 'TURNSTILE_FAILED', message: 'Перевірку не пройдено. Оновіть сторінку і спробуйте ще раз' },
    };
  }
  return null;
}
