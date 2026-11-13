import { Pool } from 'pg';
import { OpenReyestrTools } from '../openreyestr-tools';

function mockPool(rows: any[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('searchProzorro with winners (LEXAI-2227)', () => {
  it('starts from contracts when a supplier filter is given', async () => {
    const { pool, query } = mockPool([{ tender_id: 't', supplier_edrpou: '41633007' }]);
    const tools = new OpenReyestrTools(pool);
    await tools.searchProzorro({ supplier_edrpou: '41633007', cpv_code: '45', limit: 10 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/FROM prozorro_contracts c\s+JOIN prozorro_tenders t ON t.tender_id = c.tender_id/);
    expect(sql).toContain('t.cpv_code LIKE $1');
    expect(sql).toContain('c.supplier_edrpou = $2');
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect(values).toEqual(['45%', '41633007', 10, 0]);
  });

  it('normalizes the phone before matching', async () => {
    const { pool, query } = mockPool([{ tender_id: 't' }]);
    await new OpenReyestrTools(pool).searchProzorro({ supplier_phone: '097 700-92-63' });
    expect(query.mock.calls[0][1][0]).toBe('380977009263');
  });

  it('rejects a phone that cannot be a phone without querying', async () => {
    const { pool, query } = mockPool();
    const [r] = await new OpenReyestrTools(pool).searchProzorro({ supplier_phone: '12' });
    expect(r.found).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('attaches winners to tenders when searching by buyer', async () => {
    const { pool, query } = mockPool([{ tender_id: 't', winners: [] }]);
    await new OpenReyestrTools(pool).searchProzorro({ buyer_edrpou: '05403286', limit: 500 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/FROM prozorro_tenders t\s+LEFT JOIN LATERAL/);
    expect(sql).toContain('AS winners');
    expect(values).toEqual(['05403286', 100, 0]); // limit capped
  });

  it('explains that winners are partial when a supplier has no contracts', async () => {
    const { pool } = mockPool([]);
    const [r] = await new OpenReyestrTools(pool).searchProzorro({ supplier_edrpou: '1' });
    expect(r.found).toBe(false);
    expect(r.message).toContain('поступово');
  });

  it('still requires at least one filter', async () => {
    const { pool, query } = mockPool();
    const [r] = await new OpenReyestrTools(pool).searchProzorro({});
    expect(r.found).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
