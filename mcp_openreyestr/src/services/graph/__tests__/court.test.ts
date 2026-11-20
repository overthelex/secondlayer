import { caseKey, COURT_HUB_POLICY, courtHubThreshold, rolePair, sourceYearSql } from '../court';
import { EDGE_KINDS, EDGE_SOURCES } from '../keys';
import { stageDdl } from '../builder';

describe('court co_party helpers (LEXAI-2304)', () => {
  it('keys case numbers without blanks, lower case', () => {
    expect(caseKey('910 / 100/24')).toBe('910/100/24');
    expect(caseKey('  ')).toBeNull();
    expect(caseKey(null)).toBeNull();
  });

  it('labels role pairs src first', () => {
    expect(rolePair(1, 2)).toBe('plaintiff-defendant');
    expect(rolePair(2, 1)).toBe('defendant-plaintiff');
    expect(rolePair(3, 3)).toBe('third_party-third_party');
    expect(rolePair(1, 7)).toBe('plaintiff-role7');
  });

  it('computes the litigation hub threshold as max(floor, percentile)', () => {
    expect(courtHubThreshold(245)).toEqual({ threshold: 245, basis: 'percentile' });
    expect(courtHubThreshold(3)).toEqual({ threshold: COURT_HUB_POLICY.floor, basis: 'floor' });
    expect(courtHubThreshold(null)).toEqual({ threshold: COURT_HUB_POLICY.floor, basis: 'floor' });
    expect(courtHubThreshold(245, 7)).toEqual({ threshold: 7, basis: 'override' });
  });

  it('copies only 8-digit codes and no names from the source', () => {
    const sql = sourceYearSql(2024);
    expect(sql).toContain(`p.edrpou ~ '^[0-9]{8}$'`);
    expect(sql).toContain('p.adj_year = 2024');
    expect(sql).not.toMatch(/name_(raw|norm|core)/);
    expect(() => sourceYearSql(2024.5)).toThrow();
  });

  it('declares the new kind and source in the staging DDL', () => {
    expect(EDGE_KINDS).toContain('co_party');
    expect(EDGE_SOURCES).toContain('edrsr');
    const ddl = stageDdl('s').join('\n');
    for (const k of EDGE_KINDS) expect(ddl).toContain(`'${k}'`);
    for (const s of EDGE_SOURCES) expect(ddl).toContain(`'${s}'`);
  });
});
