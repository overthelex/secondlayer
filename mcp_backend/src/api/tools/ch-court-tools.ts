/**
 * ChCourtTools — search and get over the Swiss court decisions corpus
 * (table `ch_court_decisions`, sourced from entscheidsuche.ch).
 *
 * Only stage='loaded' rows are served — everything else (indexed/fetched/extracted/
 * ocr_pending/failed) is still in the pipeline and has no reliable text. See migration
 * 196_ch_court_pipeline.sql for the stage machine.
 *
 * `decision_date = '2021-01-01'` is a source placeholder, not a real date (the upstream
 * feed fills it in when the true date is unknown). It is reported as `null` with
 * `decision_date_unknown: true`, and is excluded from date_from/date_to filtering even
 * when the literal value would satisfy the range.
 *
 * The full-text predicate is written to match `idx_ch_court_fts` verbatim (parties ||
 * abstract || full_text, 'simple' config) so the GIN index is actually used.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const MAX_FULL_TEXT_CHARS = 80000;
const ABSTRACT_PREVIEW_CHARS = 600;
const PLACEHOLDER_DATE = '2021-01-01';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LANGS = ['de', 'fr', 'it'];

const FTS_PREDICATE =
  `to_tsvector('simple', coalesce(parties,'') || ' ' || coalesce(abstract,'') || ' ' || coalesce(full_text,'')) @@ plainto_tsquery('simple', $1)`;

export class ChCourtTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_court_decisions',
        annotations: { title: 'Пошук судових рішень Швейцарії', readOnlyHint: true },
        description: `Повнотекстовий пошук по корпусу судових рішень Швейцарії (federal + 26 кантональних судів, джерело entscheidsuche.ch).

Фільтри: court_code (напр. CH_BGer_001, ZH_OG_003; префікс CH_BGer шукає всі палати), canton (двобуквений код кантону або CH для федеральних судів, напр. ZH, TI), lang (de/fr/it), date_from/date_to (YYYY-MM-DD).
Рішення без встановленої дати (плейсхолдер джерела) повертаються з decision_date: null, decision_date_unknown: true, і виключаються з фільтрів за датою.
Результати відсортовані за релевантністю (rank), потім за датою.
Далі: ch_get_court_decision для повного тексту рішення (ECLI або doc_id).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Пошуковий запит (повний текст, анотація, сторони)' },
            court_code: { type: 'string', description: 'Код суду, напр. CH_BGer_001, ZH_OG_003; префікс CH_BGer шукає всі палати' },
            canton: { type: 'string', description: 'Двобуквений код кантону або CH для федеральних судів, напр. ZH, TI, GE' },
            lang: { type: 'string', enum: ['de', 'fr', 'it'], description: 'Мова рішення' },
            date_from: { type: 'string', description: 'Дата від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Дата до (YYYY-MM-DD)' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
            offset: { type: 'number', default: 0, description: 'Зсув для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'ch_get_court_decision',
        annotations: { title: 'Картка судового рішення Швейцарії', readOnlyHint: true },
        description: `Повна картка судового рішення Швейцарії за ECLI або doc_id (потрібен один з них).

Повертає повний текст (full_text), обрізаний до 80 000 символів (full_text_truncated, full_text_length — реальна довжина), сторони, анотацію, джерело тексту (html/pdf/ocr) та якість вилучення тексту.
Рішення, що ще не пройшло обробку (stage ≠ loaded), повертає { error: 'not_loaded', ecli, stage } замість тексту.`,
        inputSchema: {
          type: 'object',
          properties: {
            ecli: { type: 'string', description: 'ECLI рішення, напр. ECLI:CH:BGER:2017:4A.22.2017' },
            doc_id: { type: 'string', description: 'Ідентифікатор документа entscheidsuche.ch' },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_court_decisions': return this.searchCourtDecisions(args);
      case 'ch_get_court_decision': return this.getCourtDecision(args);
      default: return null;
    }
  }

  // ─── ch_search_court_decisions ─────────────────────────────────────

  private async searchCourtDecisions(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, court_code, canton, lang, date_from, date_to, limit = 20, offset = 0 } = args as any;

    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — пошуковий запит по судових рішеннях.');
    }
    if (lang && !LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    if (date_from && !DATE_RE.test(String(date_from))) {
      return this.wrapResponse('date_from має бути у форматі YYYY-MM-DD.');
    }
    if (date_to && !DATE_RE.test(String(date_to))) {
      return this.wrapResponse('date_to має бути у форматі YYYY-MM-DD.');
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const off = Math.max(Number(offset) || 0, 0);

    try {
      // $1 = query (the FTS predicate/rank/snippet below must reference exactly $1 to
      // match the indexed expression), $2 = the placeholder-date constant.
      const values: any[] = [String(query), PLACEHOLDER_DATE];
      const filters: string[] = [];
      let pi = 3;

      // court_code is chamber-granular (e.g. CH_BGer_001, ZH_OG_003; 440 distinct values in
      // prod). An exact match still works, and a caller can also pass a bare prefix like
      // CH_BGer to match every chamber under it — the underscore in the LIKE pattern is
      // escaped so it does not act as a single-char wildcard.
      if (court_code) {
        filters.push(`(court_code = $${pi} OR court_code LIKE $${pi} || '\\_%')`);
        values.push(String(court_code)); pi++;
      }
      if (canton) { filters.push(`canton = $${pi}`); values.push(String(canton)); pi++; }
      if (lang) { filters.push(`languages[1] = $${pi}`); values.push(String(lang)); pi++; }
      // A placeholder date never satisfies a date-range filter, regardless of its literal
      // value — the row's date is not actually known.
      if (date_from) {
        filters.push(`decision_date IS DISTINCT FROM $2::date`);
        filters.push(`decision_date >= $${pi}::date`); values.push(String(date_from)); pi++;
      }
      if (date_to) {
        filters.push(`decision_date IS DISTINCT FROM $2::date`);
        filters.push(`decision_date <= $${pi}::date`); values.push(String(date_to)); pi++;
      }

      const limIdx = pi; values.push(lim); pi++;
      const offIdx = pi; values.push(off); pi++;

      const sql = `
        SELECT ecli, doc_id, court_code, court_name, chamber, canton,
               CASE WHEN decision_date = $2::date THEN NULL
                    ELSE to_char(decision_date, 'YYYY-MM-DD') END AS decision_date,
               COALESCE(decision_date = $2::date, true) AS decision_date_unknown,
               docket_number, languages,
               left(coalesce(abstract, ''), ${ABSTRACT_PREVIEW_CHARS}) AS abstract,
               ts_headline('simple', coalesce(abstract,'') || ' ' || coalesce(full_text,''),
                           plainto_tsquery('simple', $1), 'MaxWords=40, MinWords=15') AS snippet,
               html_url, pdf_url,
               ts_rank_cd(to_tsvector('simple', coalesce(abstract,'')), plainto_tsquery('simple', $1)) AS rank,
               count(*) OVER() AS _total_count
          FROM ch_court_decisions
         WHERE stage = 'loaded'
           AND ${FTS_PREDICATE}
           ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
         ORDER BY rank DESC,
                  (CASE WHEN decision_date = $2::date THEN NULL ELSE decision_date END) DESC NULLS LAST,
                  ecli
         LIMIT $${limIdx} OFFSET $${offIdx}`;

      const rows = (await this.db.query(sql, values)).rows;
      return this.wrapSearchResults(rows, lim, off);
    } catch (error: any) {
      logger.error('ch_search_court_decisions error', { error: error.message });
      return this.wrapError(`Помилка пошуку судових рішень Швейцарії: ${error.message}`);
    }
  }

  // ─── ch_get_court_decision ──────────────────────────────────────────

  private async getCourtDecision(args: Record<string, unknown>): Promise<ToolResult> {
    const { ecli, doc_id } = args as any;

    if (!ecli && !doc_id) {
      return this.wrapResponse('Вкажіть ecli або doc_id — один із параметрів обов’язковий.');
    }

    try {
      const column = ecli ? 'ecli' : 'doc_id';
      const value = ecli ? String(ecli) : String(doc_id);
      const row = (await this.db.query(
        `SELECT ecli, doc_id, spider, court_code, court_name, chamber, canton, decision_type,
                to_char(decision_date, 'YYYY-MM-DD') AS decision_date, docket_number, languages,
                parties, abstract, full_text, text_source, text_quality, html_url, pdf_url, json_url
           FROM ch_court_decisions WHERE ${column} = $1 AND stage = 'loaded'`,
        [value]
      )).rows[0];

      if (!row) {
        // Distinguish "no such row" from "row exists but is still in the pipeline" — a
        // non-loaded row has no reliable text yet, but reporting it as not_found would
        // hide that it exists and is just not ready.
        const stageRow = (await this.db.query(
          `SELECT ecli, doc_id, stage FROM ch_court_decisions WHERE ${column} = $1`,
          [value]
        )).rows[0];

        if (stageRow) {
          return this.wrapResponse({
            error: 'not_loaded',
            ecli: stageRow.ecli,
            doc_id: stageRow.doc_id,
            stage: stageRow.stage,
            message: `Це рішення ще не опрацьоване (стадія: ${stageRow.stage}) і поки не має надійного тексту.`,
          });
        }

        return this.wrapResponse({ error: 'not_found', ecli: ecli ? String(ecli) : null, doc_id: doc_id ? String(doc_id) : null });
      }

      const isPlaceholderDate = row.decision_date === PLACEHOLDER_DATE;
      const isUnknownDate = isPlaceholderDate || row.decision_date == null;

      const fullText = row.full_text ?? '';
      const fullTextLength = fullText.length;
      const truncated = fullTextLength > MAX_FULL_TEXT_CHARS;

      return this.wrapResponse({
        ecli: row.ecli,
        doc_id: row.doc_id,
        spider: row.spider,
        court_code: row.court_code,
        court_name: row.court_name,
        chamber: row.chamber,
        canton: row.canton,
        decision_type: row.decision_type,
        decision_date: isUnknownDate ? null : row.decision_date,
        decision_date_unknown: isUnknownDate,
        docket_number: row.docket_number,
        languages: row.languages,
        parties: row.parties,
        abstract: row.abstract,
        full_text: truncated ? fullText.slice(0, MAX_FULL_TEXT_CHARS) : fullText,
        full_text_truncated: truncated,
        full_text_length: fullTextLength,
        text_source: row.text_source,
        text_quality: row.text_quality,
        html_url: row.html_url,
        pdf_url: row.pdf_url,
        json_url: row.json_url,
      });
    } catch (error: any) {
      logger.error('ch_get_court_decision error', { error: error.message });
      return this.wrapError(`Помилка отримання судового рішення Швейцарії: ${error.message}`);
    }
  }
}
