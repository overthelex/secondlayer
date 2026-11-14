import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createVpRoutes } from '../vp-routes.js';

const ROW = { slug: '754-511-23-2026-02-11', cause_num: '754/511/23', d: '2026-02-11', category: 'Кредит', doc_id: '1', judge: 'Воробйова І. А.',
  full_text: 'УСТАНОВИЛА:\nВступ\n1. Спір про 3 % річних.\nП О С Т А Н О В И Л А:\nСкаргу задовольнити.' };

function app() {
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WHERE v.slug = $1') && sql.includes('full_text')) return { rows: params[0] === ROW.slug ? [ROW] : [] };
      if (sql.includes('FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)\n        WHERE v.slug')) return { rows: [{ nreg: '435-15', art_no: '625' }] };
      return { rows: [] };
    }),
  };
  const a = express();
  a.use('/pozytsiia-vs', createVpRoutes(db as never));
  return a;
}

describe('/pozytsiia-vs routes', () => {
  it('renders a decision with its text, anchors and article links', async () => {
    const res = await request(app()).get('/pozytsiia-vs/754-511-23-2026-02-11');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Постанова Великої Палати Верховного Суду від 11.02.2026 у справі № 754/511/23</h1>');
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/pozytsiia-vs/754-511-23-2026-02-11">');
    expect(res.text).toContain('href="/zakon/tsyvilnyi-kodeks/stattia-625"');
    expect(res.text).toContain('<h2 id="postanovyla">Постановила</h2>');
    expect(res.text).toContain('reyestr.court.gov.ua/Review/1');
  });

  it('answers 404 for unknown, malformed and empty-year pages', async () => {
    for (const p of ['/pozytsiia-vs/nema-2020-01-01', '/pozytsiia-vs/Bad_Slug', '/pozytsiia-vs/rik-1999']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(404);
      expect(res.text).toContain('noindex');
    }
  });
});
