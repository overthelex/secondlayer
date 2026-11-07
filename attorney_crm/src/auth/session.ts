import { createHmac, randomBytes } from 'crypto';
import type { CookieOptions } from 'express';
import type { Queryable } from '../db';
import type { User } from './users';

export const COOKIE_NAME = 'acrm_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;

// The DB stores HMAC(secret, token): a dumped sessions table is useless without
// ATTORNEY_CRM_SESSION_SECRET, and rotating the secret logs everyone out.
function hashToken(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Creates a session row and returns the cookie value (never stored itself). */
export async function createSession(pool: Queryable, userId: number, secret: string, now: Date = new Date()): Promise<string> {
  const value = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  await pool.query('INSERT INTO attorney_crm_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(value, secret),
    userId,
    expiresAt,
  ]);
  return value;
}

/** Resolves a cookie value to its user; an expired session is deleted and treated as absent. */
export async function resolveSession(
  pool: Queryable,
  cookieValue: string | undefined,
  secret: string,
  now: Date = new Date(),
): Promise<User | null> {
  if (!cookieValue) return null;
  const tokenHash = hashToken(cookieValue, secret);
  const r = await pool.query<{ id: number; email: string; display_name: string; expires_at: Date }>(
    `SELECT u.id, u.email, u.display_name, s.expires_at
       FROM attorney_crm_sessions s JOIN attorney_crm_users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await pool.query('DELETE FROM attorney_crm_sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function destroySession(pool: Queryable, cookieValue: string, secret: string): Promise<void> {
  await pool.query('DELETE FROM attorney_crm_sessions WHERE token_hash = $1', [hashToken(cookieValue, secret)]);
}

export function cookieOptions(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_MS };
}

/** For res.clearCookie: same attributes, no maxAge (Express would turn it into a 30-day Expires). */
export function clearCookieOptions(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
}
