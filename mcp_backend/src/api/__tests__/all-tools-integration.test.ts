/**
 * Comprehensive Integration Tests for All MCP Tools
 * Tests all 34 tools via HTTP API
 */

import axios, { AxiosInstance } from 'axios';

describe('SecondLayer MCP Tools - Integration Tests', () => {
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
      timeout: 60000, // 60 seconds for complex operations
    });
  });

  // Helper function to call tools
  const callTool = async (toolName: string, args: any) => {
    try {
      const response = await client.post(`/api/tools/${toolName}`, args);
      const data = response.data;

      // Extract actual result from MCP response structure
      if (data.result && data.result.content && Array.isArray(data.result.content)) {
        const textContent = data.result.content.find((c: any) => c.type === 'text');
        if (textContent && textContent.text) {
          try {
            // Try to parse JSON from text content
            return JSON.parse(textContent.text);
          } catch {
            // If not JSON, return the text as is
            return { text: textContent.text };
          }
        }
      }

      // Return full response if structure is unexpected
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
      expect(response.data.service).toBe('secondlayer-mcp-http');
    });

    test('should list all available tools', async () => {
      const response = await client.get('/api/tools');
      expect(response.status).toBe(200);
      expect(response.data.tools).toBeDefined();
      expect(response.data.tools.length).toBeGreaterThan(30);
      expect(response.data.count).toBe(response.data.tools.length);
    });
  });

  describe('Pipeline Core Tools', () => {
    test('classify_intent - should classify legal query', async () => {
      const result = await callTool('classify_intent', {
        query: 'Хочу оскаржити рішення суду першої інстанції',
      });

      expect(result).toBeDefined();
      expect(result.service || result.service_type).toBeDefined();
      expect(result.depth || result.reasoning_depth).toBeDefined();
    });

    test('retrieve_legal_sources - should retrieve raw sources', async () => {
      const result = await callTool('retrieve_legal_sources', {
        query: 'договір позики',
        limit: 5,
      });

      expect(result).toBeDefined();
      expect(result.sources).toBeDefined();
      expect(Array.isArray(result.sources)).toBe(true);
    });

    test('analyze_legal_patterns - should extract patterns', async () => {
      const result = await callTool('analyze_legal_patterns', {
        query: 'стягнення боргу за договором позики',
        context: { domain: 'civil' },
      });

      expect(result).toBeDefined();
    });

    test('validate_response - should validate against sources', async () => {
      const result = await callTool('validate_response', {
        response: 'Згідно статті 1046 ЦК України позика повинна бути повернена',
        sources: [{ type: 'legislation', reference: 'ЦК України ст. 1046' }],
      });

      expect(result).toBeDefined();
      expect(result.is_valid).toBeDefined();
    });
  });

  describe('Search and Precedent Tools', () => {
    test('search_legal_precedents - should find precedents', async () => {
      const result = await callTool('search_legal_precedents', {
        query: 'стягнення боргу',
        limit: 5,
      });

      expect(result).toBeDefined();
      expect(result.results || result.cases).toBeDefined();
    }, 30000);

    test('analyze_case_pattern - should analyze patterns', async () => {
      const result = await callTool('analyze_case_pattern', {
        query: 'розірвання договору оренди',
        limit: 10,
      });

      expect(result).toBeDefined();
    }, 30000);

    test('get_similar_reasoning - should find similar reasoning', async () => {
      const result = await callTool('get_similar_reasoning', {
        query: 'Позивач не довів факт порушення своїх прав',
        limit: 5,
      });

      expect(result).toBeDefined();
    }, 30000);

    test('search_supreme_court_practice - should find Supreme Court cases', async () => {
      const result = await callTool('search_supreme_court_practice', {
        procedure_code: 'cpc',
        query: 'тлумачення норм цивільного права',
        limit: 5,
      });

      expect(result).toBeDefined();
    });

    test('compare_practice_pro_contra - should find pro/contra practice', async () => {
      const result = await callTool('compare_practice_pro_contra', {
        procedure_code: 'cpc',
        query: 'Можливість стягнення інфляційних втрат',
      });

      expect(result).toBeDefined();
    });

    test('find_similar_fact_pattern_cases - should find similar fact patterns', async () => {
      const result = await callTool('find_similar_fact_pattern_cases', {
        procedure_code: 'cpc',
        facts_text: 'ДТП з участю двох автомобілів, один водій був у стані алкогольного сп\'яніння',
        limit: 5,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Document Management Tools', () => {
    test('get_court_decision - should get decision text', async () => {
      const result = await callTool('get_court_decision', {
        case_number: '756/655/23',
      });

      expect(result).toBeDefined();
      expect(result.text || result.sections).toBeDefined();
    }, 20000);

    test('get_case_text - should get case text (alias)', async () => {
      const result = await callTool('get_case_text', {
        case_number: '756/655/23',
      });

      expect(result).toBeDefined();
    }, 20000);

    test('extract_document_sections - should extract sections', async () => {
      const result = await callTool('extract_document_sections', {
        case_number: '756/655/23',
        use_llm: false,
      });

      expect(result).toBeDefined();
      expect(result.sections).toBeDefined();
    }, 20000);

    test('load_full_texts - should load full texts', async () => {
      const result = await callTool('load_full_texts', {
        case_numbers: ['756/655/23'],
      });

      expect(result).toBeDefined();
      expect(result.loaded || result.results).toBeDefined();
    }, 30000);
  });

  describe('Analytics Tools', () => {
    test('count_cases_by_party - should count party cases', async () => {
      const result = await callTool('count_cases_by_party', {
        party_name: 'ПриватБанк',
        role: 'plaintiff',
      });

      expect(result).toBeDefined();
      expect(result.count).toBeDefined();
    }, 30000);

    test('get_citation_graph - should build citation graph', async () => {
      const result = await callTool('get_citation_graph', {
        case_number: '756/655/23',
        depth: 1,
      });

      expect(result).toBeDefined();
    });

    test('check_precedent_status - should check precedent status', async () => {
      const result = await callTool('check_precedent_status', {
        case_number: '756/655/23',
      });

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });
  });

  describe('Legislation Tools (RADA Integration)', () => {
    test('get_legislation_article - should get article text', async () => {
      const result = await callTool('get_legislation_article', {
        code: 'ЦПК',
        article: '175',
      });

      expect(result).toBeDefined();
      expect(result.text || result.content).toBeDefined();
    });

    test('get_legislation_section - should get section by reference', async () => {
      const result = await callTool('get_legislation_section', {
        reference: 'ст. 625 ЦК',
      });

      expect(result).toBeDefined();
    });

    test('get_legislation_articles - should get multiple articles', async () => {
      const result = await callTool('get_legislation_articles', {
        code: 'ЦПК',
        articles: ['175', '176', '177'],
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.articles || result.results)).toBe(true);
    });

    test('search_legislation - should search legislation semantically', async () => {
      const result = await callTool('search_legislation', {
        query: 'апеляційне оскарження',
        limit: 5,
      });

      expect(result).toBeDefined();
    });

    test('get_legislation_structure - should get law structure', async () => {
      const result = await callTool('get_legislation_structure', {
        code: 'ЦПК',
      });

      expect(result).toBeDefined();
      expect(result.structure || result.chapters).toBeDefined();
    });

    test('find_relevant_law_articles - should find relevant articles', async () => {
      const result = await callTool('find_relevant_law_articles', {
        topic: 'позовна давність',
      });

      expect(result).toBeDefined();
    });

    test('search_procedural_norms - should search procedural norms', async () => {
      const result = await callTool('search_procedural_norms', {
        query: 'строки подачі апеляції',
      });

      expect(result).toBeDefined();
    });
  });

  describe('Procedural Tools', () => {
    test('calculate_procedural_deadlines - should calculate deadlines', async () => {
      const result = await callTool('calculate_procedural_deadlines', {
        procedure_code: 'cpc',
        event_type: 'judgment_delivered',
        event_date: '2024-01-15',
      });

      expect(result).toBeDefined();
      expect(result.deadline || result.deadlines).toBeDefined();
    });

    test('build_procedural_checklist - should build checklist', async () => {
      const result = await callTool('build_procedural_checklist', {
        procedure_code: 'cpc',
        stage: 'позов',
      });

      expect(result).toBeDefined();
      expect(result.checklist || result.items).toBeDefined();
    });

    test('calculate_monetary_claims - should calculate claims', async () => {
      const result = await callTool('calculate_monetary_claims', {
        principal: 100000,
        start_date: '2023-01-01',
        end_date: '2024-01-01',
      });

      expect(result).toBeDefined();
      expect(result.total || result.interest).toBeDefined();
    });
  });

  describe('Document Processing Tools', () => {
    test('parse_document - should parse document metadata', async () => {
      // Note: This test might need actual file upload
      const result = await callTool('parse_document', {
        document_url: 'https://example.com/test.pdf',
        extract_text: false,
      });

      expect(result).toBeDefined();
    }, 60000);

    test('extract_key_clauses - should extract contract clauses', async () => {
      const result = await callTool('extract_key_clauses', {
        document_text: 'Договір позики від 01.01.2024. Позичальник зобов\'язується повернути суму 100000 грн до 31.12.2024.',
      });

      expect(result).toBeDefined();
      expect(result.clauses).toBeDefined();
    });

    test('summarize_document - should create document summary', async () => {
      const result = await callTool('summarize_document', {
        document_text: 'Договір позики. Сторони: Позикодавець ТОВ "Компанія" та Позичальник Іванов І.І. Сума позики 100000 грн. Термін повернення: 31.12.2024.',
        summary_type: 'executive',
      });

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    test('compare_documents - should compare document versions', async () => {
      const result = await callTool('compare_documents', {
        document1: 'Договір від 01.01.2024. Сума: 100000 грн.',
        document2: 'Договір від 01.01.2024. Сума: 150000 грн.',
      });

      expect(result).toBeDefined();
      expect(result.changes || result.differences).toBeDefined();
    });
  });

  describe('Advanced Tools', () => {
    test('get_legal_advice - quick mode', async () => {
      const result = await callTool('get_legal_advice', {
        situation: 'Сусід затопив мою квартиру, потрібна юридична порада',
        reasoning_budget: 'quick',
      });

      expect(result).toBeDefined();
      expect(result.analysis || result.advice).toBeDefined();
    }, 60000);

    test('format_answer_pack - should format structured answer', async () => {
      const result = await callTool('format_answer_pack', {
        norm: 'ст. 1166 ЦК України',
        position: 'Власник зобов\'язаний відшкодувати шкоду',
        conclusion: 'Позов підлягає задоволенню',
        risks: ['Необхідність доказування розміру шкоди'],
      });

      expect(result).toBeDefined();
      expect(result.formatted).toBeDefined();
    });

    test('bulk_ingest_court_decisions - should ingest decisions', async () => {
      const result = await callTool('bulk_ingest_court_decisions', {
        query: 'затоплення квартири',
        limit: 5,
        date_from: '2023-01-01',
      });

      expect(result).toBeDefined();
      expect(result.ingested || result.count).toBeDefined();
    }, 120000);
  });

  describe('Error Handling', () => {
    test('should return error for invalid tool name', async () => {
      try {
        await client.post('/api/tools/nonexistent_tool', {});
        throw new Error('Expected error was not thrown');
      } catch (error: any) {
        expect(error.response.status).toBe(404);
      }
    });

    test('should return error for missing required parameters', async () => {
      try {
        await callTool('search_legal_precedents', {});
        throw new Error('Expected error was not thrown');
      } catch (error: any) {
        expect(error.message).toContain('required');
      }
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
  });
});
