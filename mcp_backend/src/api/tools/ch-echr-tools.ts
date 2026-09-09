/**
 * ChEchrTools — European Court of Human Rights documents for Swiss practice
 * (`echr_cases`, migration 215), written by services/ch-pipeline echr_import_stage from
 * the HUDOC harvest. LEXAI-2040, gap plan phase 3.
 *
 * What is in the table on lawrider: every HUDOC document with Switzerland as respondent
 * (judgments, decisions, communicated cases, execution resolutions, Commission reports,
 * Information Note summaries, translations), plus every Chamber and Grand Chamber judgment
 * of importance 1–3 in English and French — the leading cases a Swiss court cites whatever
 * the respondent.
 *
 * Two tools:
 *  - `ch_search_echr` — full-text search over title + text ('simple' stored tsvector, the
 *    210 pattern), narrowed by respondent (default CHE), document kind, language,
 *    importance, Convention article, date range. Snippets only.
 *  - `ch_get_echr_case` — one document by HUDOC item_id or by application number, full
 *    text in slices (text_offset / text_chars), the same shape as ch_get_commentary.
 *
 * HUDOC's texts are the Court's own publications (© Council of Europe, reproduction
 * permitted with attribution); every row carries `hudoc_url`.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const SNIPPET_WORDS = 40;
const DEFAULT_TEXT_CHARS = 20000;
const MAX_TEXT_CHARS = 200000;

/** HUDOC doctype prefixes → what a lawyer calls the document. */
const KINDS: Record<string, string[]> = {
  judgment: ['HEJUD', 'HFJUD'],
  decision: ['HEDEC', 'HFDEC'],
  communicated: ['HECOM', 'HFCOM'],
  resolution: ['HERES54', 'HFRES54', 'HERES', 'HFRES'],
  report: ['HEREP', 'HFREP'],
  summary: ['CLIN', 'CLINF'],
  translation: [], // any doctype ending in a language code other than ENG/FRE: HJUDGER, HJUDITA, ...
};
const KIND_NAMES = Object.keys(KINDS);

/** Tool-facing language codes → HUDOC's languageisocode. */
const LANGS: Record<string, string> = { en: 'ENG', fr: 'FRE', de: 'GER', it: 'ITA' };

