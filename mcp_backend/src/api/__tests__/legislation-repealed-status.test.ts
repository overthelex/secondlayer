import { LegislationTools } from '../legislation-tools';
import { buildActStatus } from '../../services/legislation-act-status';

/**
 * LEXAI-2147: the repealed Господарський кодекс (436-15, втратив чинність з
 * 28.08.2025) was served as current law: no status, no warning, and a topical
 * search («штрафні санкції … господарського зобов'язання неустойка») returned
 * only ГК because the AI classifier pinned the answer to ГК ст. 230.
 */

const GK = buildActStatus({
  nreg: '436-15',
  status_code: 1,
  last_ed: '2025-08-28',
  repeal_note: '{Кодекс втратив чинність на підставі Закону № 4196-IX від 09.01.2025 }',
});
const CK = buildActStatus({ nreg: '435-15', status_code: 5, last_ed: '2026-08-05' });

const gkArticle = {
  rada_id: '436-15',
  article_number: '230',
  title: 'Штрафні санкції',
  full_text: 'Штрафними санкціями … неустойка, штраф, пеня … господарського зобов\'язання',
  url: 'https://zakon.rada.gov.ua/laws/show/436-15#n230',
  npa_title: 'Господарський кодекс України',
};
const ckArticle = {
  rada_id: '435-15',
  article_number: '549',
  title: 'Поняття неустойки',
  full_text: 'Неустойкою (штрафом, пенею) є грошова сума …',
  url: 'https://zakon.rada.gov.ua/laws/show/435-15#n549',
  npa_title: 'Цивільний кодекс України',
};

function buildTools(overrides: Record<string, jest.Mock> = {}) {
  const service: any = {
    parseArticleReferenceWithAI: jest.fn().mockResolvedValue(null),
    getArticle: jest.fn().mockResolvedValue(gkArticle),
    getMultipleArticles: jest.fn().mockResolvedValue([gkArticle]),
    findRelevantArticles: jest.fn().mockResolvedValue([ckArticle]),
    getLegislationStructure: jest.fn().mockResolvedValue(null),
    getActStatuses: jest.fn(async (ids: string[]) => {
      const m = new Map();
      for (const id of ids) {
        if (id === '436-15') m.set(id, GK);
        if (id === '435-15') m.set(id, CK);
      }
      return m;
    }),
    ...overrides,
  };
  const renderer: any = { renderArticleHTML: jest.fn(), renderMultipleArticlesHTML: jest.fn() };
  return { tools: new LegislationTools(service, renderer), service };
}

describe('legislation tools expose act status (LEXAI-2147)', () => {
  it('get_legislation_section warns before the text of a repealed act', async () => {
    const { tools } = buildTools();
    const res = await tools.getLegislationSection({ rada_id: '436-15', article_number: '230' });
    expect(Object.keys(res)[0]).toBe('warning');
    expect(res.warning).toContain('Акт втратив чинність з 28.08.2025');
    expect(res.warning).toContain('435-15');
    expect(res.act_status).toMatchObject({ status: 'Втратив чинність', in_force: false, repealed: true, repealed_from: '2025-08-28' });
    expect(res.full_text).toBeTruthy();
  });

  it('get_legislation_section: no warning for an act in force', async () => {
    const { tools } = buildTools({ getArticle: jest.fn().mockResolvedValue(ckArticle) });
    const res = await tools.getLegislationSection({ rada_id: '435-15', article_number: '549' });
    expect(res.warning).toBeUndefined();
    expect(res.act_status).toEqual({ status: 'Чинний', in_force: true });
  });

  it('get_legislation_articles carries the warning', async () => {
    const { tools } = buildTools();
    const res = await tools.getLegislationArticles({ rada_id: '436-15', article_numbers: ['230'] });
    expect(res.warning).toContain('втратив чинність');
    expect(res.act_status.repealed).toBe(true);
  });

  it('still answers when the status lookup fails', async () => {
    const { tools } = buildTools({ getActStatuses: jest.fn().mockRejectedValue(new Error('boom')) });
    const res = await tools.getLegislationSection({ rada_id: '436-15', article_number: '230' });
    expect(res.full_text).toBeTruthy();
    expect(res.warning).toBeUndefined();
  });

  it('get_legislation_section schema no longer offers 436-15 as an example', () => {
    const { tools } = buildTools();
    const def = tools.getToolDefinitions().find((d: any) => d.name === 'get_legislation_section')!;
    expect(JSON.stringify(def.inputSchema)).not.toContain('436-15');
    const search = tools.getToolDefinitions().find((d: any) => d.name === 'search_legislation')!;
    expect((search.inputSchema.properties as any).include_repealed.type).toBe('boolean');
  });
});

