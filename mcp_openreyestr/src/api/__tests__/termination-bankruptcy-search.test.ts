import { Pool } from 'pg';
import { OpenReyestrTools, escapeLike, formatBankruptcyRow, toIsoDate } from '../openreyestr-tools';

function mockPool(rows: any[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('searchTerminationStarted (LEXAI-2090)', () => {
  it('searches a name through the registry join, not entity_record', async () => {
    const { pool, query } = mockPool([
      { id: 1, entity_type: 'UO', entity_record: '583858', edrpou: '31316718', entity_name: 'ТОВ "АГРО"', op_date: '27.01.2026', creditor_req_end_date: '' },
    ]);
    const res = await new OpenReyestrTools(pool).searchTerminationStarted({ query: 'Агро' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN legal_entities l ON t\.entity_type = 'UO' AND l\.record = t\.entity_record/);
    expect(sql).toMatch(/LEFT JOIN public_associations p ON t\.entity_type = 'FSU' AND p\.record = t\.entity_record/);
    expect(sql).toMatch(/COALESCE\(l\.name, p\.name\) ILIKE \$1/);
    expect(sql).not.toMatch(/entity_record ILIKE/);
    expect(values[0]).toBe('%Агро%');
    expect(res[0]).toMatchObject({ edrpou: '31316718', entity_name: 'ТОВ "АГРО"', op_date: '2026-01-27', creditor_req_end_date: null });
  });

  it('treats a digit-only query as EDRPOU (or record) and does not ILIKE it', async () => {
    const { pool, query } = mockPool([]);
    const res = await new OpenReyestrTools(pool).searchTerminationStarted({ query: ' 40075815 ' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT record FROM legal_entities WHERE edrpou = \$1/);
    expect(sql).toMatch(/SELECT record FROM public_associations WHERE edrpou = \$1/);
    expect(values.slice(0, 1)).toEqual(['40075815']);
    expect(res[0]).toMatchObject({ found: false, message: 'Записів про припинення не знайдено' });
  });

  it('numbers LIMIT/OFFSET after the filters', async () => {
    const { pool, query } = mockPool([]);
    await new OpenReyestrTools(pool).searchTerminationStarted({ query: 'Агро', entity_type: 'UO', limit: 5, offset: 10 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
    expect(values).toEqual(['%Агро%', 'UO', 5, 10]);
  });
});

describe('searchBankruptcyCases (LEXAI-2091)', () => {
  it('formats dates in SQL, drops court_name and resolves EDRPOU by exact name for the page only', async () => {
    const { pool, query } = mockPool([]);
    await new OpenReyestrTools(pool).searchBankruptcyCases({ query: 'Агро', limit: 20 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/to_char\(b\.registration_date, 'YYYY-MM-DD'\)/);
    expect(sql).toMatch(/to_char\(b\.court_decision_date, 'YYYY-MM-DD'\)/);
    expect(sql).not.toMatch(/court_name/);
    expect(sql).toMatch(/CASE WHEN count\(\*\) = 1 THEN min\(l\.edrpou\) END/);
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3\s*\) b/);
    expect(values).toEqual(['Агро', 20, 0]);
  });

  it('filters debtor_edrpou through the ЄДР name as well as the column', async () => {
    const { pool, query } = mockPool([]);
    await new OpenReyestrTools(pool).searchBankruptcyCases({ debtor_edrpou: '41659659' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/debtor_edrpou = \$1/);
    expect(sql).toMatch(/FROM legal_entities WHERE edrpou = \$1/);
    expect(values[0]).toBe('41659659');
  });

  it('maps the raw NAIS fields to honest names', () => {
    const out = formatBankruptcyRow({
      id: 1,
      registration_number: '65729',
      registration_date: '2024-05-29',
      case_number: '904/1519/24',
      court_decision_date: '2024-05-28',
      debtor_name: 'ТДВ "САЛТІВСЬКИЙ ХЛІБЗАВОД"',
      debtor_edrpou: null,
      matched_edrpou: '41659659',
      proceeding_status: 'Ліквідація: (Не визначено), затверджений звіт ліквідатора',
      raw_procedure: 'Ліквідація',
      raw_status: '(Не визначено), затверджений звіт ліквідатора в порядку, передбаченому Законом',
      raw_initiator: { CODEXARTICLE: 'ДПІ у м.Херсоні' },
    });
    expect(out).toEqual({
      id: 1,
      registration_number: '65729',
      registration_date: '2024-05-29',
      case_number: '904/1519/24',
      court_decision_date: '2024-05-28',
      debtor_name: 'ТДВ "САЛТІВСЬКИЙ ХЛІБЗАВОД"',
      debtor_edrpou: '41659659',
      debtor_edrpou_source: 'edr_exact_name_match',
      procedure: 'Ліквідація',
      case_status: null,
      case_closure_ground: 'затверджений звіт ліквідатора в порядку, передбаченому Законом',
      case_initiator: 'ДПІ у м.Херсоні',
      proceeding_status: 'Ліквідація: (Не визначено), затверджений звіт ліквідатора',
    });
    expect(out).not.toHaveProperty('court_name');
  });

  it('keeps empty raw values as null and an ambiguous match as null', () => {
    const out = formatBankruptcyRow({
      id: 2, registration_number: 'x', case_number: '', debtor_name: '', debtor_edrpou: null, matched_edrpou: null,
      raw_procedure: '.', raw_status: ',', raw_initiator: '',
    });
    expect(out).toMatchObject({
      case_number: null, debtor_name: null, debtor_edrpou: null, debtor_edrpou_source: null,
      procedure: null, case_status: null, case_closure_ground: null, case_initiator: null,
      registration_date: null,
    });
    expect(formatBankruptcyRow({ raw_status: 'ухвала суду про скасування закриття провадження, інша підстава', raw_initiator: { CODEXARTICLE: '-' } }))
      .toMatchObject({ case_status: 'ухвала суду про скасування закриття провадження', case_closure_ground: 'інша підстава', case_initiator: null });
  });
});

describe('helpers', () => {
  it('toIsoDate converts DD.MM.YYYY and leaves other values', () => {
    expect(toIsoDate('14.03.2026')).toBe('2026-03-14');
    expect(toIsoDate('2026-03-14')).toBe('2026-03-14');
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });

  it('escapeLike neutralises wildcards', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});
