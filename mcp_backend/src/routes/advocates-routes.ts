/**
 * Public pages from the Unified Register of Advocates (ЄРАУ open data).
 *
 *   GET /advokaty                       councils
 *   GET /advokaty/:council              first letters
 *   GET /advokaty/:council/:letter      advocates
 *   GET /advokat/:slug                  one advocate (slug ends with the ЄРАУ id; a stale
 *                                       name part is 301-redirected to the current one)
 *   GET /advokat/sitemap.xml
 *
 * Only advocates whose right to practise is in force and whose record has no
 * other note; never contacts or street addresses; opt-outs in seo_advocate_optout.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { cachedHtml } from '../services/seo/seo-cache.js';
import { esc } from '../services/seo/seo-page.js';
import { renderSitemap } from '../services/seo/zakon-render.js';
import { AdvocatesRepository } from '../services/seo/advocates-repository.js';
import {
  renderAdvocatesIndex, renderCouncil, renderLetter, renderAdvocate,
  councilSlug, letterSlug, letterFromSlug, advocateSlug, idFromSlug,
} from '../services/seo/advocates-render.js';

const TTL_S = 6 * 60 * 60;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function notFound(res: Response): void {
  res.status(404).type('html').set('Cache-Control', 'public, max-age=300').send(
    '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Сторінку не знайдено | LEX</title></head>' +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${esc('Сторінку не знайдено')}</h1><p><a href="/advokaty">Адвокати України</a></p></body></html>`,
  );
}
const send = (res: Response, html: string) =>
  res.status(200).type('html').set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400').send(html);

export function createAdvocatesRoutes(db: BaseDatabase): { lists: Router; profiles: Router } {
  const repo = new AdvocatesRepository(db);
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[advokat] render failed', { path: req.originalUrl, err: (err as Error).message });
      next(err);
    });

  const councilBySlug = async (slug: string) => (await repo.councils()).find(c => councilSlug(c.council) === slug)?.council ?? null;

  const lists = Router();
  lists.get('/', wrap(async (_req, res) => {
    send(res, (await cachedHtml('adv:v1:index', TTL_S, async () => renderAdvocatesIndex(await repo.councils())))!);
  }));
  lists.get('/:council', wrap(async (req, res) => {
    const cs = String(req.params.council);
    if (!SLUG.test(cs)) return notFound(res);
    const html = await cachedHtml(`adv:v1:council:${cs}`, TTL_S, async () => {
      const council = await councilBySlug(cs);
      return council ? renderCouncil(council, await repo.letters(council)) : null;
    });
    return html ? void send(res, html) : notFound(res);
  }));
  lists.get('/:council/:letter', wrap(async (req, res) => {
    const cs = String(req.params.council);
    const letter = letterFromSlug(String(req.params.letter));
    if (!SLUG.test(cs) || !letter) return notFound(res);
    const html = await cachedHtml(`adv:v1:letter:${cs}:${letterSlug(letter)}`, TTL_S, async () => {
      const council = await councilBySlug(cs);
      if (!council) return null;
      const list = await repo.byLetter(council, letter);
      return list.length ? renderLetter(council, letter, list) : null;
    });
    return html ? void send(res, html) : notFound(res);
  }));

  const profiles = Router();
  profiles.get('/', (_req, res) => res.redirect(301, '/advokaty'));
  profiles.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cachedHtml('adv:v1:sitemap', TTL_S, async () => {
      const { items, lastmod } = await repo.sitemap();
      const d = lastmod ?? new Date().toISOString().slice(0, 10);
      const councils = await repo.councils();
      const lettersPaths: string[] = [];
      for (const c of councils) {
        for (const l of await repo.letters(c.council)) {
          const ls = letterSlug(l.letter);
          if (ls) lettersPaths.push(`/advokaty/${councilSlug(c.council)}/${ls}`);
        }
      }
      return renderSitemap([
        { path: '/advokaty', lastmod: d },
        ...councils.map(c => ({ path: `/advokaty/${councilSlug(c.council)}`, lastmod: d })),
        ...lettersPaths.map(p => ({ path: p, lastmod: d })),
        ...items.map(a => ({ path: `/advokat/${advocateSlug(a)}`, lastmod: d })),
      ]);
    });
    res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  }));
  profiles.get('/:slug', wrap(async (req, res) => {
    const slug = String(req.params.slug);
    const id = SLUG.test(slug) ? idFromSlug(slug) : null;
    if (!id) return notFound(res);
    const a = await repo.byId(id);
    if (!a) return notFound(res);
    const canonical = advocateSlug(a);
    if (canonical !== slug) return void res.redirect(301, `/advokat/${canonical}`);
    send(res, (await cachedHtml(`adv:v1:${id}`, TTL_S, async () => renderAdvocate(a)))!);
  }));

  return { lists, profiles };
}
