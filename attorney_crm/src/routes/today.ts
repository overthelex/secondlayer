import { Router } from 'express';
import type { Queryable } from '../db';
import { dueToday, recentNotes } from '../leads/repo';
import { renderTodayPage } from '../views/today';

export function todayRoutes(pool: Queryable): Router {
  const r = Router();
  r.get('/', async (_req, res, next) => {
    try {
      const [due, notes] = await Promise.all([dueToday(pool), recentNotes(pool)]);
      res.type('html').send(renderTodayPage({ due, notes, user: res.locals.user! }));
    } catch (err) {
      next(err);
    }
  });
  return r;
}
