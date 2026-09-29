import { classifyEffect, matchEffect, parseTarget } from '../uk-effects-match';

// Register strings below are real ones seen in uk_legislation_effects for the acts a
// 2016 London office lease cites.
describe('parseTarget', () => {
  it('reads bare numbers, prefixed numbers, keys and schedule paragraphs', () => {
    expect(parseTarget('253', 'ukpga/1986/45')).toEqual({ kind: 'section', number: '253' });
    expect(parseTarget('38A', 'ukpga/Eliz2/2-3/56')).toEqual({ kind: 'section', number: '38A' });
    expect(parseTarget('s.196', 'ukpga/Geo5/15-16/20')).toEqual({ kind: 'section', number: '196' });
    expect(parseTarget('ukpga/1986/45/section/253', 'ukpga/1986/45')).toEqual({ kind: 'section', number: '253' });
    expect(parseTarget('schedule/B1/paragraph/15', 'ukpga/1986/45')).toEqual({ kind: 'paragraph', schedule: 'B1', number: '15' });
    expect(parseTarget('2', 'uksi/2007/991')).toEqual({ kind: 'regulation', number: '2' });
    expect(parseTarget('180', 'uksi/2003/1417', 'rule')).toEqual({ kind: 'rule', number: '180' });
    expect(parseTarget('not a provision', 'ukpga/1986/45')).toBeNull();
  });
});

describe('matchEffect', () => {
  const s = (n: string) => ({ kind: 'section', number: n });

  it('matches the provision itself, including subsections', () => {
    expect(matchEffect('s. 253(5)', s('253'))).toBe('provision');
    expect(matchEffect('s. 106(1)(d)', s('106'))).toBe('provision');
  });

  it('does not confuse s.1 with s.12 or s.123', () => {
    expect(matchEffect('s. 12(3)', s('1'))).toBeNull();
    expect(matchEffect('s. 123', s('1'))).toBeNull();
    expect(matchEffect('s. 1(4)(b)', s('1'))).toBe('provision');
  });

  it('treats a range as covering every section inside it', () => {
    // LURA 2023 s.209 excludes "s. 24-28" of the 1954 Act: s.25 is inside, s.29 is not.
    expect(matchEffect('s. 24-28', s('25'))).toBe('provision');
    expect(matchEffect('s. 24-28', s('28'))).toBe('provision');
    expect(matchEffect('s. 24-28', s('29'))).toBeNull();
    expect(matchEffect('s. 1-7B', s('7A'))).toBe('provision');
    expect(matchEffect('s. 1-7B', s('7C'))).toBeNull();
  });

  it('reports whole-instrument and Part effects by scope', () => {
    expect(matchEffect('Regulations', { kind: 'regulation', number: '2' })).toBe('whole_instrument');
    expect(matchEffect('Act', s('38A'))).toBe('whole_instrument');
    expect(matchEffect('Pt. 2', s('24'))).toBe('part');
  });

  it('matches schedule paragraphs only inside their own schedule', () => {
    const p15 = { kind: 'paragraph', schedule: 'B1', number: '15' };
    expect(matchEffect('Sch. B1 para. 15(2)', p15)).toBe('provision');
    expect(matchEffect('Sch. B1 para. 14-16', p15)).toBe('provision');
    expect(matchEffect('Sch. B1 para. 150', p15)).toBeNull();
    expect(matchEffect('Sch. 4 para. 15', p15)).toBeNull();
    expect(matchEffect('Sch. B1', p15)).toBe('part');
    // A Part of the body of the act never holds a schedule paragraph.
    expect(matchEffect('Pt. 9 Ch. 1 heading', p15)).toBeNull();
  });

  it('never matches a schedule entry to a section', () => {
    expect(matchEffect('Sch. 1 para. 253', s('253'))).toBeNull();
    expect(matchEffect('Sch. Pt. B Class B2', s('2'))).toBeNull();
  });

  it('matches regulations and articles by their own prefix', () => {
    expect(matchEffect('reg. 2(1)', { kind: 'regulation', number: '2' })).toBe('provision');
    expect(matchEffect('art. 3(6)(p)-(x)', { kind: 'article', number: '3' })).toBe('provision');
    expect(matchEffect('reg. 2(1)', { kind: 'article', number: '2' })).toBeNull();
  });
});

describe('classifyEffect', () => {
  it('separates real changes from the act being used elsewhere', () => {
    expect(classifyEffect('words substituted')).toBe('amendment');
    expect(classifyEffect('revoked')).toBe('amendment');
    expect(classifyEffect('amended (prosp.)')).toBe('amendment');
    expect(classifyEffect('omitted')).toBe('amendment');
    expect(classifyEffect('excluded')).toBe('modification');
    expect(classifyEffect('restricted')).toBe('modification');
    expect(classifyEffect('modified')).toBe('modification');
    expect(classifyEffect('coming into force')).toBe('commencement');
    expect(classifyEffect('applied')).toBe('other');
    expect(classifyEffect('applied (with modifications)')).toBe('other');
    expect(classifyEffect('applied by 2007 c. 27 s. 27A(2) (as inserted)')).toBe('other');
    expect(classifyEffect('power to apply (with or without modifications) conferred by 2007 c. 27 s. 27A(7) (as inserted)')).toBe('other');
    expect(classifyEffect('transfer of powers in part (W)')).toBe('other');
  });
});
