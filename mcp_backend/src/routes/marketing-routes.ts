/**
 * Public marketing pages, server-rendered:
 *   GET /                     home for guests (signed-in users are sent to /chat by an inline script)
 *   GET /pricing              live per-query prices (tool_pricing × default tier × NBU rate)
 *   GET /sudova-praktyka, /perevirka-kontragenta, /dlia-advokativ, /mcp-dlia-yurystiv
 *   GET /kalkuliator-sudovoho-zboru   court fee calculator (GET form, computed per request)
 *   GET /praktykum            interactive practicum for advocates (answers checked against our data)
 *   GET /sitemap-landing.xml
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { cachedHtml } from '../services/seo/seo-cache.js';
import { renderSitemap } from '../services/seo/zakon-render.js';
import { MarketingRepository } from '../services/seo/marketing-repository.js';
import { renderHome, renderPricing, renderLanding, LANDINGS } from '../services/seo/marketing-render.js';
import { renderCourtFee, FEE_PATH } from '../services/seo/court-fee-render.js';
import { PraktykumRepository, checkAnswers } from '../services/seo/praktykum.js';
import { renderPraktykum, PRAK_PATH } from '../services/seo/praktykum-render.js';
import { FEE_YEARS } from '../services/seo/court-fee.js';

const TTL_S = 6 * 60 * 60;

export function createMarketingRoutes(db: BaseDatabase, repo = new MarketingRepository(db), prak = new PraktykumRepository(db)): Router {
  const r = Router();
  const send = (res: Response, html: string) =>
    res.status(200).type('html').set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400').send(html);
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(err => {
      logger.error('[marketing] render failed', { path: req.originalUrl, err: (err as Error).message });
      next(err);
    });

  r.get('/', wrap(async (_req, res) => {
    send(res, (await cachedHtml('mkt:v1:home', TTL_S, async () => renderHome(await repo.coverage())))!);
  }));
  r.get('/pricing', wrap(async (_req, res) => {
    send(res, (await cachedHtml('mkt:v1:pricing', 60 * 60, async () => renderPricing(await repo.pricing())))!);
  }));
  for (const l of LANDINGS) {
    r.get(l.path, wrap(async (_req, res) => {
      send(res, (await cachedHtml(`mkt:v1:${l.path}`, TTL_S, async () => renderLanding(l, await repo.coverage())))!);
    }));
  }
  r.get(FEE_PATH, wrap(async (req, res) => {
    // With a query the result is per request (cheap, pure); the bare page is cached.
    const q = req.query as Record<string, unknown>;
    const html = Object.keys(q).length
      ? renderCourtFee(q)
      : (await cachedHtml('mkt:v1:court-fee', TTL_S, async () => renderCourtFee({})))!;
    send(res, html);
  }));
  r.get(PRAK_PATH, wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    if (q.check !== '1') {
      send(res, (await cachedHtml('mkt:v1:praktykum', 60 * 60, async () => renderPraktykum(await prak.data(), {}, null)))!);
      return;
    }
    const d = await prak.data();
    send(res, renderPraktykum(d, q, await checkAnswers(q, d, prak, FEE_YEARS[0])));
  }));
  r.get('/sitemap-landing.xml', wrap(async (_req, res) => {
    const d = new Date().toISOString().slice(0, 10);
    const xml = renderSitemap(['/', '/pricing', FEE_PATH, PRAK_PATH, ...LANDINGS.map(l => l.path)].map(path => ({ path, lastmod: d })));
    res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  }));
  return r;
}
