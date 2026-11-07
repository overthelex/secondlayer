/**
 * Court Session Tools - Search and bulk ingest court sessions from ZakonOnline
 *
 * 2 tools:
 * - search_court_hearing_schedule (formerly search_court_sessions)
 * - bulk_ingest_court_sessions
 */

import { EdsrLocalAdapter } from '../../adapters/edrsr-local-adapter.js';
import { logger } from '../../utils/logger.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';

/** «910/5220/26», «352/923/16-ц», «1-кс/757/1/19»: digits and slashes, no letters beyond a suffix. */
/** hearing_date («DD.MM.YYYY HH:MI», or ISO) → date; NULL when neither shape matches. */
export const HEARING_DAY_SQL = `(CASE
  WHEN hearing_date ~ '^\\d{2}\\.\\d{2}\\.\\d{4}' THEN to_date(substr(hearing_date, 1, 10), 'DD.MM.YYYY')
  WHEN hearing_date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substr(hearing_date, 1, 10)::date
END)`;

/** Calendar day of a hearing row («DD.MM.YYYY HH:MI» or ISO) for merging and ordering; '' when unparseable. */
export function hearingDay(hearingDate: unknown): string {
  const s = String(hearingDate ?? '');
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : '';
}

/**
 * One list out of the two sources. The same hearing can sit in both (the schedule
 * snapshot and the archive it was later copied into): rows that agree on case
 * number, day and court are one hearing, and the schedule row wins because it
 * carries the room and the description. Newest day first, then the schedule's
 * own time string.
 */
export function mergeHearings(schedule: any[], archive: any[]): any[] {
  const key = (r: any) =>
    `${String(r.case_number ?? '').replace(/\s+/g, '')}|${hearingDay(r.hearing_date)}|${String(r.court_name ?? '').trim().toLowerCase()}`;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const row of [...schedule.map((r) => ({ ...r, source: 'schedule' })), ...archive.map((r) => ({ ...r, source: 'archive' }))]) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out.sort((a, b) => hearingDay(b.hearing_date).localeCompare(hearingDay(a.hearing_date))
    || String(b.hearing_date ?? '').localeCompare(String(a.hearing_date ?? '')));
}

export function looksLikeCaseNumber(q: string): boolean {
  const t = q.replace(/\s+/g, '');
  return /^[0-9]{1,4}(-[а-яіїєa-z]{1,3})?\/[0-9]{1,6}\/[0-9]{1,6}(\/[0-9]{1,4})?(-[а-яіїєa-z]{1,3})?$/i.test(t)
    || /^[0-9]{3,4}\/[0-9]{1,6}\/[0-9]{2,4}(-[а-яіїєa-z]{1,3})?$/i.test(t);
}

