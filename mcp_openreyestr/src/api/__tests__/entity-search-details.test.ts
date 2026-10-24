import { Pool } from 'pg';
import {
  OpenReyestrTools,
  formatDssuActivity,
  isMeaningfulExchangeRow,
  nameCoreSql,
  normalizeNameCore,
} from '../openreyestr-tools';

describe('normalizeNameCore (LEXAI-2098)', () => {
  it.each([
    ['Нова Пошта', 'НОВА ПОШТА'],
    ['ТОВ «Нова Пошта»', 'НОВА ПОШТА'],
    ['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "НОВА ПОШТА"', 'НОВА ПОШТА'],
    ['"Нова пошта" ТОВ', 'НОВА ПОШТА'],
    ['АТ КБ "ПриватБанк"', 'ПРИВАТБАНК'],
    ['АКЦІОНЕРНЕ ТОВАРИСТВО КОМЕРЦІЙНИЙ БАНК «ПРИВАТБАНК»', 'ПРИВАТБАНК'],
    ['ПрАТ Київстар', 'КИЇВСТАР'],
    ['Розетка.уа', 'РОЗЕТКА УА'],
    ["Кар'єр", 'КАРЄР'],
    ['ТОВ', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeNameCore(input)).toBe(expected);
  });

  it('keeps a non-ОПФ first word (ТОВАРНА БІРЖА is not ТОВ)', () => {
    expect(normalizeNameCore('Товарна біржа Україна')).toBe('ТОВАРНА БІРЖА УКРАЇНА');
  });
});

