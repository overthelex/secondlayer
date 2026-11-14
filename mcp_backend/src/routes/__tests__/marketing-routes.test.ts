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
  a.use(createMarketingRoutes({} as never, repo as never));
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
    expect(sm.text.match(/<url>/g)).toHaveLength(7);
  });

  it('computes the court fee from the query and keeps one canonical', async () => {
    const res = await request(app()).get('/kalkuliator-sudovoho-zboru?court=civil&payer=person&doc=claim&kind=property&amount=100000&year=2026&e=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Судовий збір: 1\u00a0064,96 грн');
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/kalkuliator-sudovoho-zboru">');
    const bad = await request(app()).get('/kalkuliator-sudovoho-zboru?court=admin&doc=order');
    expect(bad.text).toContain('Судовий наказ в адміністративному судочинстві не видається.');
  });
});
