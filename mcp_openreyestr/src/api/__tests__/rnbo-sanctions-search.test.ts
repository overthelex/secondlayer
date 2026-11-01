import { Pool } from 'pg';
import { OpenReyestrTools, formatRnboSanctionRow, normalizeRnboSchemaType } from '../openreyestr-tools';

function mockPool(rows: any[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('normalizeRnboSchemaType (LEXAI-2167)', () => {
  it.each([
    ['Company', 'Organization'],
    ['LegalEntity', 'Organization'],
    ['Organization', 'Organization'],
    ['organisation', 'Organization'],
    ['legal', 'Organization'],
    ['юридична особа', 'Organization'],
    ['Person', 'Person'],
    ['individual', 'Person'],
    [' фізична  особа ', 'Person'],
    ['Vessel', 'Vessel'],
    ['ship', 'Vessel'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRnboSchemaType(input)).toBe(expected);
  });

  it.each(['Airplane', 'Aircraft', 'CryptoWallet', ''])('%s → null (not in the register)', (input) => {
    expect(normalizeRnboSchemaType(input)).toBeNull();
  });
});

describe('formatRnboSanctionRow (LEXAI-2167)', () => {
  it('drops import timestamps and reports listing_date as unknown', () => {
    const snap = new Date('2026-07-03T11:11:09.939Z');
    const out = formatRnboSanctionRow({
      entity_id: 'DRS-14453', name: 'Медведчук Віктор Володимирович', sanctions: 'active',
      first_seen: snap, last_seen: snap, last_change: snap,
    });
    expect(out).not.toHaveProperty('first_seen');
    expect(out).not.toHaveProperty('last_seen');
    expect(out).not.toHaveProperty('last_change');
    expect(out).toMatchObject({
      entity_id: 'DRS-14453',
      listing_date: null,
      register_snapshot_date: '2026-07-03',
    });
    expect(out.listing_date_note).toMatch(/невідома/);
  });

  it('uses last_seen when first_seen/last_change are NULL (new importer)', () => {
    const out = formatRnboSanctionRow({ name: 'X', first_seen: null, last_seen: '2026-10-30T08:00:00Z', last_change: null });
    expect(out.register_snapshot_date).toBe('2026-10-30');
  });
});

describe('searchRnboSanctions (LEXAI-2167)', () => {
  it('maps schema_type Company to the stored Organization', async () => {
    const { pool, query } = mockPool([
      { id: 1, entity_id: 'DRS-1', schema_type: 'Organization', name: 'АДЕЛАНТБАНК', sanctions: 'active',
        first_seen: new Date('2026-07-03T11:11:09Z'), last_seen: new Date('2026-07-03T11:11:09Z'), last_change: new Date('2026-07-03T11:11:09Z') },
    ]);
    const res = await new OpenReyestrTools(pool).searchRnboSanctions({ query: 'Аделантбанк', schema_type: 'Company' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/schema_type = \$2/);
    expect(values).toEqual(['%Аделантбанк%', 'Organization', 50, 0]);
    expect(sql).not.toMatch(/ORDER BY last_change/);
    expect(res[0]).toMatchObject({ name: 'АДЕЛАНТБАНК', listing_date: null, register_snapshot_date: '2026-07-03' });
    expect(res[0]).not.toHaveProperty('first_seen');
  });

  it('rejects a schema_type the register does not hold, without querying', async () => {
    const { pool, query } = mockPool([]);
    const res = await new OpenReyestrTools(pool).searchRnboSanctions({ query: 'Ан', schema_type: 'Airplane' });
    expect(query).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ found: false, schema_type: 'Airplane' });
    expect(res[0].message).toMatch(/Person.*Organization.*Vessel/);
  });
});
