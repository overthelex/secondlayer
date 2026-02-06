/**
 * Integration test for get_case_documents_chain tool
 * Tests the new tool that gets all related documents for a case
 */

import axios, { AxiosInstance } from 'axios';

describe('get_case_documents_chain - Integration Test', () => {
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
      timeout: 60000,
    });
  });

  // Helper function to call tools
  const callTool = async (toolName: string, args: any) => {
    try {
      const response = await client.post(`/api/tools/${toolName}`, args);
      const data = response.data;

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

  it('should get all related documents for a case number', async () => {
    const result = await callTool('get_case_documents_chain', {
      case_number: '756/655/23',
      include_full_text: false,
      max_docs: 20,
      group_by_instance: true,
    });

    expect(result).toBeDefined();

    // Check structure
    expect(result).toHaveProperty('case_number');
    expect(result).toHaveProperty('total_documents');
    expect(result).toHaveProperty('grouped_documents');
    expect(result).toHaveProperty('summary');

    // Check summary structure
    expect(result.summary).toHaveProperty('instances');
    expect(result.summary).toHaveProperty('document_types');

    console.log('Total documents found:', result.total_documents);
    console.log('Summary:', JSON.stringify(result.summary, null, 2));

    if (result.grouped_documents) {
      console.log('Grouped documents:', Object.keys(result.grouped_documents));
    }
  }, 30000);

  it('should return empty result for non-existent case', async () => {
    const result = await callTool('get_case_documents_chain', {
      case_number: '999999/999999/99',
      include_full_text: false,
    });

    expect(result).toBeDefined();
    expect(result.total_documents).toBe(0);
  }, 15000);

  it('should include full text when requested', async () => {
    const result = await callTool('get_case_documents_chain', {
      case_number: '756/655/23',
      include_full_text: true,
      max_docs: 5,
    });

    expect(result).toBeDefined();

    if (result.total_documents > 0) {
      const docs = result.documents || Object.values(result.grouped_documents || {}).flat();
      const hasFullText = docs.some((doc: any) => doc.full_text && doc.full_text.length > 0);

      console.log('Documents with full text:', docs.filter((d: any) => d.full_text).length);
    }
  }, 45000);

  it('should require case_number parameter', async () => {
    await expect(
      callTool('get_case_documents_chain', {})
    ).rejects.toThrow();
  });

  it('should classify document types correctly', async () => {
    const result = await callTool('get_case_documents_chain', {
      case_number: '756/655/23',
      max_docs: 20,
    });

    if (result.total_documents > 0) {
      expect(result.summary.document_types).toBeDefined();
      expect(result.summary.document_types).toHaveProperty('decisions');
      expect(result.summary.document_types).toHaveProperty('rulings');
      expect(result.summary.document_types).toHaveProperty('orders');

      console.log('Document types breakdown:', result.summary.document_types);
    }
  }, 30000);

  it('should classify instances correctly', async () => {
    const result = await callTool('get_case_documents_chain', {
      case_number: '756/655/23',
      max_docs: 20,
    });

    if (result.total_documents > 0) {
      expect(result.summary.instances).toBeDefined();
      expect(result.summary.instances).toHaveProperty('first_instance');
      expect(result.summary.instances).toHaveProperty('appeal');
      expect(result.summary.instances).toHaveProperty('cassation');
      expect(result.summary.instances).toHaveProperty('grand_chamber');

      console.log('Instance breakdown:', result.summary.instances);
    }
  }, 30000);
});
