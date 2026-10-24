/**
 * Tests for LegislationService class methods and standalone utility functions.
 * Existing legislation-reference.test.ts covers parseLegislationReference regexp cases.
 * This file covers: normalizeRadaId, parseLegislationReferenceWithAI,
 * and all LegislationService class methods with mocked dependencies.
 */

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../legislation-classifier', () => ({
  LegislationClassifier: jest.fn().mockImplementation(() => ({
    classify: jest.fn(),
    setRedisClient: jest.fn(),
  })),
}));

import {
  normalizeRadaId,
  parseLegislationReferenceWithAI,
  parseKmuPrefix,
  hasKmuPrefix,
  LegislationService,
} from '../legislation-service';

// Mock types
const createMockDb = () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
});

const createMockEmbeddingService = () => ({
  generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0)),
  generateEmbeddings: jest.fn().mockResolvedValue([new Array(1536).fill(0)]),
  searchSimilar: jest.fn().mockResolvedValue([]),
  searchVectors: jest.fn().mockResolvedValue([]),
  upsertVectors: jest.fn().mockResolvedValue(undefined),
});

const createMockAdapter = () => ({
  fetchLegislation: jest.fn().mockResolvedValue({
    metadata: { rada_id: '435-15', title: 'Цивільний кодекс' },
    articles: [],
  }),
  saveLegislationToDatabase: jest.fn().mockResolvedValue(undefined),
  getArticleByNumber: jest.fn().mockResolvedValue(null),
  chunkArticles: jest.fn().mockReturnValue([]),
  getLegislationStructure: jest.fn().mockResolvedValue(null),
  searchArticles: jest.fn().mockResolvedValue([]),
  searchArticlesHybrid: jest.fn().mockResolvedValue([]),
  createArticleChunks: jest.fn().mockReturnValue([]),
});

const createMockClassifier = () => ({
  classify: jest.fn(),
  setRedisClient: jest.fn(),
});

describe('normalizeRadaId', () => {
  it('should fix Latin "k" to Cyrillic "к" in Constitution ID', () => {
    expect(normalizeRadaId('254k/96-vr')).toBe('254к/96-вр');
  });

  it('should handle 254k/96-bp variant', () => {
    expect(normalizeRadaId('254k/96-bp')).toBe('254к/96-вр');
  });

  it('should be case-insensitive', () => {
    expect(normalizeRadaId('254K/96-VR')).toBe('254к/96-вр');
  });

  it('should return unchanged ID when no mapping exists', () => {
    expect(normalizeRadaId('435-15')).toBe('435-15');
    expect(normalizeRadaId('1798-12')).toBe('1798-12');
  });
});

describe('parseKmuPrefix / hasKmuPrefix (LEXAI-865)', () => {
  it('parses KMU: prefix as постанова (-п)', () => {
    expect(parseKmuPrefix('KMU:1388')).toEqual({ kmuNumber: '1388', docType: '-п' });
    expect(parseKmuPrefix('KMU:265')).toEqual({ kmuNumber: '265', docType: '-п' });
  });

  it('parses KMU-Р: prefix as розпорядження (-р)', () => {
    expect(parseKmuPrefix('KMU-Р:265')).toEqual({ kmuNumber: '265', docType: '-р' });
    expect(parseKmuPrefix('KMU-Р:1588')).toEqual({ kmuNumber: '1588', docType: '-р' });
  });

  it('returns null for non-KMU rada_ids', () => {
    expect(parseKmuPrefix('435-15')).toBeNull();
    expect(parseKmuPrefix('265-2019-р')).toBeNull();
    expect(parseKmuPrefix('1388-98-п')).toBeNull();
    expect(parseKmuPrefix('')).toBeNull();
  });

  it('hasKmuPrefix matches both variants', () => {
    expect(hasKmuPrefix('KMU:1388')).toBe(true);
    expect(hasKmuPrefix('KMU-Р:265')).toBe(true);
    expect(hasKmuPrefix('435-15')).toBe(false);
    expect(hasKmuPrefix(null)).toBe(false);
    expect(hasKmuPrefix(undefined)).toBe(false);
  });
});

