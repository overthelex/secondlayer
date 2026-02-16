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
      {
        name: 'search_notaries',
        description: `Пошук нотаріусів у Єдиному реєстрі нотаріусів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук нотаріусів за ім'ям, регіоном або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені нотаріуса" },
            region: { type: 'string', description: 'Регіон (наприклад, "Київська")' },
            status: { type: 'string', description: 'Статус діяльності' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_court_experts',
        description: `Пошук атестованих судових експертів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук судових експертів за ім'ям, регіоном або типом експертизи.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені експерта" },
            region: { type: 'string', description: 'Регіон' },
            expertise_type: { type: 'string', description: 'Тип експертизи' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_arbitration_managers',
        description: `Пошук арбітражних керуючих (банкрутство)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук арбітражних керуючих за ім'ям або статусом свідоцтва.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені арбітражного керуючого" },
            status: { type: 'string', description: 'Статус свідоцтва' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_debtors',
        description: `Пошук боржників у Єдиному реєстрі боржників

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук боржників за ім'ям/назвою, ЄДРПОУ або категорією стягнення.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника або частина назви" },
            edrpou: { type: 'string', description: 'Код ЄДРПОУ боржника' },
            collection_category: { type: 'string', description: 'Категорія стягнення' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_enforcement_proceedings',
        description: `Пошук виконавчих проваджень

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук виконавчих проваджень за боржником, стягувачем або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника" },
            debtor_edrpou: { type: 'string', description: 'ЄДРПОУ боржника' },
            creditor_name: { type: 'string', description: "Ім'я/назва стягувача" },
            proceeding_status: { type: 'string', description: 'Статус провадження' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_bankruptcy_cases',
        description: `Пошук справ про банкрутство

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук справ про банкрутство за боржником, ЄДРПОУ або номером справи.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника" },
            debtor_edrpou: { type: 'string', description: 'ЄДРПОУ боржника' },
            case_number: { type: 'string', description: 'Номер справи' },
            proceeding_status: { type: 'string', description: 'Статус провадження' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_special_forms',
        description: `Пошук спеціальних бланків нотаріальних документів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук спеціальних бланків за серією, номером або отримувачем.`,
        inputSchema: {
          type: 'object',
          properties: {
            series: { type: 'string', description: 'Серія бланка' },
            form_number: { type: 'string', description: 'Номер бланка' },
            recipient: { type: 'string', description: "Ім'я отримувача" },
            status: { type: 'string', description: 'Статус бланка' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_forensic_methods',
        description: `Пошук методик судових експертиз

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук зареєстрованих методик судових експертиз за назвою або типом експертизи.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва методики або ключове слово' },
            expertise_type: { type: 'string', description: 'Тип експертизи' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_legal_acts',
        description: `Пошук нормативно-правових актів у реєстрі НАІС

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук НПА за назвою, типом акту, видавником або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва або ключове слово в назві акту' },
            act_type: { type: 'string', description: 'Тип акту (закон, указ, постанова тощо)' },
            publisher: { type: 'string', description: 'Видавник акту' },
            status: { type: 'string', description: 'Статус акту (чинний, нечинний)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_administrative_units',
        description: `Пошук адміністративно-територіальних одиниць (КОАТУУ)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук населених пунктів, районів та областей за назвою або регіоном.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва населеного пункту або адмінодиниці' },
            region: { type: 'string', description: 'Область' },
            unit_type: { type: 'string', description: 'Тип одиниці (місто, село, селище, район тощо)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_streets',
        description: `Пошук вулиць у реєстрі НАІС

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук вулиць за назвою, населеним пунктом або регіоном.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва вулиці або частина назви' },
            settlement: { type: 'string', description: 'Населений пункт' },
            region: { type: 'string', description: 'Область' },
            street_type: { type: 'string', description: 'Тип (вулиця, проспект, бульвар тощо)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
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
        case 'search_notaries':
          result = await this.tools.searchNotaries(args);
          break;
        case 'search_court_experts':
          result = await this.tools.searchCourtExperts(args);
          break;
        case 'search_arbitration_managers':
          result = await this.tools.searchArbitrationManagers(args);
          break;
        case 'search_debtors':
          result = await this.tools.searchDebtors(args);
          break;
        case 'search_enforcement_proceedings':
          result = await this.tools.searchEnforcementProceedings(args);
          break;
        case 'search_bankruptcy_cases':
          result = await this.tools.searchBankruptcyCases(args);
          break;
        case 'search_special_forms':
          result = await this.tools.searchSpecialForms(args);
          break;
        case 'search_forensic_methods':
          result = await this.tools.searchForensicMethods(args);
          break;
        case 'search_legal_acts':
          result = await this.tools.searchLegalActs(args);
          break;
        case 'search_administrative_units':
          result = await this.tools.searchAdministrativeUnits(args);
          break;
        case 'search_streets':
          result = await this.tools.searchStreets(args);
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
