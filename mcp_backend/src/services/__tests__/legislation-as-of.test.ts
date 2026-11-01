import {
  articleMissMessage,
  classifyAsOfDate,
  kyivToday,
  parseIsoDate,
  PLACEHOLDER_VERSION_SQL,
} from '../legislation-as-of';

/**
 * LEXAI-2146: get_legislation_section {rada_id:'435-15', article_number:'625',
 * as_of_date:'2001-01-01'} returned today's ЦК text with is_historical:true.
 * ЦК first edition 16.01.2003.
 */

const CK = { first_edition: '2003-01-16', effective_date: null, last_edition: '2026-08-05' };
const TODAY = '2026-11-01';

describe('classifyAsOfDate', () => {
  it('no date → current', () => {
    expect(classifyAsOfDate(undefined, CK, TODAY)).toEqual({ kind: 'current' });
    expect(classifyAsOfDate('  ', CK, TODAY)).toEqual({ kind: 'current' });
  });

  it('rejects malformed and impossible dates', () => {
    expect(classifyAsOfDate('01.01.2001', CK, TODAY).kind).toBe('invalid');
    expect(classifyAsOfDate('2023-02-30', CK, TODAY).kind).toBe('invalid');
  });

  it('a date before the first edition is an error, in Ukrainian, with the dates', () => {
    const v = classifyAsOfDate('2001-01-01', CK, TODAY);
    expect(v.kind).toBe('before_act');
    if (v.kind !== 'before_act') return;
    expect(v.error).toContain('Акт ще не діяв на 01.01.2001');
    expect(v.error).toContain('перша редакція від 16.01.2003');
    expect(v.first_edition).toBe('2003-01-16');
  });

  it('names the entry-into-force date when known', () => {
    const v = classifyAsOfDate('2001-01-01', { ...CK, effective_date: '2004-01-01' }, TODAY);
    expect(v.kind === 'before_act' && v.error).toContain('набрав чинності 01.01.2004');
  });

  it('between adoption and entry into force: historical text with a caveat', () => {
    const v = classifyAsOfDate('2003-06-01', { ...CK, effective_date: '2004-01-01' }, TODAY);
    expect(v.kind).toBe('historical');
    expect(v.kind === 'historical' && v.note).toContain('ще не набрав чинності');
  });

  it('the first-edition day itself is in range', () => {
    expect(classifyAsOfDate('2003-01-16', CK, TODAY)).toEqual({ kind: 'historical', as_of_date: '2003-01-16' });
  });

  it('a future date → current text with a note', () => {
    const v = classifyAsOfDate('2030-01-01', CK, TODAY);
    expect(v.kind).toBe('use_current');
    expect(v.kind === 'use_current' && v.note).toContain('ще не настала');
  });

  it('on/after the latest edition → current text', () => {
    const v = classifyAsOfDate('2026-09-01', CK, TODAY);
    expect(v.kind).toBe('use_current');
    expect(v.kind === 'use_current' && v.note).toContain('05.08.2026');
  });

  it('unknown act timeline does not refuse', () => {
    expect(classifyAsOfDate('2001-01-01', null, TODAY)).toEqual({ kind: 'historical', as_of_date: '2001-01-01' });
  });
});

describe('articleMissMessage', () => {
  it('article inserted by a later amendment', () => {
    const m = articleMissMessage('625-1', '2010-01-01', {
      article_first_seen: '2015-02-06', in_current_text: true, edition_on_date: '2009-12-15', earliest_loaded_edition: '2003-01-16',
    });
    expect(m).toContain('Стаття 625-1 ще не існувала станом на 01.01.2010');
    expect(m).toContain('редакції від 15.12.2009');
    expect(m).toContain('06.02.2015');
  });

  it('article only in the current text', () => {
    const m = articleMissMessage('9', '2010-01-01', {
      article_first_seen: null, in_current_text: true, edition_on_date: '2009-12-15', earliest_loaded_edition: '2003-01-16',
    });
    expect(m).toContain('є лише в чинній редакції');
  });

  it('no loaded edition on the date: says so instead of claiming non-existence', () => {
    const m = articleMissMessage('9', '2002-01-01', {
      article_first_seen: null, in_current_text: true, edition_on_date: null, earliest_loaded_edition: '2005-01-01',
    });
    expect(m).toContain('у базі немає');
    expect(m).not.toContain('не існувала');
  });

  it('unknown article → null (plain not-found)', () => {
    expect(articleMissMessage('99999', '2010-01-01', { in_current_text: false, edition_on_date: '2009-12-15' })).toBeNull();
  });
});

describe('helpers', () => {
  it('parseIsoDate / kyivToday', () => {
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29');
    expect(parseIsoDate('2023-02-29')).toBeNull();
    // 22:30 UTC on 31.10 is already 01.11 in Kyiv (UTC+2 after DST ends).
    expect(kyivToday(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11-01');
  });

  it('placeholder predicate targets the 2000-01-01 stamp', () => {
    expect(PLACEHOLDER_VERSION_SQL).toContain("TIMESTAMP '2000-01-01 02:00:00'");
    expect(PLACEHOLDER_VERSION_SQL).toContain('legislation_editions');
  });
});
