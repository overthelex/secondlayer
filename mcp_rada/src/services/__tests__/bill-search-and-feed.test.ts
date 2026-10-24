jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../adapters/rada-api-adapter', () => ({ RadaAPIAdapter: class {} }));
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BillService } from '../bill-service';
import { billCardUrl, billInfoToRow } from '../bill-feed';
import { buildUpsert } from '../../scripts/sync-bills';

// LEXAI-2099: «бронювання працівників» returned 1 bill (phrase ILIKE on title) and
// status/stage/url were NULL for every bill (only billinfo_list was ever imported).

const makeService = (query: jest.Mock) => new BillService({ query } as any, {} as any);

describe('BillService.searchBills word-level search', () => {
  it('matches every query word by stem in the title, title hits ranked first', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ bill_number: '16160' }] });
    await makeService(query).searchBills({ query: 'бронювання', limit: 20 });

    const [sql, params] = query.mock.calls[0];
    expect(params).toContain('бронюванн:*');
    expect(params).toContain('%бронювання%');
    expect(sql).toContain("to_tsvector('simple', title) @@ to_tsquery('simple', $");
    expect(sql).toMatch(/ORDER BY \(to_tsvector.*\) DESC, ts_rank\(/);
    // single word: no relaxed pass
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('appends idf-weighted any-word matches when the strict pass is short of the limit', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ bill_number: '16160' }] })
      .mockResolvedValueOnce({
        rows: [
          { bill_number: '15237', _score: 7.1 },
          { bill_number: '11388', _score: 7.1 },
        ],
      });
    const result = await makeService(query).searchBills({ query: 'бронювання працівників', limit: 20 });

    expect(query.mock.calls[0][1]).toContain('бронюванн:* & працівник:*');
    const [sql, params] = query.mock.calls[1];
    expect(params[0]).toEqual(['бронюванн:*', 'працівник:*']);
    expect(params[1]).toBe('бронюванн:* | працівник:*');
    expect(params[2]).toEqual(['16160']); // strict hits are not repeated
    expect(sql).toContain('_score >= 0.5 *');
    expect(sql).toContain('LIMIT 19');
    expect(result.bills.map((b) => b.bill_number)).toEqual(['16160', '15237', '11388']);
    expect(result.bills[1]).not.toHaveProperty('_score');
    expect(result.relaxed).toBe(true);
  });

  it('skips the relaxed pass when the strict pass fills the limit', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ bill_number: '1' }, { bill_number: '2' }] });
    const result = await makeService(query).searchBills({ query: 'бронювання працівників', limit: 2 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.relaxed).toBeUndefined();
  });

  it('maps the status enum onto Rada phase labels in both passes', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    // stop the zero-result API sync from running
    const service = makeService(query);
    (service as any).syncRecentBills = jest.fn().mockResolvedValue(0);
    await service.searchBills({ query: 'бронювання працівників', status: 'adopted' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('status = ANY($1::text[])');
    expect(params[0]).toEqual(expect.arrayContaining(['Закон підписано', 'Постанову підписано']));
    const [relaxedSql, relaxedParams] = query.mock.calls[1];
    expect(relaxedSql).toMatch(/status = ANY\(\$4::text\[\]\)/);
    expect(relaxedParams[3]).toEqual(BillService.STATUS_GROUPS.adopted);
  });
});

describe('billInfoToRow (billinfo-sklN.json card → rada.bills)', () => {
  const card = {
    id: 44414,
    type: 'Звичайний',
    name: 'Проєкт Закону про внесення змін до Податкового кодексу України, спрямованих на встановлення спеціального збору за бронювання',
    url: 'https://itd.rada.gov.ua/billInfo/Bills/Card/44414',
    registrationNumber: '11332-1',
    registrationDate: '2024-06-17T00:00:00',
    registrationSession: '11 сесія',
    registrationConvocation: 'IX скликання',
    redaction: 'Альтернативний',
    rubric: 'Економічна політика',
    subject: 'Народний депутат України',
    initiators: [
      { mp: { person: { id: 208, surname: 'Іванов', firstname: 'Іван', patronymic: 'Іванович' } } },
    ],
    mainExecutives: [
      { department: 'Комітет Верховної Ради України з питань фінансів, податкової та митної політики' },
    ],
    currentPhase: { date: null, title: null, status: 'Опрацьовується в комітеті' },
    passings: [
      { date: '2024-06-17T18:53:14', title: 'Направлено на розгляд Комітету', status: 'Одержано проєкт' },
      { date: '2024-06-18T08:57:28.517', title: 'Надано для ознайомлення', status: 'Опрацьовується в комітеті' },
      { date: '2024-06-17T14:57:26.113', title: 'Одержано Верховною Радою України', status: 'Прийом' },
    ],
  };

  it('fills status, stage (latest passing), url, committee and rubric', () => {
    const row = billInfoToRow(card, 9)!;
    expect(row.bill_number).toBe('11332-1');
    expect(row.registration_date).toBe('2024-06-17');
    expect(row.status).toBe('Опрацьовується в комітеті');
    expect(row.stage).toBe('Надано для ознайомлення');
    expect(row.url).toBe('https://itd.rada.gov.ua/billInfo/Bills/Card/44414');
    expect(row.main_committee_name).toContain('фінансів, податкової');
    expect(row.subject_area).toBe('Економічна політика');
    expect(row.initiator_type).toBe('Народний депутат України');
    expect(row.initiator_names).toEqual(['Іванов Іван Іванович']);
    expect(row.metadata).toMatchObject({ bill_id: 44414, convocation: 9, initiator_ids: [208] });
  });

  it('derives the itd card url from the id when the feed has none', () => {
    const row = billInfoToRow({ ...card, url: '' }, 9)!;
    expect(row.url).toBe('https://itd.rada.gov.ua/billInfo/Bills/Card/44414');
    expect(billCardUrl(undefined)).toBeNull();
    expect(billCardUrl('abc')).toBeNull();
  });

  it('skips cards without a number or title', () => {
    expect(billInfoToRow({ ...card, registrationNumber: null }, 9)).toBeNull();
    expect(billInfoToRow({ ...card, name: ' ' }, 9)).toBeNull();
  });
});

describe('sync-bills buildUpsert', () => {
  it('upserts by bill_number without wiping known values with NULLs', () => {
    const row = billInfoToRow(
      {
        id: 1,
        name: 'Проєкт Закону',
        registrationNumber: '2064',
        registrationDate: '2019-09-05T00:00:00',
        currentPhase: { status: 'Закон підписано' },
        passings: [],
      },
      9
    )!;
    const { sql, params } = buildUpsert([row, { ...row, bill_number: '2065' }], 86400);
    expect(params[0]).toBe(86400);
    expect(params).toHaveLength(1 + 2 * 11);
    expect(sql).toContain('ON CONFLICT (bill_number) DO UPDATE');
    expect(sql).toContain('status = COALESCE(EXCLUDED.status, bills.status)');
    expect(sql).toContain('url = COALESCE(EXCLUDED.url, bills.url)');
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).toContain('($13, $14,');
  });
});
