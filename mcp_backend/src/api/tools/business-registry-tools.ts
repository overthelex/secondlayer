/**
 * Business Registry Tools - OpenReyestr integration
 *
 * 4 tools for searching Ukrainian business registry:
 * - search_business_entities
 * - get_business_entity_details
 * - search_entity_beneficiaries
 * - lookup_by_edrpou
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { callOpenReyestrTool, parseOpenReyestrResponse, translateEntityType, formatBusinessEntitiesResponse } from '../tool-utils.js';
import { logger } from '../../utils/logger.js';

export class BusinessRegistryTools extends BaseToolHandler {
  constructor() {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_business_entities',
        description: `Пошук суб'єктів господарювання в Єдиному державному реєстрі України

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
              description: 'Код ЄДРПОУ',
            },
            entity_type: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU', 'ALL'],
              description: 'Тип суб\'єкта: UO (юридичні особи), FOP (ФОП), FSU (громадські організації), ALL (всі типи)',
            },
            status: {
              type: 'string',
              description: 'Статус діяльності (наприклад, "зареєстровано", "припинено")',
            },
            limit: {
              type: 'number',
              description: 'Максимальна кількість результатів (1-100)',
            },
          },
        },
      },
      {
        name: 'get_business_entity_details',
        description: `Отримання повної інформації про суб'єкт господарювання

Включає відомості про засновників, бенефіціарів, керівників, філії та іншу інформацію з реєстру.`,
        inputSchema: {
          type: 'object',
          properties: {
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі',
            },
            entity_type: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU'],
              description: 'Тип суб\'єкта (необов\'язково, визначається автоматично)',
            },
          },
          required: ['record'],
        },
      },
      {
        name: 'search_entity_beneficiaries',
        description: `Пошук кінцевих бенефіціарних власників (контролерів) компаній

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
              description: 'Максимальна кількість результатів (1-100)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'lookup_by_edrpou',
        description: `Швидкий пошук суб'єкта господарювання за кодом ЄДРПОУ

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
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_business_entities':
        return await this.searchBusinessEntities(args);
      case 'get_business_entity_details':
        return await this.getBusinessEntityDetails(args);
      case 'search_entity_beneficiaries':
        return await this.searchEntityBeneficiaries(args);
      case 'lookup_by_edrpou':
        return await this.lookupByEdrpou(args);
      default:
        return null;
    }
  }

  private async searchBusinessEntities(args: any): Promise<ToolResult> {
    logger.info('search_business_entities: calling openreyestr', { query: args.query });

    const openReyestrArgs = {
      query: args.query,
      edrpou: args.edrpou,
      entityType: args.entity_type || 'ALL',
      stan: args.status,
      limit: args.limit || 50,
    };

    const response = await callOpenReyestrTool('search_entities', openReyestrArgs);
    const parsed = parseOpenReyestrResponse(response);

    return {
      content: [{
        type: 'text',
        text: parsed
          ? formatBusinessEntitiesResponse(parsed, args)
          : 'Помилка: не вдалося отримати дані з реєстру',
      }],
    };
  }

  private async getBusinessEntityDetails(args: any): Promise<ToolResult> {
    logger.info('get_business_entity_details: calling openreyestr', { record: args.record });

    const response = await callOpenReyestrTool('get_entity_details', {
      record: args.record,
      entityType: args.entity_type,
    });

    const parsed = parseOpenReyestrResponse(response);
    if (!parsed) {
      return {
        content: [{
          type: 'text',
          text: 'Помилка: суб\'єкт не знайдено або помилка отримання даних',
        }],
      };
    }

    let text = `# Детальна інформація про суб'єкт господарювання\n\n`;
    text += `**Номер запису:** ${parsed.record}\n`;
    text += `**Тип:** ${translateEntityType(parsed.entityType)}\n\n`;

    const main = parsed.mainInfo;
    if (main) {
      text += `## Основна інформація\n\n`;
      text += `- **Назва:** ${main.name || main.short_name}\n`;
      if (main.edrpou) text += `- **ЄДРПОУ:** ${main.edrpou}\n`;
      if (main.stan) text += `- **Статус:** ${main.stan}\n`;
      if (main.opf) text += `- **ОПФ:** ${main.opf}\n`;
      if (main.registration) text += `- **Дата реєстрації:** ${main.registration}\n`;
      text += `\n`;
    }

    if (parsed.founders && parsed.founders.length > 0) {
      text += `## Засновники (${parsed.founders.length})\n\n`;
      parsed.founders.slice(0, 5).forEach((f: any) => {
        text += `- ${f.founder_name || 'н/д'}\n`;
      });
      if (parsed.founders.length > 5) text += `... та ще ${parsed.founders.length - 5}\n`;
      text += `\n`;
    }

    if (parsed.beneficiaries && parsed.beneficiaries.length > 0) {
      text += `## Бенефіціари (${parsed.beneficiaries.length})\n\n`;
      parsed.beneficiaries.forEach((b: any) => {
        text += `- ${b.beneficiary_info || 'н/д'}\n`;
      });
      text += `\n`;
    }

    return { content: [{ type: 'text', text }] };
  }

  private async searchEntityBeneficiaries(args: any): Promise<ToolResult> {
    logger.info('search_entity_beneficiaries: calling openreyestr', { query: args.query });

    const response = await callOpenReyestrTool('search_beneficiaries', {
      query: args.query,
      limit: args.limit || 50,
    });

    const parsed = parseOpenReyestrResponse(response);
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Бенефіціарів не знайдено',
        }],
      };
    }

    let text = `# Пошук бенефіціарів: "${args.query}"\n\n`;
    text += `**Знайдено:** ${parsed.length}\n\n`;

    parsed.forEach((item: any, idx: number) => {
      text += `## ${idx + 1}. ${item.beneficiary_info || 'н/д'}\n\n`;
      if (item.entity_name) {
        text += `- **Суб'єкт:** ${item.entity_name}\n`;
      }
      if (item.entity_record) {
        text += `- **Номер запису:** ${item.entity_record}\n`;
      }
      text += `\n`;
    });

    return { content: [{ type: 'text', text }] };
  }

  private async lookupByEdrpou(args: any): Promise<ToolResult> {
    logger.info('lookup_by_edrpou: calling openreyestr', { edrpou: args.edrpou });

    const response = await callOpenReyestrTool('get_by_edrpou', {
      edrpou: args.edrpou,
    });

    const parsed = parseOpenReyestrResponse(response);
    if (!parsed) {
      return {
        content: [{
          type: 'text',
          text: `Суб'єкт з ЄДРПОУ ${args.edrpou} не знайдено`,
        }],
      };
    }

    let text = `# Інформація за ЄДРПОУ: ${args.edrpou}\n\n`;
    text += `- **Назва:** ${parsed.name || parsed.short_name}\n`;
    text += `- **Номер запису:** ${parsed.record}\n`;
    text += `- **Тип:** ${translateEntityType(parsed.entity_type)}\n`;
    text += `- **Статус:** ${parsed.stan || 'н/д'}\n`;
    if (parsed.opf) text += `- **ОПФ:** ${parsed.opf}\n`;

    return { content: [{ type: 'text', text }] };
  }
}
