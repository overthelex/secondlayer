/**
 * ChLegislationTools — search, point-in-time article lookup, and amendment history over
 * the Swiss legislation corpus: federal (Fedlex) and cantonal (Lexwork, 19 cantons), in
 * `ch_act`, `ch_act_version`, `ch_act_article`, `ch_act_change`, `ch_article_provenance`
 * (see migrations 197_ch_legislation_corpus.sql, 198_ch_as_bbl.sql and
 * 201_ch_cantonal_legislation.sql).
 *
 * `ch_act.jurisdiction` is 'CH' for federal acts or a two-letter canton code (ZH, BE,
 * ...). Every tool takes an optional `canton` that defaults to 'CH', so callers that
 * predate the cantonal corpus keep seeing federal acts only. `sr_number` is not unique
 * even within one jurisdiction (an act can be re-issued under the same number), so the
 * act lookups keep the `enforcement_status = 0 DESC ... LIMIT 1` preference. Aliases
 * (`ch_act_alias`) are federal only and are never matched against cantonal acts.
 *
 * Only `stage = 'parsed'` versions are addressable editions — `discovered`/`fetched`/
 * `failed` versions have no reliable article text (same pipeline shape as
 * ch-court-tools.ts's `stage = 'loaded'` rule).
 *
 * `ch_get_act_article` resolves an edition by date rather than by version_id: Fedlex
 * publishes point-in-time consolidations, and `date_applicability <= as_of AND (as_of <=
 * date_end_applicability OR date_end_applicability IS NULL)` (open-ended when NULL) is
 * how a caller finds "the text of article 336 as it stood on 2016-06-01".
 * `date_end_applicability` is the LAST DAY the edition is in force (inclusive), not an
 * exclusive end — verified against prod on 2026-08-23: across 19,428 consecutive parsed
 * editions of the same act/lang, `next.date_applicability = prev.date_end_applicability +
 * 1 day` (e.g. SR 220 de: 2021-01-01..2021-01-31, 2021-02-01..2021-04-30). A `<` predicate
 * against `date_end_applicability` therefore skips the correct edition (or finds none) on
 * an edition's own last day. A date before the earliest machine-readable edition is
 * reported as `no_edition_for_date`, not a false 404 on the article itself.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { isValidIsoDate } from './ch-date-utils.js';

const LANGS = ['de', 'fr', 'it'];

// Escapes POSIX/ARE regex metacharacters in a caller-supplied token before it is
// embedded in a Postgres `~*` pattern (used for the word-bounded short-query title
// match below) — the token itself is still sent as a bound parameter, this only makes
// it safe to concatenate into the pattern string on the Postgres side.
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_JURISDICTION = 'CH';
const CANTON_CODE_RE = /^[A-Z]{2}$/;
const ALL_JURISDICTIONS = 'all';

// Resolves the `canton` argument to the jurisdiction value bound in SQL. Absent means
// federal ('CH'). 'all' (no jurisdiction filter) is only meaningful for search, where the
// result rows carry their own jurisdiction; a single-act lookup has to name one.
// Anything else must be a two-letter upper-case code. Returns a Ukrainian message when
// the value is rejected so the caller can wrap it without running a query.
function resolveCanton(
  value: unknown,
  allowAll: boolean
): { jurisdiction: string } | { message: string } {
  if (value === undefined || value === null) {
    return { jurisdiction: DEFAULT_JURISDICTION };
  }
  const canton = String(value);
  if (allowAll && canton === ALL_JURISDICTIONS) {
    return { jurisdiction: ALL_JURISDICTIONS };
  }
  if (CANTON_CODE_RE.test(canton)) {
    return { jurisdiction: canton };
  }
  return {
    message: allowAll
      ? "canton має бути 'CH', кодом кантону з двох великих літер (напр. ZH, BE) або 'all' (усі юрисдикції)."
      : "canton має бути 'CH' або кодом кантону з двох великих літер (напр. ZH, BE).",
  };
}

function cantonSchema(allowAll: boolean) {
  return {
    type: 'string',
    default: DEFAULT_JURISDICTION,
    description: allowAll
      ? "Юрисдикція: 'CH' (федеральне, за замовчуванням), код кантону (ZH, BE, ...) або 'all' (усі юрисдикції)"
      : "Юрисдикція: 'CH' (федеральне, за замовчуванням) або код кантону (ZH, BE, ...)",
  };
}

export class ChLegislationTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_legislation',
        annotations: { title: 'Пошук законодавства Швейцарії (Fedlex та кантони)', readOnlyHint: true },
        description: `Пошук актів швейцарського федерального (Fedlex) та кантонального (19 кантонів) законодавства за номером SR (або кантональним номером збірки), абревіатурою (напр. OR, ZGB, StGB) або назвою.

canton (типово 'CH') задає юрисдикцію: 'CH' для федеральних актів, код кантону (ZH, BE, ...) для кантональних, 'all' для пошуку в усіх юрисдикціях. Кожен результат містить поле jurisdiction.
Порядок збігів: точний sr_number → точна абревіатура (без урахування регістру; абревіатури-синоніми лише для федеральних актів) → назва (ILIKE) мовою lang.
in_force_only (типово true) — лише чинні акти (enforcement_status = 0).
Результат включає editions_count і latest_edition_date — кількість і дату останньої машиночитаної (parsed) редакції мовою lang.
Далі: ch_get_act_article для тексту статті на певну дату, ch_get_act_history для історії змін (передавайте той самий canton).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Номер SR, абревіатура або фрагмент назви' },
            canton: cantonSchema(true),
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
        description: `Текст статті швейцарського закону, федерального (Fedlex) та кантонального (19 кантонів), станом на конкретну дату (point-in-time consolidation).

Потрібні sr_number (напр. 220) та article (напр. 336 або 336a). canton (типово 'CH') задає юрисдикцію акта: 'CH' або код кантону (ZH, BE, ...); у відповіді є поле jurisdiction. as_of типово — сьогодні.
Редакція чинна з date_applicability по date_end_applicability включно (відкрита, якщо end = NULL) — обирається та, для якої date_applicability <= as_of <= date_end_applicability.
Якщо жодна редакція не покриває as_of — { error: 'no_edition_for_date', earliest_edition }.
Якщо редакція є, але статті немає — { error: 'article_not_found', available_examples }.
article_number не унікальний в межах редакції (перехідні положення можуть повторювати номер статті) — обирається стаття верхнього рівня, інші збіги повертаються в other_matches.`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220' },
            canton: cantonSchema(false),
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
        description: `Історія редакцій та змін швейцарського закону, федерального (Fedlex) та кантонального (19 кантонів): усі машиночитані редакції (editions), обчислена по-статейна різниця між редакціями (changes, з ch_act_change) та походження поправок з приміток Akoma Ntoso (provenance — action, посилання AS/RO та BBl/FF, дата набуття чинності).

canton (типово 'CH') задає юрисдикцію акта: 'CH' або код кантону (ZH, BE, ...); у відповіді є поле jurisdiction.
Якщо вказано article — changes і provenance фільтруються по цій статті (макс. 200 рядків кожен).`,
        inputSchema: {
          type: 'object',
          properties: {
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220' },
            canton: cantonSchema(false),
            article: { type: 'string', description: "Номер статті для фільтрації, напр. '336a'" },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Мова редакцій' },
          },
          required: ['sr_number'],
        },
      },
      {
        name: 'ch_get_act_text',
        annotations: { title: 'Повний текст акта Швейцарії на певну дату', readOnlyHint: true },
        description: `Повний текст швейцарського акта в редакції, чинній на задану дату.

Обов'язково рівно один з act_id або sr_number (для sr_number резолвиться федеральний акт, чинний пріоритетно, як і в інших ch_* інструментах). as_of — обов'язкова дата (YYYY-MM-DD).
Джерело тексту різне для різних редакцій: для новіших (XML, Fedlex) текст збирається зі статей (ch_act_article); для давніх, доступних лише як PDF ("pdf-era"), текст зберігається цілком у full_text. Поле edition.source показує, яке джерело обслужило запит.
Якщо жодна редакція не покриває as_of — обирається найдавніша машиночитана редакція акта, а retrieval_status='nearest_later_edition' (замість 'edition_at_date'). Якщо машиночитаних редакцій немає взагалі — { error: 'no_edition_for_date', earliest_edition: null }.
lang (типово 'de') — бажана мова; якщо редакції цією мовою немає, обслуговується німецька (lang у відповіді показує фактичну мову, requested_lang — запитану).
offset/max_chars керують посторінковим читанням довгого тексту (max_chars типово 50000, максимум 200000); truncated=true, якщо текст не вміщено повністю.`,
        inputSchema: {
          type: 'object',
          properties: {
            act_id: { type: 'number', description: 'Внутрішній ідентифікатор акта (альтернатива sr_number)' },
            sr_number: { type: 'string', description: 'Номер SR акта, напр. 220 (альтернатива act_id)' },
            as_of: { type: 'string', description: 'Дата (YYYY-MM-DD), станом на яку потрібна редакція' },
            lang: { type: 'string', enum: LANGS, default: 'de', description: 'Бажана мова редакції' },
            offset: { type: 'number', default: 0, description: 'Зсув у символах для посторінкового читання' },
            max_chars: { type: 'number', default: 50000, maximum: 200000, description: 'Макс. символів у відповіді (макс. 200000)' },
          },
          required: ['as_of'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_legislation': return this.searchLegislation(args);
      case 'ch_get_act_article': return this.getActArticle(args);
      case 'ch_get_act_history': return this.getActHistory(args);
      case 'ch_get_act_text': return this.getActText(args);
      default: return null;
    }
  }

  // ─── ch_search_legislation ─────────────────────────────────────────

  private async searchLegislation(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, canton, lang = 'de', in_force_only = true, limit = 20, offset = 0 } = args as any;

    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — номер SR, абревіатуру або назву акта.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const resolved = resolveCanton(canton, true);
    if ('message' in resolved) {
      return this.wrapResponse(resolved.message);
    }
    const jurisdiction = resolved.jurisdiction;

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const off = Math.max(Number(offset) || 0, 0);
    const titleCol = `title_${lang}`;
    const rawQuery = String(query);

    try {
      const values: any[] = [rawQuery, String(lang)];
      let pi = 3;
      const forceFilter = in_force_only === false ? '' : 'AND enforcement_status = 0';

      // A 1-5 char query with no whitespace is almost always an abbreviation (CO, OR,
      // ZGB, StGB) — match the title on a word boundary instead of a bare ILIKE
      // substring, so e.g. "CO" does not match inside "comptabilité" or other unrelated
      // words. Longer / multi-word queries keep the original substring match.
      const isShortToken = rawQuery.length >= 1 && rawQuery.length <= 5 && !/\s/.test(rawQuery);
      let titleMatchExpr: string;
      if (isShortToken) {
        values.push(escapeRegexLiteral(rawQuery));
        titleMatchExpr = `${titleCol} ~* ('\\m' || $${pi} || '\\M')`;
        pi++;
      } else {
        titleMatchExpr = `${titleCol} ILIKE '%' || $1 || '%'`;
      }

      // ch_act_alias (abbr, lang, sr_number, source) is a curated table of non-German
      // abbreviations (e.g. 'CO' → SR 220 in fr) that arrives with PR #2342 and may not
      // exist yet. Guard its use with a runtime check so the SQL text never references
      // the table when it is absent — referencing a nonexistent table is a hard error,
      // not a zero-match no-op.
      const aliasTableExists = (await this.db.query(
        `SELECT to_regclass('public.ch_act_alias') IS NOT NULL AS alias_table_exists`
      )).rows[0].alias_table_exists === true;

      // Aliases are curated for federal acts only: a cantonal act that happens to share an
      // sr_number with a federal one must not inherit the federal abbreviation hit.
      const aliasJoin = aliasTableExists
        ? `LEFT JOIN LATERAL (
             SELECT bool_or(al.lang = $2) AS lang_hit
               FROM ch_act_alias al
              WHERE al.sr_number = a.sr_number AND lower(al.abbr) = lower($1)
                AND a.jurisdiction = 'CH'
           ) alias_match ON true`
        : '';
      const aliasMatchCond = aliasTableExists ? 'OR alias_match.lang_hit IS NOT NULL' : '';
      const aliasTierCond = aliasTableExists ? 'WHEN alias_match.lang_hit IS NOT NULL THEN 1' : '';
      const aliasTieBreak = aliasTableExists ? 'COALESCE(alias_match.lang_hit, false) DESC,' : '';

      const jurIdx = pi; values.push(jurisdiction); pi++;
      const limIdx = pi; values.push(lim); pi++;
      const offIdx = pi; values.push(off); pi++;

      const sql = `
        SELECT act_id, sr_number, abbreviation,
               ${titleCol} AS title, title_de, title_fr, title_it,
               to_char(date_entry_force, 'YYYY-MM-DD') AS date_entry_force,
               to_char(date_no_longer_in_force, 'YYYY-MM-DD') AS date_no_longer_in_force,
               in_force, eli_work_uri, a.jurisdiction,
               (SELECT count(*)::int FROM ch_act_version v
                 WHERE v.act_id = a.act_id AND v.lang = $2 AND v.stage = 'parsed') AS editions_count,
               (SELECT to_char(max(v.date_applicability), 'YYYY-MM-DD') FROM ch_act_version v
                 WHERE v.act_id = a.act_id AND v.lang = $2 AND v.stage = 'parsed') AS latest_edition_date,
               count(*) OVER() AS _total_count
          FROM ch_act a
          ${aliasJoin}
         WHERE (sr_number = $1 OR lower(abbreviation) = lower($1) ${aliasMatchCond} OR ${titleMatchExpr})
           AND ($${jurIdx} = 'all' OR a.jurisdiction = $${jurIdx})
           ${forceFilter}
         ORDER BY CASE WHEN sr_number = $1 THEN 0
                       WHEN lower(abbreviation) = lower($1) THEN 1
                       ${aliasTierCond}
                       ELSE 2 END,
                  ${aliasTieBreak}
                  in_force DESC,
                  date_entry_force DESC NULLS LAST,
                  a.act_id
         LIMIT $${limIdx} OFFSET $${offIdx}`;

      const rows = (await this.db.query(sql, values)).rows;
      return this.wrapSearchResults(rows, lim, off);
    } catch (error: any) {
      logger.error('ch_search_legislation error', { error: error.message });
      return this.wrapError(`Помилка пошуку законодавства Швейцарії: ${error.message}`);
    }
  }

  // ─── ch_get_act_article ─────────────────────────────────────────────

  private async getActArticle(args: Record<string, unknown>): Promise<ToolResult> {
    const { sr_number, canton, article, lang = 'de', as_of } = args as any;

    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!article || !String(article).trim()) {
      return this.wrapResponse('Вкажіть article — номер статті.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    if (as_of && !isValidIsoDate(String(as_of))) {
      return this.wrapResponse('as_of має бути у форматі YYYY-MM-DD.');
    }
    const resolved = resolveCanton(canton, false);
    if ('message' in resolved) {
      return this.wrapResponse(resolved.message);
    }
    const jurisdiction = resolved.jurisdiction;

    try {
      const act = (await this.db.query(
        `SELECT act_id, sr_number, abbreviation, title_de, title_fr, title_it, jurisdiction
           FROM ch_act WHERE jurisdiction = $2 AND sr_number = $1
          ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
          LIMIT 1`,
        [String(sr_number), jurisdiction]
      )).rows[0];

      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', sr_number: String(sr_number), jurisdiction });
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
            -- date_end_applicability is the LAST DAY the edition is in force (inclusive),
            -- not an exclusive end. Verified against prod on 2026-08-23: across 19,428
            -- consecutive parsed editions of the same act/lang, next.date_applicability =
            -- prev.date_end_applicability + 1 day (e.g. SR 220 de: 2021-01-01..2021-01-31,
            -- 2021-02-01..2021-04-30). A '<' predicate here would skip this edition (or find
            -- none) on its own last day.
            AND date_applicability <= $3::date
            AND ($3::date <= date_end_applicability OR date_end_applicability IS NULL)
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
          : act.jurisdiction === 'CH'
            ? 'На Fedlex для цього акта доступна лише одна машиночитана редакція; попередні редакції існують лише у форматі PDF.'
            : 'У кантональному збірнику для цього акта доступна лише одна редакція.';
      }

      return this.wrapResponse({
        sr_number: act.sr_number,
        jurisdiction: act.jurisdiction,
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
    const { sr_number, canton, article, lang = 'de' } = args as any;

    if (!sr_number || !String(sr_number).trim()) {
      return this.wrapResponse('Вкажіть sr_number — номер SR акта.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }
    const resolved = resolveCanton(canton, false);
    if ('message' in resolved) {
      return this.wrapResponse(resolved.message);
    }
    const jurisdiction = resolved.jurisdiction;

    try {
      const act = (await this.db.query(
        `SELECT act_id, sr_number, abbreviation, jurisdiction
           FROM ch_act WHERE jurisdiction = $2 AND sr_number = $1
          ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
          LIMIT 1`,
        [String(sr_number), jurisdiction]
      )).rows[0];

      if (!act) {
        return this.wrapResponse({ error: 'not_found', entity: 'act', sr_number: String(sr_number), jurisdiction });
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

      // e_id is only meaningful within its own edition (version_id) — the same e_id can
      // denote a different article_number in another edition. Correlate the article-number
      // filter to the provenance row's own version, not across every version of the act.
      //
      // A parsed footnote is repeated verbatim on every edition that carries the article it
      // documents, so the same (e_id, action, as_reference, bbl_reference, effective_date)
      // tuple shows up once per edition. De-duplicate on that tuple, keeping the row from
      // the earliest edition (smallest v.date_applicability) as the representative.
      const provenanceRows = (await this.db.query(
        `SELECT e_id, action, as_reference, bbl_reference, effective_date
           FROM (
             SELECT DISTINCT ON (p.e_id, p.action, p.as_reference, p.bbl_reference, p.effective_date)
                    p.e_id, p.action, p.as_reference, p.bbl_reference,
                    to_char(p.effective_date, 'YYYY-MM-DD') AS effective_date,
                    p.effective_date AS effective_date_raw
               FROM ch_article_provenance p
               JOIN ch_act_version v ON v.version_id = p.version_id
              WHERE v.act_id = $1 AND v.lang = $2
                AND ($3::text IS NULL OR EXISTS (
                      SELECT 1 FROM ch_act_article a
                       WHERE a.version_id = p.version_id AND a.e_id = p.e_id AND a.article_number = $3))
              ORDER BY p.e_id, p.action, p.as_reference, p.bbl_reference, p.effective_date,
                       v.date_applicability ASC
           ) dedup
          ORDER BY effective_date_raw DESC NULLS LAST
          LIMIT 200`,
        [act.act_id, String(lang), articleFilter]
      )).rows;
      const provenance = provenanceRows.map(({ effective_date_raw, ...rest }: any) => rest);

      return this.wrapResponse({
        sr_number: act.sr_number,
        jurisdiction: act.jurisdiction,
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

  // ─── ch_get_act_text ─────────────────────────────────────────────────

  private async getActText(args: Record<string, unknown>): Promise<ToolResult> {
    const { act_id, sr_number, as_of, lang = 'de', offset = 0, max_chars = 50000 } = args as any;

    const hasActId = act_id !== undefined && act_id !== null && String(act_id).trim() !== '';
    const hasSrNumber = sr_number !== undefined && sr_number !== null && String(sr_number).trim() !== '';
    if (hasActId === hasSrNumber) {
      return this.wrapResponse('Вкажіть рівно один з параметрів: act_id або sr_number.');
    }
    if (!as_of || !String(as_of).trim()) {
      return this.wrapResponse('Вкажіть as_of — дату у форматі YYYY-MM-DD.');
    }
    if (!isValidIsoDate(String(as_of))) {
      return this.wrapResponse('as_of має бути у форматі YYYY-MM-DD.');
    }
    if (!LANGS.includes(String(lang))) {
      return this.wrapResponse(`lang має бути одним з: ${LANGS.join(', ')}.`);
    }

    const asOfDate = String(as_of);
    const requestedLang = String(lang);
    const off = Math.max(Number(offset) || 0, 0);
    const maxChars = Math.min(Math.max(Number(max_chars) || 50000, 1), 200000);

    try {
      // act_id resolves directly; sr_number resolves like the other ch_* tools (the
      // in-force act wins, then the most recently entered-into-force one), scoped to the
      // federal jurisdiction — this tool has no `canton` parameter, unlike
      // ch_get_act_article/ch_get_act_history.
      const act = hasActId
        ? (await this.db.query(
            `SELECT act_id, sr_number, title_de, title_fr, title_it
               FROM ch_act WHERE act_id = $1`,
            [Number(act_id)]
          )).rows[0]
        : (await this.db.query(
            `SELECT act_id, sr_number, title_de, title_fr, title_it
               FROM ch_act WHERE jurisdiction = 'CH' AND sr_number = $1
              ORDER BY in_force DESC, date_entry_force DESC NULLS LAST
              LIMIT 1`,
            [String(sr_number)]
          )).rows[0];

      if (!act) {
        return this.wrapResponse({
          error: 'no_edition_for_date',
          act_id: hasActId ? Number(act_id) : null,
          earliest_edition: null,
        });
      }

      // Edition pick: the best edition (across all langs) that covers as_of AND actually
      // has text to serve — either full_text (pdf-era) or ch_act_article rows (xml-era).
      // date_end_applicability is the LAST DAY the edition is in force (inclusive), same
      // predicate as ch_get_act_article.
      let edition = (await this.db.query(
        `SELECT version_id, lang, source,
                to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                to_char(date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability
           FROM ch_act_version v
          WHERE v.act_id = $1 AND v.stage = 'parsed'
            AND v.date_applicability <= $2::date
            AND ($2::date <= v.date_end_applicability OR v.date_end_applicability IS NULL)
            AND (v.full_text IS NOT NULL OR EXISTS (
                   SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))
          ORDER BY (v.lang = $3) DESC, (v.lang = 'de') DESC, v.date_applicability DESC
          LIMIT 1`,
        [act.act_id, asOfDate, requestedLang]
      )).rows[0];

      let retrievalStatus: 'edition_at_date' | 'nearest_later_edition' = 'edition_at_date';

      if (!edition) {
        // No edition covers as_of with usable text — fall back to the earliest parsed
        // edition of the act with usable text, same lang preference, earliest first.
        edition = (await this.db.query(
          `SELECT version_id, lang, source,
                  to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                  to_char(date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability
             FROM ch_act_version v
            WHERE v.act_id = $1 AND v.stage = 'parsed'
              AND (v.full_text IS NOT NULL OR EXISTS (
                     SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))
            ORDER BY (v.lang = $2) DESC, (v.lang = 'de') DESC, v.date_applicability ASC
            LIMIT 1`,
          [act.act_id, requestedLang]
        )).rows[0];

        if (!edition) {
          return this.wrapResponse({
            error: 'no_edition_for_date',
            act_id: Number(act.act_id),
            earliest_edition: null,
          });
        }
        retrievalStatus = 'nearest_later_edition';
      }

      // Slice in SQL — never ship the whole full_text (or the whole assembled-from-articles
      // text) into Node. `|| ''` guards the PG15/Alpine multibyte substr/left bug.
      const sliceRow = (await this.db.query(
        `SELECT substr(src || '', $2 + 1, $3) AS text_slice,
                length(src || '') AS total
           FROM (
             SELECT COALESCE(
                      v.full_text,
                      (SELECT string_agg(aa.text, E'\n\n' ORDER BY aa.ordinal)
                         FROM ch_act_article aa WHERE aa.version_id = v.version_id)
                    ) AS src
               FROM ch_act_version v WHERE v.version_id = $1
           ) t`,
        [edition.version_id, off, maxChars]
      )).rows[0];

      const textSlice: string = sliceRow.text_slice ?? '';
      const totalChars = Number(sliceRow.total ?? 0);

      return this.wrapResponse({
        act_id: Number(act.act_id),
        sr_number: act.sr_number,
        title: act[`title_${edition.lang}`],
        lang: edition.lang,
        requested_lang: requestedLang,
        as_of: asOfDate,
        retrieval_status: retrievalStatus,
        edition: {
          date_applicability: edition.date_applicability,
          date_end_applicability: edition.date_end_applicability,
          source: edition.source,
        },
        text: textSlice,
        text_offset: off,
        text_total_chars: totalChars,
        truncated: off + textSlice.length < totalChars,
      });
    } catch (error: any) {
      logger.error('ch_get_act_text error', { error: error.message });
      return this.wrapError(`Помилка отримання тексту акта Швейцарії: ${error.message}`);
    }
  }
}
