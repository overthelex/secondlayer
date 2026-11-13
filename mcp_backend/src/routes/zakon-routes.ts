/**
 * Public, server-rendered SEO pages for the main codes of Ukraine.
 *
 *   GET /zakon                               list of codes
 *   GET /zakon/:code                         table of contents
 *   GET /zakon/:code/stattia-:n              one article (current edition)
 *   GET /zakon/sitemap.xml                   sitemap for all of the above
 *
 * No auth (mounted outside /api, so no X-Robots-Tag: noindex either).
 * Data comes only from npa.* in Postgres; rendered HTML is cached in Redis
 * per edition, so a new edition invalidates the cache by key.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { getRedisClient } from '../utils/redis-client.js';
import { logger } from '../utils/logger.js';
import { NPA_REPEALED_CODES } from '../api/tools/npa-dicts.js';
import { ZAKON_CODES, codeBySlug, artNoFromSlug, articleSlug, type ZakonCode } from '../services/seo/zakon-codes.js';
import { ZakonRepository, ZakonDataCache, type CodeData } from '../services/seo/zakon-repository.js';
import { parseArticleBody } from '../services/seo/zakon-text.js';
import { renderCodesIndex, renderCodeToc, renderArticle, renderSitemap, esc } from '../services/seo/zakon-render.js';

const CACHE_TTL_S = 24 * 60 * 60;
const CACHE_PREFIX = 'zakon:v1:';
const HTML_CACHE_CONTROL = 'public, max-age=600, stale-while-revalidate=86400';

type Cache = { get(k: string): Promise<string | null>; set(k: string, v: string, o: { EX: number }): Promise<unknown> };

const REDIS_TIMEOUT_MS = 300;

/** Resolve to null instead of waiting: a slow or reconnecting Redis must not stall a page. */
function withTimeout<T>(p: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

async function cache(): Promise<Cache | null> {
  const c = (await withTimeout(getRedisClient() as Promise<unknown>)) as (Cache & { isReady?: boolean }) | null;
  return c && c.isReady !== false ? c : null;
}

async function cached(key: string, build: () => Promise<string | null>): Promise<string | null> {
  const c = await cache();
  if (c) {
    const hit = await withTimeout(c.get(CACHE_PREFIX + key));
    if (hit) return hit;
  }
  const html = await build();
  if (html && c) {
    withTimeout(c.set(CACHE_PREFIX + key, html, { EX: CACHE_TTL_S })).catch(() => undefined);
  }
  return html;
}

function notFound(res: Response, message = 'Сторінку не знайдено'): void {
  res.status(404).type('html').set('Cache-Control', 'public, max-age=300').send(
    `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(message)} | LEX</title></head>` +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px"><h1>${esc(message)}</h1><p><a href="/zakon">Кодекси України</a></p></body></html>`,
  );
}

function sendHtml(res: Response, html: string): void {
  res.status(200).type('html').set('Cache-Control', HTML_CACHE_CONTROL).send(html);
}

const isRepealed = (d: CodeData) => d.edition.statusCode !== null && NPA_REPEALED_CODES.includes(d.edition.statusCode);

export function createZakonRoutes(db: BaseDatabase): Router {
  const router = Router();
  const repo = new ZakonRepository(db);
  const data = new ZakonDataCache(repo);

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[zakon] render failed', { path: req.path, err: (err as Error).message });
      next(err);
    });

  router.get('/', wrap(async (_req, res) => {
    sendHtml(res, renderCodesIndex());
  }));

  router.get('/sitemap.xml', wrap(async (_req, res) => {
    const xml = await cached('sitemap', async () => {
      const entries: Array<{ path: string; lastmod: string }> = [];
      const latest: string[] = [];
      for (const code of ZAKON_CODES) {
        const d = await data.get(code.nreg);
        if (!d) continue;
        latest.push(d.edition.edDate);
        entries.push({ path: `/zakon/${code.slug}`, lastmod: d.edition.edDate });
        for (const a of d.index) entries.push({ path: `/zakon/${code.slug}/${articleSlug(a.artNo)}`, lastmod: d.edition.edDate });
      }
      entries.unshift({ path: '/zakon', lastmod: latest.sort().pop() || new Date().toISOString().slice(0, 10) });
      return renderSitemap(entries);
    });
    res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  }));

  const loadCode = async (req: Request, res: Response): Promise<{ code: ZakonCode; d: CodeData } | null> => {
    const code = codeBySlug(String(req.params.code));
    if (!code) { notFound(res); return null; }
    const d = await data.get(code.nreg);
    if (!d) { notFound(res); return null; }
    return { code, d };
  };

  router.get('/:code', wrap(async (req, res) => {
    const loaded = await loadCode(req, res);
    if (!loaded) return;
    const { code, d } = loaded;
    const html = await cached(`toc:${code.slug}:${d.edition.edDate}`, async () => renderCodeToc(code, d, isRepealed(d)));
    sendHtml(res, html!);
  }));

  router.get('/:code/:article', wrap(async (req, res) => {
    const artNo = artNoFromSlug(String(req.params.article));
    if (!artNo) return notFound(res);
    const loaded = await loadCode(req, res);
    if (!loaded) return;
    const { code, d } = loaded;
    const html = await cached(`art:${code.slug}:${artNo}:${d.edition.edDate}`, async () => {
      const body = await repo.articleBody(code.nreg, d.edition.edDate, artNo);
      const parsed = body ? parseArticleBody(body, code.articleTitles) : null;
      return parsed ? renderArticle(code, d, parsed, isRepealed(d)) : null;
    });
    if (!html) return notFound(res, 'Статтю не знайдено');
    sendHtml(res, html);
  }));

  return router;
}
