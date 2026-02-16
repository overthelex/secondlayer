/**
 * Legal Acts Tools - Search НПА (normative legal acts) from ZakonOnline
 *
 * 2 tools:
 * - search_legal_acts
 * - get_legal_act_meta
 */

import { ZOAdapter } from '../../adapters/zo-adapter.js';
import { logger } from '../../utils/logger.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';

export class LegalActsTools extends BaseToolHandler {
  constructor(private zoLegalActsAdapter: ZOAdapter) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_legal_acts',
        description: `Пошук нормативно-правових актів (НПА): законів, кодексів, указів, постанов, наказів тощо

Шукає в базі НПА ZakonOnline. Можна шукати за назвою або текстом документа.
Повертає список знайдених актів з метаданими.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (назва або текст НПА)',
            },
            target: {
              type: 'string',
              enum: ['title', 'text'],
              default: 'title',
              description: 'Тип пошуку: title (за назвою) або text (за текстом)',
            },
            date_before: {
              type: 'string',
              description: 'Версія НПА до дати (YYYY-MM-DD) — фільтр по version_date',
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
        name: 'get_legal_act_meta',
        description: `Отримати метадані/кількість НПА за запитом без завантаження результатів

Швидкий запит для перевірки кількості результатів та фасетів.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит',
            },
            target: {
              type: 'string',
              enum: ['title', 'text'],
              default: 'title',
              description: 'Тип пошуку',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_legal_acts':
        return this.searchLegalActs(args);
      case 'get_legal_act_meta':
        return this.getLegalActMeta(args);
      default:
        return null;
    }
  }

  private async searchLegalActs(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const target = args.target || 'title';
    const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));

    const searchParams: any = {
      meta: { search: query },
      target,
      limit,
    };

    // Add date filter (version_date <= date_before)
    if (args.date_before) {
      searchParams.where = [
        { field: 'version_date', operator: '<=', value: args.date_before },
      ];
    }

    const rawResponse = await this.zoLegalActsAdapter.searchCourtDecisions(searchParams);

    const responseData = Array.isArray(rawResponse)
      ? rawResponse
      : (rawResponse?.data && Array.isArray(rawResponse.data) ? rawResponse.data : []);

    if (responseData.length === 0) {
      return this.wrapResponse({
        query,
        target,
        acts_found: 0,
        message: 'Нормативно-правових актів не знайдено за вашим запитом',
      });
    }

    return this.wrapResponse({
      query,
      target,
      acts_found: responseData.length,
      acts: responseData.slice(0, limit),
    });
  }

  private async getLegalActMeta(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const target = args.target || 'title';

    const metaResponse = await this.zoLegalActsAdapter.getSearchMetadata({
      meta: { search: query },
      target,
    });

    return this.wrapResponse({
      query,
      target,
      metadata: metaResponse,
    });
  }
}
