/**
 * EDRSR Extended Tools — Спеціалізовані запити по ЄДРСР
 *
 * 2 tools:
 * - edrsr_court_decisions_by_court — FTS у рамках одного суду з обовʼязковим вікном дат
 * - edrsr_get_decision_dispositive — витяг лише резолютивної частини (ВИРІШИВ/УХВАЛИВ/ПОСТАНОВИВ)
 *
 * Обидва інструменти оптимізовані для роботи з партиціонованими таблицями
 * edrsr_documents (RANGE по adjudication_date) та edrsr_fulltext (LIST по adj_year).
 * FTS-конфіг — 'simple' (без українського стемера, але коректно токенізує українську).
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { extractDispositiveFromText } from '../../utils/dispositive.js';
import { cleanEdrsrTextSql } from '../../services/edrsr-fts-service.js';
import { formatCourtDate } from '../tool-utils.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STATEMENT_TIMEOUT_MS = 60_000;

export class EdsrExtendedTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'edrsr_court_decisions_by_court',
        annotations: { title: 'Рішення конкретного суду (ЄДРСР)', readOnlyHint: true, openWorldHint: true },
        description: `Пошук судових рішень конкретного суду за FTS-запитом у заданому вікні дат.

Оптимізовано для отримання прецедентів одного суду (напр., усі виграні адмінпозови проти ТЦК
у Оболонському районному суді м. Києва за останній рік).

Обовʼязково:
- court_code (код суду з таблиці edrsr_courts; напр., 2605 = Оболонський районний суд м. Києва)
- fts_query (український FTS-запит; plainto_tsquery з конфігом 'simple')
- date_from (YYYY-MM-DD; без дати запит сканує всі партиції, тому date_from обовʼязковий)

Повертає метадані + ts_rank + snippet з highlights. Сортування: за датою DESC, потім за rank DESC.
Для повного тексту — get_edrsr_decision_fulltext. Для лише резолютивки — edrsr_get_decision_dispositive.`,
        inputSchema: {
          type: 'object',
          properties: {
            court_code: {
              type: 'number',
              description: 'Код суду (edrsr_courts.court_code). Приклади: 2605=Оболонський районний м.Києва, 1070=Київський окружний адмін, 9901=Верховний Суд',
            },
            fts_query: {
              type: 'string',
              description: 'FTS-запит українською (plainto_tsquery). Напр., "повістка ТЦК розшук належне оповіщення"',
            },
            date_from: {
              type: 'string',
              description: 'Дата ухвалення ВІД (YYYY-MM-DD). ОБОВʼЯЗКОВА для пруну партицій.',
            },
            date_to: {
              type: 'string',
              description: 'Дата ухвалення ДО (YYYY-MM-DD). За замовчуванням — поточна дата.',
            },
            limit: {
              type: 'number',
              default: 20,
              maximum: 100,
              description: 'Максимальна кількість результатів (1-100)',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зміщення для пагінації',
            },
          },
          required: ['court_code', 'fts_query', 'date_from'],
        },
      },
      {
        name: 'edrsr_get_decision_dispositive',
        annotations: { title: 'Резолютивна частина рішення', readOnlyHint: true, idempotentHint: true },
        description: `Повертає лише резолютивну частину судового рішення (ВИРІШИВ / УХВАЛИВ / ПОСТАНОВИВ / ВИРОК).

Економить контекст LLM при аналізі багатьох рішень одночасно: замість 50-500 KB повного тексту
повертає 2-8 KB резолютивки. Якщо жодного з маркерів не знайдено — повертає останні 4000 символів
як fallback (у 95% випадків резолютивка знаходиться в кінці документа).

Повертає:
- dispositive (текст резолютивки)
- marker (який маркер знайдено або null)
- marker_position (позиція в повному тексті або null)
- text_length (довжина повного тексту)
- is_fallback (true, якщо повернуто кінець тексту без явного маркера)`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: ['string', 'number'],
              description: 'ID документа в ЄДРСР',
            },
          },
          required: ['doc_id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'edrsr_court_decisions_by_court':
        return await this.searchByCourt(args);
      case 'edrsr_get_decision_dispositive':
        return await this.getDispositive(args);
      default:
        return null;
    }
  }

  private async searchByCourt(args: any): Promise<ToolResult> {
    const courtCode = Number(args.court_code);
    const ftsQuery = (args.fts_query || '').trim();
    const dateFrom = args.date_from;
    const dateTo = args.date_to || new Date().toISOString().slice(0, 10);
    const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(Number(args.offset) || 0, 0);

    if (!courtCode || Number.isNaN(courtCode)) {
      return this.wrapError('court_code є обовʼязковим числовим параметром');
    }
    if (!ftsQuery) {
      return this.wrapError('fts_query є обовʼязковим параметром');
    }
    if (!dateFrom) {
      return this.wrapError('date_from є обовʼязковим (без нього запит сканує всі партиції)');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return this.wrapError('date_from та date_to повинні бути у форматі YYYY-MM-DD');
    }

    const yearFrom = Number(dateFrom.slice(0, 4));
    const yearTo = Number(dateTo.slice(0, 4));

    const client = await this.db.connect?.() ?? this.db;
    const shouldRelease = typeof this.db.connect === 'function';

    try {
      if (shouldRelease) {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      }

      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM edrsr_documents d
        JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        WHERE d.court_code = $1
          AND d.adjudication_date >= $2::date
          AND d.adjudication_date < ($3::date + INTERVAL '1 day')
          AND f.adj_year BETWEEN $4 AND $5
          AND f.tsv @@ plainto_tsquery('simple', $6)
      `;

      const dataSql = `
        SELECT
          d.doc_id,
          d.cause_num,
          d.adjudication_date,
          d.judge,
          d.court_code,
          d.justice_kind,
          d.judgment_code,
          d.category_code,
          d.doc_url,
          ts_rank_cd(f.tsv, plainto_tsquery('simple', $6)) AS rank,
          safe_ts_headline(
            'simple'::regconfig,
            f.full_text,
            plainto_tsquery('simple', $6),
            'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "'
          ) AS snippet
        FROM edrsr_documents d
        JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        WHERE d.court_code = $1
          AND d.adjudication_date >= $2::date
          AND d.adjudication_date < ($3::date + INTERVAL '1 day')
          AND f.adj_year BETWEEN $4 AND $5
          AND f.tsv @@ plainto_tsquery('simple', $6)
        ORDER BY d.adjudication_date DESC, rank DESC
        LIMIT $7 OFFSET $8
      `;

      const params = [courtCode, dateFrom, dateTo, yearFrom, yearTo, ftsQuery];

      const [courtRow, countResult, dataResult] = await Promise.all([
        client.query(`SELECT name FROM edrsr_courts WHERE court_code = $1`, [courtCode]),
        client.query(countSql, params),
        client.query(dataSql, [...params, limit, offset]),
      ]);

      const courtName = courtRow.rows[0]?.name || null;
      const total = countResult.rows[0]?.total || 0;

      const enriched = await this.enrich(dataResult.rows, courtName);

      logger.info('[EdsrExtendedTools] edrsr_court_decisions_by_court', {
        court_code: courtCode,
        fts_query: ftsQuery,
        date_from: dateFrom,
        date_to: dateTo,
        total,
        returned: enriched.length,
      });

      return this.wrapResponse({
        query: {
          court_code: courtCode,
          court_name: courtName,
          fts_query: ftsQuery,
          date_from: dateFrom,
          date_to: dateTo,
        },
        total,
        returned: enriched.length,
        offset,
        has_more: offset + enriched.length < total,
        results: enriched,
      });
    } catch (err: any) {
      logger.error('[EdsrExtendedTools] edrsr_court_decisions_by_court failed', {
        error: err.message,
        court_code: courtCode,
        fts_query: ftsQuery,
      });
      return this.wrapError(`Помилка пошуку: ${err.message}`);
    } finally {
      if (shouldRelease && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  private async getDispositive(args: any): Promise<ToolResult> {
    const docId = args.doc_id;
    if (!docId) {
      return this.wrapError('doc_id є обовʼязковим параметром');
    }

    try {
      const result = await this.db.query(
        `SELECT ${cleanEdrsrTextSql('full_text')} AS full_text, text_length FROM edrsr_fulltext WHERE doc_id = $1`,
        [docId]
      );

      if (result.rows.length === 0) {
        return this.wrapError(`Рішення з doc_id=${docId} не знайдено (або повний текст відсутній)`);
      }

      const row = result.rows[0];
      const fullText: string = row.full_text || '';
      const textLength: number = row.text_length || fullText.length;

      if (!fullText) {
        return this.wrapResponse({
          doc_id: Number(docId) || docId,
          dispositive: null,
          marker: null,
          marker_position: null,
          text_length: 0,
          is_fallback: false,
          note: 'Повний текст відсутній',
        });
      }

      const { dispositive, marker, marker_position, is_fallback } =
        extractDispositiveFromText(fullText);

      logger.info('[EdsrExtendedTools] edrsr_get_decision_dispositive', {
        doc_id: docId,
        marker,
        marker_position,
        text_length: textLength,
        is_fallback,
        dispositive_length: dispositive.length,
      });

      return this.wrapResponse({
        doc_id: Number(docId) || docId,
        dispositive,
        marker,
        marker_position,
        text_length: textLength,
        dispositive_length: dispositive.length,
        is_fallback,
        external_url: `https://reyestr.court.gov.ua/Review/${docId}`,
      });
    } catch (err: any) {
      logger.error('[EdsrExtendedTools] edrsr_get_decision_dispositive failed', {
        error: err.message,
        doc_id: docId,
      });
      return this.wrapError(`Помилка отримання резолютивної частини: ${err.message}`);
    }
  }

  private async enrich(rows: any[], courtName: string | null): Promise<any[]> {
    if (rows.length === 0) return [];

    const justiceKinds = new Set<number>();
    const judgmentCodes = new Set<number>();
    for (const row of rows) {
      if (row.justice_kind) justiceKinds.add(row.justice_kind);
      if (row.judgment_code) judgmentCodes.add(row.judgment_code);
    }

    const [justiceMap, judgmentMap] = await Promise.all([
      this.batchLookup('edrsr_justice_kinds', 'justice_kind', Array.from(justiceKinds)),
      this.batchLookup('edrsr_judgment_forms', 'judgment_code', Array.from(judgmentCodes)),
    ]);

    return rows.map((row) => ({
      doc_id: row.doc_id,
      cause_num: row.cause_num,
      adjudication_date: formatCourtDate(row.adjudication_date),
      judge: row.judge,
      court_code: row.court_code,
      court_name: courtName,
      justice_kind: row.justice_kind,
      justice_kind_name: justiceMap.get(row.justice_kind) || null,
      judgment_code: row.judgment_code,
      judgment_form: judgmentMap.get(row.judgment_code) || null,
      category_code: row.category_code,
      doc_url: row.doc_url,
      external_url: `https://reyestr.court.gov.ua/Review/${row.doc_id}`,
      rank: typeof row.rank === 'number' ? row.rank : Number(row.rank) || 0,
      snippet: row.snippet || null,
    }));
  }

  private static readonly ALLOWED_LOOKUP_TABLES: Record<string, Set<string>> = {
    edrsr_justice_kinds: new Set(['justice_kind']),
    edrsr_judgment_forms: new Set(['judgment_code']),
  };

  private async batchLookup(
    table: string,
    idColumn: string,
    ids: number[]
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    const allowed = EdsrExtendedTools.ALLOWED_LOOKUP_TABLES[table];
    if (!allowed || !allowed.has(idColumn)) return map;

    try {
      const result = await this.db.query(
        `SELECT ${idColumn}, name FROM ${table} WHERE ${idColumn} = ANY($1)`,
        [ids]
      );
      for (const row of result.rows) {
        map.set(row[idColumn], row.name);
      }
    } catch {
      // Reference table might be missing — non-critical
    }
    return map;
  }
}
