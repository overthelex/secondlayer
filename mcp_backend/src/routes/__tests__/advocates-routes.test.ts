import express from 'express';
import request from 'supertest';

jest.mock('../../utils/redis-client.js', () => ({ getRedisClient: async () => null }));

import { createAdvocatesRoutes } from '../advocates-routes.js';
import { idFromSlug, letterFromSlug, letterSlug, councilSlug } from '../../services/seo/advocates-render.js';

const ADV = {
  id: '8317', family_name: 'Крупнік', name: 'Олена', additional_name: 'Михайлівна', council: 'Рада адвокатів міста Києва',
  certificate_num: '4040', certificate_date: '2011-09-28 00:00:00', decision_date: null, authority_name: 'Київська міська КДКА',
  city: 'Київ', region: 'Київ', orgs: [{ type: 'Адвокатське бюро', name: 'КРУПНІК І ПАРТНЕРИ' }], imported_at: '2026-11-01',
};

function app() {
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('a.source_id = $1')) return { rows: params[0] === '8317' ? [ADV] : [] };
      if (sql.includes('GROUP BY 1 ORDER BY 1') && sql.includes('ra_name) AS council')) return { rows: [{ council: 'Рада адвокатів міста Києва', count: 1 }] };
      if (sql.includes('upper(left(btrim(a.family_name), 1)) AS letter')) return { rows: [{ letter: 'К', count: 1 }] };
      if (sql.includes('upper(left(btrim(a.family_name), 1)) = $2')) return { rows: params[1] === 'К' ? [{ id: '8317', family_name: 'Крупнік', name: 'Олена', additional_name: 'Михайлівна' }] : [] };
      return { rows: [] };
    }),
  };
  const r = createAdvocatesRoutes(db as never);
  const a = express();
  a.use('/advokaty', r.lists);
  a.use('/advokat', r.profiles);
  return a;
}

describe('advocate slugs', () => {
  it('parses the trailing register id', () => {
    expect(idFromSlug('krupnik-olena-mykhailivna-8317')).toBe('8317');
    expect(idFromSlug('krupnik-olena')).toBeNull();
  });
  it('gives every letter a distinct slug', () => {
    const letters = 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ'.split('');
    const slugs = letters.map(l => letterSlug(l));
    expect(new Set(slugs).size).toBe(letters.length);
    for (const l of letters) expect(letterFromSlug(letterSlug(l)!)).toBe(l);
  });
  it('drops the council prefix', () => {
    expect(councilSlug('Рада адвокатів міста Києва')).toBe('mista-kyieva');
  });
});

describe('/advokaty and /advokat routes', () => {
  it('renders a profile without contacts and with the removal note', async () => {
    const res = await request(app()).get('/advokat/krupnik-olena-mykhailivna-8317');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Крупнік Олена Михайлівна</h1>');
    expect(res.text).toContain('№ 4040 від 28.09.2011');
    expect(res.text).toContain('КРУПНІК І ПАРТНЕРИ');
    expect(res.text).toContain('mailto:info@legal.org.ua');
    expect(res.text).toContain('<link rel="canonical" href="https://legal.org.ua/advokat/krupnik-olena-mykhailivna-8317">');
  });

  it('redirects a stale name part to the current slug', async () => {
    const res = await request(app()).get('/advokat/stare-prizvyshche-8317');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/advokat/krupnik-olena-mykhailivna-8317');
  });

  it('answers 404 for unknown, hidden or malformed profiles and lists', async () => {
    for (const p of ['/advokat/kto-to-9999', '/advokat/Bad_Slug', '/advokat/bez-id', '/advokaty/nema-rady', '/advokaty/mista-kyieva/zz', '/advokaty/mista-kyieva/a']) {
      const res = await request(app()).get(p);
      expect(res.status).toBe(404);
    }
  });

  it('lists councils, letters and advocates', async () => {
    expect((await request(app()).get('/advokaty')).text).toContain('href="/advokaty/mista-kyieva"');
    expect((await request(app()).get('/advokaty/mista-kyieva')).text).toContain('href="/advokaty/mista-kyieva/k"');
    expect((await request(app()).get('/advokaty/mista-kyieva/k')).text).toContain('href="/advokat/krupnik-olena-mykhailivna-8317"');
  });
});
