/**
 * Smoke Tests for RADA MCP Tools
 * Quick validation that all 4 tools respond without errors
 */

import axios, { AxiosInstance } from 'axios';

describe('RADA MCP Tools - Smoke Tests', () => {
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
      timeout: 30000,
    });
  });

  const callTool = async (toolName: string, args: any) => {
    const response = await client.post(`/api/tools/${toolName}`, args);
    return response.data;
  };

  test('Health check', async () => {
    const response = await client.get('/health');
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('ok');
  });

  test('List all tools', async () => {
    const response = await client.get('/api/tools');
    expect(response.data.tools.length).toBe(4);
  });

  test('search_parliament_bills works', async () => {
    const result = await callTool('search_parliament_bills', {
      query: 'бюджет', limit: 3
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('get_deputy_info works', async () => {
    const result = await callTool('get_deputy_info', {
      name: 'Федоров'
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('search_legislation_text works', async () => {
    const result = await callTool('search_legislation_text', {
      law_identifier: 'constitution'
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('analyze_voting_record works', async () => {
    const result = await callTool('analyze_voting_record', {
      deputy_name: 'Федоров'
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('Error on invalid tool', async () => {
    const response = await client.post('/api/tools/nonexistent', {});
    expect(response.status).toBe(200);
    expect(response.data.result?.isError).toBe(true);
    expect(response.data.result?.content[0]?.text).toContain('Unknown tool');
  });

  test('Error on unauthorized', async () => {
    const unauthed = axios.create({ baseURL: BASE_URL });
    try {
      await unauthed.get('/api/tools');
      throw new Error('Should have failed');
    } catch (error: any) {
      expect(error.response?.status).toBe(401);
    }
  });
});