export class CourtSessionTools extends BaseToolHandler {
  constructor(
    private zoSessionsAdapter: EdsrLocalAdapter,
    private db: any
  ) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_court_hearing_schedule',
        annotations: { title: 'Розклад засідань', readOnlyHint: true },
        description: `Пошук РОЗКЛАДУ судових засідань (дата, час, зал, учасники) — НЕ для пошуку текстів судових рішень або правових позицій.

Для пошуку судової практики та рішень використовуйте: search_edrsr_fulltext, compare_practice_pro_contra, find_similar_fact_pattern_cases.

💰 Примерная стоимость: $0.001-$0.01 USD
Знаходить заплановані та завершені засідання за номером справи, учасниками, суддею.
Джерела: опублікований розклад (найближчі засідання) та архів проведених засідань з 2020 року (30M+ з відкритих даних судової влади); кожен рядок позначено source=schedule|archive. Архів шукає за номером справи, учасником або судом (суддя — лише як додатковий фільтр). Номер справи в query розпізнається автоматично.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит: номер справи (напр. 910/5220/26) або ім\'я/назва учасника',
            },
            source: {
              type: 'string',
              enum: ['api', 'opendata', 'all'],
              default: 'all',
              description: 'Застаріле: усі значення шукають у відкритих даних (ZakonOnline API вимкнено)',
            },
            target: {
              type: 'string',
              enum: ['cause_num', 'case_involved'],
              description: 'Як трактувати query: cause_num (номер справи) або case_involved (учасники). За замовчуванням визначається автоматично',
            },
            case_number: {
              type: 'string',
              description: 'Номер справи (для opendata пошуку)',
            },
            judge: {
              type: 'string',
              description: 'Прізвище судді (для opendata пошуку)',
            },
            participant: {
              type: 'string',
              description: 'Прізвище або назва учасника справи (для opendata пошуку)',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду (для opendata пошуку)',
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
        },
      },
      {
        name: 'bulk_ingest_court_sessions',
        annotations: { title: 'Масовий імпорт засідань' },
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
      case 'search_court_hearing_schedule':
      case 'search_court_sessions': // backward-compat alias
      case 'search_court_schedule': // backward-compat alias
        return this.searchCourtSessions(args);
      case 'bulk_ingest_court_sessions':
        return this.bulkIngestCourtSessions(args);
      default:
        return null;
    }
  }

  private async searchCourtSessions(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    const limit = Math.min(1000, Math.max(1, Number(args.limit || 50)));

    const opendataResults: any[] = [];
    const hasFilter = query || ['case_number', 'judge', 'participant', 'court_name', 'date_from', 'date_to']
      .some((k) => args[k]);
    if (!hasFilter) {
      return this.wrapResponse('Вкажіть query (номер справи або учасник) або фільтри: case_number, judge, participant, court_name, date_from/date_to');
    }

    // ZakonOnline API is retired (LEXAI-2193): the adapter wired here is the local EDRSR
    // decisions adapter, so source=api searched court DECISIONS with session parameters
    // and always came back empty. Every source value now reads the opendata schedule;
    // `source` is still accepted so existing callers do not break.
    const odArgs = { ...args };
    if (query && !args.case_number && !args.participant) {
      const asCaseNumber = args.target === 'cause_num'
        || (args.target !== 'case_involved' && looksLikeCaseNumber(query));
      if (asCaseNumber) odArgs.case_number = query.replace(/\s+/g, '');
      else odArgs.participant = query;
    }
    // Two tables hold hearings: opendata_court_schedule is the published schedule (the
    // coming weeks, ~600K rows) and court_sessions the archive of past hearings (30M+).
    // Reading only the schedule answered "no hearings" for any case whose hearings had
    // already taken place — 200/2129/24 had four in the archive (client report 06.11.2026).
    const [scheduleRows, archiveRows] = await Promise.all([
      this.searchScheduleFromOpendata(odArgs, limit),
      this.searchArchiveSessions(odArgs, limit),
    ]);
    opendataResults.push(...mergeHearings(scheduleRows, archiveRows));

    const totalFound = opendataResults.length;
    if (totalFound === 0) {
      return this.wrapResponse({
        query: query || undefined,
        sessions_found: 0,
        message: 'Судових засідань не знайдено за вашим запитом',
      });
    }

    const response: any = {
      query: query || undefined,
      source: 'opendata',
      sessions_found: totalFound,
      sources: { schedule: scheduleRows.length, archive: archiveRows.length },
    };

    if (opendataResults.length > 0) {
      response.opendata_results = opendataResults.slice(0, limit);
    }

    return this.wrapResponse(response);
  }

  /**
   * Past hearings from court_sessions (30M+ rows). Only predicates its indexes answer
   * anchor a statement: case_number (b-tree), participant and court_name (GIN on
   * to_tsvector('simple', …)). judge_name has no index, so a judge alone would seq-scan
   * the table: the archive leg is skipped then and the schedule answers on its own.
   * Rows come back in the schedule's column shape so the two sources merge as one list.
   */
  private async searchArchiveSessions(args: any, limit: number): Promise<any[]> {
    const { case_number, judge, participant, court_name, date_from, date_to, query } = args;
    const participantText = participant || (query && !case_number ? query : undefined);
    if (!case_number && !participantText && !court_name) return [];

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (case_number) {
      conditions.push(`case_number = $${pi}`);
      values.push(case_number);
      pi++;
    }
    if (participantText) {
      conditions.push(`to_tsvector('simple', involved_parties) @@ plainto_tsquery('simple', $${pi})`);
      values.push(participantText);
      pi++;
    }
    if (court_name) {
      conditions.push(`to_tsvector('simple', court_name) @@ plainto_tsquery('simple', $${pi})`);
      values.push(court_name);
      pi++;
    }
    if (judge) {
      conditions.push(`judge_name ILIKE $${pi}`);
      values.push(`%${judge}%`);
      pi++;
    }
    if (date_from) {
      conditions.push(`session_date >= $${pi}::date`);
      values.push(date_from);
      pi++;
    }
    if (date_to) {
      conditions.push(`session_date <= $${pi}::date`);
      values.push(date_to);
      pi++;
    }

    values.push(Math.min(Number(limit) || 50, 100));

    const sql = `SELECT to_char(session_date, 'DD.MM.YYYY') || COALESCE(' ' || NULLIF(session_time, ''), '') AS hearing_date,
             court_name, case_number, judge_name AS judges, session_place AS court_room,
             involved_parties AS case_involved, session_form AS case_description
      FROM court_sessions
      WHERE ${conditions.join(' AND ')}
      ORDER BY session_date DESC NULLS LAST, session_time DESC
      LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      return result.rows;
    } catch (error: any) {
      logger.error('search_court_schedule archive (court_sessions) error', { error: error.message });
      return [];
    }
  }

  private async searchScheduleFromOpendata(args: any, limit: number): Promise<any[]> {
    const { case_number, judge, participant, court_name, date_from, date_to, query } = args;

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (case_number) {
      conditions.push(`case_number = $${pi}`);
      values.push(case_number);
      pi++;
    }
    if (judge) {
      conditions.push(`judges ILIKE $${pi}`);
      values.push(`%${judge}%`);
      pi++;
    }
    if (participant) {
      conditions.push(`case_involved ILIKE $${pi}`);
      values.push(`%${participant}%`);
      pi++;
    } else if (query && !case_number) {
      // Use query as participant search fallback for opendata
      conditions.push(`case_involved ILIKE $${pi}`);
      values.push(`%${query}%`);
      pi++;
    }
    if (court_name) {
      conditions.push(`court_name ILIKE $${pi}`);
      values.push(`%${court_name}%`);
      pi++;
    }
    // hearing_date is TEXT «05.05.2026 00:00»: compared as a string against an ISO
    // bound, '06.05.2026' > '2026-05-01' for every row, so the filter and the sort were
    // meaningless. Compare (and order by) the parsed calendar day instead.
    if (date_from) {
      conditions.push(`${HEARING_DAY_SQL} >= $${pi}::date`);
      values.push(date_from);
      pi++;
    }
    if (date_to) {
      conditions.push(`${HEARING_DAY_SQL} <= $${pi}::date`);
      values.push(date_to);
      pi++;
    }

    if (conditions.length === 0) return [];

    values.push(Math.min(Number(limit) || 50, 100));

    const sql = `SELECT hearing_date, court_name, case_number, judges, court_room, case_involved, case_description
      FROM opendata_court_schedule
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${HEARING_DAY_SQL} DESC NULLS LAST, hearing_date DESC
      LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      return result.rows;
    } catch (error: any) {
      logger.error('search_court_schedule opendata error', { error: error.message });
      return [];
    }
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
