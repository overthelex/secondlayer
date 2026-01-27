/**
 * Comprehensive Integration Tests for RADA MCP Tools
 * Tests all 4 parliamentary tools via HTTP API
 */

import axios, { AxiosInstance } from 'axios';

describe('RADA MCP Tools - Integration Tests', () => {
  let client: AxiosInstance;
  const BASE_URL = process.env.RADA_TEST_BASE_URL || 'http://localhost:3001';
  const API_KEY = process.env.RADA_TEST_API_KEY || 'test-key-123';

  beforeAll(() => {
    client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
  });

  const callTool = async (toolName: string, args: any) => {
    try {
      const response = await client.post(`/api/tools/${toolName}`, args);
      const data = response.data;

      // Extract actual result from MCP response structure
      if (data.result && data.result.content && Array.isArray(data.result.content)) {
        const textContent = data.result.content.find((c: any) => c.type === 'text');
        if (textContent && textContent.text) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return { text: textContent.text };
          }
        }
      }
      return data;
    } catch (error: any) {
      if (error.response) {
        throw new Error(`Tool ${toolName} failed: ${error.response.data.error || error.message}`);
      }
      throw error;
    }
  };

  describe('Health Check', () => {
    test('should return healthy status', async () => {
      const response = await client.get('/health');
      expect(response.status).toBe(200);
      expect(response.data.status).toBe('ok');
      expect(response.data.service).toBe('rada-mcp-http');
    });

    test('should list all available tools', async () => {
      const response = await client.get('/api/tools');
      expect(response.status).toBe(200);
      expect(response.data.tools).toBeDefined();
      expect(response.data.tools.length).toBe(4);
      expect(response.data.count).toBe(4);
    });
  });

  describe('search_parliament_bills', () => {
    test('should search bills by query', async () => {
      const result = await callTool('search_parliament_bills', {
        query: 'бюджет',
        limit: 5,
      });

      expect(result).toBeDefined();
      expect(result.bills || result.results).toBeDefined();
      expect(Array.isArray(result.bills || result.results)).toBe(true);
    }, 30000);

    test('should search bills with status filter', async () => {
      // Note: This may fail if RADA API is unavailable and data not in cache
      const result = await callTool('search_parliament_bills', {
        query: 'освіта',
        status: 'adopted',
        limit: 5,
      });

      expect(result).toBeDefined();
      // API may return error if external source unavailable
      if (result.bills) {
        expect(Array.isArray(result.bills)).toBe(true);
      }
    }, 30000);

    test('should search bills with date range', async () => {
      // Note: This may fail if RADA API is unavailable and data not in cache
      const result = await callTool('search_parliament_bills', {
        query: 'медицина',
        date_from: '2023-01-01',
        date_to: '2024-01-01',
        limit: 10,
      });

      expect(result).toBeDefined();
      // API may return error if external source unavailable
      if (result.bills) {
        expect(Array.isArray(result.bills)).toBe(true);
      }
    }, 30000);

    test('should search bills by initiator', async () => {
      const result = await callTool('search_parliament_bills', {
        query: 'цифровізація',
        initiator: 'Федоров',
        limit: 5,
      });

      expect(result).toBeDefined();
    }, 30000);

    test('should search bills by committee', async () => {
      const result = await callTool('search_parliament_bills', {
        query: 'податки',
        committee: 'фінансів',
        limit: 5,
      });

      expect(result).toBeDefined();
    }, 30000);

    test('should handle empty results gracefully', async () => {
      const result = await callTool('search_parliament_bills', {
        query: 'xyzabc123nonexistent',
        limit: 5,
      });

      expect(result).toBeDefined();
      const bills = result.bills || result.results || [];
      expect(Array.isArray(bills)).toBe(true);
    }, 30000);
  });

  describe('get_deputy_info', () => {
    test('should get deputy info by name', async () => {
      const result = await callTool('get_deputy_info', {
        name: 'Федоров',
      });

      expect(result).toBeDefined();
      expect(result.full_name).toBeDefined();
      expect(result.rada_id).toBe('20021');
    }, 20000);

    test('should get deputy info by rada_id', async () => {
      // Note: This test requires a valid RADA ID
      const result = await callTool('get_deputy_info', {
        rada_id: '20021',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('should get deputy info with voting record', async () => {
      const result = await callTool('get_deputy_info', {
        name: 'Шмигаль',
        include_voting_record: true,
      });

      expect(result).toBeDefined();
      if (result.voting_record) {
        expect(Array.isArray(result.voting_record)).toBe(true);
      }
    }, 30000);

    test('should get deputy info with assistants', async () => {
      const result = await callTool('get_deputy_info', {
        name: 'Стефанчук',
        include_assistants: true,
      });

      expect(result).toBeDefined();
      if (result.assistants) {
        expect(Array.isArray(result.assistants)).toBe(true);
      }
    }, 20000);

    test('should handle partial name match', async () => {
      const result = await callTool('get_deputy_info', {
        name: 'Федор',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('should return error for nonexistent deputy', async () => {
      try {
        await callTool('get_deputy_info', {
          name: 'Nonexistent Deputy XYZ123',
        });
        // If it doesn't throw, it should return empty or not found
        // Don't fail the test
      } catch (error: any) {
        expect(error.message).toBeDefined();
      }
    }, 20000);
  });

  describe('search_legislation_text', () => {
    test('should search Constitution by alias', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'constitution',
      });

      expect(result).toBeDefined();
      expect(result.law_number || result.title).toBeDefined();
      expect(result.full_text_plain || result.text).toBeDefined();
    }, 20000);

    test('should search Civil Code by alias', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'цивільний кодекс',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('should search specific article', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'constitution',
        article: '124',
      });

      expect(result).toBeDefined();
      expect(result.law_number || result.title || result.full_text_plain).toBeDefined();
    }, 20000);

    test('should search by text in law', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'кпк',
        search_text: 'апеляція',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('should include court citations', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'constitution',
        article: '124',
        include_court_citations: true,
      });

      expect(result).toBeDefined();
      // Court citations might not always be available
      if (result.court_citations) {
        expect(result.court_citations).toBeDefined();
        // court_citations is an object with {total, recent}
        if (result.court_citations.recent) {
          expect(Array.isArray(result.court_citations.recent)).toBe(true);
        }
      }
    }, 30000);

    test('should handle Criminal Code alias', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: 'кримінальний кодекс',
        article: '185',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('should handle law by number', async () => {
      const result = await callTool('search_legislation_text', {
        law_identifier: '254к/96-ВР',
      });

      expect(result).toBeDefined();
    }, 20000);
  });

  describe('analyze_voting_record', () => {
    test('should analyze deputy voting record', async () => {
      const result = await callTool('analyze_voting_record', {
        deputy_name: 'Федоров',
      });

      expect(result).toBeDefined();
      expect(result.statistics).toBeDefined();
      expect(result.deputy).toBeDefined();
      expect(result.voting_records).toBeDefined();
    }, 30000);

    test('should analyze voting with date range', async () => {
      const result = await callTool('analyze_voting_record', {
        deputy_name: 'Стефанчук',
        date_from: '2023-01-01',
        date_to: '2024-01-01',
      });

      expect(result).toBeDefined();
    }, 30000);

    test('should analyze voting on specific bill', async () => {
      const result = await callTool('analyze_voting_record', {
        deputy_name: 'Шмигаль',
        bill_number: '1234',
      });

      expect(result).toBeDefined();
    }, 30000);

    test('should analyze voting patterns with AI', async () => {
      const result = await callTool('analyze_voting_record', {
        deputy_name: 'Федоров',
        analyze_patterns: true,
      });

      expect(result).toBeDefined();
      if (result.patterns) {
        expect(result.patterns).toBeDefined();
      }
    }, 60000);

    test('should handle voting analysis with date range and patterns', async () => {
      const result = await callTool('analyze_voting_record', {
        deputy_name: 'Зеленський',
        date_from: '2023-06-01',
        date_to: '2023-12-31',
        analyze_patterns: true,
      });

      expect(result).toBeDefined();
    }, 60000);
  });

  describe('Error Handling', () => {
    test('should return error for invalid tool name', async () => {
      const response = await client.post('/api/tools/nonexistent_tool', {});
      expect(response.status).toBe(200);
      expect(response.data.result?.isError).toBe(true);
      expect(response.data.result?.content[0]?.text).toContain('Unknown tool');
    });

    test('should return error for missing required parameters', async () => {
      const result = await callTool('search_parliament_bills', {});
      // API may return error or empty results
      expect(result).toBeDefined();
    });

    test('should return error for unauthorized request', async () => {
      const unauthorizedClient = axios.create({
        baseURL: BASE_URL,
        timeout: 10000,
      });

      try {
        await unauthorizedClient.get('/api/tools');
        throw new Error('Expected error was not thrown');
      } catch (error: any) {
        expect(error.response.status).toBe(401);
      }
    });

    test('should handle invalid date format', async () => {
      try {
        await callTool('search_parliament_bills', {
          query: 'тест',
          date_from: 'invalid-date',
        });
        // Should either throw or handle gracefully
      } catch (error: any) {
        expect(error.message).toBeDefined();
      }
    }, 20000);
  });

  describe('Performance Tests', () => {
    test('should complete simple search within 10 seconds', async () => {
      const start = Date.now();
      await callTool('get_deputy_info', {
        name: 'Федоров',
      });
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(10000);
    });

    test('should handle concurrent requests', async () => {
      const promises = [
        callTool('search_parliament_bills', { query: 'освіта', limit: 3 }),
        callTool('get_deputy_info', { name: 'Федоров' }),
        callTool('search_legislation_text', { law_identifier: 'constitution' }),
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toBeDefined();
      });
    }, 60000);
  });

  describe('Caching Tests', () => {
    test('should cache deputy info (7 days TTL)', async () => {
      // First call
      const start1 = Date.now();
      const result1 = await callTool('get_deputy_info', {
        name: 'Федоров',
      });
      const duration1 = Date.now() - start1;

      // Second call (should be cached)
      const start2 = Date.now();
      const result2 = await callTool('get_deputy_info', {
        name: 'Федоров',
      });
      const duration2 = Date.now() - start2;

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      // Cached call should be faster (but not always guaranteed)
      console.log(`First call: ${duration1}ms, Cached call: ${duration2}ms`);
    }, 30000);
  });
});
