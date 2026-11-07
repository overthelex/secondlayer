import { Router } from 'express';
import type { Queryable } from '../db';
import { findUserByEmail, touchLogin } from '../auth/users';
import { verifyPassword } from '../auth/password';
import { COOKIE_NAME, cookieOptions, createSession, destroySession } from '../auth/session';
import { parseCookies } from '../auth/cookies';
import type { LoginRateLimit } from '../auth/rate-limit';
import { attachUser } from '../auth/middleware';
import { renderLogin } from '../views/login';

export const BLOCKED_MESSAGE = 'Забагато спроб. Спробуйте за 15 хвилин.';
export const BAD_CREDENTIALS = 'Невірний e-mail або пароль';

export function authRoutes(pool: Queryable, rateLimit: LoginRateLimit): Router {
  const r = Router();

  r.get('/login', attachUser(pool), (_req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.type('html').send(renderLogin({}));
  });

  r.post('/login', async (req, res, next) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (rateLimit.isBlocked(email)) {
        return res.status(429).type('html').send(renderLogin({ error: BLOCKED_MESSAGE, email }));
      }
      const user = email ? await findUserByEmail(pool, email) : null;
      const ok = user ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !ok) {
        rateLimit.recordFailure(email);
        return res.status(200).type('html').send(renderLogin({ error: BAD_CREDENTIALS, email }));
      }
      rateLimit.reset(email);
      const value = await createSession(pool, user.id);
      await touchLogin(pool, user.id);
      res.cookie(COOKIE_NAME, value, cookieOptions());
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  r.post('/logout', async (req, res, next) => {
    try {
      const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (value) await destroySession(pool, value);
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.redirect('/login');
    } catch (err) {
      next(err);
    }
  });

  return r;
}