describe('search_legislation and repealed acts (LEXAI-2147)', () => {
  const QUERY = "штрафні санкції за порушення господарського зобов'язання неустойка";

  it('an AI guess that lands on a repealed act serves current law instead', async () => {
    const { tools, service } = buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
        radaId: '436-15', articleNumber: '230', source: 'ai', confidence: 0.88,
      }),
    });
    const res = await tools.searchLegislation({ query: QUERY });
    expect(service.findRelevantArticles).toHaveBeenCalledWith(QUERY, undefined, 10, undefined, { repealed: 'exclude' });
    expect(service.getArticle).not.toHaveBeenCalled();
    expect(res.articles.map((a: any) => a.rada_id)).toEqual(['435-15']);
    expect(res.articles[0].act_status.in_force).toBe(true);
    expect(res.repealed_reference).toMatchObject({ rada_id: '436-15', article_number: '230' });
    expect(res.note).toContain('втратив чинність');
  });

  it('include_repealed keeps the ГК article, warned, and adds current law', async () => {
    const { tools, service } = buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
        radaId: '436-15', articleNumber: '230', source: 'ai', confidence: 0.88,
      }),
    });
    const res = await tools.searchLegislation({ query: QUERY, include_repealed: true });
    expect(service.findRelevantArticles).toHaveBeenCalledWith(QUERY, undefined, 10, undefined, { repealed: 'demote' });
    expect(res.articles[0].rada_id).toBe('436-15');
    expect(res.articles[0].warning).toContain('втратив чинність');
    expect(res.articles.some((a: any) => a.rada_id === '435-15')).toBe(true);
    expect(res.warning).toContain('втратив чинність');
  });

  it('an explicit citation of a repealed act is served with a warning plus current law', async () => {
    const { tools, service } = buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
        radaId: '436-15', articleNumber: '230', source: 'regexp',
      }),
    });
    const res = await tools.searchLegislation({ query: 'ст. 230 ГК' });
    expect(service.getArticle).toHaveBeenCalled();
    expect(res.articles[0].rada_id).toBe('436-15');
    expect(res.warning).toContain('Акт втратив чинність');
    expect(res.articles.some((a: any) => a.rada_id === '435-15')).toBe(true);
  });

  it('plain semantic search excludes repealed acts by default and labels hits', async () => {
    const { tools, service } = buildTools();
    const res = await tools.searchLegislation({ query: 'неустойка пеня' });
    expect(service.findRelevantArticles).toHaveBeenCalledWith('неустойка пеня', undefined, 10, undefined, { repealed: 'exclude' });
    expect(res.articles[0].act_status).toEqual({ status: 'Чинний', in_force: true });
    expect(res.note).toContain('include_repealed');
  });

  it('an explicit rada_id keeps that act even if repealed', async () => {
    const { tools, service } = buildTools({ findRelevantArticles: jest.fn().mockResolvedValue([gkArticle]) });
    const res = await tools.searchLegislation({ query: 'неустойка', rada_id: '436-15' });
    expect(service.findRelevantArticles).toHaveBeenCalledWith('неустойка', '436-15', 10, undefined, { repealed: 'keep' });
    expect(res.articles[0].warning).toContain('втратив чинність');
  });
});
