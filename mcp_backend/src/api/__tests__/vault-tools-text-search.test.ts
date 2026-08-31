/**
 * VaultTools text search & chunked embedding tests
 *
 * Covers:
 * 1. listDocuments with text search (full-text tsvector + ILIKE fallback)
 * 2. listDocuments with folder filtering
 * 3. listDocuments sorting (relevance vs column)
 * 4. storeDocument chunked embedding flow for large documents
 * 5. Edge cases: empty query, special characters, no results
 */

import { VaultTools } from '../vault-tools';

// ──────────────────────────────────────────────────────────────────────────
// Mock factories
// ──────────────────────────────────────────────────────────────────────────

function makeDocumentParser(overrides: any = {}) {
  return {
    parseDocument: jest.fn().mockResolvedValue({
      text: 'Parsed document text content.',
      mimeType: 'text/plain',
      metadata: { pageCount: 1 },
    }),
    ...overrides,
  };
}

function makeSectionizer(overrides: any = {}) {
  return {
    extractSections: jest.fn().mockResolvedValue([
      { type: 'FACTS', text: 'Section facts text.', start_index: 0, end_index: 100, confidence: 0.9 },
    ]),
    ...overrides,
  };
}

function makePatternStore(overrides: any = {}) {
  return {
    analyzePatterns: jest.fn().mockResolvedValue({ riskFactors: [], keyArguments: [], confidence: 0.5 }),
    ...overrides,
  };
}

