import type { Queryable } from '../db';
import { hashPassword } from './password';

export interface User {
  id: number;
  email: string;
  displayName: string;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export async function upsertUser(pool: Queryable, email: string, password: string, displayName = ''): Promise<void> {
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO attorney_crm_users (email, password_hash, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE attorney_crm_users.display_name END`,
    [email.trim().toLowerCase(), passwordHash, displayName],
  );
}

export async function findUserByEmail(pool: Queryable, email: string): Promise<UserWithHash | null> {
  const r = await pool.query<{ id: number; email: string; display_name: string; password_hash: string }>(
    'SELECT id, email, display_name, password_hash FROM attorney_crm_users WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const row = r.rows[0];
  return row ? { id: row.id, email: row.email, displayName: row.display_name, passwordHash: row.password_hash } : null;
}

export async function touchLogin(pool: Queryable, userId: number): Promise<void> {
  await pool.query('UPDATE attorney_crm_users SET last_login_at = NOW() WHERE id = $1', [userId]);
}
