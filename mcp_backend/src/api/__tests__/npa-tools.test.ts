/**
 * Unit tests for the full-НПА-corpus tools.
 *
 * Focus is on the things that silently produce wrong output rather than throwing:
 * dictionary decoding (types_raw is pipe-separated multi-value), the temporal edition
 * branch, and the TOAST-safe / chrome-stripped text paths.
 */

import { NpaTools } from '../tools/npa-tools.js';
import { docTypeIdFromLabel, docTypeLabels, npaUrl, statusLabel } from '../tools/npa-dicts.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const ACT_ROW = {
  nreg: '2755-17',
  title: 'Податковий кодекс України',
  status_code: 5,
  types_raw: '21|1|124',
  editions_cnt: 241,
  texts_cnt: 241,
  has_articles: true,
  first_ed: '2010-12-02',
  last_ed: '2026-01-01',
};

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('npa-dicts', () => {
  it('decodes status codes', () => {
    expect(statusLabel(5)).toBe('Чинний');
    expect(statusLabel(1)).toBe('Втратив чинність');
    expect(statusLabel(null)).toBe('Не визначено');
  });

  it('treats types_raw as a pipe-separated multi-value field', () => {
    expect(docTypeLabels('21|1|124')).toEqual(['Кодекс України', 'Закон', 'Кодекс']);
    expect(docTypeLabels('2')).toEqual(['Постанова']);
    expect(docTypeLabels(null)).toEqual([]);
    // unknown ids are dropped, not rendered as "Код N"
    expect(docTypeLabels('2|99999')).toEqual(['Постанова']);
  });

  it('maps doc-type labels case-insensitively, preferring the shortest prefix match', () => {
    expect(docTypeIdFromLabel('Закон')).toBe(1);
    expect(docTypeIdFromLabel('постанова')).toBe(2);
    expect(docTypeIdFromLabel('кодекс')).toBe(124); // "Кодекс" beats "Кодекс України"
    expect(docTypeIdFromLabel('нісенітниця')).toBeNull();
  });

  it('links to a historical edition only when one is shown', () => {
    expect(npaUrl('435-15')).toBe('https://zakon.rada.gov.ua/laws/show/435-15');
    expect(npaUrl('435-15', '2022-05-27', false)).toBe('https://zakon.rada.gov.ua/laws/show/435-15/ed20220527');
    expect(npaUrl('435-15', '2026-01-01', true)).toBe('https://zakon.rada.gov.ua/laws/show/435-15');
  });
});

