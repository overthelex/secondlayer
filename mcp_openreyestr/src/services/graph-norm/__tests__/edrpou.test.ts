import { edrpouCheckDigit, isValidEdrpou, normEdrpou } from '../edrpou';

// [first 7 digits, check digit] computed by a separate reference implementation of the algorithm;
// covers weights 1..7 (< 30000000, > 60000000), 7,1..6 (30000000..60000000) and the second pass
// (first remainder 10). Prefixes are synthetic.
const GOLDEN: Array<[string, number]> = [
  ['1234567', 8], ['0003212', 9], ['2000000', 2],          // weights 1..7
  ['3123456', 2], ['4123456', 9], ['5555555', 8],          // weights 7,1,2,3,4,5,6
  ['7654321', 7],                                          // above 60000000
  ['9999999', 4], ['1213813', 4], ['1237570', 5], ['1293003', 2], ['1324679', 8], ['1593925', 1], // second pass
];

describe('edrpouCheckDigit (golden)', () => {
  it.each(GOLDEN)('%s -> %d', (p7, digit) => {
    expect(edrpouCheckDigit(`${p7}0`)).toBe(digit);
    expect(isValidEdrpou(`${p7}${digit}`)).toBe(true);
    expect(isValidEdrpou(`${p7}${(digit + 1) % 10}`)).toBe(false);
  });
});

describe('normEdrpou', () => {
  it('restores leading zeros and strips spaces', () => {
    expect(normEdrpou('32129')).toEqual({ code: '00032129', checksumOk: expect.any(Boolean), problem: null });
    expect(normEdrpou(32129).code).toBe('00032129');
    expect(normEdrpou(' 0003 2129 ').code).toBe('00032129');
    expect(normEdrpou('0012345678').code).toBe('12345678');
  });

  it('flags values that cannot be a code', () => {
    expect(normEdrpou(null)).toEqual({ code: null, checksumOk: false, problem: 'empty' });
    expect(normEdrpou('')).toMatchObject({ problem: 'empty' });
    expect(normEdrpou('00000000')).toMatchObject({ code: null, problem: 'empty' });
    expect(normEdrpou('1234567A')).toMatchObject({ code: null, problem: 'not_digits' });
    expect(normEdrpou('12-345-678')).toMatchObject({ code: null, problem: 'not_digits' });
    expect(normEdrpou('1234567890')).toMatchObject({ code: null, problem: 'too_long' }); // РНОКПП
  });

  it('keeps a code with a wrong check digit, flagged', () => {
    expect(normEdrpou('12345670')).toEqual({ code: '12345670', checksumOk: false, problem: null });
    expect(normEdrpou('12345678')).toEqual({ code: '12345678', checksumOk: true, problem: null });
  });
});
