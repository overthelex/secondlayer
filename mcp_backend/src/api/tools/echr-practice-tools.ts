/**
 * ECHR Practice Tools - Search European Court of Human Rights practice from ZakonOnline
 *
 * 2 tools:
 * - search_echr_practice
 * - get_echr_document
 */

import { ZOAdapter } from '../../adapters/zo-adapter.js';
import { logger } from '../../utils/logger.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';

export class ECHRPracticeTools extends BaseToolHandler {
  constructor(private zoECHRAdapter: ZOAdapter) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_echr_practice',
        description: `Пошук практики ЄСПЛ (Європейського суду з прав людини)

Шукає правові позиції ЄСПЛ та КСУ в базі ZakonOnline.
Типи документів: 1=Правова позиція, 2=Правова позиція ЄСПЛ, 3=Правова позиція КСУ.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит',
            },
            type_id: {
              type: 'number',
              enum: [1, 2, 3],
              description: 'Фільтр за типом: 1=Правова позиція, 2=Правова позиція ЄСПЛ, 3=Правова позиція КСУ',
            },
            limit: {
              type: 'number',
              default: 20,
              maximum: 100,
              description: 'Максимальна кількість результатів',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_echr_document',
        description: `Отримати повний текст документа ЄСПЛ за його ID

Завантажує повний текст правової позиції або рішення ЄСПЛ.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID документа ЄСПЛ',
            },
          },
          required: ['id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_echr_practice':
        return this.searchECHRPractice(args);
      case 'get_echr_document':
        return this.getECHRDocument(args);
      default:
        return null;
    }
  }

  private async searchECHRPractice(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));

    const searchParams: any = {
      meta: { search: query },
      limit,
    };

    // Filter by type_id if provided
    if (args.type_id) {
      searchParams.where = [
        { field: 'type_id', operator: '$eq', value: args.type_id },
      ];
    }

    const rawResponse = await this.zoECHRAdapter.searchCourtDecisions(searchParams);

    const responseData = Array.isArray(rawResponse)
      ? rawResponse
      : (rawResponse?.data && Array.isArray(rawResponse.data) ? rawResponse.data : []);

    if (responseData.length === 0) {
      return this.wrapResponse({
        query,
        documents_found: 0,
        message: 'Документів практики ЄСПЛ не знайдено за вашим запитом',
      });
    }

    return this.wrapResponse({
      query,
      documents_found: responseData.length,
      documents: responseData.slice(0, limit),
    });
  }

  private async getECHRDocument(args: any): Promise<ToolResult> {
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id parameter is required');

    const doc = await this.zoECHRAdapter.getDocumentById(id);

    if (!doc) {
      return this.wrapError(`Документ ЄСПЛ з ID ${id} не знайдено`);
    }

    return this.wrapResponse({
      id,
      document: doc,
    });
  }
}
