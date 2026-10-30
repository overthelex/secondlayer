/**
 * uk_search_legislation by title: an exact or leading title match and primary legislation
 * rank above SIs that merely name the act ('Landlord and Tenant Act 1954' used to come
 * after its own regulations). The database is mocked — no network.
 */

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { UkLegislationTools } from '../uk-legislation-tools.js';

function search(args: Record<string, unknown>) {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  return new UkLegislationTools(db).executeTool('uk_search_legislation', args).then(() => {
    const [sql, values] = db.query.mock.calls[0];
    return { sql: sql as string, values: values as any[] };
  });
}

describe('uk_search_legislation ranking', () => {
  it('ranks exact title, then title prefix, then primary legislation, then year', async () => {
    const { sql, values } = await search({ query: 'Landlord and Tenant Act 1954' });
    const order = sql.slice(sql.indexOf('ORDER BY'));
    const tiers = [/lower\(l\.title\) = lower\(\$2\)/, /left\(lower\(l\.title\)/, /leg_type = ANY\(\$3::text\[\]\)/, /l\.year DESC/];
    const at = tiers.map(re => order.search(re));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(values[0]).toBe('%Landlord and Tenant Act 1954%');
    expect(values[1]).toBe('Landlord and Tenant Act 1954');
    expect(values[2]).toEqual(expect.arrayContaining(['ukpga', 'asp', 'nia']));
    expect(values[2]).not.toContain('uksi');
  });

  it('keeps the filter parameters ahead of the ranking ones', async () => {
    const { sql, values } = await search({ query: 'Housing', leg_type: 'ukpga', year: 1988 });
    expect(sql).toMatch(/l\.leg_type = \$2/);
    expect(sql).toMatch(/l\.year = \$3/);
    expect(values.slice(1, 4)).toEqual(['ukpga', 1988, 'Housing']);
    expect(sql).toMatch(/lower\(l\.title\) = lower\(\$4\)/);
  });

  it('still puts an exact id first', async () => {
    const { sql, values } = await search({ query: 'ukpga/2006/46' });
    expect(sql).toMatch(/ORDER BY \(l\.id = \$1\) DESC/);
    expect(values[0]).toBe('ukpga/2006/46');
  });
});
