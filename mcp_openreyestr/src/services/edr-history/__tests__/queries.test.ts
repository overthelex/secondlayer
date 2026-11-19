import { queryMatchKey } from '../queries';
import { uaMatchKey } from '../norm';

describe('queryMatchKey', () => {
  it('writes out НАК so the query meets the full name the register stores', () => {
    expect(queryMatchKey('НАК НАФТОГАЗ УКРАЇНИ'))
      .toBe(uaMatchKey('НАЦІОНАЛЬНА АКЦІОНЕРНА КОМПАНІЯ "НАФТОГАЗ УКРАЇНИ"'));
    expect(queryMatchKey('нак «Нафтогаз України»')).toBe('natsionalna aktsionerna naftohaz ukraini');
  });

  it('leaves other queries as uaMatchKey makes them', () => {
    expect(queryMatchKey('Коломойський Ігор')).toBe(uaMatchKey('Коломойський Ігор'));
    expect(queryMatchKey('НАКАЗ')).toBe(uaMatchKey('НАКАЗ'));
  });
});
