import { MCPQueryAPI } from '../mcp-query-api.js';
import { SectionType } from '../../types/index.js';

jest.mock('../../utils/openai-client.js', () => {
  return {
    getOpenAIManager: () => {
      return {
        executeWithRetry: async (fn: any) => {
          const fakeClient = {
            chat: {
              completions: {
                create: async () => {
                  const packaged = {
                    short_conclusion: {
                      conclusion: 'mock conclusion',
                      conditions: 'mock conditions',
                      risk_or_exception: 'mock risk',
                    },
                    legal_framework: {
                      norms: [
                        {
                          act: 'ЦПК України',
                          article_ref: 'mock',
                          quote: 'mock quote',
                          comment: 'mock comment',
                        },
                      ],
                    },
                    supreme_court_positions: [
                      {
                        thesis: 'mock thesis',
                        quotes: [
                          {
                            quote: 'mock quote',
                            source_doc_id: '101',
                            section_type: 'COURT_REASONING',
                          },
                        ],
                        context: 'mock context',
                      },
                    ],
                    practice: [
                      {
                        source_doc_id: '101',
                        section_type: 'COURT_REASONING',
                        quote: 'mock practice quote',
                        relevance_reason: 'mock reason',
                        case_number: 'mock/1/23',
                        court: 'mock court',
                        date: '2024-01-01',
                      },
                    ],
                    criteria_test: ['mock criterion'],
                    counterarguments_and_risks: ['mock risk'],
                    checklist: {
                      steps: ['mock step'],
                      evidence: ['mock evidence'],
                    },
                    sources: [
                      {
                        document_id: '101',
                        section_type: 'COURT_REASONING',
                        quote: 'mock quote',
                      },
                    ],
                  };

                  return {
                    choices: [{ message: { content: JSON.stringify(packaged) } }],
                  };
                },
              },
            },
          };

          return await fn(fakeClient);
        },
      };
    },
  };
});

jest.mock('../../utils/model-selector.js', () => {
  return {
    ModelSelector: {
      getChatModel: () => 'mock-model',
      supportsJsonMode: () => false,
    },
  };
});

describe('get_legal_advice: CPC examples (first two questions)', () => {
  test.each([
    [
      'Яка позиція Верховного Суду щодо поновлення строку на апеляційне оскарження у разі несвоєчасного отримання повного тексту рішення?',
    ],
    ['Які критерії ВС застосовує для оцінки поважності причин пропуску процесуальних строків (ЦПК)?'],
  ])('should return structured response for: %s', async (query: string) => {
    const queryPlanner: any = {
      classifyIntent: jest.fn(async () => {
        return {
          intent: 'procedural_deadlines',
          confidence: 0.9,
          domains: ['court'],
          required_entities: [],
          sections: [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES],
          reasoning_budget: 'quick',
          slots: {
            procedure_code: 'ЦПК',
            court_level: 'SC',
          },
        };
      }),
      buildQueryParams: jest.fn(() => ({ meta: { search: 'mock search' } })),
    };

    const zoAdapter: any = {
      searchCourtDecisions: jest.fn(async () => ({ data: [] })),
      normalizeResponse: jest.fn(async () => {
        return {
          data: [
            {
              doc_id: 101,
              full_text: 'A'.repeat(300),
              url: 'https://zakononline.ua/court-decisions/show/101',
              cause_num: 'mock/1/23',
              court: 'mock court',
              adjudication_date: '2024-01-01',
            },
            {
              doc_id: 102,
              full_text: 'B'.repeat(300),
              url: 'https://zakononline.ua/court-decisions/show/102',
              cause_num: 'mock/2/23',
              court: 'mock court',
              adjudication_date: '2024-02-01',
            },
          ],
        };
      }),
      getDocumentFullText: jest.fn(async () => ({ text: 'C'.repeat(300), html: '<p>mock</p>' })),
      saveDocumentsMetadataToDatabase: jest.fn(async () => undefined),
    };

    const sectionizer: any = {
      extractSections: jest.fn(async () => {
        return [
          { type: SectionType.COURT_REASONING, text: 'mock reasoning' },
          { type: SectionType.DECISION, text: 'mock decision' },
          { type: SectionType.LAW_REFERENCES, text: 'mock law refs' },
        ];
      }),
    };

    const embeddingService: any = {
      generateEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
    };

    const patternStore: any = {
      matchPatterns: jest.fn(async () => []),
    };

    const citationValidator: any = {};
    const hallucinationGuard: any = {};

    const mcpAPI = new MCPQueryAPI(
      queryPlanner,
      zoAdapter,
      zoAdapter,
      sectionizer,
      embeddingService,
      patternStore,
      citationValidator,
      hallucinationGuard
    );

    const result = await mcpAPI.handleToolCall('get_legal_advice', {
      query,
      reasoning_budget: 'quick',
    });

    expect(result).toBeDefined();
    expect(result.content?.[0]?.text).toBeDefined();

    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty('intent');
    expect(parsed).toHaveProperty('precedent_chunks');
    expect(parsed).toHaveProperty('packaged_answer');

    expect(parsed.packaged_answer).toHaveProperty('short_conclusion');
    expect(parsed.packaged_answer).toHaveProperty('legal_framework');
    expect(parsed.packaged_answer).toHaveProperty('supreme_court_positions');
    expect(parsed.packaged_answer).toHaveProperty('checklist');
    expect(Array.isArray(parsed.packaged_answer.sources)).toBe(true);

    expect(zoAdapter.saveDocumentsMetadataToDatabase).toHaveBeenCalled();
  });
});
