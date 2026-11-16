/**
 * Public pages of the most cited cassation decisions of the Supreme Court
 * (КЦС, КГС, КАС, ККС ВС).
 *
 *   GET /praktyka-vs                index: years, most cited per court
 *   GET /praktyka-vs/rik-<year>     published decisions of a year
 *   GET /praktyka-vs/<slug>         one decision: official ЄДРСР text, articles, links
 *   GET /praktyka-vs/sitemap.xml
 *
 * Nothing on these pages is generated: the text is the anonymised ЄДРСР text.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { cachedHtml } from '../services/seo/seo-cache.js';
import { esc } from '../services/seo/seo-page.js';
import { renderSitemap } from '../services/seo/zakon-render.js';
import { CassationRepository, CASSATION_COURT_INFO } from '../services/seo/cassation-repository.js';
import { renderCassationDecision, renderCassationIndex, renderCassationYear } from '../services/seo/cassation-render.js';

const TTL_S = 12 * 60 * 60;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YEAR = /^rik-(\d{4})$/;
const TOP_PER_COURT = 25;

function notFound(res: Response): void {
  res.status(404).type('html').set('Cache-Control', 'public, max-age=300').send(
    '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Сторінку не знайдено | LEX</title></head>' +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${esc('Сторінку не знайдено')}</h1><p><a href="/praktyka-vs">Практика Верховного Суду</a></p></body></html>`,
  );
}

const send = (res: Response, html: string) =>
  res.status(200).type('html').set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400').send(html);

export function createCassationRoutes(db: BaseDatabase): Router {
  const repo = new CassationRepository(db);
  const router = Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[praktyka-vs] render failed', { path: req.originalUrl, err: (err as Error).message });
      next(err);
    });

  router.get('/', wrap(async (_req, res) => {
    const html = await cachedHtml('cass:v1:index', TTL_S, async () => {
      const top = new Map<number, Awaited<ReturnType<typeof repo.topCited>>>();
      for (const c of CASSATION_COURT_INFO) top.set(c.code, await repo.topCited(c.code, TOP_PER_COURT));
      return renderCassationIndex(await repo.years(), await repo.courts(), top);
    });
    send(res, html!);
  }));

  router.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cachedHtml('cass:v1:sitemap', TTL_S, async () => {
      const items = await repo.sitemap();
      const years = await repo.years();
      const newest = items.reduce((m, i) => (i.lastmod > m ? i.lastmod : m), '') || new Date().toISOString().slice(0, 10);
      return renderSitemap([
        { path: '/praktyka-vs', lastmod: newest },
        ...years.map(y => ({ path: `/praktyka-vs/rik-${y.year}`, lastmod: newest })),
        ...items.map(i => ({ path: `/praktyka-vs/${i.slug}`, lastmod: i.lastmod })),
      ]);
    });
    res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  }));

  router.get('/:slug', wrap(async (req, res) => {
    const slug = String(req.params.slug);
    const y = YEAR.exec(slug);
    if (y) {
      const year = Number(y[1]);
      const html = await cachedHtml(`cass:v1:year:${year}`, TTL_S, async () => {
        const items = await repo.byYear(year);
        return items.length ? renderCassationYear(year, items) : null;
      });
      return html ? void send(res, html) : notFound(res);
    }
    if (!SLUG.test(slug)) return notFound(res);
    const html = await cachedHtml(`cass:v1:doc:${slug}`, TTL_S, async () => {
      const d = await repo.bySlug(slug);
      if (!d) return null;
      const [arts, cites, citedBy] = await Promise.all([repo.articles(slug), repo.cites(d.docId), repo.citedBy(d.causeNum, d.docId)]);
      return renderCassationDecision(d, arts, { cites, citedBy });
    });
    if (!html) return notFound(res);
    send(res, html);
  }));

  return router;
}
