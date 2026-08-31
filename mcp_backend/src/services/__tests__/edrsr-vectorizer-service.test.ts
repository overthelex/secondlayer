/**
 * Tests for EdsrVectorizerService — initialization, token tracking, stats.
 *
 * Note: Full vectorization/search tests require complex VoyageAI + Qdrant
 * mock interactions. Here we test initialization, callback management,
 * and error paths.
 */

// `edrsr_decisions` is the live collection and the service's default. The fixture
// used to name `edrsr_serving`, which has not existed since 2026-07-05.
const mockGetCollections = jest.fn().mockResolvedValue({ collections: [{ name: 'edrsr_decisions' }] });
const mockGetCollection = jest.fn().mockResolvedValue({ points_count: 5000 });
const mockCollectionExists = jest.fn().mockResolvedValue(true);
const mockSearch = jest.fn().mockResolvedValue([]);

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    getCollections: mockGetCollections,
    getCollection: mockGetCollection,
    collectionExists: mockCollectionExists,
    createCollection: jest.fn().mockResolvedValue({}),
    createPayloadIndex: jest.fn().mockResolvedValue({}),
    upsert: jest.fn().mockResolvedValue({}),
    search: mockSearch,
    scroll: jest.fn().mockResolvedValue({ points: [] }),
  })),
}));

jest.mock('../../utils/voyage-client.js', () => ({
  VoyageAIClient: jest.fn().mockImplementation(() => ({
    embedBatch: jest.fn().mockResolvedValue({ embeddings: [], usage: { total_tokens: 0 } }),
    embed: jest.fn().mockResolvedValue({ data: [{ embedding: new Array(1024).fill(0) }], usage: { total_tokens: 50 } }),
  })),
}));

jest.mock('../../utils/bge-m3-client.js', () => ({
  BgeM3Client: jest.fn().mockImplementation(() => ({
    embedBatch: jest.fn().mockResolvedValue({ embeddings: [], usage: { total_tokens: 0 } }),
    embed: jest.fn().mockResolvedValue({ embedding: new Array(1024).fill(0), usage: { total_tokens: 50 } }),
    generateEmbeddingsBatchWithUsage: jest.fn().mockResolvedValue({ embeddings: [new Array(1024).fill(0)], totalTokens: 50 }),
  })),
}));

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { EdsrVectorizerService, AsyncSemaphore } from '../edrsr-vectorizer-service';

