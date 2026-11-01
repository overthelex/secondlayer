import { LegislationTools } from '../legislation-tools';
import { NpaTools } from '../tools/npa-tools.js';
import { buildActStatus } from '../../services/legislation-act-status';
import { classifyAsOfDate } from '../../services/legislation-as-of';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

/**
 * LEXAI-2146: as_of_date before the act (or the article) existed returned the
 * current text as historical. Every tool taking as_of_date applies one rule.
 */

const CK_TIMELINE = { first_edition: '2003-01-16', effective_date: null, last_edition: '2026-08-05' };
const CK = buildActStatus({ nreg: '435-15', status_code: 5, last_ed: '2026-08-05' });

const art625 = {
  rada_id: '435-15',
  article_number: '625',
  title: 'Відповідальність за порушення грошового зобов\'язання',
  full_text: 'Боржник не звільняється від відповідальності …',
  url: 'https://zakon.rada.gov.ua/laws/show/435-15#n625',
  npa_title: 'Цивільний кодекс України',
  metadata: {},
};

function buildTools(overrides: Record<string, jest.Mock> = {}) {
  const service: any = {
    parseArticleReferenceWithAI: jest.fn().mockResolvedValue(null),
    getArticle: jest.fn().mockResolvedValue(art625),
    getMultipleArticles: jest.fn().mockResolvedValue([art625]),
    findRelevantArticles: jest.fn().mockResolvedValue([art625]),
    getLegislationStructure: jest.fn().mockResolvedValue(null),
    getActStatuses: jest.fn(async () => new Map([['435-15', CK]])),
    assessAsOfDate: jest.fn(async (_id: string, d: unknown) => classifyAsOfDate(d, CK_TIMELINE, '2026-11-01')),
    explainArticleMisses: jest.fn(async (_id: string, nums: string[]) => new Map(nums.map(n => [n, {
      article_first_seen: '2015-02-06', in_current_text: true, edition_on_date: '2009-12-15', earliest_loaded_edition: '2003-01-16',
    }]))),
    ...overrides,
  };
  const renderer: any = { renderArticleHTML: jest.fn(), renderMultipleArticlesHTML: jest.fn() };
  return { tools: new LegislationTools(service, renderer), service };
}

describe('get_legislation_section as_of_date (LEXAI-2146)', () => {
  it('before the act existed: Ukrainian error, no text, no lookup', async () => {
    const { tools, service } = buildTools();
    const res = await tools.getLegislationSection({ rada_id: '435-15', article_number: '625', as_of_date: '2001-01-01' });
    expect(res.error).toContain('Акт ще не діяв на 01.01.2001');
    expect(res.error).toContain('16.01.2003');
    expect(res.full_text).toBeUndefined();
    expect(service.getArticle).not.toHaveBeenCalled();
  });

  it('in range: looks up the historical edition', async () => {
    const { tools, service } = buildTools();
    await tools.getLegislationSection({ rada_id: '435-15', article_number: '625', as_of_date: '2010-01-01' });
    expect(service.getArticle).toHaveBeenCalledWith('435-15', '625', '2010-01-01');
  });

  it('article added later: says it did not exist yet', async () => {
    const { tools } = buildTools({ getArticle: jest.fn().mockResolvedValue(null) });
    const res = await tools.getLegislationSection({ rada_id: '435-15', article_number: '625-1', as_of_date: '2010-01-01' });
    expect(res.error).toContain('ще не існувала станом на 01.01.2010');
    expect(res.full_text).toBeUndefined();
  });

  it('future date: current text, not historical, with a note', async () => {
    const { tools, service } = buildTools();
    const res = await tools.getLegislationSection({ rada_id: '435-15', article_number: '625', as_of_date: '2030-01-01' });
    expect(service.getArticle).toHaveBeenCalledWith('435-15', '625', undefined);
    expect(res.full_text).toBeTruthy();
    expect(res.metadata.is_historical).toBe(false);
    expect(res.as_of_note).toContain('ще не настала');
  });

  it('malformed date is rejected', async () => {
    const { tools } = buildTools();
    const res = await tools.getLegislationSection({ rada_id: '435-15', article_number: '625', as_of_date: '2001-13-01' });
    expect(res.error).toContain('YYYY-MM-DD');
  });

  it('no date: no as_of assessment at all', async () => {
    const { tools, service } = buildTools();
    await tools.getLegislationSection({ rada_id: '435-15', article_number: '625' });
    expect(service.assessAsOfDate).not.toHaveBeenCalled();
  });

  it('vector branch keeps the date caveat next to the search-scope note', async () => {
    const { tools } = buildTools({
      assessAsOfDate: jest.fn(async () => ({ kind: 'historical', as_of_date: '2003-06-01', note: 'Акт прийнято, але ще не набрав чинності.' })),
    });
    const res = await tools.getLegislationSection({ rada_id: '435-15', query: 'інфляційні втрати', as_of_date: '2003-06-01' });
    expect(res.as_of_note).toContain('ще не набрав чинності');
    expect(res.as_of_note).toContain('по чинній редакції');
  });

  it('vector branch (rada_id + query) applies the act-level rule too', async () => {
    const { tools, service } = buildTools();
    const res = await tools.getLegislationSection({ rada_id: '435-15', query: 'інфляційні втрати', as_of_date: '2001-01-01' });
    expect(res.error).toContain('Акт ще не діяв');
    expect(service.findRelevantArticles).not.toHaveBeenCalled();
  });
});

