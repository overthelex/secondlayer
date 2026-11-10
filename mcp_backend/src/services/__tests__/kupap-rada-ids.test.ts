import { expandKupapRadaIds, KUPAP_RADA_ID, KUPAP_LEGACY_RADA_IDS } from '../legislation-service';

describe('expandKupapRadaIds', () => {
  it('leaves the in-force КУпАП id alone: 8073-10 holds every article', () => {
    expect(expandKupapRadaIds('8073-10')).toEqual(['8073-10']);
    expect(KUPAP_RADA_ID).toBe('8073-10');
  });

  it('still widens a legacy half to both halves (pre-2017 editions)', () => {
    expect(expandKupapRadaIds('80731-10')).toEqual([...KUPAP_LEGACY_RADA_IDS]);
    expect(expandKupapRadaIds('80732-10')).toEqual([...KUPAP_LEGACY_RADA_IDS]);
  });

  it('never adds the legacy halves to a current lookup', () => {
    expect(expandKupapRadaIds('8073-10')).not.toContain('80731-10');
  });

  it('passes any other id through unchanged', () => {
    expect(expandKupapRadaIds('1618-15')).toEqual(['1618-15']);
  });
});