describe('AsyncSemaphore', () => {
  it('caps concurrent runs at max (LEXAI-1758)', async () => {
    const sem = new AsyncSemaphore(2);
    let active = 0, peak = 0;
    const task = () => sem.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('runs all tasks and returns their results in order', async () => {
    const sem = new AsyncSemaphore(2);
    const results = await Promise.all([1, 2, 3, 4].map((n) => sem.run(async () => n * 10)));
    expect(results).toEqual([10, 20, 30, 40]);
  });
});

describe('EdsrVectorizerService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, VOYAGEAI_API_KEY: 'test-key', QDRANT_URL: 'http://localhost:6333', BGE_M3_URL: 'http://localhost:8080' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should initialize with default concurrency', () => {
      const service = new EdsrVectorizerService();
      expect(service).toBeDefined();
    });

    it('should initialize with custom concurrency', () => {
      const service = new EdsrVectorizerService(4);
      expect(service).toBeDefined();
    });
  });

  describe('setUsageCallback', () => {
    it('should accept callback', () => {
      const service = new EdsrVectorizerService();
      const cb = jest.fn();
      expect(() => service.setUsageCallback(cb)).not.toThrow();
    });

    it('should accept undefined to clear callback', () => {
      const service = new EdsrVectorizerService();
      expect(() => service.setUsageCallback(undefined)).not.toThrow();
    });
  });

  describe('getVectorizationStats', () => {
    it('should return stats when collection exists', async () => {
      const service = new EdsrVectorizerService();
      mockGetCollections.mockResolvedValueOnce({
        collections: [{ name: 'edrsr_decisions' }],
      });
      mockGetCollection.mockResolvedValueOnce({ points_count: 5000 });

      const stats = await service.getVectorizationStats();

      expect(stats.collection_exists).toBe(true);
      expect(stats.total_points).toBe(5000);
    });

    it('should return zero stats when collection missing', async () => {
      const service = new EdsrVectorizerService();
      mockGetCollections.mockResolvedValueOnce({ collections: [] });

      const stats = await service.getVectorizationStats();

      expect(stats.collection_exists).toBe(false);
      expect(stats.total_points).toBe(0);
    });
  });

  describe('vectorizeDocuments', () => {
    it('should handle empty document array', async () => {
      const service = new EdsrVectorizerService();
      await expect(service.vectorizeDocuments([])).resolves.not.toThrow();
    });
  });

  describe('semanticSearch score_threshold', () => {
    const searchArgs = () => mockSearch.mock.calls.at(-1)![1] as any;

    it('omits score_threshold when unset (no recall regression by default)', async () => {
      delete process.env.QDRANT_EDRSR_SCORE_THRESHOLD;
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест');
      expect('score_threshold' in searchArgs()).toBe(false);
    });

    it('forwards the env-configured floor to Qdrant', async () => {
      process.env.QDRANT_EDRSR_SCORE_THRESHOLD = '0.45';
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест');
      expect(searchArgs().score_threshold).toBe(0.45);
    });

    it('lets a per-call threshold override the env default', async () => {
      process.env.QDRANT_EDRSR_SCORE_THRESHOLD = '0.45';
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест', undefined, 10, 0.6);
      expect(searchArgs().score_threshold).toBe(0.6);
    });

    it('ignores a non-numeric env value', async () => {
      process.env.QDRANT_EDRSR_SCORE_THRESHOLD = 'abc';
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест');
      expect('score_threshold' in searchArgs()).toBe(false);
    });
  });

  describe('semanticSearch filter coercion', () => {
    const filterMust = () => (((mockSearch.mock.calls.at(-1)![1] as any).filter?.must) ?? []) as any[];

    it('coerces a string justice_kind into an integer Qdrant match (index is integer)', async () => {
      const service = new EdsrVectorizerService();
      // hybrid callers may forward the raw tool-call arg, which arrives as a string
      await service.semanticSearch('тест', { justice_kind: '4' as unknown as number });
      const jk = filterMust().find((c) => c.key === 'justice_kind');
      expect(jk).toBeDefined();
      expect(jk.match.value).toBe(4);
    });

    it('coerces a string court_code into an integer Qdrant match', async () => {
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест', { court_code: '9931' as unknown as number });
      const cc = filterMust().find((c) => c.key === 'court_code');
      expect(cc).toBeDefined();
      expect(cc.match.value).toBe(9931);
    });

    it('keeps a numeric justice_kind unchanged', async () => {
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест', { justice_kind: 1 });
      const jk = filterMust().find((c) => c.key === 'justice_kind');
      expect(jk.match.value).toBe(1);
    });

    it('adds no justice_kind clause when no filter is supplied', async () => {
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест');
      expect(filterMust().find((c) => c.key === 'justice_kind')).toBeUndefined();
    });

    it('pushes court_codes as a match-any on court_code (instance/court_level → vector leg)', async () => {
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест', { court_codes: [9901, 9911, '9921' as unknown as number] });
      const cc = filterMust().find((c) => c.key === 'court_code');
      expect(cc).toBeDefined();
      expect(cc.match.any).toEqual([9901, 9911, 9921]); // coerced to integers for the index
    });

    it('prefers a single court_code over court_codes when both are set', async () => {
      const service = new EdsrVectorizerService();
      await service.semanticSearch('тест', { court_code: 9931, court_codes: [9901, 9911] });
      const cc = filterMust().find((c) => c.key === 'court_code');
      expect(cc.match.value).toBe(9931);
      expect(cc.match.any).toBeUndefined();
    });
  });
});