describe('get_npa_act', () => {
  let db: { query: jest.Mock };
  let tools: NpaTools;

  beforeEach(() => {
    db = { query: jest.fn() };
    tools = new NpaTools(db);
  });

  it('resolves the edition in force on as_of_date, not the current one', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '2755-17' }] })                        // resolveNreg
      .mockResolvedValueOnce({ rows: [ACT_ROW] })                                    // act card
      .mockResolvedValueOnce({ rows: [{ ed_date: '2022-05-27', is_current: false }] }) // resolveEdition
      .mockResolvedValueOnce({ rows: [{ article_count: 0, char_len: 123 }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '2755-17', as_of_date: '2022-06-01' }));

    expect(out.shown_edition).toBe('2022-05-27');
    expect(out.is_current).toBe(false);
    expect(out.url).toBe('https://zakon.rada.gov.ua/laws/show/2755-17/ed20220527');
    // the temporal branch must be the ed_date <= $2 one
    const editionSql = db.query.mock.calls[2][0];
    expect(editionSql).toContain('ed_date <= $2::date');
    expect(db.query.mock.calls[2][1]).toEqual(['2755-17', '2022-06-01']);
  });

  it('uses the is_current branch when no date is given', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '2755-17' }] })
      .mockResolvedValueOnce({ rows: [ACT_ROW] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2026-01-01', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ article_count: 2, char_len: 9 }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '2755-17' }));

    expect(db.query.mock.calls[2][0]).toContain('is_current');
    expect(out.status).toBe('Чинний');
    expect(out.doc_types).toEqual(['Кодекс України', 'Закон', 'Кодекс']);
  });

  it('reports an unknown act instead of throwing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const out = await tools.executeTool('get_npa_act', { nreg: 'не-існує' });
    expect(out!.content[0].text).toContain('не знайдено');
  });

  it('rejects a malformed as_of_date before touching the database', async () => {
    const out = await tools.executeTool('get_npa_act', { nreg: '2755-17', as_of_date: '01.06.2022' });
    expect(out!.content[0].text).toContain('YYYY-MM-DD');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('never slices a TOASTed body directly and strips the page chrome', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '254к/96-вр' }] })
      .mockResolvedValueOnce({ rows: [{ ...ACT_ROW, nreg: '254к/96-вр', title: 'Конституція України' }] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2020-01-01', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 136113, text: 'КОНСТИТУЦІЯ УКРАЇНИ' }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '254к/96-вр', mode: 'text' }));

    const textSql = db.query.mock.calls[3][0];
    // The table column must be fully detoasted in the innermost subquery; slicing
    // npa.edition_text.body directly raises UTF8 errors on ~30% of rows. Every later
    // substr() in this statement reads the already-materialised CTE column, not the table.
    expect(textSql).toMatch(/FROM \(SELECT body \|\| '' AS b FROM npa\.edition_text/);
    expect(textSql).toContain('mouse wheel');
    expect(out.total_chars).toBe(136113);
    // first page of a 136k-char act — the caller must know to page on
    expect(out.has_more).toBe(true);
    expect(out.offset).toBe(0);
  });

  it('does not offer a table of contents for an act with no article layer', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '148-2003-п' }] })
      .mockResolvedValueOnce({ rows: [{ ...ACT_ROW, nreg: '148-2003-п', has_articles: false }] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2020-01-01', is_current: true }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '148-2003-п', mode: 'toc' }));
    expect(out.note).toContain('mode=text');
  });
});

describe('search_npa', () => {
  let db: { query: jest.Mock };
  let tools: NpaTools;

  beforeEach(() => {
    db = { query: jest.fn() };
    tools = new NpaTools(db);
  });

  it('requires query or title', async () => {
    const out = await tools.executeTool('search_npa', {});
    expect(out!.content[0].text).toContain('query');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('excludes repealed acts by default and never ranks on document bodies', async () => {
    db.query.mockResolvedValue({
      rows: [{ ...ACT_ROW, _total_count: 190, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'фрагмент' }],
    });

    const out = parse(await tools.executeTool('search_npa', { query: 'відстрочка від мобілізації' }));

    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain('t.is_current');            // required to hit the partial FTS index
    expect(sql).not.toContain('ts_rank');             // ~8s over full bodies — must stay out
    expect(sql).toContain("body || ''");              // TOAST-safe snippet
    expect(out.results[0].status).toBe('Чинний');
    expect(out.total_count_at_least).toBe(190);
    expect(out.capped).toBe(false);
  });

  it('relaxes an over-strict AND query to OR only when the strict pass is thin', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...ACT_ROW, _total_count: 1, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'x' }] })
      .mockResolvedValueOnce({
        rows: [1, 2, 3, 4].map(() => ({ ...ACT_ROW, _total_count: 4, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'x' })),
      });

    const out = parse(await tools.executeTool('search_npa', { query: 'відстрочка від мобілізації' }));

    expect(db.query.mock.calls[0][1][0]).toContain(' & ');
    expect(db.query.mock.calls[1][1][0]).toContain(' | ');
    expect(out.note).toContain('пом’якшений');
    expect(out.results).toHaveLength(4);
  });

  it('rejects an unknown doc_type instead of silently ignoring it', async () => {
    const out = await tools.executeTool('search_npa', { query: 'податок', doc_type: 'Мандат' });
    expect(out!.content[0].text).toContain('Невідомий тип документа');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a query with no usable content tokens', async () => {
    const out = await tools.executeTool('search_npa', { query: 'та і в на' });
    expect(out!.content[0].text).toContain('придатних для пошуку');
    expect(db.query).not.toHaveBeenCalled();
  });
});