describe('nameCoreSql', () => {
  it('cuts the ОПФ column off the full name and abbreviations only before a quote', () => {
    const sql = nameCoreSql('name', 'opf');
    expect(sql).toMatch(/left\(upper\(coalesce\(name, ''\)\), length\(opf\) \+ 1\) = upper\(opf\) \|\| ' '/);
    expect(sql).toMatch(/\(ТОВ\|ТДВ\|ПП\|.*\)\[\[:space:\]\]\+\)\+\(\?="\)/);
    expect(nameCoreSql('short_name')).not.toMatch(/opf/);
  });
});

describe('searchEntities ranking (LEXAI-2098)', () => {
  function mockPool(rows: any[] = [{ id: 1 }]) {
    const query = jest.fn().mockResolvedValue({ rows });
    return { pool: { query } as unknown as Pool, query };
  }

  it('ranks exact core > prefix > substring, registered first, over name and short_name FTS', async () => {
    const { pool, query } = mockPool();
    await new OpenReyestrTools(pool).searchEntities({ query: 'ТОВ «Нова Пошта»', entityType: 'UO', limit: 5 });
    const [sql, values] = query.mock.calls[0];
    expect(values).toEqual(['ТОВ «Нова Пошта»', 'НОВА ПОШТА', 5, 0]);
    expect(sql).toMatch(/to_tsvector\('simple', coalesce\(short_name, ''\)\) @@/);
    expect(sql).toMatch(/WHEN _nc = \$2 OR _sc = \$2 THEN 0/);
    expect(sql).toMatch(/WHEN _nc LIKE \$2 \|\| '%' OR _sc LIKE \$2 \|\| '%' THEN 1/);
    expect(sql).toMatch(/WHEN _nc LIKE '%' \|\| \$2 \|\| '%'/);
    expect(sql).toMatch(/CASE WHEN stan = 'зареєстровано' THEN 0 ELSE 1 END/);
    expect(sql).toMatch(/similarity\(_nc, \$2\)/);
    expect(sql.indexOf('THEN 0')).toBeLessThan(sql.indexOf("stan = 'зареєстровано'"));
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
    // internal ranking columns are not returned
    expect(sql).toMatch(/SELECT id, record, edrpou, name, short_name, opf, stan, registration, entity_type\s+FROM c/);
  });

  it('FOP has no short_name/edrpou; an EDRPOU filter skips the FOP table', async () => {
    const { pool, query } = mockPool();
    await new OpenReyestrTools(pool).searchEntities({ query: 'Іванов', entityType: 'FOP' });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/short_name/);
    expect(sql).toMatch(/NULL::text AS _sc/);

    const q2 = mockPool([]);
    await new OpenReyestrTools(q2.pool).searchEntities({ edrpou: '31316718', entityType: 'ALL' });
    const tables = q2.query.mock.calls.map(c => /FROM (\w+)/.exec(c[0])?.[1]);
    expect(tables).not.toContain('individual_entrepreneurs');
  });

  it('without a query keeps the id ordering and parameter numbering', async () => {
    const { pool, query } = mockPool();
    await new OpenReyestrTools(pool).searchEntities({ edrpou: '31316718', stan: 'зареєстровано', entityType: 'UO', limit: 3, offset: 6 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE edrpou = \$1 AND stan = \$2/);
    expect(sql).toMatch(/ORDER BY id DESC\s+LIMIT \$3 OFFSET \$4/);
    expect(values).toEqual(['31316718', 'зареєстровано', 3, 6]);
  });
});

describe('getEntityDetails (LEXAI-2107)', () => {
  const main = { record: '583858', edrpou: '31316718', name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "НОВА ПОШТА"' };
  const empty = { id: 1, entity_type: 'UO', entity_record: '583858', tax_payer_type: '', start_date: '', start_num: null, end_date: '', end_num: '' };
  const filled = { ...empty, id: 2, tax_payer_type: 'Реєстр платників податків', start_date: '02.10.2006', start_num: '42483' };

  function poolFor(exchange: any[], dssu: any[]) {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (/FROM legal_entities WHERE record/.test(sql)) return { rows: [main] };
      if (/FROM exchange_data/.test(sql)) return { rows: exchange };
      if (/FROM dssu_financial_reports/.test(sql)) return { rows: dssu };
      return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it('drops all-empty exchange rows and the block when nothing is left; notes missing address/КВЕД', async () => {
    const { pool, query } = poolFor([empty, { ...empty, id: 3 }], []);
    const d = await new OpenReyestrTools(pool).getEntityDetails('583858', 'UO');
    expect(d?.exchangeData).toBeUndefined();
    expect(d?.addressAndActivity).toBeUndefined();
    expect(d?.dataNotes?.[0]).toMatch(/Адреса та КВЕД відсутні/);
    const dssuCall = query.mock.calls.find(c => /dssu_financial_reports/.test(c[0]));
    expect(dssuCall?.[1]).toEqual(['31316718']);
  });

  it('keeps meaningful exchange rows and adds address/КВЕД from ДССУ when present', async () => {
    const { pool } = poolFor([empty, filled], [
      { firm_address: 'УКРАЇНА, 03026, М.КИЇВ', firm_region: 'м. Київ', firm_kved: '53.20', firm_kved_name: 'Інша поштова та кур\'єрська діяльність', report_year: 2024 },
    ]);
    const d = await new OpenReyestrTools(pool).getEntityDetails('583858', 'UO');
    expect(d?.exchangeData).toEqual([filled]);
    expect(d?.addressAndActivity).toEqual({
      address: 'УКРАЇНА, 03026, М.КИЇВ', region: 'м. Київ', kved: '53.20',
      kvedName: 'Інша поштова та кур\'єрська діяльність', reportYear: 2024, source: 'dssu_financial_reports',
    });
    expect(d?.dataNotes).toBeUndefined();
  });

  it('helpers', () => {
    expect(isMeaningfulExchangeRow(empty)).toBe(false);
    expect(isMeaningfulExchangeRow({ ...empty, end_num: ' 5 ' })).toBe(true);
    expect(formatDssuActivity(undefined)).toBeUndefined();
    expect(formatDssuActivity({ firm_address: ' ', firm_kved: null })).toBeUndefined();
  });
});