describe('get_legislation_articles as_of_date (LEXAI-2146)', () => {
  it('before the act existed: error, no lookup', async () => {
    const { tools, service } = buildTools();
    const res = await tools.getLegislationArticles({ rada_id: '435-15', article_numbers: ['625'], as_of_date: '2001-01-01' });
    expect(res.error).toContain('Акт ще не діяв');
    expect(service.getMultipleArticles).not.toHaveBeenCalled();
  });

  it('lists articles that did not exist yet next to those that did', async () => {
    const { tools } = buildTools();
    const res = await tools.getLegislationArticles({ rada_id: '435-15', article_numbers: ['625', '625-1'], as_of_date: '2010-01-01' });
    expect(res.articles).toHaveLength(1);
    expect(res.missing).toEqual([{ article_number: '625-1', reason: expect.stringContaining('ще не існувала') }]);
  });
});

describe('get_npa_act as_of_date (LEXAI-2146)', () => {
  const ACT = {
    nreg: '435-15', title: 'Цивільний кодекс України', status_code: 5, types_raw: '21|1|124',
    editions_cnt: 183, texts_cnt: 183, has_articles: true, first_ed: '2003-01-16', last_ed: '2026-08-05',
  };

  it('before the first edition: error, no edition lookup', async () => {
    const db = { query: jest.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '435-15' }] })
      .mockResolvedValueOnce({ rows: [ACT] });
    const tools = new NpaTools(db as any);
    const out = JSON.parse((await tools.executeTool('get_npa_act', { nreg: '435-15', mode: 'article', article_number: '625', as_of_date: '2001-01-01' }))!.content[0].text);
    expect(out.error).toContain('Акт ще не діяв на 01.01.2001');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('the 1990-01-01 first_ed placeholder does not count as a first edition', async () => {
    const db = { query: jest.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '995_004' }] })
      .mockResolvedValueOnce({ rows: [{ ...ACT, nreg: '995_004', first_ed: '1990-01-01', last_ed: '2010-01-01' }] })
      .mockResolvedValueOnce({ rows: [] });
    const tools = new NpaTools(db as any);
    const out = JSON.parse((await tools.executeTool('get_npa_act', { nreg: '995_004', as_of_date: '1985-01-01' }))!.content[0].text);
    expect(out.error).toBeUndefined();
    expect(db.query.mock.calls[2][1]).toEqual(['995_004', '1985-01-01']); // looked up, not refused
  });

  it('on/after the last edition: current edition with a note', async () => {
    const db = { query: jest.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '435-15' }] })
      .mockResolvedValueOnce({ rows: [ACT] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2026-08-05', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ article_count: 1275, char_len: 9 }] });
    const tools = new NpaTools(db as any);
    const out = JSON.parse((await tools.executeTool('get_npa_act', { nreg: '435-15', as_of_date: '2026-09-01' }))!.content[0].text);
    expect(db.query.mock.calls[2][0]).toContain('is_current');
    expect(out.as_of_note).toContain('05.08.2026');
  });

  it('future date: current edition with a note', async () => {
    const db = { query: jest.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '435-15' }] })
      .mockResolvedValueOnce({ rows: [ACT] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2026-08-05', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ article_count: 1275, char_len: 9 }] });
    const tools = new NpaTools(db as any);
    const out = JSON.parse((await tools.executeTool('get_npa_act', { nreg: '435-15', as_of_date: '2099-01-01' }))!.content[0].text);
    expect(db.query.mock.calls[2][0]).toContain('is_current');
    expect(out.as_of_note).toContain('ще не настала');
  });
});
