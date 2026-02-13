/**
 * Court Session Tools - Search and bulk ingest court sessions from ZakonOnline
 *
 * 2 tools:
 * - search_court_sessions
 * - bulk_ingest_court_sessions
 */

import { ZOAdapter } from '../../adapters/zo-adapter.js';
import { logger } from '../../utils/logger.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';

export class CourtSessionTools extends BaseToolHandler {
  constructor(
    private zoSessionsAdapter: ZOAdapter,
    private db: any
  ) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_court_sessions',
        description: `Пошук судових засідань за номером справи або учасниками

💰 Примерная стоимость: $0.005-$0.01 USD
Пошук запланованих та завершених судових засідань. Пошук за номером справи або ім'ям учасника.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (номер справи або ім\'я учасника)',
            },
            target: {
              type: 'string',
              enum: ['cause_num', 'case_involved'],
              default: 'case_involved',
              description: 'Тип пошуку: cause_num (номер справи) або case_involved (учасники)',
            },
            date_from: {
              type: 'string',
              description: 'Дата від (YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              description: 'Дата до (YYYY-MM-DD)',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 1000,
              description: 'Максимальна кількість результатів',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'bulk_ingest_court_sessions',
        description: `Масове завантаження судових засідань в локальну базу

💰 Примерная стоимость: $0.01-$0.05 USD
Завантажує метадані судових засідань з ZakonOnline API і зберігає в PostgreSQL.
Не потребує скрапінгу HTML — тільки метадані через API.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит',
            },
            date_from: {
              type: 'string',
              description: 'Дата від (YYYY-MM-DD). За замовчуванням: рік тому',
            },
            date_to: {
              type: 'string',
              description: 'Дата до (YYYY-MM-DD)',
            },
            max_sessions: {
              type: 'number',
              default: 5000,
              description: 'Максимальна кількість засідань для завантаження',
            },
            max_pages: {
              type: 'number',
              default: 50,
              description: 'Максимальна кількість сторінок API',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_court_sessions':
        return this.searchCourtSessions(args);
      case 'bulk_ingest_court_sessions':
        return this.bulkIngestCourtSessions(args);
      default:
        return null;
    }
  }

  private async searchCourtSessions(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const target = args.target || 'case_involved';
    const limit = Math.min(1000, Math.max(1, Number(args.limit || 50)));

    const searchParams: any = {
      meta: { search: query, target },
      limit,
      offset: 0,
    };

    // Add date filter if provided
    if (args.date_from) {
      searchParams.date_session_from = args.date_from;
    }
    if (args.date_to) {
      searchParams.date_session_to = args.date_to;
    }

    const rawResponse = await this.zoSessionsAdapter.searchCourtDecisions(searchParams);

    const responseData = Array.isArray(rawResponse)
      ? rawResponse
      : (rawResponse?.data && Array.isArray(rawResponse.data) ? rawResponse.data : []);

    if (responseData.length === 0) {
      return this.wrapResponse({
        query,
        sessions_found: 0,
        message: 'Судових засідань не знайдено за вашим запитом',
      });
    }

    // Save to local DB for caching
    let savedCount = 0;
    for (const session of responseData) {
      try {
        await this.saveSessionToDb(session);
        savedCount++;
      } catch (err) {
        // Skip duplicates silently
      }
    }

    return this.wrapResponse({
      query,
      sessions_found: responseData.length,
      sessions_saved: savedCount,
      sessions: responseData.slice(0, 20), // Return first 20 in response
      note: responseData.length > 20
        ? `Показано перші 20 з ${responseData.length} засідань. Всі збережені в локальній базі.`
        : undefined,
    });
  }

  private async bulkIngestCourtSessions(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const defaultDateFrom = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const dateFrom = args.date_from || defaultDateFrom;
    const dateTo = args.date_to;
    const maxSessions = Number(args.max_sessions || 5000);
    const maxPages = Number(args.max_pages || 50);
    const pageSize = 1000;

    const startTime = Date.now();
    const seenIds = new Set<string>();
    let pagesFetched = 0;
    let offset = 0;
    let emptyPages = 0;
    let savedCount = 0;

    while (pagesFetched < maxPages && seenIds.size < maxSessions) {
      const searchParams: any = {
        meta: { search: query },
        limit: pageSize,
        offset,
      };

      if (dateFrom) searchParams.date_session_from = dateFrom;
      if (dateTo) searchParams.date_session_to = dateTo;

      const rawResponse = await this.zoSessionsAdapter.searchCourtDecisions(searchParams);
      pagesFetched++;

      const responseData = Array.isArray(rawResponse)
        ? rawResponse
        : (rawResponse?.data && Array.isArray(rawResponse.data) ? rawResponse.data : []);

      if (responseData.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) break;
        offset += pageSize;
        continue;
      }
      emptyPages = 0;

      // Filter by date locally
      const filtered = responseData.filter((session: any) => {
        const sessionDate = session.date_session ? new Date(session.date_session) : null;
        if (!sessionDate) return true; // Include sessions without date
        if (dateFrom && sessionDate < new Date(dateFrom)) return false;
        if (dateTo && sessionDate > new Date(dateTo)) return false;
        return true;
      });

      for (const session of filtered) {
        const sessionId = String(session.doc_id || session.id || session.session_id || '');
        if (!sessionId || seenIds.has(sessionId)) continue;
        if (seenIds.size >= maxSessions) break;

        seenIds.add(sessionId);
        try {
          await this.saveSessionToDb(session);
          savedCount++;
        } catch (err) {
          // Skip errors silently
        }
      }

      if (responseData.length < pageSize) break;
      offset += pageSize;
    }

    const timeTaken = Date.now() - startTime;
    const costEstimate = pagesFetched * 0.00714;

    return this.wrapResponse({
      query,
      date_from: dateFrom,
      ...(dateTo ? { date_to: dateTo } : {}),
      pages_fetched: pagesFetched,
      unique_sessions_found: seenIds.size,
      sessions_saved: savedCount,
      max_sessions: maxSessions,
      time_taken_ms: timeTaken,
      cost_estimate_usd: parseFloat(costEstimate.toFixed(6)),
      note: 'Метадані засідань збережено в PostgreSQL. Скрапінг HTML не потрібен.',
    });
  }

  private async saveSessionToDb(session: any): Promise<void> {
    const sessionId = String(session.doc_id || session.id || session.session_id || '');
    if (!sessionId) return;

    await this.db.query(
      `INSERT INTO court_sessions (
        zakononline_id, case_number, court_name, judge_name,
        session_date, session_time, session_form, justice_kind,
        involved_parties, session_place, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (zakononline_id) DO UPDATE SET
        case_number = EXCLUDED.case_number,
        court_name = EXCLUDED.court_name,
        judge_name = EXCLUDED.judge_name,
        session_date = EXCLUDED.session_date,
        session_time = EXCLUDED.session_time,
        session_form = EXCLUDED.session_form,
        justice_kind = EXCLUDED.justice_kind,
        involved_parties = EXCLUDED.involved_parties,
        session_place = EXCLUDED.session_place,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        sessionId,
        session.cause_num || session.case_number || null,
        session.court_name || session.court || null,
        session.judge || session.judge_name || null,
        session.date_session || null,
        session.time_session || session.session_time || null,
        session.session_form || session.form || null,
        session.justice_kind || session.justice || null,
        session.involved || session.case_involved || session.parties || null,
        session.session_place || session.place || null,
        JSON.stringify(session),
      ]
    );
  }
}
