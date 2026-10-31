import { LegislationTools } from '../legislation-tools';

/**
 * Regression for the MSP IP-demo miss (2026-07-01): the AI classifier hallucinated a
 * rada_id ("строк чинності патенту на винахід" → 3769-12 замість 3687-12), the guessed
 * article did not exist, and searchLegislation early-returned "Пункт/стаття не знайдено"
 * with 0 results — never reaching semantic search, which had the right answer all along.
 * When the AI-resolved article is missing, the handler must fall back to semantic search
 * (scoped + unscoped) before giving up.
 */

const patentArticle = {
  rada_id: '3687-12',
  article_number: '6',
  title: 'Умови надання правової охорони',
  full_text: 'Строк дії патенту на винахід становить 20 років...',
  url: 'https://zakon.rada.gov.ua/laws/show/3687-12#n6',
  npa_title: 'Про охорону прав на винаходи і корисні моделі',
};

function buildTools(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const service: any = {
    parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
      radaId: '3769-12',
      articleNumber: '7',
      source: 'ai',
      confidence: 0.85,
    }),
    getArticle: jest.fn().mockResolvedValue(null),
    findRelevantArticles: jest.fn().mockResolvedValue([patentArticle]),
    getLegislationStructure: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  const renderer: any = { renderArticleHTML: jest.fn(), renderMultipleArticlesHTML: jest.fn() };
  return { tools: new LegislationTools(service, renderer), service };
}

describe('search_legislation semantic fallback when AI-resolved article is missing', () => {
  it('falls back to semantic search instead of terminal "не знайдено"', async () => {
    const { tools, service } = buildTools();

    const result = await tools.searchLegislation({ query: 'строк чинності патенту на винахід' });

    expect(result.total_found).toBe(1);
    expect(result.articles[0].rada_id).toBe('3687-12');
    expect(result.articles[0].article_number).toBe('6');
    expect(result.resolved_reference.not_found).toBe(true);
    // Both scoped (guessed act) and unscoped searches must run
    // The guessed act is not the caller's rada_id, so the repealed filter applies (LEXAI-2147).
    expect(service.findRelevantArticles).toHaveBeenCalledWith(
      'строк чинності патенту на винахід', '3769-12', 10, undefined, { repealed: 'exclude' }
    );
    // Unscoped search hides repealed acts by default (LEXAI-2147).
    expect(service.findRelevantArticles).toHaveBeenCalledWith(
      'строк чинності патенту на винахід', undefined, 10, undefined, { repealed: 'exclude' }
    );
  });

  it('dedups scoped/unscoped hits by rada_id:article_number', async () => {
    const { tools } = buildTools({
      findRelevantArticles: jest.fn().mockResolvedValue([patentArticle, patentArticle]),
    });

    const result = await tools.searchLegislation({ query: 'строк чинності патенту' });
    expect(result.total_found).toBe(1);
  });

  it('keeps the legacy structure hint when semantic fallback finds nothing', async () => {
    const { tools } = buildTools({
      findRelevantArticles: jest.fn().mockResolvedValue([]),
      getLegislationStructure: jest.fn().mockResolvedValue({
        title: 'Про введення в дію…',
        total_articles: 3,
      }),
    });

    const result = await tools.searchLegislation({ query: 'строк чинності патенту' });
    expect(result.total_found).toBe(0);
    expect(result.legislation_found.rada_id).toBe('3769-12');
    expect(result.suggestion).toContain('не знайдено');
  });

  it('still returns the article directly when it exists (no fallback)', async () => {
    const { tools, service } = buildTools({
      getArticle: jest.fn().mockResolvedValue({
        ...patentArticle,
        rada_id: '3687-12',
      }),
      parseArticleReferenceWithAI: jest.fn().mockResolvedValue({
        radaId: '3687-12',
        articleNumber: '6',
        source: 'ai',
        confidence: 0.95,
      }),
    });

    const result = await tools.searchLegislation({ query: 'строк дії патенту на винахід' });
    expect(result.articles[0].article_number).toBe('6');
    expect(result.resolved_reference.not_found).toBeUndefined();
  });
});
