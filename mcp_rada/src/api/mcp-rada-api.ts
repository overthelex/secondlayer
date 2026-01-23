/**
 * RADA MCP API - MCP tools definition and routing
 * Provides parliament data analysis tools via Model Context Protocol
 */

import { DeputyService } from '../services/deputy-service';
import { BillService } from '../services/bill-service';
import { LegislationService } from '../services/legislation-service';
import { VotingService } from '../services/voting-service';
import { CrossReferenceService } from '../services/cross-reference-service';
import { CostTracker } from '../services/cost-tracker';
import {
  SearchParliamentBillsArgs,
  GetDeputyInfoArgs,
  SearchLegislationTextArgs,
  AnalyzeVotingRecordArgs,
} from '../types/rada';
import { logger } from '../utils/logger';

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export class MCPRadaAPI {
  constructor(
    private deputyService: DeputyService,
    private billService: BillService,
    private legislationService: LegislationService,
    private votingService: VotingService,
    private crossRefService: CrossReferenceService,
    private _costTracker: CostTracker
  ) {
    logger.debug('MCPRadaAPI initialized', { costTracking: Boolean(this._costTracker) });
  }

  getTools() {
    return [
      {
        name: 'search_parliament_bills',
        description: `Пошук законопроєктів Верховної Ради з семантичним аналізом

💰 Примерная стоимость: $0.01-$0.05 USD
Поиск и фильтрация законопроектов. Включает RADA API (бесплатно) и опциональный AI анализ.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (назва, тема законопроєкту)'
            },
            status: {
              type: 'string',
              enum: ['registered', 'first_reading', 'second_reading', 'adopted', 'rejected', 'all'],
              default: 'all',
              description: 'Статус законопроєкту',
            },
            initiator: {
              type: 'string',
              description: 'Ініціатор законопроєкту (ім\'я депутата або фракція)',
            },
            committee: {
              type: 'string',
              description: 'Комітет, який розглядає законопроєкт',
            },
            date_from: {
              type: 'string',
              description: 'Дата початку періоду реєстрації (формат: YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              description: 'Дата кінця періоду реєстрації (формат: YYYY-MM-DD)',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Максимальна кількість результатів',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_deputy_info',
        description: `Отримання детальної інформації про народного депутата

💰 Примерная стоимость: $0.005-$0.01 USD
Інформація про депутата з кешем (7 днів). Включає біографію, комітети, фракцію, голосування.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'ПІБ депутата (повне або часткове)',
            },
            rada_id: {
              type: 'string',
              description: 'ID депутата в системі data.rada.gov.ua',
            },
            include_voting_record: {
              type: 'boolean',
              default: false,
              description: 'Включити історію голосувань депутата',
            },
            include_assistants: {
              type: 'boolean',
              default: false,
              description: 'Включити список помічників депутата',
            },
          },
          required: [],
        },
      },
      {
        name: 'search_legislation_text',
        description: `Пошук у текстах законів України з посиланнями на судові рішення

💰 Примерная стоимость: $0.005-$0.02 USD
Повнотекстовий пошук у законодавстві. Підтримує псевдоніми: constitution, цивільний кодекс, кпк тощо.`,
        inputSchema: {
          type: 'object',
          properties: {
            law_identifier: {
              type: 'string',
              description: 'Ідентифікатор закону (номер або псевдонім: constitution, цивільний кодекс, кпк)',
            },
            article: {
              type: 'string',
              description: 'Номер статті закону для пошуку',
            },
            search_text: {
              type: 'string',
              description: 'Текст для пошуку в законі',
            },
            include_court_citations: {
              type: 'boolean',
              default: false,
              description: 'Включити посилання на судові рішення, що цитують цей закон (використовує SecondLayer)',
            },
          },
          required: ['law_identifier'],
        },
      },
      {
        name: 'analyze_voting_record',
        description: `Аналіз історії голосувань депутата з AI-інсайтами

💰 Примерная стоимость: $0.02-$0.10 USD
Аналіз паттернів голосування депутата. Включає AI аналіз (OpenAI) для виявлення трендів.`,
        inputSchema: {
          type: 'object',
          properties: {
            deputy_name: {
              type: 'string',
              description: 'ПІБ депутата',
            },
            date_from: {
              type: 'string',
              description: 'Дата початку періоду аналізу (формат: YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              description: 'Дата кінця періоду аналізу (формат: YYYY-MM-DD)',
            },
            bill_number: {
              type: 'string',
              description: 'Номер законопроєкту для аналізу голосування',
            },
            analyze_patterns: {
              type: 'boolean',
              default: false,
              description: 'Використовувати AI для аналізу паттернів голосування',
            },
          },
          required: ['deputy_name'],
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    logger.info('RADA tool call', { name, args });

    try {
      switch (name) {
        case 'search_parliament_bills':
          return await this.searchParliamentBills(args);
        case 'get_deputy_info':
          return await this.getDeputyInfo(args);
        case 'search_legislation_text':
          return await this.searchLegislationText(args);
        case 'analyze_voting_record':
          return await this.analyzeVotingRecord(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      logger.error('RADA tool call error:', error);
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

  private async searchParliamentBills(args: SearchParliamentBillsArgs) {
    logger.info('Searching parliament bills', { query: args.query, status: args.status });

    try {
      const result = await this.billService.searchBills({
        query: args.query,
        status: args.status,
        initiator: args.initiator,
        committee: args.committee,
        date_from: args.date_from,
        date_to: args.date_to,
        limit: args.limit || 20,
      });

      logger.info('Bills search completed', {
        query: args.query,
        found: result.total,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              status: args.status || 'all',
              total_found: result.total,
              bills: result.bills.map(bill => ({
                bill_number: bill.bill_number,
                title: bill.title,
                registration_date: bill.registration_date,
                status: bill.status,
                stage: bill.stage,
                initiator_type: bill.initiator_type,
                initiator_names: bill.initiator_names,
                main_committee_name: bill.main_committee_name,
                url: bill.url,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to search bills', { error: error.message });
      throw new Error(`Failed to search bills: ${error.message}`);
    }
  }

  private async getDeputyInfo(args: GetDeputyInfoArgs) {
    logger.info('Getting deputy info', {
      name: args.name,
      rada_id: args.rada_id,
      include_voting: args.include_voting_record,
    });

    try {
      // Search deputy by name or ID
      const searchParams: any = {
        include_voting_record: args.include_voting_record || false,
        include_assistants: args.include_assistants || false,
      };

      if (args.rada_id) {
        searchParams.rada_id = args.rada_id;
      } else if (args.name) {
        searchParams.name = args.name;
      } else {
        throw new Error('Either name or rada_id must be provided');
      }

      const deputies = await this.deputyService.searchDeputies(searchParams);

      if (deputies.length === 0) {
        throw new Error('Deputy not found');
      }

      if (deputies.length > 1) {
        // Return multiple matches for user to choose
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                multiple_matches: true,
                count: deputies.length,
                deputies: deputies.map(d => ({
                  rada_id: d.deputy.rada_id,
                  full_name: d.deputy.full_name,
                  faction_name: d.deputy.faction_name,
                  active: d.deputy.active,
                })),
                message: 'Знайдено кілька депутатів. Уточніть запит або використайте rada_id.',
              }, null, 2),
            },
          ],
        };
      }

      const deputyInfo = deputies[0];
      const deputy = deputyInfo.deputy;

      const result: any = {
        rada_id: deputy.rada_id,
        full_name: deputy.full_name,
        short_name: deputy.short_name,
        active: deputy.active,
        faction_name: deputy.faction_name,
        committee_name: deputy.committee_name,
        committee_role: deputy.committee_role,
        region: deputy.region,
        district: deputy.district,
        birth_date: deputy.birth_date,
        birth_place: deputy.birth_place,
        biography: deputy.biography,
        photo_url: deputy.photo_url,
      };

      // Include voting statistics if requested
      if (args.include_voting_record && deputyInfo.voting_statistics) {
        result.voting_statistics = deputyInfo.voting_statistics;
      }

      // Include assistants if requested
      if (args.include_assistants && deputyInfo.assistants) {
        result.assistants = deputyInfo.assistants;
      }

      logger.info('Deputy info retrieved', {
        rada_id: deputy.rada_id,
        name: deputy.full_name,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to get deputy info', { error: error.message });
      throw new Error(`Failed to get deputy info: ${error.message}`);
    }
  }

  private async searchLegislationText(args: SearchLegislationTextArgs) {
    logger.info('Searching legislation text', {
      law_identifier: args.law_identifier,
      article: args.article,
      include_citations: args.include_court_citations,
    });

    try {
      const legislationResult = await this.legislationService.searchLegislation({
        law_identifier: args.law_identifier,
        article: args.article,
        search_text: args.search_text,
        include_court_citations: args.include_court_citations,
      });

      if (!legislationResult || !legislationResult.legislation) {
        throw new Error(`Law not found: ${args.law_identifier}`);
      }

      const legislation = legislationResult.legislation;

      const result: any = {
        law_number: legislation.law_number,
        title: legislation.title,
        law_type: legislation.law_type,
        adoption_date: legislation.adoption_date,
        effective_date: legislation.effective_date,
        status: legislation.status,
        url: legislation.url,
        full_text_plain: legislation.full_text_plain,
      };

      // Include specific article if found
      if (legislationResult.article) {
        result.article = legislationResult.article;
      }

      // Include court citations if requested
      if (args.include_court_citations) {
        logger.info('Fetching court citations via SecondLayer');
        const citations = await this.crossRefService.getCourtCitations(
          legislation.law_number,
          args.article
        );
        result.court_citations = {
          total: citations.length,
          recent: citations.slice(0, 10).map((c: any) => ({
            case_number: c.court_case_number,
            citation_count: c.citation_count,
            last_citation_date: c.last_citation_date,
          })),
        };
      }

      logger.info('Legislation retrieved', {
        law: legislation.law_number,
        title: legislation.title,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to search legislation', { error: error.message });
      throw new Error(`Failed to search legislation: ${error.message}`);
    }
  }

  private async analyzeVotingRecord(args: AnalyzeVotingRecordArgs) {
    logger.info('Analyzing voting record', {
      deputy: args.deputy_name,
      analyze_patterns: args.analyze_patterns,
    });

    try {
      // Find deputy
      const deputies = await this.deputyService.searchDeputies({
        name: args.deputy_name,
      });
      if (deputies.length === 0) {
        throw new Error(`Deputy not found: ${args.deputy_name}`);
      }
      const deputyInfo = deputies[0];
      const deputy = deputyInfo.deputy;

      // Get voting statistics
      const votingStats = await this.votingService.analyzeVotingRecord({
        deputy_name: args.deputy_name,
        date_from: args.date_from,
        date_to: args.date_to,
        bill_number: args.bill_number,
        analyze_patterns: args.analyze_patterns,
      });

      const result: any = {
        deputy: {
          rada_id: deputy.rada_id,
          full_name: deputy.full_name,
          faction: deputy.faction_name,
        },
        period: {
          from: args.date_from || 'all time',
          to: args.date_to || 'present',
        },
        statistics: {
          total_votes: votingStats.total_votes,
          voted_for: votingStats.voted_for,
          voted_against: votingStats.voted_against,
          abstained: votingStats.abstained,
          not_present: votingStats.not_present,
          attendance_rate: votingStats.attendance_rate,
        },
        voting_records: votingStats.positions.slice(0, 20).map(p => ({
          date: p.date,
          question: p.question,
          bill_number: p.bill_number,
          vote: p.vote,
          result: p.result,
        })),
      };

      // AI pattern analysis if requested
      if (args.analyze_patterns && votingStats.patterns) {
        result.ai_analysis = votingStats.patterns;
      }

      logger.info('Voting analysis completed', {
        deputy_rada_id: deputy.rada_id,
        total_votes: votingStats.total_votes,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to analyze voting record', { error: error.message });
      throw new Error(`Failed to analyze voting record: ${error.message}`);
    }
  }
}
