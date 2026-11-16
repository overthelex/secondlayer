import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createCassationRoutes } from '../cassation-routes.js';

const ROW = {
  slug: '554-7669-21-2024-06-24', court_code: 9931, cause_num: '554/7669/21', d: '2024-06-24', category: 'Спадкування', cited_by: 2981,
  doc_id: '42', judge: 'Петров П. П.', court_slug: 'kasatsiinyi-tsyvilnyi-sud-verkhovnoho-sudu',
  full_text: 'ПОСТАНОВА\nІМЕНЕМ УКРАЇНИ\n24 червня 2024 року\nсправа № 554/7669/21\nУСТАНОВИВ:\nОписова частина\n1. Позивач просив визнати право на спадщину.\nП О С Т А Н О В И В:\nКасаційну скаргу залишити без задоволення.',
};

function app() {
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WHERE s.slug = $1') && sql.includes('full_text')) return { rows: params[0] === ROW.slug ? [ROW] : [] };
      if (sql.includes('FROM seo_cassation_articles a')) return { rows: [{ nreg: '435-15', art_no: '1268' }] };
      if (sql.includes('WHERE l.from_doc_id = $1')) return { rows: [{ kind: 'vp', slug: '14-1cs24-2025-01-01', court_code: null, cause_num: '14/1/24', d: '2025-01-01' }] };
      if (sql.includes('WHERE l.to_cause = $1')) return { rows: [{ kind: 'cass', slug: '1-2-25-2025-05-05', court_code: 9911, cause_num: '1/2/25', d: '2025-05-05', total: '3' }] };
      if (sql.includes('AS lastmod FROM seo_cassation_decisions')) return { rows: [{ slug: ROW.slug, lastmod: '2024-06-24' }] };
      if (sql.includes('GROUP BY 1 ORDER BY 1 DESC')) return { rows: [{ year: 2024, count: 1 }] };
      return { rows: [] };
    }),
  };
  const a = express();
  a.use('/praktyka-vs', createCassationRoutes(db as never));
  return a;
}

describe('/praktyka-vs routes', () => {
  it('renders a decision with its text, court link, article links and citation links', async () => {
    const res = await request(app()).get('/praktyka-vs/554-7669-21-2024-06-24');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Постанова Верховного Суду (Касаційний цивільний суд) від 24.06.2024 у справі № 554/7669/21</h1>');
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/praktyka-vs/554-7669-21-2024-06-24">');
    expect(res.text).toContain('href="/sud/kasatsiinyi-tsyvilnyi-sud-verkhovnoho-sudu"');
    expect(res.text).toContain('href="/zakon/tsyvilnyi-kodeks/stattia-1268"');
    expect(res.text).toContain('<h2 id="postanovyla">Постановив</h2>');
    expect(res.text).toMatch(/посилається 2\s981 рішення/);
    expect(res.text).toContain('href="/pozytsiia-vs/14-1cs24-2025-01-01"');
    expect(res.text).toContain('href="/praktyka-vs/1-2-25-2025-05-05">КГС ВС, 05.05.2025');
    expect(res.text).toContain('(1 з 3, новіші)');
    expect(res.text).toContain('reyestr.court.gov.ua/Review/42');
  });

  it('serves a sitemap of published pages', async () => {
    const res = await request(app()).get('/praktyka-vs/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<loc>https://legal.org.ua/praktyka-vs/554-7669-21-2024-06-24</loc>');
    expect(res.text).toContain('<loc>https://legal.org.ua/praktyka-vs/rik-2024</loc>');
  });

  it('answers 404 for unknown, malformed and empty-year pages', async () => {
    for (const p of ['/praktyka-vs/nema-2020-01-01', '/praktyka-vs/Bad_Slug', '/praktyka-vs/rik-1999']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(404);
      expect(res.text).toContain('noindex');
    }
  });
});
