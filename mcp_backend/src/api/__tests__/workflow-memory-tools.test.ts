/**
 * WorkflowMemoryTools unit tests
 *
 * Covers:
 * - getToolDefinitions: returns 3 tool defs with correct names/annotations
 * - executeTool: dispatches correctly, returns null for unknown tool
 * - workflow_memory_query: formats results, handles empty results, caps top_k at 20
 * - workflow_memory_ingest: principle (with/without key), pattern defaults, practitioner, unknown layer
 * - workflow_memory_stats: formatted response
 * - Error handling: wraps errors with isError: true
 */

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WorkflowMemoryTools } from '../tools/workflow-memory-tools';

// ---------------------------------------------------------------------------
// Helper: build a mock of WorkflowMemoryService using explicit jest.Mock<any>
// ---------------------------------------------------------------------------

interface MockService {
  initialize: jest.Mock<any>;
  query: jest.Mock<any>;
  ingestPrinciple: jest.Mock<any>;
  ingestPattern: jest.Mock<any>;
  ingestPractitioner: jest.Mock<any>;
  getStats: jest.Mock<any>;
  reconcileSession: jest.Mock<any>;
}

function makeMockService(): MockService {
  return {
    initialize: jest.fn() as jest.Mock<any>,
    query: jest.fn() as jest.Mock<any>,
    ingestPrinciple: jest.fn() as jest.Mock<any>,
    ingestPattern: jest.fn() as jest.Mock<any>,
    ingestPractitioner: jest.fn() as jest.Mock<any>,
    getStats: jest.fn() as jest.Mock<any>,
    reconcileSession: jest.fn() as jest.Mock<any>,
  };
}

// Convenience: parse the text payload of a ToolResult
function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------

