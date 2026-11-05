jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { stripTrailingDivisionNumber } from '../npa-tools';

// LEXAI-2132: the next division's number stayed glued to the last article of a part.
describe('stripTrailingDivisionNumber', () => {
  it('drops a bare roman numeral after an amendment note', () => {
    expect(stripTrailingDivisionNumber('… від 07.04.2011 } VII.')).toBe('… від 07.04.2011 }');
  });

  it('drops «Розділ N» after the end of a sentence', () => {
    expect(stripTrailingDivisionNumber('встановленому Кабінетом Міністрів України. Розділ IV')).toBe('встановленому Кабінетом Міністрів України.');
  });

  it('keeps a roman numeral that is part of the text', () => {
    expect(stripTrailingDivisionNumber('відповідно до розділу VII')).toBe('відповідно до розділу VII');
    expect(stripTrailingDivisionNumber('скликання IX.')).toBe('скликання IX.');
  });
});
