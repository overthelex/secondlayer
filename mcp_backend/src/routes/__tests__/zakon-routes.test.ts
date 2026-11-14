import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createZakonRoutes } from '../zakon-routes.js';

const EDITION = 'Розділ I\nЗАГАЛЬНІ ПОЛОЖЕННЯ\nСтаття 624. Неустойка\nСтаття 625. Відповідальність\nСтаття 626. Договір';
const ARTICLES: Record<string, string> = {
  '624': 'Стаття 624. Неустойка\n1. Текст.',
  '625': "Стаття 625. Відповідальність за порушення грошового зобов'язання\n1. Боржник <b>не</b> звільняється.\n{Стаття 625 із змінами}",
  '626': 'Стаття 626. Поняття договору\n1. Текст.',
};

function fakeDb(statusCode = 5) {
  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM npa.act')) return { rows: params[0] === '435-15' || params[0] === '436-15' ? [{ ed_date: '2026-08-05', status_code: params[0] === '436-15' ? 1 : statusCode }] : [] };
      if (sql.includes('split_part')) return { rows: Object.entries(ARTICLES).map(([art_no, body]) => ({ art_no, first_line: body.split('\n')[0] })) };
      if (sql.includes('FROM npa.article')) return { rows: ARTICLES[params[2] as string] ? [{ body: ARTICLES[params[2] as string] }] : [] };
      if (sql.includes('FROM npa.edition_text')) return { rows: [{ body: EDITION }] };
      if (sql.includes('seo_vp_articles')) return { rows: [{ slug: '911-952-22-2024-10-15', cause_num: '911/952/22', d: '2024-10-15', category: null, total: 1 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

function app(db = fakeDb()) {
  const a = express();
  a.use('/zakon', createZakonRoutes(db as never));
  return a;
}

describe('/zakon routes', () => {
  it('renders an article with its own canonical, escaped text and neighbours', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-625');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/zakon/tsyvilnyi-kodeks/stattia-625">');
    expect(res.text).toContain("<h1>Стаття 625 ЦК України. Відповідальність за порушення грошового зобов&#39;язання</h1>");
    expect(res.text).toContain('Боржник &lt;b&gt;не&lt;/b&gt; звільняється.');
    expect(res.text).not.toContain('<b>не</b>');
    expect(res.text).toContain('<p class="note">');
    expect(res.text).toContain('href="/zakon/tsyvilnyi-kodeks/stattia-624"');
    expect(res.text).toContain('href="/zakon/tsyvilnyi-kodeks/stattia-626"');
    expect(res.text).toContain('Розділ I. Загальні положення');
    expect(res.text).toContain('"@type":"BreadcrumbList"');
    expect(res.text).toContain('href="/pozytsiia-vs/911-952-22-2024-10-15"');
  });

  it('renders the table of contents', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2>Розділ I. Загальні положення</h2>');
    expect(res.text).toContain('href="/zakon/tsyvilnyi-kodeks/stattia-625"');
  });

  it('marks a repealed code', async () => {
    const res = await request(app()).get('/zakon/hospodarskyi-kodeks');
    expect(res.text).toContain('втратив чинність');
    expect(res.text).toContain('NotInForce');
  });

  it('answers 404 (noindex) for unknown codes, malformed and missing articles', async () => {
    for (const p of ['/zakon/nope', '/zakon/tsyvilnyi-kodeks/stattia-9999', '/zakon/tsyvilnyi-kodeks/625', '/zakon/kryminalnyi-kodeks']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(404);
      expect(res.text).toContain('noindex');
    }
  });

  it('lists every code page and article in the sitemap', async () => {
    const res = await request(app()).get('/zakon/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<loc>https://legal.org.ua/zakon</loc>');
    expect(res.text).toContain('<loc>https://legal.org.ua/zakon/tsyvilnyi-kodeks/stattia-625</loc><lastmod>2026-08-05</lastmod>');
  });
});