const ROW_COLUMNS = `
  item_id, app_no, doc_name, doc_type, importance, to_char(judgment_date, 'YYYY-MM-DD') AS judgment_date,
  conclusion, respondent, language_iso, document_collection_id2, ecli,
  'https://hudoc.echr.coe.int/eng?i=' || item_id AS hudoc_url`;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isoDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export class ChEchrTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_echr',
        annotations: { title: 'Пошук практики ЄСПЛ (Швейцарія)', readOnlyHint: true },
        description: `Повнотекстовий пошук у практиці Європейського суду з прав людини з корпусу HUDOC: усі документи, де відповідач — Швейцарія (рішення, ухвали про прийнятність, комуніковані справи, резолюції про виконання, доповіді Комісії, резюме Information Note, переклади), плюс усі рішення Палати та Великої палати важливості 1–3 англійською і французькою (провідні справи, на які посилаються швейцарські суди незалежно від відповідача).

Типово respondent='CHE'; respondent='' (порожній рядок) — шукати по всьому корпусу. kind: judgment | decision | communicated | resolution | report | summary | translation. lang: en | fr | de | it. importance: 1 (ключова) … 4. article — стаття Конвенції, як HUDOC пише її в conclusion (напр. '8', 'P1-1'). Результат — назва справи, номер заяви, дата, висновок, hudoc_url; повний текст — через ch_get_echr_case.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Пошуковий запит (слова англійською/французькою; для перекладів — німецькою/італійською)' },
            respondent: { type: 'string', default: 'CHE', description: "Код держави-відповідача (HUDOC, 3 літери); '' — без обмеження" },
            kind: { type: 'string', enum: KIND_NAMES, description: 'Вид документа' },
            lang: { type: 'string', enum: Object.keys(LANGS), description: 'Мова документа' },
            importance: { type: 'integer', minimum: 1, maximum: 4, description: 'Рівень важливості за HUDOC (1 — ключова справа)' },
            article: { type: 'string', description: "Стаття Конвенції у висновку, напр. '6', '8', 'P1-1'" },
            date_from: { type: 'string', description: 'Від дати (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'До дати (YYYY-MM-DD)' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          required: ['query'],
        },
      },
      {
        name: 'ch_get_echr_case',
        annotations: { title: 'Документ ЄСПЛ (HUDOC)', readOnlyHint: true },
        description: `Один документ ЄСПЛ з корпусу HUDOC за item_id (напр. 001-92353) або за номером заяви app_no (напр. 41773/98; тоді повертається рішення по суті, якщо є, інакше найновіший документ, і список решти документів справи в related). Текст віддається зрізом (text_offset / text_chars, типово перші 20 000 символів; text_total_chars — повна довжина; text NULL, якщо HUDOC не віддав текст). Якщо документа немає — { error: 'not_found' }.`,
        inputSchema: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: 'HUDOC item id, напр. 001-92353' },
            app_no: { type: 'string', description: 'Номер заяви, напр. 41773/98' },
            lang: { type: 'string', enum: Object.keys(LANGS), description: 'Мова (при пошуку за app_no)' },
            text_offset: { type: 'integer', minimum: 0, default: 0 },
            text_chars: { type: 'integer', minimum: 1, maximum: MAX_TEXT_CHARS, default: DEFAULT_TEXT_CHARS },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_echr': return this.search(args);
      case 'ch_get_echr_case': return this.getCase(args);
      default: return null;
    }
  }

  private async search(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, kind, lang, article, date_from, date_to } = args as any;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — пошуковий запит.');
    }
    if (kind != null && !KIND_NAMES.includes(String(kind))) {
      return this.wrapResponse(`kind має бути одним з: ${KIND_NAMES.join(', ')}.`);
    }
    if (lang != null && !LANGS[String(lang)]) {
      return this.wrapResponse(`lang має бути одним з: ${Object.keys(LANGS).join(', ')}.`);
    }
    const respondent = args.respondent === undefined ? 'CHE' : String(args.respondent).trim().toUpperCase();
    const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const offset = clampInt(args.offset, 0, 0, 100000);

    const params: unknown[] = [String(query).trim()];
    const where = [`tsv @@ plainto_tsquery('simple', $1)`];
    if (respondent) {
      // respondent is "CHE" or "CHE;ITA": a whole code, not a substring
      params.push(respondent);
      where.push(`$${params.length} = ANY(string_to_array(coalesce(respondent, ''), ';'))`);
    }
    if (kind) {
      if (kind === 'translation') {
        where.push(`doc_type ~ '^H(JUD|DEC)[A-Z]{3}$' AND language_iso NOT IN ('ENG', 'FRE')`);
      } else {
        params.push(KINDS[String(kind)]);
        where.push(`doc_type = ANY($${params.length}::text[])`);
      }
    }
    if (lang) {
      params.push(LANGS[String(lang)]);
      where.push(`language_iso = $${params.length}`);
    }
    if (args.importance != null) {
      params.push(clampInt(args.importance, 4, 1, 4));
      where.push(`importance = $${params.length}`);
    }
    if (article && String(article).trim()) {
      // HUDOC writes "Violation of Art. 8", "No violation of P1-1", "Art. 6-1"
      params.push(`(^|[^0-9A-Z-])(Art\\. )?${String(article).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`);
      where.push(`coalesce(conclusion, '') ~ $${params.length}`);
    }
    const from = isoDate(date_from);
    if (from) { params.push(from); where.push(`judgment_date >= $${params.length}::date`); }
    const to = isoDate(date_to);
    if (to) { params.push(to); where.push(`judgment_date <= $${params.length}::date`); }
    params.push(limit, offset);

    try {
      const rows = (await this.db.query(
        `SELECT ${ROW_COLUMNS},
                ts_rank(tsv, plainto_tsquery('simple', $1)) AS rank,
                ts_headline('simple', coalesce(full_text, doc_name, ''), plainto_tsquery('simple', $1),
                            'MaxWords=${SNIPPET_WORDS}, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
                full_text IS NOT NULL AS has_text,
                COUNT(*) OVER() AS _total_count
           FROM echr_cases
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC, importance ASC NULLS LAST, judgment_date DESC NULLS LAST, item_id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )).rows;
      return this.wrapSearchResults(rows, limit, offset, '© Council of Europe / European Court of Human Rights, HUDOC');
    } catch (error: any) {
      logger.error('[ChEchrTools] ch_search_echr failed', { error: error.message });
      return this.wrapError(`Помилка пошуку в практиці ЄСПЛ: ${error.message}`);
    }
  }

  private async getCase(args: Record<string, unknown>): Promise<ToolResult> {
    const itemId = String(args.item_id ?? '').trim();
    const appNo = String(args.app_no ?? '').trim();
    const lang = args.lang != null ? String(args.lang) : null;
    if (!itemId && !appNo) {
      return this.wrapResponse('Вкажіть item_id (напр. 001-92353) або app_no (напр. 41773/98).');
    }
    if (lang != null && !LANGS[lang]) {
      return this.wrapResponse(`lang має бути одним з: ${Object.keys(LANGS).join(', ')}.`);
    }
    const offset = clampInt(args.text_offset, 0, 0, MAX_TEXT_CHARS * 100);
    const chars = clampInt(args.text_chars, DEFAULT_TEXT_CHARS, 1, MAX_TEXT_CHARS);

    try {
      const params: unknown[] = [offset, chars];
      let where: string;
      if (itemId) {
        params.push(itemId);
        where = `item_id = $3`;
      } else {
        params.push(appNo);
        where = `$3 = ANY(string_to_array(coalesce(app_no, ''), ';'))`;
        if (lang) { params.push(LANGS[lang]); where += ` AND language_iso = $4`; }
      }
      const row = (await this.db.query(
        `SELECT ${ROW_COLUMNS},
                substr(full_text || '', $1::int + 1, $2::int) AS text,
                length(full_text) AS text_total_chars
           FROM echr_cases
          WHERE ${where}
          ORDER BY (doc_type IN ('HEJUD', 'HFJUD')) DESC, judgment_date DESC NULLS LAST, item_id
          LIMIT 1`,
        params
      )).rows[0];
      if (!row) {
        return this.wrapResponse({ error: 'not_found', item_id: itemId || null, app_no: appNo || null });
      }
      const related = appNo || row.app_no
        ? (await this.db.query(
            `SELECT item_id, doc_type, language_iso, to_char(judgment_date, 'YYYY-MM-DD') AS judgment_date, doc_name
               FROM echr_cases
              WHERE $1 = ANY(string_to_array(coalesce(app_no, ''), ';')) AND item_id <> $2
              ORDER BY judgment_date DESC NULLS LAST, item_id
              LIMIT 50`,
            [appNo || String(row.app_no).split(';')[0], row.item_id]
          )).rows
        : [];
      const total = Number(row.text_total_chars) || 0;
      const text = row.text_total_chars == null ? null : String(row.text || '');
      const { text: _t, text_total_chars: _n, ...rest } = row;
      return this.wrapResponse({
        ...rest,
        text,
        text_offset: offset,
        text_total_chars: total,
        truncated: text != null && offset + text.length < total,
        related,
        attribution: `${row.doc_name} — ${row.hudoc_url} (© Council of Europe / ECHR)`,
      });
    } catch (error: any) {
      logger.error('[ChEchrTools] ch_get_echr_case failed', { error: error.message });
      return this.wrapError(`Помилка отримання документа ЄСПЛ: ${error.message}`);
    }
  }
}