describe('parseLegislationReferenceWithAI', () => {
  it('should return regexp result when regexp matches', async () => {
    const result = await parseLegislationReferenceWithAI('ст. 625 ЦК');

    expect(result).toEqual({
      radaId: '435-15',
      articleNumber: '625',
      source: 'regexp',
    });
  });

  it('should fall back to AI when regexp fails', async () => {
    const classifier = createMockClassifier();
    classifier.classify.mockResolvedValue({
      rada_id: '435-15',
      article_number: '1',
      confidence: 0.9,
      code_name: 'ЦК',
    });

    const result = await parseLegislationReferenceWithAI(
      'перша стаття цивільного кодексу',
      classifier as any,
      0.7
    );

    expect(result).toEqual({
      radaId: '435-15',
      articleNumber: '1',
      source: 'ai',
      confidence: 0.9,
    });
  });

  it('should return null when AI confidence is below threshold', async () => {
    const classifier = createMockClassifier();
    classifier.classify.mockResolvedValue({
      rada_id: '435-15',
      article_number: '1',
      confidence: 0.3,
    });

    const result = await parseLegislationReferenceWithAI(
      'якийсь незрозумілий текст',
      classifier as any,
      0.7
    );

    expect(result).toBeNull();
  });

  it('should use lower threshold (0.4) for KMU patterns', async () => {
    const classifier = createMockClassifier();
    classifier.classify.mockResolvedValue({
      rada_id: 'KMU:1388',
      article_number: '',
      confidence: 0.5,
    });

    // Use text that won't match regexp to force AI fallback
    const result = await parseLegislationReferenceWithAI(
      'урядова постанова тисяча триста вісімдесят вісім',
      classifier as any,
      0.7
    );

    expect(result).toEqual({
      radaId: 'KMU:1388',
      articleNumber: '',
      source: 'ai',
      confidence: 0.5,
    });
  });

  it('should return null without classifier when regexp fails', async () => {
    const result = await parseLegislationReferenceWithAI('random text');
    expect(result).toBeNull();
  });

  it('should return null for empty input', async () => {
    const result = await parseLegislationReferenceWithAI('');
    expect(result).toBeNull();
  });
});

