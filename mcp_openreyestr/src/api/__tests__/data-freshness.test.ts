import { Pool } from 'pg';
import { FRESHNESS_FROM_IMPORT_LOG, FRESHNESS_PROBES, OpenReyestrTools } from '../openreyestr-tools';

describe('getDataFreshness (LEXAI-2227)', () => {
  function tools(failOn?: string) {
    const query = jest.fn(async (sql: string) => {
      if (failOn && sql.includes(failOn)) throw new Error('relation does not exist');
      if (sql.includes('import_log')) return { rows: [{ registry_name: 'debtors', at: new Date('2026-11-13T03:05:37Z') }] };
      return { rows: [{ v: new Date('2026-11-05T05:18:07Z') }] };
    });
    return { t: new OpenReyestrTools({ query } as unknown as Pool), query };
  }

  it('dates each registry and carries upstream caveats for frozen sources', async () => {
    const { t } = tools();
    const f = await t.getDataFreshness();
    expect(f.legal_entities).toEqual({ as_of: '2026-11-05', basis: expect.any(String) });
    expect(f.debtors.as_of).toBe('2026-11-13');
    expect(f.enforcement_proceedings.as_of).toBeNull(); // no import_log row
    expect(f.tax_debt.note).toMatch(/22\.02\.2022/);
    expect(f.bankruptcy_cases.note).toMatch(/31\.05\.2024/);
    expect(f.founders).toEqual(f.beneficiaries);
    for (const p of FRESHNESS_PROBES) expect(f[p.key]).toBeDefined();
    for (const [k] of FRESHNESS_FROM_IMPORT_LOG) expect(f[k]).toBeDefined();
  });

  it('marks a failing probe as unknown instead of failing the whole call, and caches', async () => {
    const { t, query } = tools('FROM esv_debt');
    const f = await t.getDataFreshness();
    expect(f.esv_debt).toEqual({ as_of: null, basis: 'невідомо' });
    const n = query.mock.calls.length;
    await t.getDataFreshness();
    expect(query.mock.calls.length).toBe(n);
  });
});
