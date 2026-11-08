import { createHmac, timingSafeEqual } from 'crypto';

// Unsubscribe links carry the address itself plus an HMAC over it, so the public
// endpoint needs no token table and a link stays valid for as long as the secret
// does. Format: base64url(email) + '.' + base64url(hmac-sha256(secret, email)[0..16]).

const B64 = /^[A-Za-z0-9_-]+$/;

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function mac(secret: string, email: string): Buffer {
  return createHmac('sha256', secret).update(`unsubscribe:${email}`).digest().subarray(0, 16);
}

export function signUnsubscribeToken(secret: string, rawEmail: string): string {
  const email = normaliseEmail(rawEmail);
  return `${Buffer.from(email, 'utf8').toString('base64url')}.${mac(secret, email).toString('base64url')}`;
}

/** The address a token was issued for, or null when the token is malformed or forged. */
export function verifyUnsubscribeToken(secret: string, token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const [emailPart, macPart] = [token.slice(0, dot), token.slice(dot + 1)];
  if (!B64.test(emailPart) || !B64.test(macPart)) return null;
  const email = Buffer.from(emailPart, 'base64url').toString('utf8');
  if (!email.includes('@') || normaliseEmail(email) !== email) return null;
  const expected = mac(secret, email);
  const given = Buffer.from(macPart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return email;
}
