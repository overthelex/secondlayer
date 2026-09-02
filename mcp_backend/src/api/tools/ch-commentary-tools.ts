/**
 * ChCommentaryTools — open-access commentaries on Swiss federal acts (`ch_commentary`,
 * migration 208), written by services/ch-pipeline commentary_stage from onlinekommentar.ch
 * (CC BY 4.0). LEXAI-2037, gap plan phase 1a.
 *
 * Two tools:
 *  - `ch_get_commentary` — the commentary of one article of one act (sr_number + article),
 *    in one language, full text. The row is keyed on the SR number the pipeline RESOLVED
 *    from the source's act id, so an article the source has commented under a different
 *    act abbreviation than the caller expects still resolves as long as the SR number is
 *    the same. Commentaries the pipeline could not place (sr_number NULL) are reachable
 *    only through search.
 *  - `ch_search_commentary` — full-text search over title + text ('simple' tsvector, the
 *    same configuration migration 134 chose for the decisions: four languages in one
 *    column), optionally narrowed to an act and a language, snippets only.
 *
 * Every row carries `licence` and `source_url`; both are returned on every hit so a
 * caller re-serving the text can attribute it, which CC BY requires.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const LANGS = ['de', 'fr', 'it', 'en'];
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const SNIPPET_WORDS = 40;
// Full text of a commentary can run to 170K characters (Art. 1b BankG, measured
// 2026-09-02). ch_get_commentary slices in SQL, the same way ch_get_act_text does,
// so a caller never receives more than it asked for and the offset is honest.
const DEFAULT_TEXT_CHARS = 20000;
const MAX_TEXT_CHARS = 200000;

const ROW_COLUMNS = `
  id, source, source_id, lang, kind, sr_number, act_title, abbr, article_number, title,
  authors, editors, to_char(version_date, 'YYYY-MM-DD') AS version_date,
  suggested_citation, licence, source_url, pdf_url`;

const FTS_EXPR = `to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content_text, ''))`;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export class ChCommentaryTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_get_commentary',
        annotations: { title: 'Коментар до статті закону Швейцарії', readOnlyHint: true },
        description: `Науково-практичний коментар до однієї статті швейцарського федерального акта з відкритого джерела onlinekommentar.ch (ліцензія CC BY 4.0; 391 коментар у кожній з мов de/fr/it/en до 23 актів: BV, ZGB, OR, ZPO, StPO, StGB, SchKG, DSG, GwG, BankG, BPR, IRSG, KG, StHG, DBG, IPRG, HMG, MepV, HRegV, KGTG, BGÖ, LugÜ, CCC).

Потрібні sr_number (напр. 952.0) та article (напр. 1b). lang типово 'de'; якщо коментаря цією мовою немає, повертаються наявні мови в available_langs. Текст віддається зрізом (text_offset / text_chars, типово перші 20 000 символів; text_total_chars — повна довжина). Кожна відповідь містить licence і source_url — їх треба наводити при цитуванні (вимога CC BY), а також suggested_citation від джерела.
Якщо коментаря немає — { error: 'not_found', sr_number, article, available_articles }.`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 952.0' },
            article: { type: 'string', description: "Номер статті, напр. '1b' або '119a'" },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Мова коментаря' },
            text_offset: { type: 'integer', minimum: 0, default: 0, description: 'Зсув у символах' },
            text_chars: { type: 'integer', minimum: 1, maximum: MAX_TEXT_CHARS, default: DEFAULT_TEXT_CHARS, description: 'Скільки символів тексту повернути' },
          },
          required: ['sr_number', 'article'],
        },
      },
      {
        name: 'ch_search_commentary',
        annotations: { title: 'Пошук у коментарях до законів Швейцарії', readOnlyHint: true },
        description: `Повнотекстовий пошук у відкритих коментарях до швейцарських федеральних актів (onlinekommentar.ch, CC BY 4.0), із фрагментами (snippet). Можна звузити до акта (sr_number) та мови (lang). Результат — заголовок, акт, стаття, автори, дата редакції, licence, source_url; повний текст — через ch_get_commentary.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Пошуковий запит (слова будь-якою з мов de/fr/it/en)' },
            sr_number: { type: 'string', description: 'Обмежити актом, напр. 220' },
            lang: { type: 'string', enum: LANGS, description: 'Обмежити мовою' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_get_commentary': return this.getCommentary(args);
      case 'ch_search_commentary': return this.searchCommentary(args);
      default: return null;
    }
  }

  private async getCommentary(args: Record<string, unknown>): Promise<ToolResult> {
    const { sr_number, article, lang = 'de' } = args as any;
    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!article || !String(article).trim()) {
      return this.wrapResponse('Вкажіть article — номер статті.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const offset = clampInt(args.text_offset, 0, 0, MAX_TEXT_CHARS * 100);
    const chars = clampInt(args.text_chars, DEFAULT_TEXT_CHARS, 1, MAX_TEXT_CHARS);
    const sr = String(sr_number).trim();
    const art = String(article).trim();

    try {
      // substr(content_text || '') rather than substr(content_text): on prod's
      // PG15/Alpine a NULL-able text through substr came back wrong once
      // (see ch_get_act_text and feedback_toast_slice_breaks_left); the
      // column is NOT NULL here, the guard costs nothing.
      const row = (await this.db.query(
        `SELECT ${ROW_COLUMNS},
                legal_text,
                substr(content_text || '', $4::int + 1, $5::int) AS text,
                length(content_text) AS text_total_chars
           FROM ch_commentary
          WHERE sr_number = $1 AND article_number = $2 AND lang = $3 AND kind = 'article'
          ORDER BY version_date DESC NULLS LAST, id
          LIMIT 1`,
        [sr, art, String(lang), offset, chars]
      )).rows[0];

      if (!row) {
        const siblings = (await this.db.query(
          `SELECT lang, article_number FROM ch_commentary
            WHERE sr_number = $1 AND kind = 'article'
            ORDER BY lang, article_number`,
          [sr]
        )).rows;
        const availableLangs = [...new Set(siblings.filter((s: any) => s.article_number === art).map((s: any) => s.lang))];
        const availableArticles = [...new Set(siblings.filter((s: any) => s.lang === String(lang)).map((s: any) => s.article_number))];
        return this.wrapResponse({
          error: 'not_found',
          sr_number: sr,
          article: art,
          lang: String(lang),
          available_langs: availableLangs,
          available_articles: availableArticles.slice(0, 200),
          available_articles_truncated: availableArticles.length > 200,
        });
      }

      const total = Number(row.text_total_chars) || 0;
      const text = String(row.text || '');
      const { text: _t, text_total_chars: _n, ...rest } = row;
      return this.wrapResponse({
        ...rest,
        text,
        text_offset: offset,
        text_total_chars: total,
        truncated: offset + text.length < total,
        attribution: `${row.suggested_citation || row.title} — ${row.source_url} (${row.licence})`,
      });
    } catch (error: any) {
      logger.error('[ChCommentaryTools] ch_get_commentary failed', { error: error.message });
      return this.wrapError(`Помилка отримання коментаря: ${error.message}`);
    }
  }

  private async searchCommentary(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, sr_number, lang } = args as any;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — пошуковий запит.');
    }
    if (lang != null && !LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const offset = clampInt(args.offset, 0, 0, 100000);

    const params: unknown[] = [String(query).trim()];
    const where = [`${FTS_EXPR} @@ plainto_tsquery('simple', $1)`];
    if (sr_number && String(sr_number).trim()) {
      params.push(String(sr_number).trim());
      where.push(`sr_number = $${params.length}`);
    }
    if (lang) {
      params.push(String(lang));
      where.push(`lang = $${params.length}`);
    }
    params.push(limit, offset);

    try {
      const rows = (await this.db.query(
        `SELECT ${ROW_COLUMNS},
                ts_rank(${FTS_EXPR}, plainto_tsquery('simple', $1)) AS rank,
                ts_headline('simple', content_text, plainto_tsquery('simple', $1),
                            'MaxWords=${SNIPPET_WORDS}, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
                COUNT(*) OVER() AS _total_count
           FROM ch_commentary
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC, version_date DESC NULLS LAST, id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )).rows;
      return this.wrapSearchResults(rows, limit, offset);
    } catch (error: any) {
      logger.error('[ChCommentaryTools] ch_search_commentary failed', { error: error.message });
      return this.wrapError(`Помилка пошуку в коментарях: ${error.message}`);
    }
  }
}
