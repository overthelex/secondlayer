/**
 * OpenReyestr MCP API - MCP tools definition and routing
 * Provides Ukrainian State Register access via Model Context Protocol
 */

import { OpenReyestrTools } from './openreyestr-tools';
import { CostTracker } from '../services/cost-tracker';
import { logger } from '../utils/logger';

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export class MCPOpenReyestrAPI {
  constructor(
    private tools: OpenReyestrTools,
    private _costTracker?: CostTracker
  ) {
    logger.debug('MCPOpenReyestrAPI initialized', { costTracking: Boolean(this._costTracker) });
  }

  getTools() {
    return [
      {
        name: 'search_entities',
        description: `Пошук суб'єктів господарювання в Єдиному державному реєстрі України

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук юридичних осіб, ФОП та громадських організацій за назвою, ЄДРПОУ або іншими критеріями.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (назва або частина назви суб\'єкта)',
            },
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ (8 цифр)',
            },
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU', 'ALL'],
              default: 'ALL',
              description: 'Тип суб\'єкта: UO (юридичні особи), FOP (ФОП), FSU (громадські організації), ALL (всі типи)',
            },
            stan: {
              type: 'string',
              description: 'Статус діяльності (наприклад, "зареєстровано", "припинено")',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              minimum: 1,
              description: 'Максимальна кількість результатів (1-100)',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зміщення для пагінації',
            },
          },
        },
      },
      {
        name: 'get_entity_details',
        description: `Отримання повної інформації про суб'єкт господарювання

💰 Примерная стоимость: $0.001-$0.003 USD
Включає відомості про засновників, бенефіціарів, керівників, філії та іншу інформацію з реєстру.`,
        inputSchema: {
          type: 'object',
          properties: {
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU'],
              description: 'Тип суб\'єкта (необов\'язково, визначається автоматично)',
            },
          },
          required: ['record'],
        },
      },
      {
        name: 'search_beneficiaries',
        description: `Пошук кінцевих бенефіціарних власників (контролерів) компаній

💰 Примерная стоимость: $0.002-$0.005 USD
Пошук бенефіціарів за ім'ям у всіх суб'єктах господарювання.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Ім\'я або частина імені бенефіціара',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              minimum: 1,
              description: 'Максимальна кількість результатів (1-100)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_by_edrpou',
        description: `Швидкий пошук суб'єкта господарювання за кодом ЄДРПОУ

💰 Примерная стоимость: $0.001 USD
Отримання базової інформації про компанію за її ідентифікаційним кодом.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ (8 цифр)',
            },
          },
          required: ['edrpou'],
        },
      },
      {
        name: 'get_statistics',
        description: `Статистика по Єдиному державному реєстру

💰 Примерная стоимость: $0.001 USD
Загальна кількість зареєстрованих суб'єктів за типами та статусами.`,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    logger.info('OpenReyestr tool call', { name, args });

    try {
      let result: any;

      switch (name) {
        case 'search_entities':
          result = await this.tools.searchEntities(args);
          break;
        case 'get_entity_details':
          result = await this.tools.getEntityDetails(args.record, args.entityType);
          break;
        case 'search_beneficiaries':
          result = await this.tools.searchBeneficiaries(args.query, args.limit);
          break;
        case 'get_by_edrpou':
          result = await this.tools.getByEdrpou(args.edrpou);
          break;
        case 'get_statistics':
          result = await this.tools.getStatistics();
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Format response in MCP format
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('OpenReyestr tool call error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Stream support for future SSE implementation
  async handleToolCallWithStreaming(
    name: string,
    args: any,
    onEvent: StreamEventCallback
  ): Promise<void> {
    onEvent({ type: 'progress', data: { message: 'Processing...', progress: 0.3 } });

    const result = await this.handleToolCall(name, args);

    onEvent({ type: 'progress', data: { message: 'Finalizing...', progress: 0.9 } });
    onEvent({ type: 'complete', data: result, id: 'final' });
  }
}
