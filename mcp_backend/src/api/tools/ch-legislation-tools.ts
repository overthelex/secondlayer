/**
 * ChLegislationTools — search, point-in-time article lookup, and amendment history over
 * the Swiss federal legislation corpus (Fedlex: `ch_act`, `ch_act_version`,
 * `ch_act_article`, `ch_act_change`, `ch_article_provenance`; see migrations
 * 197_ch_legislation_corpus.sql and 198_ch_as_bbl.sql).
 *
 * Only `stage = 'parsed'` versions are addressable editions — `discovered`/`fetched`/
 * `failed` versions have no reliable article text (same pipeline shape as
 * ch-court-tools.ts's `stage = 'loaded'` rule).
 *
 * `ch_get_act_article` resolves an edition by date rather than by version_id: Fedlex
 * publishes point-in-time consolidations, and `date_applicability <=
 * as_of < date_end_applicability` (open-ended when NULL) is how a caller finds "the text
 * of article 336 as it stood on 2016-06-01". A date before the earliest machine-readable
 * edition is reported as `no_edition_for_date`, not a false 404 on the article itself.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LANGS = ['de', 'fr', 'it'];

export class ChLegislationTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_legislation',
        annotations: { title: 'Пошук законодавства Швейцарії (Fedlex)', readOnlyHint: true },
        description: `Пошук актів швейцарського федерального законодавства (Fedlex) за номером SR, абревіатурою (напр. OR, ZGB, StGB) або назвою.

Порядок збігів: точний sr_number → точна абревіатура (без урахування регістру) → назва (ILIKE) мовою lang.
in_force_only (типово true) — лише чинні акти (enforcement_status = 0).
Результат включає editions_count і latest_edition_date — кількість і дату останньої машиночитаної (parsed) редакції мовою lang.
Далі: ch_get_act_article для тексту статті на певну дату, ch_get_act_history для історії змін.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Номер SR, абревіатура або фрагмент назви' },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Мова назви для пошуку і відображення' },
            in_force_only: { type: 'boolean', default: true, description: 'Лише чинні акти' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
            offset: { type: 'number', default: 0, description: 'Зсув для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'ch_get_act_article',
        annotations: { title: 'Стаття закону Швейцарії на певну дату', readOnlyHint: true },
        description: `Текст статті швейцарського закону (Fedlex) станом на конкретну дату (point-in-time consolidation).

Потрібні sr_number (напр. 220) та article (напр. 336 або 336a). as_of типово — сьогодні.
Редакція обирається за date_applicability <= as_of < date_end_applicability (відкрита, якщо end = NULL).
Якщо жодна редакція не покриває as_of — { error: 'no_edition_for_date', earliest_edition }.
Якщо редакція є, але статті немає — { error: 'article_not_found', available_examples }.
article_number не унікальний в межах редакції (перехідні положення можуть повторювати номер статті) — обирається стаття верхнього рівня, інші збіги повертаються в other_matches.`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220' },
            article: { type: 'string', description: "Номер статті, напр. '336' або '336a'" },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Мова редакції' },
            as_of: { type: 'string', description: 'Дата (YYYY-MM-DD), типово сьогодні' },
          },
          required: ['sr_number', 'article'],
        },
      },
      {
        name: 'ch_get_act_history',
        annotations: { title: 'Історія змін закону Швейцарії', readOnlyHint: true },
        description: `Історія редакцій та змін швейцарського закону (Fedlex): усі машиночитані редакції (editions), обчислена по-статейна різниця між редакціями (changes, з ch_act_change) та походження поправок з приміток Akoma Ntoso (provenance — action, посилання AS/RO та BBl/FF, дата набуття чинності).

Якщо вказано article — changes і provenance фільтруються по цій статті (макс. 200 рядків кожен).`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220' },
            article: { type: 'string', description: "Номер статті для фільтрації, напр. '336a'" },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Мова редакцій' },
          },
          required: ['sr_number'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_legislation': return this.searchLegislation(args);
      case 'ch_get_act_article': return this.getActArticle(args);
      case 'ch_get_act_history': return this.getActHistory(args);
      default: return null;
    }
  }

  // ─── ch_search_legislation ─────────────────────────────────────────

  private async searchLegislation(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, lang = 'de', in_force_only = true, limit = 20, offset = 0 } = args as any;

    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — номер SR, абревіатуру або назву акта.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const off = Math.max(Number(offset) || 0, 0);
    const titleCol = `title_${lang}`;

    try {
      const values: any[] = [String(query), String(lang)];
      const forceFilter = in_force_only === false ? '' : 'AND enforcement_status = 0';

      const sql = `
        SELECT act_id, sr_number, abbreviation,
               ${titleCol} AS title, title_de, title_fr, title_it,
               to_char(date_entry_force, 'YYYY-MM-DD') AS date_entry_force,
               to_char(date_no_longer_in_force, 'YYYY-MM-DD') AS date_no_longer_in_force,
               in_force, eli_work_uri,
               (SELECT count(*)::int FROM ch_act_version v
                 WHERE v.act_id = a.act_id AND v.lang = $2 AND v.stage = 'parsed') AS editions_count,
               (SELECT to_char(max(v.date_applicability), 'YYYY-MM-DD') FROM ch_act_version v
                 WHERE v.act_id = a.act_id AND v.lang = $2 AND v.stage = 'parsed') AS latest_edition_date,
               count(*) OVER() AS _total_count
          FROM ch_act a
         WHERE (sr_number = $1 OR lower(abbreviation) = lower($1) OR ${titleCol} ILIKE '%' || $1 || '%')
           ${forceFilter}
         ORDER BY CASE WHEN sr_number = $1 THEN 0
                       WHEN lower(abbreviation) = lower($1) THEN 1
                       ELSE 2 END,
                  in_force DESC,
                  date_entry_force DESC NULLS LAST,
                  a.act_id
         LIMIT $3 OFFSET $4`;

      const rows = (await this.db.query(sql, [...values, lim, off])).rows;
      return this.wrapSearchResults(rows, lim, off);
    } catch (error: any) {
      logger.error('ch_search_legislation error', { error: error.message });
      return this.wrapError(`Помилка пошуку законодавства Швейцарії: ${error.message}`);
    }
  }

  // ─── ch_get_act_article ─────────────────────────────────────────────

  private async getActArticle(args: Record<string, unknown>): Promise<ToolResult> {
    const { sr_number, article, lang = 'de', as_of } = args as any;

    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!article || !String(article).trim()) {
      return this.wrapResponse('Вкажіть article — номер статті.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    if (as_of && !DATE_RE.test(String(as_of))) {
      return this.wrapResponse('as_of має бути у форматі YYYY-MM-DD.');
    }

    try {
      const act = (await this.db.query(
        `SELECT act_id, sr_number, abbreviation, title_de, title_fr, title_it
           FROM ch_act WHERE sr_number = $1
          ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
          LIMIT 1`,
        [String(sr_number)]
      )).rows[0];

      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', sr_number: String(sr_number) });
      }

      let asOfDate: string;
      if (as_of) {
        asOfDate = String(as_of);
      } else {
        asOfDate = (await this.db.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d;
      }

      const edition = (await this.db.query(
        `SELECT version_id, eli_consolidation_uri,
                to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                to_char(date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability
           FROM ch_act_version
          WHERE act_id = $1 AND lang = $2 AND stage = 'parsed'
            AND date_applicability <= $3::date
            AND (date_end_applicability IS NULL OR $3::date < date_end_applicability)
          ORDER BY date_applicability DESC
          LIMIT 1`,
        [act.act_id, String(lang), asOfDate]
      )).rows[0];

      if (!edition) {
        const earliest = (await this.db.query(
          `SELECT to_char(min(date_applicability), 'YYYY-MM-DD') AS earliest
             FROM ch_act_version
            WHERE act_id = $1 AND lang = $2 AND stage = 'parsed'`,
          [act.act_id, String(lang)]
        )).rows[0];

        return this.wrapResponse({
          error: 'no_edition_for_date',
          earliest_edition: earliest?.earliest ?? null,
        });
      }

      // article_number is not unique within a version (a transitional provision can repeat
      // the number of the article it amends under a disposition path, e.g.
      // 'disp_u17/art_7'). The top-level provision (e_id without a '/') is preferred;
      // anything else matching the same number is reported via other_matches instead of
      // silently winning or losing depending on ordinal order.
      const articleMatches = (await this.db.query(
        `SELECT e_id, article_number, marginal_note, text
           FROM ch_act_article
          WHERE version_id = $1 AND article_number = $2
          ORDER BY (e_id LIKE '%/%'), ordinal`,
        [edition.version_id, String(article)]
      )).rows;

      if (articleMatches.length === 0) {
        const examples = (await this.db.query(
          `SELECT article_number FROM ch_act_article
            WHERE version_id = $1
            ORDER BY ordinal
            LIMIT 5`,
          [edition.version_id]
        )).rows.map((r: any) => r.article_number);

        return this.wrapResponse({
          error: 'article_not_found',
          available_examples: examples,
        });
      }

      const [articleRow, ...otherMatches] = articleMatches;

      const editionsMeta = (await this.db.query(
        `SELECT count(*)::int AS total, to_char(max(date_applicability), 'YYYY-MM-DD') AS latest_date
           FROM ch_act_version
          WHERE act_id = $1 AND lang = $2 AND stage = 'parsed'`,
        [act.act_id, String(lang)]
      )).rows[0];

      const otherEditionsCount = Math.max(Number(editionsMeta?.total ?? 1) - 1, 0);
      const isLatestEdition = editionsMeta?.latest_date === edition.date_applicability;

      let note: string | undefined;
      if (isLatestEdition) {
        note = otherEditionsCount > 0
          ? `Це текст редакції, чинної станом на ${asOfDate}. Крім неї, для цього акта доступно ще ${otherEditionsCount} машиночитаних редакцій.`
          : 'На Fedlex для цього акта доступна лише одна машиночитана редакція; попередні редакції існують лише у форматі PDF.';
      }

      return this.wrapResponse({
        sr_number: act.sr_number,
        abbreviation: act.abbreviation,
        title: act[`title_${lang}`],
        lang: String(lang),
        as_of: asOfDate,
        version: {
          version_id: edition.version_id,
          date_applicability: edition.date_applicability,
          date_end_applicability: edition.date_end_applicability,
          eli_consolidation_uri: edition.eli_consolidation_uri,
        },
        article: {
          e_id: articleRow.e_id,
          article_number: articleRow.article_number,
          marginal_note: articleRow.marginal_note,
          text: articleRow.text,
        },
        other_matches: otherMatches.map((r: any) => ({ e_id: r.e_id, marginal_note: r.marginal_note })),
        other_editions: otherEditionsCount,
        ...(note ? { note } : {}),
      });
    } catch (error: any) {
      logger.error('ch_get_act_article error', { error: error.message });
      return this.wrapError(`Помилка отримання статті закону Швейцарії: ${error.message}`);
    }
  }

  // ─── ch_get_act_history ─────────────────────────────────────────────

  private async getActHistory(args: Record<string, unknown>): Promise<ToolResult> {
    const { sr_number, article, lang = 'de' } = args as any;

    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }

    try {
      const act = (await this.db.query(
        `SELECT act_id, sr_number, abbreviation FROM ch_act WHERE sr_number = $1
          ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
          LIMIT 1`,
        [String(sr_number)]
      )).rows[0];

      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', sr_number: String(sr_number) });
      }

      const articleFilter = article ? String(article) : null;

      const editions = (await this.db.query(
        `SELECT to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                to_char(date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability,
                article_count
           FROM ch_act_version
          WHERE act_id = $1 AND lang = $2 AND stage = 'parsed'
          ORDER BY date_applicability ASC`,
        [act.act_id, String(lang)]
      )).rows;

      const changes = (await this.db.query(
        `SELECT to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                change_type, article_number, e_id
           FROM ch_act_change
          WHERE act_id = $1 AND lang = $2
            AND ($3::text IS NULL OR article_number = $3)
          ORDER BY date_applicability DESC
          LIMIT 200`,
        [act.act_id, String(lang), articleFilter]
      )).rows;

      const provenance = (await this.db.query(
        `SELECT p.e_id, p.action, p.as_reference, p.bbl_reference,
                to_char(p.effective_date, 'YYYY-MM-DD') AS effective_date
           FROM ch_article_provenance p
           JOIN ch_act_version v ON v.version_id = p.version_id
          WHERE v.act_id = $1 AND v.lang = $2
            AND ($3::text IS NULL OR p.e_id IN (
                  SELECT DISTINCT a.e_id
                    FROM ch_act_article a
                    JOIN ch_act_version v2 ON v2.version_id = a.version_id
                   WHERE v2.act_id = $1 AND a.article_number = $3))
          ORDER BY p.effective_date DESC NULLS LAST
          LIMIT 200`,
        [act.act_id, String(lang), articleFilter]
      )).rows;

      return this.wrapResponse({
        sr_number: act.sr_number,
        abbreviation: act.abbreviation,
        editions,
        changes,
        changes_truncated: changes.length === 200,
        provenance,
        provenance_truncated: provenance.length === 200,
      });
    } catch (error: any) {
      logger.error('ch_get_act_history error', { error: error.message });
      return this.wrapError(`Помилка отримання історії закону Швейцарії: ${error.message}`);
    }
  }
}
