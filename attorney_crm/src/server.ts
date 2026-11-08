import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { LoginRateLimit } from './auth/rate-limit';
import { requireLogin } from './auth/middleware';
import { authRoutes } from './routes/auth';
import { advocatesRoutes } from './routes/advocates';
import { advocateRoutes } from './routes/advocate';
import { todayRoutes } from './routes/today';
import { html } from './views/html';
import { renderPage } from './views/layout';
import { tenant } from './tenant';

export interface AppDeps {
  pool: Pool;
  config: Config;
  rateLimit: LoginRateLimit;
}

export function createApp(deps: AppDeps): Express {
  const { pool, rateLimit } = deps;
  const secret = deps.config.sessionSecret;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'static'), { maxAge: '1d' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      process.stderr.write(`[attorney_crm] healthz: ${(err as Error).message}\n`);
      res.status(503).json({ ok: false });
    }
  });

  app.use(authRoutes(pool, rateLimit, secret));
  app.use(requireLogin(pool, secret));
  app.use(advocatesRoutes(pool));
  app.use(advocateRoutes(pool));
  app.use(todayRoutes(pool));

  app.use((_req, res) => {
    const s = tenant().strings;
    res.status(404).type('html').send(renderPage({ title: s.errors.notFound, user: res.locals.user, body: html`<h1>${s.detail.notFoundHeading}</h1>` }));
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(`[attorney_crm] ${err.stack ?? err.message}\n`);
    const s = tenant().strings;
    res.status(500).type('html').send(renderPage({ title: s.errors.serverError, user: res.locals.user, body: html`<h1>${s.errors.serverErrorHeading}</h1><p class="muted">${s.errors.serverErrorBody}</p>` }));
  });
  return app;
}
