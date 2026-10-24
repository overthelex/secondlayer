/**
 * search_edrnpa name matching and ordering (LEXAI-2100).
 *
 * «бронювання військовозобов'язаних» returned three old acts because the name filter was
 * one ILIKE '%phrase%': the КМУ постанова 76/2023 stores the word with ʼ (U+02BC), so the
 * ASCII-apostrophe phrase never matched it. And ORDER BY reestr_date sorted DD.MM.YYYY
 * text, i.e. by day of month.
 */

import { OpenDataTools, edrnpaPhraseKey } from '../tools/opendata-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const CARD = {
  id: 119171, publisher: 'Кабінет Міністрів України', doc_type: 'Постанова', date_acc: '27.01.2023',
  number: '76', name: 'Деякі питання … щодо бронювання військовозобовʼязаних …', status: 'Чинний',
  reestr_date: '01.02.2023', keywords: null,
};

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('search_edrnpa', () => {
  let db: { query: jest.Mock };
  let tools: OpenDataTools;

  beforeEach(() => {
    db = { query: jest.fn() };
    tools = new OpenDataTools(db);
  });

  it('matches each word of the name separately, apostrophe-agnostic', async () => {
    db.query.mockResolvedValue({ rows: [1, 2, 3].map(() => ({ ...CARD, _total_count: 21 })) });

    const out = parse(await tools.executeTool('search_edrnpa', { name: "бронювання військовозобов'язаних" }));

    const [sql, values] = db.query.mock.calls[0];
    // no whole-phrase substring filter any more
    expect(values).not.toContain("%бронювання військовозобов'язаних%");
    // stems never carry an apostrophe, so ' / ’ / ʼ in the stored name all match
    expect(values.slice(0, 3)).toEqual(['%бронюва%', '%військовозо%', '%язан%']);
    expect(sql).toContain('(c.name ILIKE $1)::int + (c.name ILIKE $2)::int + (c.name ILIKE $3)::int');
    expect(sql).toContain('>= $4');
    expect(values[3]).toBe(3);
    expect(out.total_count).toBe(21);
    expect(out.results[0]._total_count).toBeUndefined();
  });

  it('gives the same filter for the typographic apostrophe', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await tools.executeTool('search_edrnpa', { name: 'бронювання військовозобовʼязаних' });
    const typographic = db.query.mock.calls[0][1].slice(0, 3);
    db.query.mockClear();
    await tools.executeTool('search_edrnpa', { name: "бронювання військовозобов'язаних" });
    expect(db.query.mock.calls[0][1].slice(0, 3)).toEqual(typographic);
  });

  it('orders by phrase match, then amendments last, then real date — not DD.MM.YYYY text', async () => {
    db.query.mockResolvedValue({ rows: [1, 2, 3].map(() => CARD) });

    await tools.executeTool('search_edrnpa', { name: 'бронювання військовозобовʼязаних' });

    const sql: string = db.query.mock.calls[0][0];
    const order = sql.slice(sql.indexOf('ORDER BY'));
    expect(order).not.toMatch(/ORDER BY c\.reestr_date/);
    expect(order).toMatch(/^ORDER BY strpos\(/);
    expect(order).toContain('Про (внесення|затвердження)');
    expect(order).toContain('substr(c.date_acc, 7, 4) || substr(c.date_acc, 4, 2) || substr(c.date_acc, 1, 2)');
  });

  it('relaxes to most-of-the-words only when the strict pass is thin', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [1, 2, 3, 4].map(() => ({ ...CARD, _total_count: 4 })) });

    const out = parse(await tools.executeTool('search_edrnpa', { name: "порядок бронювання військовозобов'язаних" }));

    expect(db.query.mock.calls[0][1][4]).toBe(4);   // all four stems
    expect(db.query.mock.calls[1][1][4]).toBe(2);   // ceil(4 / 2)
    expect(out.note).toContain('більшість слів');
    expect(out.results).toHaveLength(4);
  });

  it('does not relax a name + number lookup', async () => {
    db.query.mockResolvedValueOnce({ rows: [CARD] });

    await tools.executeTool('search_edrnpa', { name: 'бронювання військовозобовʼязаних', number: '76' });

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('keeps the literal substring when the name has no content words', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await tools.executeTool('search_edrnpa', { name: 'та' });
    expect(db.query.mock.calls[0][0]).toContain('c.name ILIKE $1');
    expect(db.query.mock.calls[0][1][0]).toBe('%та%');
  });

  it('builds the phrase key the same way as the SQL side', () => {
    expect(edrnpaPhraseKey('  Бронювання\n  військовозобовʼязаних ')).toBe("бронювання військовозобов'язаних");
  });
});
