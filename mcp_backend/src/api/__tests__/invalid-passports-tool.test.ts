/**
 * search_invalid_passports (LEXAI-2158)
 *
 * - Cyrillic look-alike series ("НМ") are normalised to the stored Latin form ("HM")
 *   and still queried with plain equality (series index stays usable).
 * - OVD / status text is matched per word on a stem, so "ВИКРАДЕНО" finds "ВИКРАДЕНИЙ"
 *   and "КИЇВ" finds "... В М. КИЄВІ".
 * - total_count is the real number of matches, not the page size.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  Tier1OpenDataTools,
  normalizePassportSeries,
  textTokenPatterns,
} from '../tools/tier1-opendata-tools.js';

type Call = { sql: string; params: any[] };

function likeToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

describe('normalizePassportSeries', () => {
  it('maps Cyrillic look-alikes to Latin', () => {
    expect(normalizePassportSeries('НМ')).toBe('HM');
    expect(normalizePassportSeries('ЕР')).toBe('EP');
    expect(normalizePassportSeries('АВЕКМНОРСТХІ')).toBe('ABEKMHOPCTXI');
  });

  it('upper-cases and strips separators', () => {
    expect(normalizePassportSeries(' нм ')).toBe('HM');
    expect(normalizePassportSeries('h-m')).toBe('HM');
    expect(normalizePassportSeries('і')).toBe('I');
  });

  it('keeps letters without a Latin twin as stored (mixed series like "CЮ")', () => {
    expect(normalizePassportSeries('СЮ')).toBe('CЮ');
    expect(normalizePassportSeries('13ЕД')).toBe('13EД');
    expect(normalizePassportSeries('HM')).toBe('HM');
  });
});

describe('textTokenPatterns', () => {
  const matches = (input: string, value: string) =>
    textTokenPatterns(input).every((p) => likeToRegex(p).test(value));

  it('matches registry status wording from the documented forms', () => {
    expect(matches('ВИКРАДЕНО', 'ВИКРАДЕНИЙ')).toBe(true);
    expect(matches('викрадений', 'ВИКРАДЕНИЙ')).toBe(true);
    expect(matches('ВЛАСНИК РОЗШУКУЄТЬСЯ', 'ВЛАСНИК ДОКУМЕНТА РОЗШУКУЄТЬСЯ')).toBe(true);
    expect(matches('НЕДІЙСНИЙ', 'ВИЗНАНО НЕДІЙСНИМ')).toBe(true);
    expect(matches('ВТРАЧЕНО', 'ВТРАЧЕНО')).toBe(true);
    expect(matches('ВТРАЧЕНО', 'ВИКРАДЕНИЙ')).toBe(false);
  });

  it('matches OVD names across case forms and apostrophes', () => {
    expect(matches('КИЇВ', 'ШЕВЧЕНКІВСЬКЕ УПРАВЛІННЯ ПОЛІЦІЇ ГУНП В М. КИЄВІ')).toBe(true);
    expect(matches('ГУНП Київ', 'ДАРНИЦЬКЕ УПРАВЛІННЯ ПОЛІЦІЇ ГУНП В М. КИЄВІ')).toBe(true);
    expect(matches("Солом'янське", 'СОЛОМ’ЯНСЬКЕ УПРАВЛІННЯ ПОЛІЦІЇ ГУНП В М. КИЄВІ')).toBe(true);
    expect(matches('ГУНП Київ', 'ДЕРЖАВНА МІГРАЦІЙНА СЛУЖБА УКРАЇНИ')).toBe(false);
  });

  it('escapes LIKE metacharacters and drops one-letter words', () => {
    expect(textTokenPatterns('100%')).toEqual(['%100\\%%']);
    expect(textTokenPatterns('a_b')).toEqual(['%A\\_B%']);
    expect(textTokenPatterns('В М. КИЄВІ')).toEqual(['%КИ_В%']);
    expect(textTokenPatterns('  ')).toEqual([]);
  });
});

describe('search_invalid_passports', () => {
  function makeTool(handler: (c: Call) => any[]) {
    const calls: Call[] = [];
    const db = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const call = { sql, params };
        calls.push(call);
        return { rows: handler(call) };
      }),
    };
    return { tool: new Tier1OpenDataTools(db), calls };
  }

  const parse = (r: any) => {
    const text = r.content[0].text as string;
    try { return JSON.parse(text); } catch { return text; }
  };

  it('finds a passport given a Cyrillic series via an equality lookup', async () => {
    const row = { id: '0101_HM_525271', d_series: 'HM', d_number: '525271', d_status: 'ВТРАЧЕНО', insert_date: '2026-03-26' };
    const { tool, calls } = makeTool(({ sql, params }) =>
      sql.includes('FROM opendata_invalid_passports ') && params[0] === 'HM' && params[1] === '525271' ? [row] : []);

    const out = parse(await tool.executeTool('search_invalid_passports', { d_series: 'НМ', d_number: '525271' }));

    expect(out.results).toHaveLength(1);
    expect(out.total_count).toBe(1);
    expect(out.normalized_series).toBe('HM');
    expect(calls[0].sql).toMatch(/d_series = \$1 AND d_number = \$2/);
    expect(calls[0].sql).not.toMatch(/translate|upper\(|ILIKE/i);
  });

  it('splits a series glued to the number', async () => {
    const { tool, calls } = makeTool(() => []);
    await tool.executeTool('search_invalid_passports', { d_number: 'ЕР 137986', include_foreign: false });
    expect(calls[0].params).toEqual(['EP', '137986']);
  });

  it('reports the real total, not the page size, for OVD searches', async () => {
    const page = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, insert_date: '2026-03-27' }));
    const { tool, calls } = makeTool(({ sql }) => {
      if (sql.startsWith('SELECT count(*)')) return [{ n: sql.includes('_foreign') ? '1200' : '365389' }];
      return page;
    });

    const out = parse(await tool.executeTool('search_invalid_passports', { ovd: 'ГУНП Київ', limit: 3 }));

    expect(out.total_count).toBe(366589);
    expect(out.total_by_type).toEqual({ internal: 365389, foreign: 1200 });
    expect(out.has_more).toBe(true);
    expect(out.results).toHaveLength(3);
    const select = calls[0];
    expect(select.sql).toMatch(/ovd ILIKE \$1 AND ovd ILIKE \$2/);
    expect(select.params).toEqual(['%ГУНП%', '%КИ_В%']);
  });

  it('skips the count query when the page is not full', async () => {
    const { tool, calls } = makeTool(({ sql }) => (sql.includes('_foreign') ? [] : [{ id: 'a' }, { id: 'b' }]));
    const out = parse(await tool.executeTool('search_invalid_passports', { d_status: 'ВИКРАДЕНО' }));
    expect(out.total_count).toBe(2);
    expect(out.has_more).toBe(false);
    expect(calls.some((c) => c.sql.startsWith('SELECT count(*)'))).toBe(false);
    expect(calls[0].params).toEqual(['%ВИКРАДЕН%']);
  });

  it('asks for input when nothing usable is given', async () => {
    const { tool, calls } = makeTool(() => []);
    const out = parse(await tool.executeTool('search_invalid_passports', { ovd: ' ' }));
    expect(out).toMatch(/Вкажіть/);
    expect(calls).toHaveLength(0);
  });

  it('says which normalised series was looked up when nothing is found', async () => {
    const { tool } = makeTool(() => []);
    const out = parse(await tool.executeTool('search_invalid_passports', { d_series: 'нм', d_number: '000000' }));
    expect(out).toMatch(/не знайдено/);
    expect(out).toMatch(/серія HM, номер 000000/);
  });
});
