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

// Закон «Про нотаріат»: npa.article also holds an article of another act that
// its final provisions amend (here ЦК 1248), which must not get a page.
const LAW = '3425-12';
const LAW_EDITION = 'Розділ I\nЗАГАЛЬНІ ПОЛОЖЕННЯ\nСтаття 1. Нотаріат\nСтаття 2. Законодавство\nРозділ X\nПРИКІНЦЕВІ ПОЛОЖЕННЯ\n"Стаття 1248. Нотаріальне посвідчення';
const LAW_ARTICLES: Record<string, string> = {
  '1': 'Стаття 1. Нотаріат в Україні\n1. Нотаріат в Україні - це система органів.',
  '2': 'Стаття 2. Законодавство України про нотаріат\n1. Текст.',
  '1248': 'Стаття 1248. Нотаріальне посвідчення заповіту\n1. Текст ЦК.',
};

function fakeDb(statusCode = 5) {
  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      const law = params[0] === LAW;
      const arts = law ? LAW_ARTICLES : ARTICLES;
      if (sql.includes('FROM npa.act')) return { rows: params[0] === '435-15' || params[0] === '436-15' || law ? [{ ed_date: '2026-08-05', status_code: params[0] === '436-15' ? 1 : statusCode }] : [] };
      if (sql.includes('split_part')) return { rows: Object.entries(arts).map(([art_no, body]) => ({ art_no, first_line: body.split('\n')[0] })) };
      if (sql.includes('lag(h)')) return { rows: params[1] === '625' ? [
        { ed_date: '2004-01-01', body: 'Стаття 625. Відповідальність\n1. Старий текст.' },
        { ed_date: '2026-08-05', body: ARTICLES['625'] },
        { ed_date: '2027-01-01', body: 'Стаття 625. Відповідальність\n1. Майбутній текст.' },
      ] : params[1] === '626' ? [
        { ed_date: '2001-01-01', body: null },
        { ed_date: '2010-01-01', body: 'Стаття 626. Поняття договору\n1. Інший текст.' },
        { ed_date: '2020-01-01', body: ARTICLES['626'] },
      ] : [] };
      if (sql.includes('FROM npa.article')) return { rows: arts[params[2] as string] ? [{ body: arts[params[2] as string] }] : [] };
      if (sql.includes('FROM npa.edition_text')) return { rows: [{ body: law ? LAW_EDITION : EDITION }] };
      if (sql.includes('seo_vp_articles') && law) return { rows: [] };
      if (sql.includes('seo_vp_articles')) return { rows: [{ slug: '911-952-22-2024-10-15', cause_num: '911/952/22', d: '2024-10-15', category: null, total: 1 }] };
      if (sql.includes('seo_cassation_articles')) return { rows: params[1] === '625' ? [
        { slug: '910-1-20-2021-03-02', court_code: 9911, cause_num: '910/1/20', d: '2021-03-02', category: null, cited_by: 412, total: 37 },
      ] : [] };
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
    expect(res.text).toContain('<loc>https://legal.org.ua/zakon/pro-notariat</loc>');
    expect(res.text).toContain('<loc>https://legal.org.ua/zakon/pro-notariat/stattia-2</loc>');
    expect(res.text).not.toContain('pro-notariat/stattia-1248');
  });

  it('renders a law article with the law in its heading', async () => {
    const res = await request(app()).get('/zakon/pro-notariat/stattia-1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/zakon/pro-notariat/stattia-1">');
    expect(res.text).toContain('<h1>Стаття 1 Закону України «Про нотаріат». Нотаріат в Україні</h1>');
    expect(res.text).toContain('Закон України «Про нотаріат» · редакція від');
    expect(res.text).toContain('href="/zakon/pro-notariat/stattia-2"');
    expect(res.text).toContain('>Зміст закону</a>');
    expect(res.text).toContain('Кодекси і закони України');
  });

  it("lists only the law's own articles and 404s the ones it inserts into other acts", async () => {
    const toc = await request(app()).get('/zakon/pro-notariat');
    expect(toc.status).toBe(200);
    expect(toc.text).toContain('<h1>Закон України «Про нотаріат»</h1>');
    expect(toc.text).toContain('href="/zakon/pro-notariat/stattia-2"');
    expect(toc.text).not.toContain('stattia-1248');
    const res = await request(app()).get('/zakon/pro-notariat/stattia-1248');
    expect(res.status).toBe(404);
    expect(res.text).toContain('noindex');
  });

  it('lists codes and laws in separate sections of the index', async () => {
    const res = await request(app()).get('/zakon');
    expect(res.status).toBe(200);
    const codes = res.text.indexOf('<h2>Кодекси</h2>');
    const laws = res.text.indexOf('<h2>Закони</h2>');
    expect(codes).toBeGreaterThan(0);
    expect(laws).toBeGreaterThan(codes);
    expect(res.text.indexOf('href="/zakon/tsyvilnyi-kodeks"')).toBeLessThan(laws);
    expect(res.text.indexOf('href="/zakon/pro-notariat"')).toBeGreaterThan(laws);
  });

  it('shows the edition history with past and future versions', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-625');
    expect(res.text).toContain('Історія змін статті 625 ЦК України');
    expect(res.text).toContain('змінювався 2 рази');
    expect(res.text).toContain('Редакція від 01.01.2004 до 05.08.2026');
    expect(res.text).toContain('Нова редакція з 01.01.2027 (ще не набрала чинності)');
    expect(res.text).toContain('<p class="chg">1. Старий текст.</p>');
    expect(res.text).toContain('"legislationDateVersion":"2026-08-05"');
  });
  it('has no history block for an article that never changed', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-624');
    expect(res.text).not.toContain('Історія змін');
  });
  it('lists older versions by date when their text is not loaded', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-626');
    expect(res.text).toContain('Редакція від 01.01.2010 до 01.01.2020');
    expect(res.text).toContain('<li>від 01.01.2001 до 01.01.2010</li>');
  });
  it('lists cassation decisions applying the article, most cited first', async () => {
    const res = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-625');
    expect(res.text).toContain('Постанови касаційних судів ВС, що застосовують статтю 625 ЦК України (37)');
    expect(res.text).toContain('href="/praktyka-vs/910-1-20-2021-03-02"');
    expect(res.text).toContain('посилаються 412 рішень');
    expect(res.text).toContain('href="/praktyka-vs">Усі постанови касаційних судів</a>');
    const other = await request(app()).get('/zakon/tsyvilnyi-kodeks/stattia-624');
    expect(other.text).not.toContain('Постанови касаційних судів');
  });
});
