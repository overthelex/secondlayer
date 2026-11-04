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
    // The AI guess is not forced first: current law ranks above the repealed article.
    expect(res.articles.map((a: any) => a.rada_id)).toEqual(['435-15', '436-15']);
    expect(res.articles[1].warning).toContain('втратив чинність');
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
    const { tools, service } = buildTools({
      findRelevantArticles: jest.fn(async (_q: string, _r: any, _l: number, _d: any, opts: any) => {
        if (opts?.stats) opts.stats.excluded_repealed = 3;
        return [ckArticle];
      }),
    });
    const res = await tools.searchLegislation({ query: 'неустойка пеня' });
    expect(service.findRelevantArticles).toHaveBeenCalledWith(
      'неустойка пеня', undefined, 10, undefined, expect.objectContaining({ repealed: 'exclude' })
    );
    expect(res.articles[0].act_status).toEqual({ status: 'Чинний', in_force: true });
    expect(res.excluded_repealed).toBe(3);
    expect(res.note).toContain('include_repealed');
  });

  it('says repealed matches were filtered out when nothing current is left', async () => {
    const { tools } = buildTools({
      findRelevantArticles: jest.fn(async (_q: string, _r: any, _l: number, _d: any, opts: any) => {
        if (opts?.stats) opts.stats.excluded_repealed = 4;
        return [];
      }),
    });
    const res = await tools.searchLegislation({ query: 'оперативно-господарські санкції' });
    expect(res.total_found).toBe(0);
    expect(res.suggestion).toContain('include_repealed:true');
    expect(res.suggestion).not.toContain('legislation is loaded');
  });

  it('no filter note when nothing was excluded', async () => {
    const { tools } = buildTools();
    const res = await tools.searchLegislation({ query: 'неустойка пеня' });
    expect(res.note).toBeUndefined();
  });

  it('a partially repealed act (status 9) gets a caveat, not the repeal redirect', async () => {
    const partial = buildActStatus({ nreg: '436-15', status_code: 9, last_ed: '2025-08-28' });
    const { tools, service } = buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
        radaId: '436-15', articleNumber: '230', source: 'ai', confidence: 0.95,
      }),
      getActStatuses: jest.fn(async (ids: string[]) => {
        const m = new Map();
        for (const id of ids) {
          if (id === '436-15') m.set(id, partial);
          if (id === '435-15') m.set(id, CK);
        }
        return m;
      }),
    });
    const res = await tools.searchLegislation({ query: QUERY });
    expect(service.getArticle).toHaveBeenCalled();
    expect(res.repealed_reference).toBeUndefined();
    expect(res.warning).toContain('частково втратив чинність');
    expect(res.warning).not.toContain('НЕ чинна норма');
    // Still supplemented with current law, current law first.
    expect(res.articles[0].rada_id).toBe('435-15');
  });

  it('an explicit rada_id keeps that act even if repealed', async () => {
    const { tools, service } = buildTools({ findRelevantArticles: jest.fn().mockResolvedValue([gkArticle]) });
    const res = await tools.searchLegislation({ query: 'неустойка', rada_id: '436-15' });
    expect(service.findRelevantArticles).toHaveBeenCalledWith('неустойка', '436-15', 10, undefined, { repealed: 'keep' });
    expect(res.articles[0].warning).toContain('втратив чинність');
  });
});

describe('search_legislation supplements (LEXAI-2201)', () => {
  const QUERY = 'затоплення квартири сусідом відшкодування шкоди';
  const ck1166 = { ...ckArticle, article_number: '1166', title: 'Загальні підстави відповідальності за завдану майнову шкоду', full_text: 'Майнова шкода … відшкодовується в повному обсязі особою, яка її завдала.' };
  const ck1187 = { ...ckArticle, article_number: '1187', title: 'Відшкодування шкоди', full_text: 'Шкода … відшкодовується …' };
  const bank5 = { ...ckArticle, rada_id: '2121-14', article_number: '5', title: 'Економічна незалежність банків', full_text: 'Шкода, заподіяна банку … відшкодуванню', npa_title: 'Про банки і банківську діяльність' };

  function tools(confidence: number) {
    return buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({ radaId: '435-15', articleNumber: '1166', source: 'ai', confidence }),
      getArticle: jest.fn().mockResolvedValue(ck1166),
      findRelevantArticles: jest.fn(async (_q: string, radaId?: string) => (radaId ? [ck1187] : [bank5])),
    });
  }

  it('a fairly sure act guess keeps its own articles ahead of other laws', async () => {
    const res = await tools(0.78).tools.searchLegislation({ query: QUERY, limit: 3 });
    expect(res.articles.map((a: any) => `${a.rada_id}:${a.article_number}`)).toEqual(['435-15:1166', '435-15:1187', '2121-14:5']);
  });

  it('an unsure act guess puts the unscoped hits first, as before', async () => {
    const res = await tools(0.5).tools.searchLegislation({ query: QUERY, limit: 3 });
    expect(res.articles[1].rada_id).toBe('2121-14');
  });
});

import { repealedActWeight } from '../../services/legislation-service';
describe('not-current acts are ranked like repealed ones (LEXAI-2201)', () => {
  it('status 2 «набирає чинності» is demoted, not dropped', () => {
    const s = buildActStatus({ nreg: '3077-20', status_code: 2, last_ed: '2026-01-01' });
    const w = repealedActWeight(s, 'exclude');
    expect(w).not.toBeNull();
    expect(w!).toBeLessThan(1);
    expect(repealedActWeight(CK, 'exclude')).toBe(1);
  });
});

describe('supplement interleave (LEXAI-2201 review)', () => {
  it('an unscoped hit still reaches the page when same-act hits are plentiful', async () => {
    const a = (n: string) => ({ ...ckArticle, article_number: n });
    const other = { ...ckArticle, rada_id: '2121-14', article_number: '5' };
    const { tools } = buildTools({
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({ radaId: '435-15', articleNumber: '1166', source: 'ai', confidence: 0.78 }),
      getArticle: jest.fn().mockResolvedValue(a('1166')),
      findRelevantArticles: jest.fn(async (_q: string, radaId?: string) => (radaId ? [a('1187'), a('1192'), a('1195')] : [other])),
    });
    const res = await tools.searchLegislation({ query: 'затоплення квартири сусідом відшкодування шкоди', limit: 3 });
    expect(res.articles.map((x: any) => `${x.rada_id}:${x.article_number}`)).toEqual(['435-15:1166', '435-15:1187', '2121-14:5']);
  });
});
