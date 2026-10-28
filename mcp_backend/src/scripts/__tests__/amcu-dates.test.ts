import {
  monthFromToken,
  headerDateOf,
  fileDateOf,
  monthHintOf,
  resolveDecisionDate,
  parseBidRiggingDate,
  sourceFileDateOf,
} from '../amcu-dates';

describe('monthFromToken (LEXAI-2118)', () => {
  const genitive = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  const nominative = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
    'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

  it.each(genitive.map((w, i) => [w, i + 1]))('genitive %s → %i', (w, m) => {
    expect(monthFromToken(w as string)).toBe(m);
    expect(monthFromToken((w as string).toUpperCase())).toBe(m);
  });

  it.each(nominative.map((w, i) => [w, i + 1]))('nominative %s → %i', (w, m) => {
    expect(monthFromToken(w as string)).toBe(m);
  });

  it('червня is June, never August', () => {
    expect(monthFromToken('червня')).toBe(6);
    expect(monthFromToken('серпня')).toBe(8);
  });

  it('accepts Latin look-alike letters inside Ukrainian words', () => {
    expect(monthFromToken('чepвня')).toBe(6); // Latin e, p
    expect(monthFromToken('cічня')).toBe(1); // Latin c
    expect(monthFromToken('листoпада')).toBe(11); // Latin o
  });

  it.each([
    ['sichen', 1], ['lutiy', 2], ['lyutyy', 2], ['lutuy', 2], ['berezen', 3], ['kviten', 4],
    ['traven', 5], ['cherven', 6], ['sherven', 6], ['сherven', 6] /* Cyrillic с */, ['lypen', 7],
    ['serpen', 8], ['veres', 9], ['zhovten', 10], ['zovten', 10], ['listopad', 11],
    ['lystopad', 11], ['lustopad', 11], ['hruden', 12], ['gruden', 12],
  ])('transliterated %s → %i', (w, m) => {
    expect(monthFromToken(w as string)).toBe(m);
  });

  it('rejects non-month words', () => {
    for (const w of ['rish', 'list', 'рішення', 'Київ', 'р', '']) expect(monthFromToken(w)).toBeNull();
  });
});

describe('headerDateOf', () => {
  it('reads the verbal header date', () => {
    expect(headerDateOf('АНТИМОНОПОЛЬНИЙ КОМІТЕТ УКРАЇНИ РІШЕННЯ 11 червня 2026 р. Київ № 447-р Про ...'))
      .toBe('2026-06-11');
    expect(headerDateOf('РІШЕННЯ\n4 червня 2026 р.\nКиїв\n№ 433-р')).toBe('2026-06-04');
  });

  it('reads a numeric header date and ignores dates cited after №', () => {
    expect(headerDateOf('РІШЕННЯ 23.10.2025 Київ № 697-р Про визнання рішення від 31 липня 2025 року'))
      .toBe('2025-10-23');
  });

  it('returns null without a header date', () => {
    expect(headerDateOf(null)).toBeNull();
    expect(headerDateOf('Про надання дозволу')).toBeNull();
  });
});

describe('fileDateOf', () => {
  it('prefers the document name over a batch folder', () => {
    expect(fileDateOf('x.7z!Рішення від 20.01.2018 №742-768/Рішення від 20 12 2018 № 758-р.doc'))
      .toBe('2018-12-20');
    expect(fileDateOf('a.zip!rish_cherven_2021/Рішення від 17. 06.2021 № 370-р.doc')).toBe('2021-06-17');
    expect(fileDateOf('01472215_rozporiadzhennia_vid_18_01_2024_no-_6_rp.doc')).toBe('2024-01-18');
    expect(fileDateOf('z.zip!2019-10-03/Rish 2019.10.04 № 681-р.docx')).toBe('2019-10-04');
  });

  it('falls back to the path when the name has no date', () => {
    expect(fileDateOf('03411012_2019-09-02.zip!x/рішення.doc')).toBe('2019-09-02');
  });
});

describe('resolveDecisionDate', () => {
  const p447 = '01a96090_rish_sherven_2026.zip!rish_сherven_2026/Рішення від 11.08.2026 № 447-р.docx';

  it('LEXAI-2118: 447-р is 11 June, not 11 August', () => {
    expect(monthHintOf(p447)).toBe(6);
    expect(resolveDecisionDate(p447, 'РІШЕННЯ 11 червня 2026 р. Київ № 447-р')).toBe('2026-06-11');
  });

  it('falls back to the file name without text', () => {
    expect(resolveDecisionDate(p447, null)).toBe('2026-08-11');
  });

  it('year-only conflict: archive year decides, else the file name', () => {
    // file name mistyped (2024) inside the 2025 archive
    expect(resolveDecisionDate('x_rish_kviten_12_05_2025.zip!rish_kviten/Рішення від 17.04.2024 № 164-р.docx',
      'РІШЕННЯ 17 квітня 2025 р. Київ № 164-р')).toBe('2025-04-17');
    // header mistyped (old year in January)
    expect(resolveDecisionDate('x.zip!r/2019/17.01.2019/Рішення від 17.01.2019 №19-p.doc',
      'РІШЕННЯ 17 січня 2018 р. Київ № 19-р')).toBe('2019-01-17');
  });

  it('day/month conflict: archive month decides, else the header', () => {
    expect(resolveDecisionDate('x_rish_traven_11_06_2025.zip!rish_traven/Рішення від 15.05.2025 № 201-р.doc',
      'РІШЕННЯ 15 червня 2025 р. Київ № 201-р')).toBe('2025-05-15');
    expect(resolveDecisionDate('x_24-04-2019.zip!24 04 2019/Рішення 22.04.2019 №271-р.doc',
      'РІШЕННЯ 24 квітня 2019 р. Київ № 271-р')).toBe('2019-04-24');
  });
});

describe('parseBidRiggingDate', () => {
  it('reads the publication date from the list name', () => {
    expect(sourceFileDateOf('0de137d6_zvedeni-vidomosti_11_05_2026.xlsx')).toBe('2026-05-11');
  });

  it('LEXAI-2118: swaps day/month when the date is after the list was published', () => {
    expect(parseBidRiggingDate('2026-09-04', '2026-05-11')).toBe('2026-04-09');
    expect(parseBidRiggingDate('2026-09-04', null)).toBe('2026-09-04');
    expect(parseBidRiggingDate('2023-06-19', '2026-05-11')).toBe('2023-06-19');
  });

  it('keeps an impossible swap as-is', () => {
    expect(parseBidRiggingDate('2026-09-20', '2026-05-11')).toBe('2026-09-20');
  });

  it('parses the other formats seen in the source files', () => {
    expect(parseBidRiggingDate('2020-29-05')).toBe('2020-05-29');
    expect(parseBidRiggingDate('29 05 2020')).toBe('2020-05-29');
    expect(parseBidRiggingDate('29/10/2019')).toBe('2019-10-29');
    expect(parseBidRiggingDate('08.06.2021')).toBe('2021-06-08');
    expect(parseBidRiggingDate('Tue Aug 13 2024 00:00:00 GMT+0000 (Coordinated Universal Time)')).toBe('2024-08-13');
    expect(parseBidRiggingDate('45575')).toBe('2024-10-10');
    expect(parseBidRiggingDate('02.04.202')).toBeNull();
    expect(parseBidRiggingDate('NA')).toBeNull();
  });
});
