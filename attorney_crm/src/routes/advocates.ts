import { Router } from 'express';
import type { Queryable } from '../db';
import { listAdvocates, listCities, listRegions } from '../advocates/repo';
import type { AdvocateFilters, SortKey } from '../advocates/query';
import { renderAdvocatesPage } from '../views/advocates';

const SORT_KEYS: SortKey[] = ['surname', 'city', 'region', 'cases', 'last_contact', 'next_contact'];

export function parseFilters(q: Record<string, unknown>): AdvocateFilters {
  const s = (k: string) => (typeof q[k] === 'string' && (q[k] as string).trim() ? (q[k] as string).trim() : undefined);
  const kind = Number(s('justice_kind'));
  const page = Number(s('page'));
  const sort = s('sort');
  const dir = s('dir');
  return {
    surnamePrefix: s('surname'),
    city: s('city'),
    region: s('region'),
    justiceKind: kind >= 1 && kind <= 5 ? kind : undefined,
    manualPractice: s('practice'),
    stage: s('stage'),
    sort: sort && SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : undefined,
    dir: dir === 'asc' || dir === 'desc' ? dir : undefined,
    page: page >= 1 ? Math.floor(page) : 1,
  };
}

export function advocatesRoutes(pool: Queryable): Router {
  const r = Router();
  r.get('/advocates', async (req, res, next) => {
    try {
      const filters = parseFilters(req.query as Record<string, unknown>);
      const [list, cities, regions] = await Promise.all([listAdvocates(pool, filters), listCities(pool), listRegions(pool)]);
      res.type('html').send(renderAdvocatesPage({ ...list, filters, cities, regions, user: res.locals.user! }));
    } catch (err) {
      next(err);
    }
  });
  return r;
}
