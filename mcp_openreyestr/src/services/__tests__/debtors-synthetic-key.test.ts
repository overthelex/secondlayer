import { Pool } from 'pg';
import { REGISTRIES } from '../../config/registries';
import { fillMissingUniqueKeys, isSyntheticKey } from '../synthetic-keys';
import { OpenReyestrTools, formatDebtorRow } from '../../api/openreyestr-tools';

describe('LEXAI-2120: gen_N placeholder must not become a debtor EDRPOU', () => {
  it('leaves debtor_edrpou NULL for an individual without DEBTOR_CODE', () => {
    const mapped: Record<string, unknown> = { proceeding_number: '81645862', debtor_name: 'Кравченко Ганна', debtor_edrpou: null };
    fillMissingUniqueKeys(REGISTRIES.debtors, mapped, 3383);
    expect(mapped.debtor_edrpou).toBeNull();
    expect(mapped.proceeding_number).toBe('81645862');
  });

  it('still fills the other unique-key columns of debtors with a surrogate', () => {
    const mapped: Record<string, unknown> = { proceeding_number: null, debtor_name: 'X', debtor_edrpou: '12345678' };
    fillMissingUniqueKeys(REGISTRIES.debtors, mapped, 7);
    expect(mapped.proceeding_number).toBe('gen_7');
    expect(mapped.debtor_edrpou).toBe('12345678');
  });

  it('keeps the surrogate for registries that do not opt out', () => {
    const mapped: Record<string, unknown> = { proceeding_number: '' };
    fillMissingUniqueKeys(REGISTRIES.enforcement_proceedings, mapped, 5);
    expect(mapped.proceeding_number).toBe('gen_5');
  });

  it('recognises only gen_<digits> as synthetic', () => {
    expect(isSyntheticKey('gen_4355')).toBe(true);
    expect(isSyntheticKey('12345678')).toBe(false);
    expect(isSyntheticKey('gen_')).toBe(false);
    expect(isSyntheticKey(null)).toBe(false);
  });

  it('formatDebtorRow reports a legacy gen_N as null and keeps a real code', () => {
    expect(formatDebtorRow({ id: '1', debtor_edrpou: 'gen_4355' }).debtor_edrpou).toBeNull();
    expect(formatDebtorRow({ id: '2', debtor_edrpou: '3012345678' }).debtor_edrpou).toBe('3012345678');
  });

  it('searchDebtors does not return gen_N rows as debtor_edrpou', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        { id: '10523383', debtor_name: 'Кравченко Ганна Володимирівна', debtor_type: 'individual', debtor_edrpou: 'gen_3383' },
        { id: '10523384', debtor_name: 'ТОВ "АГРО"', debtor_type: 'legal', debtor_edrpou: '31316718' },
      ],
    });
    const res = await new OpenReyestrTools({ query } as unknown as Pool).searchDebtors({ query: 'Кравченко' });
    expect(res[0].debtor_edrpou).toBeNull();
    expect(res[1].debtor_edrpou).toBe('31316718');
  });
});
