/**
 * AnalyzeDataTool unit tests
 *
 * Covers:
 * - Tool definition
 * - SQL validation: SELECT-only, forbidden keywords, LIMIT requirement, limit cap
 * - Table whitelist enforcement
 * - Read-only transaction setup (BEGIN READ ONLY + statement_timeout)
 * - Comment stripping (-- and /* *​/ )
 * - DB error handling (timeout, read-only violation)
 * - Row cap enforcement
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AnalyzeDataTool } from '../tools/analyze-data-tool.js';

type QueryCall = { sql: string; params?: any[] };

describe('AnalyzeDataTool', () => {
  let calls: QueryCall[];
  let tool: AnalyzeDataTool;

  const makePoolDb = (responder: (sql: string) => any) => ({
    connect: jest.fn(() => {
      const client = {
        query: jest.fn((sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return Promise.resolve(responder(sql));
        }),
        release: jest.fn(),
      };
      return Promise.resolve(client);
    }),
  });

  const makeSimpleDb = (responder: (sql: string) => any) => ({
    query: jest.fn((sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve(responder(sql));
    }),
  });

  beforeEach(() => {
    calls = [];
  });

  describe('tool definition', () => {
    it('exposes single analyze_data tool', () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);
      const defs = tool.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('analyze_data');
      expect(defs[0].annotations?.readOnlyHint).toBe(true);
    });

    it('returns null for unknown tool', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);
      expect(await tool.executeTool('other', {})).toBeNull();
    });
  });

  describe('SQL validation', () => {
    it('rejects empty sql', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', { sql: '' });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('sql');
    });

    it('rejects non-SELECT statements', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'INSERT INTO edrsr_documents VALUES (1)',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('SELECT');
    });

    it('rejects DELETE', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT 1; DELETE FROM edrsr_documents LIMIT 1',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('заборонені операції');
    });

    it('rejects DROP TABLE', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT 1; DROP TABLE edrsr_documents; LIMIT 1',
      });
      expect(result?.isError).toBe(true);
    });

    it('rejects UPDATE', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: "SELECT 1 FROM edrsr_documents; UPDATE edrsr_documents SET judge = 'x' LIMIT 1",
      });
      expect(result?.isError).toBe(true);
    });

    it('rejects TRUNCATE', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT 1; TRUNCATE edrsr_documents LIMIT 1',
      });
      expect(result?.isError).toBe(true);
    });

    it('requires LIMIT clause', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) FROM edrsr_documents',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('LIMIT');
    });

    it('rejects LIMIT > 500', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT * FROM edrsr_documents LIMIT 1000',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('500');
    });

    it('accepts LIMIT 500', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [], rowCount: 0, fields: [] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) FROM edrsr_documents LIMIT 500',
      });
      expect(result?.isError).toBeFalsy();
    });

    it('strips SQL comments before validation', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      // DELETE is inside a comment, shouldn't trigger
      const result = await tool.executeTool('analyze_data', {
        sql: "SELECT count(*) FROM edrsr_documents -- DELETE FROM users\nLIMIT 10",
      });
      // Should fail on table whitelist or succeed, but NOT on "forbidden keyword"
      expect(result?.isError).toBeFalsy();
    });
  });

  describe('table whitelist', () => {
    it('allows edrsr tables', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [{ cnt: 42 }], rowCount: 1, fields: [{ name: 'cnt' }] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) as cnt FROM edrsr_documents LIMIT 1',
      });
      expect(result?.isError).toBeFalsy();
      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.results[0].cnt).toBe(42);
    });

    it('allows opendata tables', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [], rowCount: 0, fields: [] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) FROM opendata_lawyers LIMIT 1',
      });
      expect(result?.isError).toBeFalsy();
    });

    it('blocks user/billing tables', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT * FROM users LIMIT 10',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('users');
    });

    it('blocks Find Case Law judgments: raw SQL would bypass the verified-user gate', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      for (const t of ['uk_court_decisions', 'uk_court_decision_fts', 'uk_judgment_access_log']) {
        const result = await tool.executeTool('analyze_data', { sql: `SELECT * FROM ${t} LIMIT 10` });
        expect(result?.isError).toBe(true);
        expect(result?.content[0].text).toContain(t);
      }
      expect(db.query).not.toHaveBeenCalled();
    });

    it('blocks billing tables', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT * FROM user_billing LIMIT 10',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('user_billing');
    });

    it('blocks sessions/auth tables', async () => {
      const db = makeSimpleDb(() => ({ rows: [] }));
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT * FROM sessions LIMIT 10',
      });
      expect(result?.isError).toBe(true);
    });

    it('allows JOINs between whitelisted tables', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [], rowCount: 0, fields: [] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT d.doc_id, c.name FROM edrsr_documents d JOIN edrsr_courts c ON c.court_code = d.court_code LIMIT 10',
      });
      expect(result?.isError).toBeFalsy();
    });
  });

  describe('read-only transaction', () => {
    it('sets up BEGIN READ ONLY and statement_timeout with pool', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [], rowCount: 0, fields: [] };
      });
      tool = new AnalyzeDataTool(db);

      await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) FROM edrsr_documents LIMIT 1',
      });

      expect(calls.some(c => c.sql.includes('BEGIN TRANSACTION READ ONLY'))).toBe(true);
      expect(calls.some(c => c.sql.includes('statement_timeout'))).toBe(true);
      expect(calls.some(c => c.sql.includes('COMMIT'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('handles statement timeout', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('SET')) return { rows: [] };
        if (sql.includes('ROLLBACK')) return { rows: [] };
        throw new Error('canceling statement due to statement timeout');
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT * FROM edrsr_documents LIMIT 10',
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('ліміт часу');
    });

    it('handles read-only violation', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('SET')) return { rows: [] };
        if (sql.includes('ROLLBACK')) return { rows: [] };
        throw new Error('cannot execute INSERT in a read-only transaction');
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: "SELECT count(*) FROM edrsr_documents LIMIT 1",
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('SELECT');
    });
  });

  describe('response formatting', () => {
    it('caps rows at 500', async () => {
      const bigRows = Array.from({ length: 600 }, (_, i) => ({ id: i }));
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: bigRows, rowCount: 600, fields: [{ name: 'id' }] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT id FROM edrsr_documents LIMIT 500',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.rows_returned).toBe(500);
      expect(parsed.has_more).toBe(true);
    });

    it('includes column names in response', async () => {
      const db = makePoolDb((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SET')) return { rows: [] };
        return { rows: [{ cnt: 42, avg_val: 3.14 }], rowCount: 1, fields: [{ name: 'cnt' }, { name: 'avg_val' }] };
      });
      tool = new AnalyzeDataTool(db);

      const result = await tool.executeTool('analyze_data', {
        sql: 'SELECT count(*) as cnt, avg(share_percent) as avg_val FROM opendata_securities_owners LIMIT 1',
      });

      const parsed = JSON.parse(result?.content[0].text || '{}');
      expect(parsed.columns).toEqual(['cnt', 'avg_val']);
    });
  });
});