describe('LegislationService', () => {
  let service: LegislationService;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEmbedding: ReturnType<typeof createMockEmbeddingService>;
  let mockAdapter: ReturnType<typeof createMockAdapter>;
  let mockClassifier: ReturnType<typeof createMockClassifier>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDb();
    mockEmbedding = createMockEmbeddingService();
    mockAdapter = createMockAdapter();
    mockClassifier = createMockClassifier();

    service = new LegislationService(
      mockDb as any,
      mockEmbedding as any,
      undefined,
      undefined,
      mockAdapter as any,
      mockClassifier as any
    );
  });

  describe('getAdapter', () => {
    it('should return the adapter instance', () => {
      expect(service.getAdapter()).toBe(mockAdapter);
    });
  });

  describe('setRedisClient', () => {
    it('should delegate to classifier', () => {
      const mockRedis = {} as any;
      service.setRedisClient(mockRedis);
      expect(mockClassifier.setRedisClient).toHaveBeenCalledWith(mockRedis);
    });
  });

  describe('ensureLegislationExists', () => {
    it('should return true when legislation exists in DB', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 1, rada_id: '435-15' }],
        rowCount: 1,
      });

      const result = await service.ensureLegislationExists('435-15');
      expect(result).toBe(true);
    });

    it('should fetch from RADA API when not in DB', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await service.ensureLegislationExists('435-15');

      expect(mockAdapter.fetchLegislation).toHaveBeenCalledWith('435-15');
      expect(mockAdapter.saveLegislationToDatabase).toHaveBeenCalled();
    });

    it('should normalize rada_id before lookup', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 1, rada_id: '254к/96-вр' }],
        rowCount: 1,
      });

      await service.ensureLegislationExists('254k/96-vr');

      // Lookup is a case-insensitive batch query (LOWER(rada_id) = ANY($1)); the
      // Latin '254k/96-vr' input must reach the DB normalized to Cyrillic, lowercased.
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(rada_id) = ANY'),
        [['254к/96-вр']]
      );
    });

    it('should handle KMU: pattern by delegating to resolveKmuRadaId', async () => {
      // First call: KMU lookup in DB
      mockDb.query.mockResolvedValueOnce({
        rows: [{ rada_id: '1388-93-п' }],
        rowCount: 1,
      });

      const result = await service.ensureLegislationExists('KMU:1388');
      expect(result).toBe(true);
    });

    it('should return false when fetch fails', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockAdapter.fetchLegislation.mockRejectedValueOnce(new Error('API down'));

      const result = await service.ensureLegislationExists('999-99');
      expect(result).toBe(false);
    });
  });

  describe('getArticle', () => {
    it('should return article when found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 1, rada_id: '435-15' }],
        rowCount: 1,
      });
      mockAdapter.getArticleByNumber.mockResolvedValueOnce({
        title: 'Стаття 1',
        full_text: 'Текст статті',
        full_text_html: '<p>Текст статті</p>',
        metadata: {},
      });

      const result = await service.getArticle('435-15', '1');

      expect(result).toEqual({
        rada_id: '435-15',
        article_number: '1',
        title: 'Стаття 1',
        full_text: 'Текст статті',
        full_text_html: '<p>Текст статті</p>',
        url: 'https://zakon.rada.gov.ua/laws/show/435-15#n1',
        metadata: {},
      });
    });

    it('should return null when article not found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 1, rada_id: '435-15' }],
        rowCount: 1,
      });
      mockAdapter.getArticleByNumber.mockResolvedValueOnce(null);

      const result = await service.getArticle('435-15', '9999');
      expect(result).toBeNull();
    });

    it('falls back to the п.-prefixed row for dash-indexed transitional points (LEXAI-1821)', async () => {
      // «16-1» (військовий збір, п. 16-1 підрозд. 10 ПКУ) is stored as 'п.16-1';
      // the old fallback predicate required a dot, so dash forms returned null.
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 641, rada_id: '2755-17' }],
        rowCount: 1,
      });
      mockAdapter.getArticleByNumber
        .mockResolvedValueOnce(null)                       // bare '16-1' → no row
        .mockResolvedValueOnce({
          article_number: 'п.16-1',
          title: 'Тимчасово, до набрання чинності... військовий збір',
          full_text: '16-1. Тимчасово... встановлюється військовий збір.',
        });

      const result = await service.getArticle('2755-17', '16-1');

      expect(mockAdapter.getArticleByNumber).toHaveBeenCalledWith('2755-17', 'п.16-1', undefined);
      expect(result?.article_number).toBe('п.16-1');
      expect(result?.full_text).toContain('військовий збір');
    });

    it('should return actual article_number from DB row (LEXAI-823)', async () => {
      // Simulates the data bug where the adapter returns a row whose article_number
      // differs from the input (e.g. "33-5" stored under article_number "33-5" but
      // requested as "33"). The response must reflect the real row so the header
      // and body stay consistent.
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 1, rada_id: '435-15' }],
        rowCount: 1,
      });
      mockAdapter.getArticleByNumber.mockResolvedValueOnce({
        article_number: '33-5',
        title: 'Real title of 33-5',
        full_text: 'Real text of article 33-5',
      });

      const result = await service.getArticle('435-15', '33');

      expect(result?.article_number).toBe('33-5');
      expect(result?.url).toBe('https://zakon.rada.gov.ua/laws/show/435-15#n33-5');
      expect(result?.title).toBe('Real title of 33-5');
    });

    it('should resolve KMU: pattern before fetching article', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ rada_id: '1388-93-п' }], rowCount: 1 }) // resolveKmuRadaId
        .mockResolvedValueOnce({ rows: [{ id: 1, rada_id: '1388-93-п' }], rowCount: 1 }); // ensureLegislationExists

      mockAdapter.getArticleByNumber.mockResolvedValueOnce({
        title: 'Стаття 5',
        full_text: 'Text',
      });

      const result = await service.getArticle('KMU:1388', '5');

      expect(result?.rada_id).toBe('1388-93-п');
    });

    it('should resolve KMU-Р: pattern for розпорядження (LEXAI-865)', async () => {
      // DB lookup for 265-%-р finds the розпорядження, not any 265-%-п
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ rada_id: '265-2019-р' }], rowCount: 1 }) // resolveKmuRadaId with -р
        .mockResolvedValueOnce({ rows: [{ id: 1, rada_id: '265-2019-р', total_articles: 1 }], rowCount: 1 }); // ensureLegislationExists

      mockAdapter.getArticleByNumber.mockResolvedValueOnce({
        article_number: '1',
        full_text: 'Весь текст розпорядження про креативні індустрії...',
      });

      const result = await service.getArticle('KMU-Р:265', '1');

      expect(result?.rada_id).toBe('265-2019-р');
      // Verify the LIKE pattern filtered by -р suffix, not any 265-% match
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LIKE $1'),
        ['265-%-р']
      );
    });
  });

  describe('getMultipleArticles', () => {
    it('should return multiple articles', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 1, rada_id: '435-15' }], rowCount: 1 }) // ensureExists
        .mockResolvedValueOnce({
          rows: [
            { article_number: '1', title: 'Art 1', full_text: 'T1', full_text_html: null, metadata: {} },
            { article_number: '2', title: 'Art 2', full_text: 'T2', full_text_html: null, metadata: {} },
          ],
          rowCount: 2,
        });

      const result = await service.getMultipleArticles('435-15', ['1', '2']);

      expect(result).toHaveLength(2);
      expect(result[0].article_number).toBe('1');
      expect(result[1].article_number).toBe('2');
    });
  });

  describe('listLegislation', () => {
    it('should return paginated legislation list', async () => {
      // First query: COUNT, second query: SELECT items
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ total: '10' }],
        })
        .mockResolvedValueOnce({
          rows: [{ rada_id: '435-15', title: 'ЦК' }],
          rowCount: 1,
        });

      const result = await service.listLegislation(5, 0);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(10);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('should apply search filter', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.listLegislation(10, 0, 'цивільний');

      // First call is COUNT with ILIKE filter
      const queryCall = mockDb.query.mock.calls[0];
      expect(queryCall[0]).toContain('ILIKE');
      expect(queryCall[1]).toContain('%цивільний%');
    });
  });

  describe('getLegislationStats', () => {
    it('should return aggregate statistics', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          total: '50',
          active: '45',
          total_articles: '12000',
        }],
      });

      const result = await service.getLegislationStats();

      expect(result).toEqual({
        total: 50,
        active: 45,
        totalArticles: 12000,
      });
    });
  });

  describe('getDistinctTypes', () => {
    it('should return unique legislation types', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { type: 'Закон' },
          { type: 'Кодекс' },
          { type: 'Постанова' },
        ],
      });

      const result = await service.getDistinctTypes();

      expect(result).toEqual(['Закон', 'Кодекс', 'Постанова']);
    });
  });

  describe('resolveKmuRadaId', () => {
    it('should return cached rada_id from DB', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ rada_id: '1388-93-п' }],
        rowCount: 1,
      });

      const result = await service.resolveKmuRadaId('1388');
      expect(result).toBe('1388-93-п');
    });

    it('should clean stale entries and try year suffixes', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // not in DB
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // cleanup stale

      mockAdapter.fetchLegislation
        .mockRejectedValue(new Error('not found')) // default
        .mockResolvedValueOnce(null); // first batch fails

      // No variant found
      const result = await service.resolveKmuRadaId('9999');
      expect(result).toBeNull();
    });

    it('should return oldest variant when multiple found', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Simulate finding variant in year suffix batch
      mockAdapter.fetchLegislation.mockImplementation(async (id: string) => {
        if (id === '100-93-п') {
          return { metadata: { rada_id: '100-93-п', title: 'Old one' }, articles: [] };
        }
        throw new Error('not found');
      });

      const result = await service.resolveKmuRadaId('100');
      expect(result).toBe('100-93-п');
    });
  });

  describe('parseArticleReference', () => {
    it('should delegate to parseLegislationReference', () => {
      const result = service.parseArticleReference('ст. 1 ЦК');
      expect(result).toEqual({ radaId: '435-15', articleNumber: '1' });
    });
  });

  describe('findRelevantArticles (hybrid FTS + vector, LEXAI-1806)', () => {
    it('demotes the broken mega-record below on-point transitional provisions', async () => {
      // Vector leg surfaces the noisy ~1M-char ст. 346 first (as it does in prod), plus п.69.22.
      mockEmbedding.searchVectors.mockResolvedValueOnce([
        { id: 'v1', score: 0.72, payload: { rada_id: '2755-17', article_number: '346', article_id: 1 } },
        { id: 'v2', score: 0.55, payload: { rada_id: '2755-17', article_number: 'п.69.22', article_id: 2 } },
      ]);
      // FTS leg (lexical) finds the actually-relevant transitional provisions.
      mockAdapter.searchArticlesHybrid.mockResolvedValueOnce([
        {
          id: 2, rada_id: '2755-17', article_number: 'п.69.22', title: '69.22',
          full_text: 'нерухоме майно окуповані території...'.padEnd(13464, 'x'),
          metadata: { is_transitional: true }, legislation_title: 'ПКУ',
        },
        {
          id: 3, rada_id: '2755-17', article_number: 'п.38.6', title: '38.6',
          full_text: 'об’єкти нерухомості на тимчасово окупованій території...'.padEnd(2725, 'x'),
          metadata: { is_transitional: true }, legislation_title: 'ПКУ',
        },
      ]);
      // The vector-only ст. 346 is resolved from DB and is a broken mega-record.
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 1, rada_id: '2755-17', article_number: '346', title: 'Оплата праці ДПС',
          full_text: 'x'.repeat(997546), metadata: {}, npa_title: 'ПКУ',
        }],
        rowCount: 1,
      });

      const result = await service.findRelevantArticles(
        'податок на нерухоме майно на тимчасово окупованій території пільга',
        '2755-17',
        5
      );

      const numbers = result.map(r => r.article_number);
      // The on-point transitional provision ranks first; the mega-record is demoted last.
      expect(numbers[0]).toBe('п.69.22');
      expect(numbers).toContain('п.38.6');
      expect(numbers[numbers.length - 1]).toBe('346');
      // 346 still present (retrievable), just no longer dominating.
      expect(numbers).toContain('346');
    });

    it('boosts an article whose exact number token appears in the query', async () => {
      mockEmbedding.searchVectors.mockResolvedValueOnce([]);
      mockAdapter.searchArticlesHybrid.mockResolvedValueOnce([
        { id: 10, rada_id: '2755-17', article_number: '265', title: '265', full_text: 'склад', metadata: {}, legislation_title: 'ПКУ' },
        { id: 11, rada_id: '2755-17', article_number: '266', title: '266', full_text: 'нерухоме майно', metadata: {}, legislation_title: 'ПКУ' },
      ]);

      const result = await service.findRelevantArticles('податок за ст 266', '2755-17', 5);
      // 265 is FTS rank 1, but 266 is named explicitly → the number-token boost lifts it to the top.
      expect(result[0].article_number).toBe('266');
    });

    it('resolves a vector winner absent from legislation_articles via npa.article', async () => {
      // КТМ ст. 391 is in the bge slice (full НПА corpus) but not in legislation_articles.
      mockEmbedding.searchVectors.mockResolvedValueOnce([
        { id: 'v1', score: 0.66, payload: { rada_id: '176/95-вр', article_number: '391' } },
      ]);
      mockAdapter.searchArticlesHybrid.mockResolvedValueOnce([]);
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // legislation_articles lookup
        .mockResolvedValueOnce({
          rows: [{
            rada_id: '176/95-вр', article_number: '391', title: 'Застосування загальних строків',
            full_text: 'Стаття 391. Застосування загальних строків\nДо вимог...', npa_title: 'КТМ',
          }],
          rowCount: 1,
        });

      const result = await service.findRelevantArticles('строки позовної давності', undefined, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ rada_id: '176/95-вр', article_number: '391', npa_title: 'КТМ' });
      expect(mockDb.query.mock.calls[1][0]).toContain('npa.article');
      expect(mockDb.query.mock.calls[1][1]).toEqual([['176/95-вр'], ['391']]);
    });

    it('falls back to text search when both legs return nothing', async () => {
      mockEmbedding.searchVectors.mockResolvedValueOnce([]);
      mockAdapter.searchArticlesHybrid.mockResolvedValueOnce([]);
      mockAdapter.searchArticles.mockResolvedValueOnce([
        { rada_id: '2755-17', legislation_title: 'ПКУ', article_number: '99', title: 'x', full_text: 'y', metadata: {} },
      ]);

      const result = await service.findRelevantArticles('щось незрозуміле', '2755-17', 5);
      expect(mockAdapter.searchArticles).toHaveBeenCalled();
      expect(result[0].article_number).toBe('99');
    });
  });

  describe('searchLegislation', () => {
    it('should return grouped search results', async () => {
      mockAdapter.searchArticles.mockResolvedValueOnce([
        {
          rada_id: '435-15',
          legislation_title: 'Цивільний кодекс',
          article_number: '1',
          title: 'Art 1',
          full_text: 'match',
          full_text_html: null,
          section_number: null,
          metadata: {},
        },
      ]);

      const result = await service.searchLegislation('test query');

      expect(result).toHaveLength(1);
      expect(result[0].rada_id).toBe('435-15');
      expect(result[0].articles).toHaveLength(1);
    });
  });
});
