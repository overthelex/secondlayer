import { Pool } from 'pg';

jest.mock('../../utils/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  formatInspectionPlanRow, namesakeProbeQuery, normalizePlanName, planDateIso, searchInspectionPlans,
} from '../inspection-plans';
import { MCPOpenReyestrAPI } from '../mcp-openreyestr-api';
import { OpenReyestrTools } from '../openreyestr-tools';

const PLAN_ROW = {
  id: 26597, business_name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ХАЙБЕРРІ"',
  supervision_area: 'Державний нагляд (контроль) у сфері санітарного та епідемічного благополуччя населення',
  start_date: '17.06.2026', duration_days: '5',
  supervisory_body: 'Державна служба України з питань безпечності харчових продуктів та захисту споживачів', plan_year: 2026,
};

/** Pool whose answers are picked by the table the SQL reads. */
function pool(answers: { entity?: any[]; plans?: any[]; namesakes?: { live: number; total: number } }) {
  const query = jest.fn(async (sql: string, _values?: any[]) => {
    if (/FROM inspection_plans/.test(sql)) return { rows: answers.plans ?? [] };
    if (/to_tsvector\('simple', name\)/.test(sql)) return { rows: [answers.namesakes ?? { live: 0, total: 0 }] };
    if (/FROM legal_entities WHERE edrpou = \$1/.test(sql)) return { rows: answers.entity ?? [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { p: { query } as unknown as Pool, query };
}

describe('inspection plan name normalisation (LEXAI-2315)', () => {
  it('ignores case, quote style, apostrophe style and whitespace', () => {
    const a = normalizePlanName('Товариство з обмеженою відповідальністю «Хайберрі»');
    expect(a).toBe('ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ ХАЙБЕРРІ');
    expect(normalizePlanName('ТОВАРИСТВО  З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ХАЙБЕРРІ" ')).toBe(a);
    expect(normalizePlanName('ПП “ОБ’ЄДНАННЯ”')).toBe(normalizePlanName("ПП \"ОБ'ЄДНАННЯ\""));
    expect(normalizePlanName('ПРИВАТНО - ОРЕНДНЕ ПІДПРИЄМСТВО')).toBe('ПРИВАТНО-ОРЕНДНЕ ПІДПРИЄМСТВО');
  });

  it('keeps different names different', () => {
    expect(normalizePlanName('ТОВ "АГРО"')).not.toBe(normalizePlanName('ТОВ "АГРО-1"'));
    expect(normalizePlanName('ТОВ "АГРО"')).not.toBe(normalizePlanName('ТОВ "АГРОС"'));
  });

  it('builds the namesake probe from distinctive words, not legal-form words or apostrophe words', () => {
    expect(namesakeProbeQuery('ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "МРІЯ"')).toBe('мрія');
    expect(namesakeProbeQuery('ПРИВАТНО-ОРЕНДНЕ ПІДПРИЄМСТВО "ЗОРЯ"')).toBe('приватно & орендне & зоря');
    expect(namesakeProbeQuery('ТОВ "ОБ’ЄДНАННЯ ЛАН"')).toBe('тов & лан');
    // only legal-form words: fall back to them rather than to nothing
    expect(namesakeProbeQuery('ПРИВАТНЕ ПІДПРИЄМСТВО')).toBe('підприємство & приватне');
    expect(namesakeProbeQuery('"5"')).toBeNull();
  });

  it('formats plan dates and durations', () => {
    expect(planDateIso('17.06.2026')).toBe('2026-06-17');
    expect(planDateIso('2026-06-17')).toBeNull();
    expect(formatInspectionPlanRow(PLAN_ROW)).toMatchObject({ start_date: '2026-06-17', duration_days: 5, plan_year: 2026 });
    expect(formatInspectionPlanRow({ ...PLAN_ROW, duration_days: '' }).duration_days).toBeNull();
  });
});

describe('searchInspectionPlans: search mode', () => {
  it('asks for a parameter instead of returning the whole plan', async () => {
    const { p, query } = pool({});
    const res = await searchInspectionPlans(p, {});
    expect(res[0].found).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('matches the normalised name, filters, and numbers LIMIT/OFFSET last', async () => {
    const { p, query } = pool({ plans: [{ ...PLAN_ROW, _total: '7' }] });
    const res = await searchInspectionPlans(p, {
      query: '«Хайберрі»', supervisory_body: 'споживачів', plan_year: 2026, date_from: '2026-06-01', date_to: 'not-a-date', limit: 5, offset: 10,
    });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/supervisory_body ILIKE \$1/);
    expect(sql).toMatch(/plan_year = \$2/);
    expect(sql).toMatch(/to_date\(start_date, 'DD\.MM\.YYYY'\) END >= \$3::date/);
    expect(sql).not.toMatch(/<= \$\d+::date/); // invalid date_to ignored
    expect(sql).toMatch(/LIKE \$4/);
    expect(sql).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(values).toEqual(['%споживачів%', 2026, '2026-06-01', '%ХАЙБЕРРІ%', 5, 10]);
    expect(res).toEqual({ total_count: 7, results: [expect.objectContaining({ id: 26597, start_date: '2026-06-17', duration_days: 5 })] });
  });

  it('escapes LIKE wildcards in the name', async () => {
    const { p, query } = pool({ plans: [] });
    const res = await searchInspectionPlans(p, { query: '100%_' });
    expect(query.mock.calls[0][1]![0]).toBe('%100\\%\\_%');
    expect(res[0]).toMatchObject({ found: false });
  });
});

describe('searchInspectionPlans: by ЄДРПОУ (dossier matching)', () => {
  const ENTITY = { name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ «ХАЙБЕРРІ»', stan: 'зареєстровано' };

  it('returns the plan rows when no other entity has the name, with the match basis', async () => {
    const { p, query } = pool({ entity: [ENTITY], plans: [PLAN_ROW, { ...PLAN_ROW, id: 2 }], namesakes: { live: 0, total: 0 } });
    const res = await searchInspectionPlans(p, { edrpou: ' 4163-3007 ' });
    expect(query.mock.calls[0][1]).toEqual(['41633007']);
    const [planSql, planValues] = query.mock.calls[1];
    expect(planSql).toMatch(/= ANY\(SELECT .* FROM unnest\(\$1::text\[\]\) AS x\)/s);
    expect(planValues).toEqual([[ENTITY.name]]);
    const [nsSql, nsValues] = query.mock.calls[2];
    expect(nsSql).toMatch(/to_tsquery\('simple', \$2\)/);
    expect(nsSql).toMatch(/edrpou IS DISTINCT FROM \$4/);
    expect(nsValues).toEqual([ENTITY.name, 'хайберрі', ['припинено', 'скасовано', 'архівний'], '41633007']);
    expect(res).toMatchObject({ edrpou: '41633007', total_count: 2, match_basis: expect.stringMatching(/Коду ЄДРПОУ в плані перевірок немає/) });
    expect(res.results).toHaveLength(2);
  });

  it('withholds the rows when another live entity has the same name (ТОВ "МРІЯ")', async () => {
    const { p } = pool({
      entity: [{ name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "МРІЯ"', stan: 'зареєстровано' }],
      plans: [PLAN_ROW, PLAN_ROW, PLAN_ROW], namesakes: { live: 95, total: 140 },
    });
    const res = await searchInspectionPlans(p, { edrpou: '12345678' });
    expect(Array.isArray(res)).toBe(true);
    expect(res[0]).toMatchObject({ found: false, ambiguous: true, plan_rows_with_name: 3, namesakes_live: 95 });
    expect(res[0].message).toMatch(/інші чинні юрособи \(95\)/);
    expect(res[0].message).toMatch(/записи не показано/);
  });

  it('a dead company gets the rows only if no other entity at all has its name', async () => {
    const dead = [{ ...ENTITY, stan: 'припинено' }];
    const withDeadNamesake = await searchInspectionPlans(pool({ entity: dead, plans: [PLAN_ROW], namesakes: { live: 0, total: 1 } }).p, { edrpou: '12345678' });
    expect(withDeadNamesake[0]).toMatchObject({ found: false, ambiguous: true });
    const alone = await searchInspectionPlans(pool({ entity: dead, plans: [PLAN_ROW], namesakes: { live: 0, total: 0 } }).p, { edrpou: '12345678' });
    expect(alone.results).toHaveLength(1);
  });

  it('does not probe namesakes when the plans have no row with the name', async () => {
    const { p, query } = pool({ entity: [ENTITY], plans: [] });
    const res = await searchInspectionPlans(p, { edrpou: '41633007' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(res[0]).toMatchObject({ found: false, message: expect.stringMatching(/немає записів/) });
  });

  it('a code missing from ЄДР cannot be matched', async () => {
    const { p } = pool({ entity: [] });
    const res = await searchInspectionPlans(p, { edrpou: '41633007' });
    expect(res[0].message).toMatch(/не знайдено в ЄДР/);
  });

  it('rejects a code that is not 8 digits without querying', async () => {
    const { p, query } = pool({});
    const res = await searchInspectionPlans(p, { edrpou: '1234567890' });
    expect(res[0].found).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('search_inspection_plans MCP wiring', () => {
  it('is listed and routed', async () => {
    const { p } = pool({ plans: [] });
    const api = new MCPOpenReyestrAPI(new OpenReyestrTools(p));
    const def = api.getTools().find((t: any) => t.name === 'search_inspection_plans');
    expect(def).toBeDefined();
    expect(Object.keys((def as any).inputSchema.properties)).toEqual(expect.arrayContaining(['query', 'edrpou', 'supervisory_body', 'plan_year']));
    const res = await api.handleToolCall('search_inspection_plans', { supervisory_body: 'праці' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)[0].found).toBe(false);
  });
});