describe('WorkflowMemoryTools', () => {
  let svc: MockService;
  let handler: WorkflowMemoryTools;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = makeMockService();
    handler = new WorkflowMemoryTools(svc as any);
  });

  // ── getToolDefinitions ─────────────────────────────────────────────────────

  describe('getToolDefinitions', () => {
    it('returns exactly 6 tool definitions', () => {
      const defs = handler.getToolDefinitions();
      // Grew from 4 to 6 with the push tools (push_refresh, push_sync_tasks).
      expect(defs).toHaveLength(6);
      expect(defs.map((d: any) => d.name)).toEqual(expect.arrayContaining([
        'workflow_memory_push_refresh', 'workflow_memory_push_sync_tasks',
      ]));
    });

    it('returns workflow_memory_query with required "query" field', () => {
      const defs = handler.getToolDefinitions();
      const queryTool = defs.find(d => d.name === 'workflow_memory_query');
      expect(queryTool).toBeDefined();
      expect(queryTool!.inputSchema.required).toContain('query');
      expect(queryTool!.annotations?.readOnlyHint).toBe(true);
    });

    it('returns workflow_memory_ingest with required fields', () => {
      const defs = handler.getToolDefinitions();
      const ingestTool = defs.find(d => d.name === 'workflow_memory_ingest');
      expect(ingestTool).toBeDefined();
      expect(ingestTool!.inputSchema.required).toContain('layer');
      expect(ingestTool!.inputSchema.required).toContain('title');
      expect(ingestTool!.inputSchema.required).toContain('body');
    });

    it('returns workflow_memory_stats with readOnlyHint and idempotentHint', () => {
      const defs = handler.getToolDefinitions();
      const statsTool = defs.find(d => d.name === 'workflow_memory_stats');
      expect(statsTool).toBeDefined();
      expect(statsTool!.annotations?.readOnlyHint).toBe(true);
      expect(statsTool!.annotations?.idempotentHint).toBe(true);
    });

    it('handles() returns true for all four tool names', () => {
      expect(handler.handles('workflow_memory_query')).toBe(true);
      expect(handler.handles('workflow_memory_ingest')).toBe(true);
      expect(handler.handles('workflow_memory_stats')).toBe(true);
      expect(handler.handles('workflow_memory_reconcile')).toBe(true);
    });

    it('handles() returns false for unknown tool name', () => {
      expect(handler.handles('workflow_memory_unknown')).toBe(false);
    });
  });

  // ── executeTool dispatch ───────────────────────────────────────────────────

  describe('executeTool', () => {
    it('returns null for an unrecognised tool name', async () => {
      const result = await handler.executeTool('totally_unknown', {});
      expect(result).toBeNull();
    });

    it('dispatches to handleQuery for workflow_memory_query', async () => {
      svc.query.mockResolvedValue({ hits: [], queryTokens: 0, layers_searched: ['principle'] });
      const result = await handler.executeTool('workflow_memory_query', { query: 'test' });
      expect(result).not.toBeNull();
      expect(svc.query).toHaveBeenCalledTimes(1);
    });

    it('dispatches to handleIngest for workflow_memory_ingest', async () => {
      svc.ingestPrinciple.mockResolvedValue(1);
      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'principle',
        title: 'T',
        body: 'B',
        principle_key: 'k',
      });
      expect(result).not.toBeNull();
      expect(svc.ingestPrinciple).toHaveBeenCalledTimes(1);
    });

    it('dispatches to handleStats for workflow_memory_stats', async () => {
      svc.getStats.mockResolvedValue({ principles: 0, patterns: 0, practitioner: 0, retrievals: 0, reconciliations: 0 });
      const result = await handler.executeTool('workflow_memory_stats', {});
      expect(result).not.toBeNull();
      expect(svc.getStats).toHaveBeenCalledTimes(1);
    });
  });

  // ── workflow_memory_query ──────────────────────────────────────────────────

  describe('workflow_memory_query', () => {
    it('returns "nothing found" message when hits array is empty', async () => {
      svc.query.mockResolvedValue({
        hits: [],
        queryTokens: 0,
        layers_searched: ['principle', 'pattern', 'practitioner'],
      });

      const result = await handler.executeTool('workflow_memory_query', { query: 'anything' });

      expect(result?.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.message).toMatch(/нічого не знайдено/i);
      expect(parsed.layers_searched).toBeDefined();
    });

    it('formats hits correctly with rounded score', async () => {
      svc.query.mockResolvedValue({
        hits: [
          {
            layer: 'principle',
            id: 1,
            title: 'Deploy blue-green',
            body: 'Use blue-green deploy strategy',
            score: 0.876543,
            tags: ['deploy'],
            source: 'adr',
            metadata: { version: 2 },
          },
        ],
        queryTokens: 0,
        layers_searched: ['principle'],
      });

      const result = await handler.executeTool('workflow_memory_query', { query: 'deploy' });

      const parsed = parseResult(result);
      expect(parsed.count).toBe(1);
      expect(parsed.hits[0].layer).toBe('principle');
      expect(parsed.hits[0].title).toBe('Deploy blue-green');
      expect(parsed.hits[0].score).toBe(0.877); // rounded to 3 dp
      expect(parsed.hits[0].source).toBe('adr');
      expect(parsed.hits[0].metadata).toEqual({ version: 2 });
    });

    it('omits source field from hit when source is not present', async () => {
      svc.query.mockResolvedValue({
        hits: [
          {
            layer: 'pattern',
            id: 2,
            title: 'T',
            body: 'B',
            score: 0.7,
            tags: [],
            source: undefined,
            metadata: undefined,
          },
        ],
        queryTokens: 0,
        layers_searched: ['pattern'],
      });

      const result = await handler.executeTool('workflow_memory_query', { query: 'x' });
      const parsed = parseResult(result);
      expect(Object.prototype.hasOwnProperty.call(parsed.hits[0], 'source')).toBe(false);
    });

    it('omits metadata field from hit when metadata is empty object', async () => {
      svc.query.mockResolvedValue({
        hits: [
          {
            layer: 'practitioner',
            id: 3,
            title: 'T',
            body: 'B',
            score: 0.7,
            tags: [],
            source: undefined,
            metadata: {},
          },
        ],
        queryTokens: 0,
        layers_searched: ['practitioner'],
      });

      const result = await handler.executeTool('workflow_memory_query', { query: 'x' });
      const parsed = parseResult(result);
      expect(Object.prototype.hasOwnProperty.call(parsed.hits[0], 'metadata')).toBe(false);
    });

    it('caps top_k at 20 even when caller passes a larger value', async () => {
      svc.query.mockResolvedValue({ hits: [], queryTokens: 0, layers_searched: ['principle'] });

      await handler.executeTool('workflow_memory_query', { query: 'x', top_k: 100 });

      expect(svc.query).toHaveBeenCalledWith(
        expect.objectContaining({ topK: 20 }),
      );
    });

    it('uses default top_k=5 when not provided', async () => {
      svc.query.mockResolvedValue({ hits: [], queryTokens: 0, layers_searched: ['principle'] });

      await handler.executeTool('workflow_memory_query', { query: 'x' });

      expect(svc.query).toHaveBeenCalledWith(
        expect.objectContaining({ topK: 5 }),
      );
    });

    it('passes layers, tags and session_id through to service', async () => {
      svc.query.mockResolvedValue({ hits: [], queryTokens: 0, layers_searched: ['principle'] });

      await handler.executeTool('workflow_memory_query', {
        query: 'test',
        layers: ['principle', 'pattern'],
        tags: ['billing'],
        session_id: 'sess-1',
        top_k: 3,
      });

      expect(svc.query).toHaveBeenCalledWith({
        query: 'test',
        layers: ['principle', 'pattern'],
        tags: ['billing'],
        topK: 3,
        sessionId: 'sess-1',
      });
    });

    it('wraps service errors with isError: true', async () => {
      svc.query.mockRejectedValue(new Error('Qdrant connection refused'));

      const result = await handler.executeTool('workflow_memory_query', { query: 'x' });

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('Qdrant connection refused');
    });
  });

  // ── workflow_memory_ingest — principle ─────────────────────────────────────

  describe('workflow_memory_ingest — principle layer', () => {
    it('returns error when principle_key is missing', async () => {
      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'principle',
        title: 'T',
        body: 'B',
        // no principle_key
      });

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('principle_key');
    });

    it('calls ingestPrinciple with correct arguments and returns success', async () => {
      svc.ingestPrinciple.mockResolvedValue(42);

      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'principle',
        title: 'Blue-green deploy',
        body: 'Deploy to inactive colour',
        principle_key: 'deploy.blue_green',
        source: 'adr',
        source_ref: 'docs/adr/001.md',
        tags: ['deploy', 'infra'],
      });

      expect(result?.isError).toBeFalsy();
      expect(svc.ingestPrinciple).toHaveBeenCalledWith({
        principleKey: 'deploy.blue_green',
        title: 'Blue-green deploy',
        body: 'Deploy to inactive colour',
        source: 'adr',
        sourceRef: 'docs/adr/001.md',
        tags: ['deploy', 'infra'],
      });

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe(42);
      expect(parsed.layer).toBe('principle');
    });

    it('wraps service error with isError: true', async () => {
      svc.ingestPrinciple.mockRejectedValue(new Error('DB connection lost'));

      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'principle',
        title: 'T',
        body: 'B',
        principle_key: 'k',
      });

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('DB connection lost');
    });
  });

  // ── workflow_memory_ingest — pattern ───────────────────────────────────────

  describe('workflow_memory_ingest — pattern layer', () => {
    it('calls ingestPattern and returns success', async () => {
      svc.ingestPattern.mockResolvedValue(55);

      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'pattern',
        title: 'Read-Edit-Build cycle',
        body: 'Always read before editing, run build after',
        tags: ['workflow'],
      });

      expect(result?.isError).toBeFalsy();
      expect(svc.ingestPattern).toHaveBeenCalledTimes(1);
      const parsed = parseResult(result);
      expect(parsed.id).toBe(55);
      expect(parsed.layer).toBe('pattern');
    });

    it('uses "edit_trace" as default pattern_type when not provided', async () => {
      svc.ingestPattern.mockResolvedValue(1);

      await handler.executeTool('workflow_memory_ingest', {
        layer: 'pattern',
        title: 'T',
        body: 'B',
      });

      expect(svc.ingestPattern).toHaveBeenCalledWith(
        expect.objectContaining({ patternType: 'edit_trace' }),
      );
    });

    it('wraps session_id into sessionIds array', async () => {
      svc.ingestPattern.mockResolvedValue(1);

      await handler.executeTool('workflow_memory_ingest', {
        layer: 'pattern',
        title: 'T',
        body: 'B',
        session_id: 'sess-77',
      });

      expect(svc.ingestPattern).toHaveBeenCalledWith(
        expect.objectContaining({ sessionIds: ['sess-77'] }),
      );
    });

    it('uses empty sessionIds when session_id absent', async () => {
      svc.ingestPattern.mockResolvedValue(1);

      await handler.executeTool('workflow_memory_ingest', {
        layer: 'pattern',
        title: 'T',
        body: 'B',
      });

      expect(svc.ingestPattern).toHaveBeenCalledWith(
        expect.objectContaining({ sessionIds: [] }),
      );
    });

    it('passes pattern_data to ingestPattern', async () => {
      svc.ingestPattern.mockResolvedValue(1);
      const patternData = { steps: ['Read', 'Edit'] };

      await handler.executeTool('workflow_memory_ingest', {
        layer: 'pattern',
        title: 'T',
        body: 'B',
        pattern_data: patternData,
      });

      expect(svc.ingestPattern).toHaveBeenCalledWith(
        expect.objectContaining({ patternData }),
      );
    });
  });

  // ── workflow_memory_ingest — practitioner ──────────────────────────────────

  describe('workflow_memory_ingest — practitioner layer', () => {
    it('calls ingestPractitioner and returns success', async () => {
      svc.ingestPractitioner.mockResolvedValue(77);

      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'practitioner',
        title: 'Session recap',
        body: 'Implemented billing fix in 3 files.',
        knowledge_type: 'session_summary',
        session_id: 'sess-42',
        commit_range: 'abc..def',
        files_touched: ['billing.ts'],
        tools_used: ['Read', 'Edit'],
        tags: ['billing'],
      });

      expect(result?.isError).toBeFalsy();
      expect(svc.ingestPractitioner).toHaveBeenCalledWith({
        knowledgeType: 'session_summary',
        title: 'Session recap',
        body: 'Implemented billing fix in 3 files.',
        sessionId: 'sess-42',
        commitRange: 'abc..def',
        filesTouched: ['billing.ts'],
        toolsUsed: ['Read', 'Edit'],
        tags: ['billing'],
      });

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe(77);
      expect(parsed.layer).toBe('practitioner');
    });

    it('uses "session_summary" as default knowledge_type when not provided', async () => {
      svc.ingestPractitioner.mockResolvedValue(1);

      await handler.executeTool('workflow_memory_ingest', {
        layer: 'practitioner',
        title: 'T',
        body: 'B',
      });

      expect(svc.ingestPractitioner).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeType: 'session_summary' }),
      );
    });
  });

  // ── workflow_memory_ingest — unknown layer ─────────────────────────────────

  describe('workflow_memory_ingest — unknown layer', () => {
    it('returns isError: true for an unrecognised layer', async () => {
      const result = await handler.executeTool('workflow_memory_ingest', {
        layer: 'bogus_layer',
        title: 'T',
        body: 'B',
      });

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('bogus_layer');
    });

    it('does not call any ingest method for unknown layer', async () => {
      await handler.executeTool('workflow_memory_ingest', {
        layer: 'ghost',
        title: 'T',
        body: 'B',
      });

      expect(svc.ingestPrinciple).not.toHaveBeenCalled();
      expect(svc.ingestPattern).not.toHaveBeenCalled();
      expect(svc.ingestPractitioner).not.toHaveBeenCalled();
    });
  });

  // ── workflow_memory_stats ──────────────────────────────────────────────────

  describe('workflow_memory_stats', () => {
    it('formats stats correctly', async () => {
      svc.getStats.mockResolvedValue({
        principles: 10,
        patterns: 25,
        practitioner: 5,
        retrievals: 100,
        reconciliations: 3,
      });

      const result = await handler.executeTool('workflow_memory_stats', {});

      expect(result?.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.layers.principles).toBe(10);
      expect(parsed.layers.patterns).toBe(25);
      expect(parsed.layers.practitioner).toBe(5);
      expect(parsed.total_entries).toBe(40);
      expect(parsed.total_retrievals).toBe(100);
      expect(parsed.total_reconciliations).toBe(3);
    });

    it('computes total_entries as sum of principles + patterns + practitioner', async () => {
      svc.getStats.mockResolvedValue({
        principles: 3,
        patterns: 7,
        practitioner: 2,
        retrievals: 0,
        reconciliations: 0,
      });

      const result = await handler.executeTool('workflow_memory_stats', {});
      const parsed = parseResult(result);
      expect(parsed.total_entries).toBe(12);
    });

    it('wraps getStats error with isError: true', async () => {
      svc.getStats.mockRejectedValue(new Error('DB timeout'));

      const result = await handler.executeTool('workflow_memory_stats', {});

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('DB timeout');
    });
  });

  // ── wrapResponse shape ─────────────────────────────────────────────────────

  describe('response shape (wrapResponse)', () => {
    it('always returns content as an array with at least one text item', async () => {
      svc.query.mockResolvedValue({ hits: [], queryTokens: 0, layers_searched: ['principle'] });
      const result = await handler.executeTool('workflow_memory_query', { query: 'x' });

      expect(Array.isArray(result?.content)).toBe(true);
      expect(result?.content.length).toBeGreaterThan(0);
      expect(result?.content[0].type).toBe('text');
      expect(typeof result?.content[0].text).toBe('string');
    });

    it('result text is valid JSON for successful responses', async () => {
      svc.getStats.mockResolvedValue({ principles: 1, patterns: 2, practitioner: 3, retrievals: 4, reconciliations: 0 });
      const result = await handler.executeTool('workflow_memory_stats', {});

      expect(() => JSON.parse(result!.content[0].text)).not.toThrow();
    });
  });
});
