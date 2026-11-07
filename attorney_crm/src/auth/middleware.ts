import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../db';
import { parseCookies } from './cookies';
import { COOKIE_NAME, clearCookieOptions, resolveSession } from './session';
import type { User } from './users';

declare module 'express-serve-static-core' {
  interface Locals {
    user?: User;
  }
}

async function lookup(pool: Queryable, secret: string, req: Request, res: Response): Promise<User | null> {
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const user = await resolveSession(pool, value, secret);
  if (!user && value) res.clearCookie(COOKIE_NAME, clearCookieOptions());
  if (user) res.locals.user = user;
  return user;
}

/** Sets res.locals.user when a live session cookie is present; never redirects. */
export function attachUser(pool: Queryable, secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    lookup(pool, secret, req, res).then(() => next(), next);
  };
}

/** Requires a live session; otherwise 302 to /login. */
export function requireLogin(pool: Queryable, secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    lookup(pool, secret, req, res).then((user) => (user ? next() : res.redirect('/login')), next);
  };
}
