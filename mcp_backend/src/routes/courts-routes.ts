/**
 * Public, server-rendered SEO pages for courts and judges.
 *
 *   GET /sud                  courts by region
 *   GET /sud/:slug            one court: judges, decisions by year and kind
 *   GET /sud/sitemap.xml
 *   GET /suddia               → 301 /sud
 *   GET /suddia/:slug         one judge (keyed by dossier number)
 *   GET /suddia/sitemap.xml
 *
 * Data: seo_* tables filled by services/seo/courts-refresh.ts, plus the
 * judges register. No discipline data: ВРП/ВККС records match judges only by
 * name, and a namesake must never be shown as dismissed.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { cachedHtml } from '../services/seo/seo-cache.js';
import { esc } from '../services/seo/seo-page.js';
import { renderSitemap } from '../services/seo/zakon-render.js';
import { CourtsRepository, shortName, type Hearings } from '../services/seo/courts-repository.js';
import { renderCourtsIndex, renderCourt, renderJudge } from '../services/seo/courts-render.js';

const TTL_S = 6 * 60 * 60;
const HTML_CACHE_CONTROL = 'public, max-age=600, stale-while-revalidate=86400';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function notFound(res: Response): void {
  res.status(404).type('html').set('Cache-Control', 'public, max-age=300').send(
    '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Сторінку не знайдено | LEX</title></head>' +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${esc('Сторінку не знайдено')}</h1><p><a href="/sud">Суди України</a></p></body></html>`,
  );
}

const send = (res: Response, html: string) => res.status(200).type('html').set('Cache-Control', HTML_CACHE_CONTROL).send(html);
const sendXml = (res: Response, xml: string) => res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);

export function createCourtsRoutes(db: BaseDatabase): { courts: Router; judges: Router } {
  const repo = new CourtsRepository(db);
  const NO_HEARINGS: Hearings = { items: [], asOf: null };
  /** The schedule is a nice-to-have: if it fails, the page still renders without it. */
  const hearingsOf = (court: string, judge?: string) =>
    repo.upcomingHearings(court, judge).catch((err: Error) => {
      logger.warn('[seo] upcoming hearings failed', { court, error: err.message });
      return NO_HEARINGS;
    });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[sud] render failed', { path: req.originalUrl, err: (err as Error).message });
      next(err);
    });

  const courts = Router();
  courts.get('/', wrap(async (_req, res) => {
    const html = await cachedHtml('sud:v1:index', TTL_S, async () => renderCourtsIndex(await repo.listCourts()));
    send(res, html!);
  }));
  courts.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cachedHtml('sud:v1:sitemap', TTL_S, async () => {
      const lastmod = (await repo.statsRefreshedAt()) ?? new Date().toISOString().slice(0, 10);
      const list = await repo.listCourts();
      return renderSitemap([{ path: '/sud', lastmod }, ...list.map(c => ({ path: `/sud/${c.slug}`, lastmod }))]);
    });
    sendXml(res, xml!);
  }));
  courts.get('/:slug', wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) return notFound(res);
    const html = await cachedHtml(`sud:v2:court:${slug}`, TTL_S, async () => {
      const court = await repo.courtBySlug(slug);
      if (!court) return null;
      const [stats, judges, hearings] = await Promise.all([
        repo.courtStats(court.courtCode), repo.courtJudges(court.courtCode), hearingsOf(court.name),
      ]);
      return renderCourt(court, stats, judges, new Date(), hearings);
    });
    if (!html) return notFound(res);
    send(res, html);
  }));

  const judges = Router();
  judges.get('/', (_req, res) => res.redirect(301, '/sud'));
  judges.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cachedHtml('suddia:v1:sitemap', TTL_S, async () =>
      renderSitemap((await repo.judgeSitemap()).map(j => ({ path: `/suddia/${j.slug}`, lastmod: j.lastmod }))));
    sendXml(res, xml!);
  }));
  judges.get('/:slug', wrap(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) return notFound(res);
    const html = await cachedHtml(`suddia:v2:${slug}`, TTL_S, async () => {
      const j = await repo.judgeBySlug(slug);
      if (!j) return null;
      const listed = j.lastSeen !== null && j.lastSeen === j.registerDate;
      const short = shortName(j.fullName);
      const courtName = j.court?.name ?? j.courtName;
      const [career, stats, hearings] = await Promise.all([
        repo.judgeCareer(j.dossier),
        j.courtCode !== null && j.judgeKey ? repo.judgeStats(j.courtCode, j.judgeKey) : Promise.resolve([]),
        listed && short && courtName ? hearingsOf(courtName, short) : Promise.resolve(NO_HEARINGS),
      ]);
      return renderJudge(j, career, stats, hearings);
    });
    if (!html) return notFound(res);
    send(res, html);
  }));

  return { courts, judges };
}
