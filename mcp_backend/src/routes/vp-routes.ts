/**
 * Public pages of Grand Chamber (ВП ВС) decisions.
 *
 *   GET /pozytsiia-vs                index: years, newest decisions
 *   GET /pozytsiia-vs/rik-<year>     all decisions of a year
 *   GET /pozytsiia-vs/<slug>         one decision: official ЄДРСР text, articles applied
 *   GET /pozytsiia-vs/sitemap.xml
 *
 * Nothing on these pages is generated: the text is the anonymised ЄДРСР text.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { cachedHtml } from '../services/seo/seo-cache.js';
import { esc } from '../services/seo/seo-page.js';
import { renderSitemap } from '../services/seo/zakon-render.js';
import { VpRepository } from '../services/seo/vp-repository.js';
import { renderVpDecision, renderVpIndex, renderVpYear } from '../services/seo/vp-render.js';

const TTL_S = 12 * 60 * 60;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YEAR = /^rik-(\d{4})$/;

function notFound(res: Response): void {
  res.status(404).type('html').set('Cache-Control', 'public, max-age=300').send(
    '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Сторінку не знайдено | LEX</title></head>' +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${esc('Сторінку не знайдено')}</h1><p><a href="/pozytsiia-vs">Постанови Великої Палати ВС</a></p></body></html>`,
  );
}

const send = (res: Response, html: string) =>
  res.status(200).type('html').set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400').send(html);

export function createVpRoutes(db: BaseDatabase): Router {
  const repo = new VpRepository(db);
  const router = Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[pozytsiia-vs] render failed', { path: req.originalUrl, err: (err as Error).message });
      next(err);
    });

  router.get('/', wrap(async (_req, res) => {
    const html = await cachedHtml('vp:v1:index', TTL_S, async () => renderVpIndex(await repo.years(), await repo.latest(30)));
    send(res, html!);
  }));

  router.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cachedHtml('vp:v1:sitemap', TTL_S, async () => {
      const items = await repo.sitemap();
      const years = await repo.years();
      const newest = items[0]?.lastmod ?? new Date().toISOString().slice(0, 10);
      return renderSitemap([
        { path: '/pozytsiia-vs', lastmod: newest },
        ...years.map(y => ({ path: `/pozytsiia-vs/rik-${y.year}`, lastmod: newest })),
        ...items.map(i => ({ path: `/pozytsiia-vs/${i.slug}`, lastmod: i.lastmod })),
      ]);
    });
    res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  }));

  router.get('/:slug', wrap(async (req, res) => {
    const slug = String(req.params.slug);
    const y = YEAR.exec(slug);
    if (y) {
      const year = Number(y[1]);
      const html = await cachedHtml(`vp:v1:year:${year}`, TTL_S, async () => {
        const items = await repo.byYear(year);
        return items.length ? renderVpYear(year, items) : null;
      });
      return html ? void send(res, html) : notFound(res);
    }
    if (!SLUG.test(slug)) return notFound(res);
    const html = await cachedHtml(`vp:v1:doc:${slug}`, TTL_S, async () => {
      const d = await repo.bySlug(slug);
      return d ? renderVpDecision(d, await repo.articles(slug)) : null;
    });
    if (!html) return notFound(res);
    send(res, html);
  }));

  return router;
}
