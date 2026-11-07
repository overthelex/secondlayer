import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { LoginRateLimit } from './auth/rate-limit';
import { requireLogin } from './auth/middleware';
import { authRoutes } from './routes/auth';
import { advocatesRoutes } from './routes/advocates';
import { advocateRoutes } from './routes/advocate';
import { html } from './views/html';
import { renderPage } from './views/layout';

export interface AppDeps {
  pool: Pool;
  config: Config;
  rateLimit: LoginRateLimit;
}

export function createApp(deps: AppDeps): Express {
  const { pool, rateLimit } = deps;
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
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  app.use(authRoutes(pool, rateLimit));
  app.use(requireLogin(pool));
  app.use(advocatesRoutes(pool));
  app.use(advocateRoutes(pool));
  app.get('/', (_req, res) => res.redirect('/advocates'));

  app.use((_req, res) => {
    res.status(404).type('html').send(renderPage({ title: 'Не знайдено', user: res.locals.user, body: html`<h1>Сторінку не знайдено</h1>` }));
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(`[attorney_crm] ${err.stack ?? err.message}\n`);
    res.status(500).type('html').send(renderPage({ title: 'Помилка', user: res.locals.user, body: html`<h1>Сталася помилка</h1><p class="muted">${err.message}</p>` }));
  });
  return app;
}
