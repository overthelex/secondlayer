import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createMarketingRoutes } from '../marketing-routes.js';
import { groupPrices, formatPrice, roughly, HOME_REDIRECT } from '../../services/seo/marketing-render.js';

const COVERAGE = { edrsrDocs: 137_944_864, npaActs: 293_049, judges: 4835, courts: 838, vpDecisions: 5831, advocates: 35_125 };
const PRICING = {
  rows: [
    { tool: 'search_court_decisions', name: 'Пошук судових рішень (ЄДРСР)', usd: 0.013 },
    { tool: 'search_legislation', name: 'Семантичний пошук у законодавстві', usd: 0.013 },
    { tool: 'openreyestr_search_debtors', name: 'Пошук боржників', usd: 0.0313 },
    { tool: 'pl_search_companies', name: 'Polish companies', usd: 0.02 },
  ],
  chatAvgUsd: 0.065,
  markupPercent: 30,
  rate: 41.5,
  rateDate: '2026-11-14',
};

function app() {
  const repo = { coverage: async () => COVERAGE, pricing: async () => PRICING };
  const a = express();
  const prak = {
    data: async () => ({ latestVpDate: '2026-02-11', realVp: ['910/1/20', '910/2/21'], fakeIsUnused: true }),
    isVpForArticle: async (c: string) => c === '910/1/20',
    courtHasHearing: async (c: string) => c === '490/234/26',
  };
  a.use(createMarketingRoutes({} as never, repo as never, prak as never));
  return a;
}

describe('marketing helpers', () => {
  it('rounds coverage numbers down', () => {
    expect(roughly(137_944_864)).toBe('понад 137 млн');
    expect(roughly(35_125)).toBe('понад 35 тис.');
  });
  it('groups prices and drops foreign-jurisdiction tools', () => {
    const g = groupPrices(PRICING.rows);
    expect(g.map(x => x.group)).toEqual(['Законодавство', 'Реєстри та перевірка контрагентів', 'Судова практика та аналіз']);
    expect(g.flatMap(x => x.rows).some(r => r.tool.startsWith('pl_'))).toBe(false);
  });
  it('formats UAH with a decimal comma, USD without a rate', () => {
    expect(formatPrice(0.013, 41.5)).toBe('0,54 грн');
    expect(formatPrice(0.0001, 41.5)).toBe('0,004 грн');
    expect(formatPrice(0.013, null)).toBe('$0.013');
  });
});

describe('marketing routes', () => {
  it('renders the guest home with the signed-in redirect and FAQ markup', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain(HOME_REDIRECT);
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/">');
    expect(res.text).toContain('"@type":"FAQPage"');
    expect(res.text).toContain('понад 137 млн');
    expect(res.text).toContain('href="/sudova-praktyka"');
  });

  it('renders live prices', async () => {
    const res = await request(app()).get('/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<td>Пошук судових рішень (ЄДРСР)</td><td>0,54 грн</td>');
    expect(res.text).toContain('41,50 грн/$ на 14.11.2026');
    expect(res.text).not.toContain('Polish companies');
    expect(res.text).toContain('"@type":"AggregateOffer"');
  });

  it('renders every landing and lists them in the sitemap', async () => {
    for (const p of ['/sudova-praktyka', '/perevirka-kontragenta', '/dlia-advokativ', '/mcp-dlia-yurystiv']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(200);
      expect(res.text).toContain(`<link rel="canonical" href="https://legal.org.ua${p}">`);
    }
    const sm = await request(app()).get('/sitemap-landing.xml');
    expect(sm.text.match(/<url>/g)).toHaveLength(8);
  });

  it('computes the court fee from the query and keeps one canonical', async () => {
    const res = await request(app()).get('/kalkuliator-sudovoho-zboru?court=civil&payer=person&doc=claim&kind=property&amount=100000&year=2026&e=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Судовий збір: 1\u00a0064,96 грн');
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/kalkuliator-sudovoho-zboru">');
    const bad = await request(app()).get('/kalkuliator-sudovoho-zboru?court=admin&doc=order');
    expect(bad.text).toContain('Судовий наказ в адміністративному судочинстві не видається.');
  });

  it('checks practicum answers against the data', async () => {
    const bare = await request(app()).get('/praktykum');
    expect(bare.status).toBe(200);
    expect(bare.text).toContain('Постанова ВП ВС у справі № 910/18342/23');
    const all = await request(app()).get('/praktykum').query({ check: '1', t1: 'ст. 625 ЦК', t2: '910/1/20', t3: '11.02.2026', t4: '4800', t5: '490/234/26', t6: '910/18342/23' });
    expect(all.text).toContain('Результат: 6 з 6');
    const some = await request(app()).get('/praktykum').query({ check: '1', t1: '530', t4: '4 800,00' });
    expect(some.text).toContain('Результат: 1 з 6');
  });

  it('issues a verifiable certificate only for a full score', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const full = { check: '1', t1: '625', t2: '910/1/20', t3: '11.02.2026', t4: '4800', t5: '490/234/26', t6: '910/18342/23' };
    const page6 = await request(app()).get('/praktykum').query(full);
    expect(page6.text).toContain('Отримати сертифікат');
    const issued = await request(app()).get('/praktykum').query({ ...full, cert: 'issue', name: 'Олена Коваленко' });
    expect(issued.status).toBe(302);
    const url = issued.headers.location as string;
    const cert = await request(app()).get(url);
    expect(cert.status).toBe(200);
    expect(cert.text).toContain('Олена Коваленко');
    expect(cert.text).toContain('<meta name="robots" content="noindex">');
    const forged = await request(app()).get(url.replace(/name=[^&]+/, 'name=Інша+Особа'));
    expect(forged.status).toBe(404);
    const partial = await request(app()).get('/praktykum').query({ ...full, t4: '1', cert: 'issue', name: 'Олена Коваленко' });
    expect(partial.status).toBe(200);
    expect(partial.text).not.toContain('Отримати сертифікат');
  });
});
