import { courtFee, FeeError, type FeeInput } from '../court-fee.js';

const base: FeeInput = { court: 'civil', payer: 'person', doc: 'claim', kind: 'property', amount: 100_000, social: false, electronic: false, year: 2026 };
const fee = (o: Partial<FeeInput>) => courtFee({ ...base, ...o }).fee;

describe('courtFee 2026 (ПМ 3328)', () => {
  it('civil property claim of an individual: 1 %, min 0.4 ПМ, max 5 ПМ', () => {
    expect(fee({})).toBe(1331.2);
    expect(fee({ amount: 500_000 })).toBe(5000);
    expect(fee({ amount: 10_000_000 })).toBe(16640);
    expect(fee({ electronic: true })).toBe(1064.96);
  });
  it('legal entity: 1.5 %, min 1 ПМ, max 350 ПМ', () => {
    expect(fee({ payer: 'legal', amount: 1_000_000 })).toBe(15000);
    expect(fee({ payer: 'legal', amount: 1_000_000_000 })).toBe(1_164_800);
  });
  it('non-property: ФОП pays as a legal entity, an individual 0.4 ПМ', () => {
    expect(fee({ kind: 'nonproperty' })).toBe(1331.2);
    expect(fee({ kind: 'nonproperty', payer: 'fop' })).toBe(3328);
  });
  it('admin property claim of a legal entity is capped at 10 ПМ', () => {
    expect(fee({ court: 'admin', payer: 'legal', amount: 10_000_000 })).toBe(33280);
  });
  it('appeal is 150 % of the claim fee, capped at 8 ПМ (3 ПМ social) for individuals', () => {
    expect(fee({ doc: 'appeal' })).toBe(1996.8);
    expect(fee({ doc: 'appeal', amount: 10_000_000 })).toBe(24960);
    expect(fee({ doc: 'appeal', amount: 10_000_000, social: true })).toBe(9984);
    expect(fee({ doc: 'appeal', court: 'commercial', payer: 'legal', amount: 1_000_000 })).toBe(22500);
  });
  it('cassation is 200 %, admin capped at 20 ПМ', () => {
    expect(fee({ doc: 'cassation', court: 'admin', payer: 'legal', amount: 100_000_000 })).toBe(66560);
  });
  it('fixed rates', () => {
    expect(fee({ doc: 'divorce' })).toBe(1331.2);
    expect(fee({ doc: 'order' })).toBe(332.8);
    expect(fee({ doc: 'ruling_appeal' })).toBe(665.6);
    expect(fee({ doc: 'security', court: 'admin' })).toBe(998.4);
  });
  it('rejects impossible combinations', () => {
    expect(() => courtFee({ ...base, doc: 'order', court: 'admin' })).toThrow(FeeError);
    expect(() => courtFee({ ...base, amount: 0 })).toThrow(FeeError);
    expect(() => courtFee({ ...base, year: 2019 })).toThrow(FeeError);
  });
});
