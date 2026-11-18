import { Pool } from 'pg';
import { OpenReyestrTools } from '../openreyestr-tools';

function mockPool(rows: any[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('searchFounders (reverse search by founder)', () => {
  it('matches the name literally and the country after the residency/citizenship marker', async () => {
    const { pool, query } = mockPool([{ founder_info: 'X' }]);
    await new OpenReyestrTools(pool).searchFounders({ query: '100%_LTD', country: 'Кіпр', limit: 10 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('f.founder_info ILIKE $1');
    expect(sql).toContain('f.founder_info ~* $2');
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect(values).toEqual(['%100\\%\\_LTD%', '(резиденство|громадянство): [^;]*Кіпр', 10, 0]);
  });

  it('escapes regex metacharacters in the country', async () => {
    const { pool, query } = mockPool([{}]);
    await new OpenReyestrTools(pool).searchFounders({ country: 'Віргінські (Брит.)' });
    expect(query.mock.calls[0][1][0]).toBe('(резиденство|громадянство): [^;]*Віргінські \\(Брит\\.\\)');
  });

  it('foreign_only excludes Ukraine and requires a country marker', async () => {
    const { pool, query } = mockPool([{}]);
    await new OpenReyestrTools(pool).searchFounders({ query: 'ГМБХ', foreign_only: true, entity_type: 'UO' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("f.founder_info !~ '(резиденство|громадянство): Україна'");
    expect(sql).toContain('f.entity_type = $2');
    expect(values).toEqual(['%ГМБХ%', 'UO', 50, 0]);
  });

  it('clamps limit to 100', async () => {
    const { pool, query } = mockPool([{}]);
    await new OpenReyestrTools(pool).searchFounders({ country: 'Кіпр', limit: 5000 });
    expect(query.mock.calls[0][1].slice(-2)).toEqual([100, 0]);
  });

  it('refuses an unselective call without querying', async () => {
    const { pool, query } = mockPool();
    const [r] = await new OpenReyestrTools(pool).searchFounders({ query: 'ab', foreign_only: true });
    expect(r.found).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('says so when nothing is found', async () => {
    const { pool } = mockPool([]);
    const [r] = await new OpenReyestrTools(pool).searchFounders({ country: 'Атлантида' });
    expect(r.found).toBe(false);
    expect(r.country).toBe('Атлантида');
  });
});
