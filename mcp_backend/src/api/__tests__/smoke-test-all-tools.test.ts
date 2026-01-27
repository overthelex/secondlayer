/**
 * Smoke Tests for All MCP Tools
 * Quick validation that all tools respond without errors
 */

import axios, { AxiosInstance } from 'axios';

describe('SecondLayer MCP Tools - Smoke Tests', () => {
  let client: AxiosInstance;
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const API_KEY = process.env.TEST_API_KEY || 'test-key-123';

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
    expect(response.data.tools.length).toBeGreaterThan(30);
  });

  test('classify_intent works', async () => {
    const result = await callTool('classify_intent', {
      query: 'Тестовий запит'
    });
    expect(result.success).toBe(true);
  });

  test('search_legal_precedents works', async () => {
    const result = await callTool('search_legal_precedents', {
      query: 'позов', limit: 2
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('get_court_decision works', async () => {
    const result = await callTool('get_court_decision', {
      case_number: '756/655/23'
    });
    expect(result.success).toBe(true);
  }, 30000);

  test('search_legislation works', async () => {
    const result = await callTool('search_legislation', {
      query: 'апеляція', limit: 2
    });
    expect(result.success).toBe(true);
  });

  test('get_legislation_article works', async () => {
    const result = await callTool('get_legislation_article', {
      rada_id: '1618-15', article_number: '175'
    });
    expect(result.success).toBe(true);
  });

  test('search_procedural_norms works', async () => {
    const result = await callTool('search_procedural_norms', {
      query: 'строки апеляції'
    });
    expect(result.success).toBe(true);
  });

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