function makeEmbeddingService(overrides: any = {}) {
  return {
    generateEmbedding: jest.fn().mockResolvedValue(new Array(1024).fill(0)),
    generateEmbeddingsBatch: jest.fn().mockResolvedValue([new Array(1024).fill(0)]),
    splitIntoChunks: jest.fn().mockReturnValue([]),
    storeChunk: jest.fn().mockResolvedValue('vec-id-1'),
    // Vault writes go to the dedicated vault collection (embedding-service.ts:494), not the
    // shared one; without this the storeDocument tests died on "storeVaultChunk is not a
    // function" instead of exercising the chunking behaviour they assert.
    storeVaultChunk: jest.fn().mockResolvedValue('vault-vec-id-1'),
    searchSimilar: jest.fn().mockResolvedValue([]),
    initialize: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDocumentService(overrides: any = {}) {
  const mockDb = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    transaction: jest.fn(),
  };
  return {
    saveDocument: jest.fn().mockResolvedValue('doc-id-1'),
    getDocumentById: jest.fn().mockResolvedValue(null),
    saveSections: jest.fn().mockResolvedValue(undefined),
    getSections: jest.fn().mockResolvedValue([]),
    db: mockDb,
    ...overrides,
  };
}

function makeMetadataExtractor(overrides: any = {}) {
  return {
    extract: jest.fn().mockResolvedValue({
      documentDate: '2025-01-01',
      tags: ['contract'],
      parties: ['Party A'],
      summary: 'A summary.',
    }),
    ...overrides,
  };
}

function createVaultTools(overrides: {
  documentParser?: any;
  sectionizer?: any;
  patternStore?: any;
  embeddingService?: any;
  documentService?: any;
  metadataExtractor?: any;
} = {}): VaultTools {
  return new VaultTools(
    overrides.documentParser || makeDocumentParser(),
    overrides.sectionizer || makeSectionizer(),
    overrides.patternStore || makePatternStore(),
    overrides.embeddingService || makeEmbeddingService(),
    overrides.documentService || makeDocumentService(),
    overrides.metadataExtractor || makeMetadataExtractor(),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tests: listDocuments text search
// ──────────────────────────────────────────────────────────────────────────

describe('VaultTools.listDocuments — text search', () => {
  it('builds SQL with plainto_tsquery and ILIKE when query is provided', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'doc-1', title: 'Contract', type: 'contract', metadata: {}, storage_type: 'vault', mime_type: null, created_at: new Date(), updated_at: new Date() }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    await vt.listDocuments({ query: 'договір купівлі', userId: 'user-1' });

    // First call is the main query, second is the count
    const mainCallArgs = mockDb.query.mock.calls[0];
    const sql: string = mainCallArgs[0];
    const params: any[] = mainCallArgs[1];

    // Should use search_vector @@ plainto_tsquery AND title ILIKE
    expect(sql).toContain("search_vector @@ plainto_tsquery('simple'");
    expect(sql).toContain('title ILIKE');
    // Should sort by ts_rank when query is active
    expect(sql).toContain('ts_rank');

    // Params should include search text and ILIKE pattern
    expect(params).toContain('договір купівлі');
    expect(params).toContain('%договір купівлі%');
  });

  it('does NOT use tsvector/ts_rank when query is empty', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    await vt.listDocuments({ userId: 'user-1' });

    const sql: string = mockDb.query.mock.calls[0][0];
    expect(sql).not.toContain('search_vector');
    expect(sql).not.toContain('ts_rank');
    expect(sql).not.toContain('plainto_tsquery');
  });

  it('does NOT use tsvector when query is only whitespace', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    await vt.listDocuments({ query: '   ', userId: 'user-1' });

    const sql: string = mockDb.query.mock.calls[0][0];
    expect(sql).not.toContain('search_vector');
  });

  it('returns empty when userId is not provided', async () => {
    const vt = createVaultTools();
    const result = await vt.listDocuments({});
    expect(result).toEqual({ documents: [], total: 0 });
  });

  it('applies folderPath prefix filter', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    await vt.listDocuments({ userId: 'user-1', folderPath: '/legal/contracts' });

    const sql: string = mockDb.query.mock.calls[0][0];
    const params: any[] = mockDb.query.mock.calls[0][1];

    expect(sql).toContain("metadata::jsonb ->> 'folderPath' LIKE");
    // Exact folder OR its sub-paths, not a bare prefix — a plain '/legal/contracts%' also
    // matched sibling folders like '/legal/contracts-old' (vault-tools.ts:955).
    expect(params).toContain('/legal/contracts');
    expect(params).toContain('/legal/contracts/%');
  });

  it('applies type filter', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    await vt.listDocuments({ userId: 'user-1', type: 'court_decision' });

    const params: any[] = mockDb.query.mock.calls[0][1];
    expect(params).toContain('court_decision');
  });

  it('handles pagination params', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '25' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    const result = await vt.listDocuments({ userId: 'user-1', limit: 10, offset: 20 });

    const params: any[] = mockDb.query.mock.calls[0][1];
    // Last two params are limit and offset
    expect(params[params.length - 2]).toBe(10);
    expect(params[params.length - 1]).toBe(20);
    expect(result.total).toBe(25);
  });

  it('maps row metadata correctly, using empty object for null metadata', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'd1', title: null, type: 'internal', metadata: null,
            storage_type: null, mime_type: null, created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    const result = await vt.listDocuments({ userId: 'user-1' });

    expect(result.documents[0].title).toBe('Untitled');
    expect(result.documents[0].metadata).toEqual({});
    expect((result.documents[0] as any).storage_type).toBe('vault');
  });

  it('handles special characters in search query safely', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    // Query with special characters — should be passed as parameterized value, not inline SQL
    await vt.listDocuments({ query: "O'Brien & Co. (test)", userId: 'user-1' });

    const params: any[] = mockDb.query.mock.calls[0][1];
    // The raw search text should be passed as a parameter, not interpolated
    expect(params).toContain("O'Brien & Co. (test)");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tests: storeDocument chunked embedding flow
// ──────────────────────────────────────────────────────────────────────────

describe('VaultTools.storeDocument — chunked embeddings', () => {
  it('does NOT chunk when document text is <= 8000 chars', async () => {
    const shortText = 'a '.repeat(3000); // 6000 chars
    const embeddingService = makeEmbeddingService({
      generateEmbeddingsBatch: jest.fn().mockResolvedValue([
        new Array(1024).fill(0), // full text
        new Array(1024).fill(0), // 1 section
      ]),
    });
    const documentParser = makeDocumentParser({
      parseDocument: jest.fn().mockResolvedValue({ text: shortText, mimeType: 'text/plain', metadata: { pageCount: 1 } }),
    });
    const docService = makeDocumentService();

    const vt = createVaultTools({ embeddingService, documentParser, documentService: docService });

    await vt.storeDocument({
      fileBase64: 'dGVzdA==',
      title: 'Short Doc',
      type: 'contract',
    });

    expect(embeddingService.splitIntoChunks).not.toHaveBeenCalled();
  });

  it('chunks and embeds when document text is > 8000 chars', async () => {
    const longText = 'word '.repeat(5000); // ~25000 chars
    const mockChunks = ['chunk1 text', 'chunk2 text', 'chunk3 text'];

    const embeddingService = makeEmbeddingService({
      splitIntoChunks: jest.fn().mockReturnValue(mockChunks),
      generateEmbeddingsBatch: jest.fn().mockResolvedValue([
        new Array(1024).fill(0), // full text
        new Array(1024).fill(0), // section
        new Array(1024).fill(0), // chunk 1
        new Array(1024).fill(0), // chunk 2
        new Array(1024).fill(0), // chunk 3
      ]),
      storeChunk: jest.fn().mockResolvedValue('vec-id'),
    });
    const documentParser = makeDocumentParser({
      parseDocument: jest.fn().mockResolvedValue({ text: longText, mimeType: 'text/plain', metadata: { pageCount: 1 } }),
    });
    const docService = makeDocumentService();

    const vt = createVaultTools({ embeddingService, documentParser, documentService: docService });

    await vt.storeDocument({
      fileBase64: 'dGVzdA==',
      title: 'Long Doc',
      type: 'court_decision',
    });

    // splitIntoChunks should have been called
    expect(embeddingService.splitIntoChunks).toHaveBeenCalledWith(longText);

    // generateEmbeddingsBatch should receive full text + 1 section + 3 chunks = 5 texts
    const batchCall = embeddingService.generateEmbeddingsBatch.mock.calls[0][0];
    expect(batchCall).toHaveLength(5);

    // 1 (full doc) + 1 (section) + 3 (chunks) = 5, via the vault-specific collection
    expect(embeddingService.storeVaultChunk).toHaveBeenCalledTimes(5);

    // Verify chunk embeddings have section_type 'CHUNK'
    const chunkCalls = embeddingService.storeVaultChunk.mock.calls.filter(
      (call: any[]) => call[0].section_type === 'CHUNK'
    );
    expect(chunkCalls).toHaveLength(3);

    // Verify chunk_index and total_chunks metadata
    expect(chunkCalls[0][0].metadata.chunk_index).toBe(0);
    expect(chunkCalls[0][0].metadata.total_chunks).toBe(3);
    expect(chunkCalls[2][0].metadata.chunk_index).toBe(2);
  });

  it('batch embeds texts: [full_text, ...sections, ...chunks]', async () => {
    const longText = 'w '.repeat(10000); // > 8000 chars
    const mockChunks = ['c1', 'c2'];
    const mockSections = [
      { type: 'FACTS', text: 'Facts section', start_index: 0, end_index: 50, confidence: 0.9 },
      { type: 'REASONING', text: 'Reasoning section', start_index: 50, end_index: 100, confidence: 0.8 },
    ];

    const embeddingService = makeEmbeddingService({
      splitIntoChunks: jest.fn().mockReturnValue(mockChunks),
      generateEmbeddingsBatch: jest.fn().mockResolvedValue(
        // 1 full + 2 sections + 2 chunks = 5
        Array.from({ length: 5 }, () => new Array(1024).fill(0))
      ),
      storeChunk: jest.fn().mockResolvedValue('vec-id'),
    });
    const sectionizer = makeSectionizer({
      extractSections: jest.fn().mockResolvedValue(mockSections),
    });
    const documentParser = makeDocumentParser({
      parseDocument: jest.fn().mockResolvedValue({ text: longText, mimeType: 'text/plain', metadata: { pageCount: 1 } }),
    });
    const docService = makeDocumentService();

    const vt = createVaultTools({
      embeddingService,
      sectionizer,
      documentParser,
      documentService: docService,
    });

    await vt.storeDocument({
      fileBase64: 'dGVzdA==',
      title: 'Batched',
      type: 'legislation',
    });

    const batchTexts = embeddingService.generateEmbeddingsBatch.mock.calls[0][0];

    // First text is full doc (truncated to 8000)
    expect(batchTexts[0].length).toBeLessThanOrEqual(8000);
    // Then sections, then chunks
    expect(batchTexts).toHaveLength(5); // 1 + 2 + 2
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tests: listFolders
// ──────────────────────────────────────────────────────────────────────────

describe('VaultTools.listFolders', () => {
  it('returns empty when userId is not provided', async () => {
    const vt = createVaultTools();
    const result = await vt.listFolders({});
    expect(result).toEqual({ folders: [], fileCount: 0 });
  });

  it('applies prefix filter to folder query', async () => {
    const mockDb = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{ folder_path: '/legal/contracts/2025' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 }),
    };
    const docService = makeDocumentService({ db: mockDb });
    const vt = createVaultTools({ documentService: docService });

    const result = await vt.listFolders({ prefix: '/legal', userId: 'user-1' });

    const sql: string = mockDb.query.mock.calls[0][0];
    expect(sql).toContain("metadata::jsonb ->> 'folderPath' LIKE");
    expect(result.folders).toBeDefined();
  });
});
