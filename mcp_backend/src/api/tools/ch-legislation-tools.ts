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

// Copied verbatim from ch-court-tools.ts:38 — CH_BGer/CH_BGE carry the source's
// three-language header {de,fr,it} verbatim in `languages` regardless of the decision's
// real language; the real language sits in metadata_json->>'Sprache' for those spiders.
// Cantonal spiders have no Sprache key, so the fallback to languages[1] covers them.
const LANG_EXPR = `COALESCE(CASE WHEN lower(btrim(metadata_json->>'Sprache')) IN ('de','fr','it') THEN lower(btrim(metadata_json->>'Sprache')) END, languages[1])`;

// `decision_date = '2021-01-01'` is a source placeholder for an unknown date, not a real
// one (see ch-court-tools.ts). ch_get_decision_legislation still reports it (unlike
// ch_get_court_decision, which nulls it) but flags it via date_unreliable/date_note so a
// caller can override it with as_of.
const PLACEHOLDER_DECISION_DATE = '2021-01-01';

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
Далі: ch_get_act_article для тексту статті на певну дату, ch_get_act_history для історії змін (передавайте той самий canton), ch_get_act_text для повного тексту акта на дату.`,
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

Обов'язково рівно один з act_id або sr_number (для sr_number резолвиться федеральний акт, чинний пріоритетно, як і в інших ch_* інструментах — canton тут не підтримується, для кантональних актів використовуйте act_id). as_of — обов'язкова дата (YYYY-MM-DD). У відповіді є поле jurisdiction.
Джерело тексту різне для різних редакцій: для новіших (XML, Fedlex) текст збирається зі статей (ch_act_article, з позначками "Art. N" і заголовками); для давніх, доступних лише як PDF ("pdf-era"), текст зберігається цілком у full_text. Поле edition.source показує, яке джерело обслужило запит.
Якщо жодна редакція не покриває as_of — обирається НАЙБЛИЖЧА в часі машиночитана редакція акта (не обов'язково найдавніша: Fedlex публікує не всі редакції, тож пропуски між редакціями — очікувана ситуація, як і запит на дату після скасування акта): retrieval_status='nearest_earlier_edition', якщо обрана редакція починається на as_of або раніше, інакше 'nearest_later_edition' (замість 'edition_at_date'). Якщо машиночитаних редакцій немає взагалі — { error: 'no_edition_for_date', earliest_edition: null }. Якщо акт не знайдено — { error: 'not_found', entity: 'act', ... }.
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
      {
        name: 'ch_get_decision_legislation',
        annotations: { title: 'Законодавство, цитоване судовим рішенням Швейцарії', readOnlyHint: true },
        description: `Всі акти, цитовані судовим рішенням Швейцарії (ECLI), кожен — у редакції, чинній на дату рішення.

Потрібен ecli. as_of дозволяє перевизначити ефективну дату замість дати рішення (decision_date). limit (типово 20, максимум 50) обмежує кількість актів у відповіді, відсортованих за кількістю цитувань (citations_count).
Деякі рішення мають ненадійну дату — плейсхолдер джерела decision_date=2021-01-01 замість справжньої дати: у такому разі date_unreliable=true і додається пояснення date_note; передайте as_of, щоб уточнити дату.
Для кожного акта: title/abbreviation/jurisdiction, citations_count, articles_cited (до 15, з articles_truncated) та edition — редакція, чинна на ефективну дату. retrieval_status: 'edition_at_date' (редакція покриває дату), 'nearest_earlier_edition'/'nearest_later_edition' (найближча в часі машиночитана редакція, коли точної немає) або 'no_text' (жодної машиночитаної редакції з текстом немає).
Нерозпізнані цитування (переважно кантональне законодавство поза корпусом) підсумовуються в unresolved.top_abbrs.
Далі: ch_get_act_text за act_id для повного тексту конкретного акта на цю дату.`,
        inputSchema: {
          type: 'object',
          properties: {
            ecli: { type: 'string', description: 'ECLI судового рішення' },
            as_of: { type: 'string', description: 'Дата (YYYY-MM-DD) замість дати рішення' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. актів у відповіді' },
          },
          required: ['ecli'],
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
      case 'ch_get_decision_legislation': return this.getDecisionLegislation(args);
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
      // act_id resolves directly and can land on ANY jurisdiction (federal or cantonal) —
      // this tool has no `canton` parameter, unlike ch_get_act_article/ch_get_act_history,
      // so sr_number resolution is scoped to the federal jurisdiction only (the in-force
      // act wins, then the most recently entered-into-force one); a cantonal act must be
      // looked up by act_id instead. Either way, jurisdiction is SELECTed and echoed back
      // from the real row — never assumed to be 'CH'.
      const act = hasActId
        ? (await this.db.query(
            `SELECT act_id, sr_number, jurisdiction, title_de, title_fr, title_it
               FROM ch_act WHERE act_id = $1`,
            [Number(act_id)]
          )).rows[0]
        : (await this.db.query(
            `SELECT act_id, sr_number, jurisdiction, title_de, title_fr, title_it
               FROM ch_act WHERE jurisdiction = 'CH' AND sr_number = $1
              ORDER BY in_force DESC, date_entry_force DESC NULLS LAST
              LIMIT 1`,
            [String(sr_number)]
          )).rows[0];

      if (!act) {
        // Echo what failed, like the sibling ch_* tools' not_found shape (ch_get_act_article,
        // ch_get_act_history) — distinct from 'no_edition_for_date', which means the act
        // exists but has no usable machine-readable edition.
        // No real row to read jurisdiction off here: the sr_number path already scoped
        // its search to 'CH' (so that literal is accurate, not assumed), and the act_id
        // path has no other jurisdiction to fall back to when the id does not resolve —
        // this tool defaults to federal, cantonal acts being reached explicitly by an
        // act_id the caller already knows is cantonal.
        return this.wrapResponse({
          error: 'not_found',
          entity: 'act',
          ...(hasActId ? { act_id: Number(act_id) } : { sr_number: String(sr_number) }),
          jurisdiction: 'CH',
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

      let retrievalStatus: 'edition_at_date' | 'nearest_earlier_edition' | 'nearest_later_edition' = 'edition_at_date';

      if (!edition) {
        // No edition covers as_of with usable text — Fedlex is missing roughly 15% of
        // editions, so as_of landing in a genuine coverage gap between two editions is the
        // expected case (as is a repealed act queried after its last edition), not just
        // "before the earliest one". Fall back to the NEAREST edition in time (by start
        // date), not the earliest: prefer an edition that already started by as_of (ties
        // broken by the smaller distance), and only reach into the future when nothing
        // started by as_of yet.
        edition = (await this.db.query(
          `SELECT version_id, lang, source,
                  to_char(date_applicability, 'YYYY-MM-DD') AS date_applicability,
                  to_char(date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability
             FROM ch_act_version v
            WHERE v.act_id = $1 AND v.stage = 'parsed'
              AND (v.full_text IS NOT NULL OR EXISTS (
                     SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))
            ORDER BY (v.lang = $3) DESC, (v.lang = 'de') DESC,
                     (v.date_applicability <= $2::date) DESC,
                     CASE WHEN v.date_applicability <= $2::date
                          THEN $2::date - v.date_applicability
                          ELSE v.date_applicability - $2::date END ASC
            LIMIT 1`,
          [act.act_id, asOfDate, requestedLang]
        )).rows[0];

        if (!edition) {
          return this.wrapResponse({
            error: 'no_edition_for_date',
            act_id: Number(act.act_id),
            earliest_edition: null,
          });
        }
        // Label from the served row, not from which branch ran: at-or-before as_of reads as
        // "nearest earlier", strictly after as_of (e.g. as_of predates every edition) reads
        // as "nearest later". ISO YYYY-MM-DD strings compare lexicographically = chronologically.
        retrievalStatus = edition.date_applicability <= asOfDate ? 'nearest_earlier_edition' : 'nearest_later_edition';
      }

      // Slice in SQL — never ship the whole full_text (or the whole assembled-from-articles
      // text) into Node. `|| ''` guards the PG15/Alpine multibyte substr/left bug. The
      // xml-era assembly keeps "Art. <number>" and the marginal note ahead of each article's
      // text so the assembled string reads like the act, not a bag of paragraphs. '\n' here
      // is already a real newline by the time this JS template literal reaches Postgres, so
      // no E'' escape prefix is needed.
      const sliceRow = (await this.db.query(
        `SELECT substr(src || '', $2 + 1, $3) AS text_slice,
                length(src || '') AS total
           FROM (
             SELECT COALESCE(
                      v.full_text,
                      (SELECT string_agg(
                                coalesce('Art. ' || aa.article_number || '\n', '') ||
                                coalesce(aa.marginal_note || '\n', '') ||
                                aa.text,
                                '\n\n' ORDER BY aa.ordinal)
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
        // The real jurisdiction of the resolved act — 'CH' for federal, a canton code
        // (ZH, BE, ...) for cantonal acts reached via act_id. NOT hardcoded: a cantonal
        // act served via act_id must not come back mislabelled 'CH'.
        jurisdiction: act.jurisdiction,
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
        // PG-side numbers only: off/maxChars are the SQL-bound slicing params, totalChars
        // is PG's length(); never mix in textSlice.length (JS UTF-16 code units), which can
        // disagree with PG's character count for non-BMP text.
        truncated: off + maxChars < totalChars,
      });
    } catch (error: any) {
      logger.error('ch_get_act_text error', { error: error.message });
      return this.wrapError(`Помилка отримання тексту акта Швейцарії: ${error.message}`);
    }
  }

  // ─── ch_get_decision_legislation ─────────────────────────────────────

  private async getDecisionLegislation(args: Record<string, unknown>): Promise<ToolResult> {
    const { ecli, as_of, limit = 20 } = args as any;

    if (!ecli || !String(ecli).trim()) {
      return this.wrapResponse('Вкажіть ecli — ідентифікатор судового рішення.');
    }
    if (as_of && !isValidIsoDate(String(as_of))) {
      return this.wrapResponse('as_of має бути у форматі YYYY-MM-DD.');
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);

    try {
      const decision = (await this.db.query(
        `SELECT ecli, to_char(decision_date, 'YYYY-MM-DD') AS decision_date, ${LANG_EXPR} AS lang
           FROM ch_court_decisions WHERE ecli = $1 AND stage = 'loaded'`,
        [String(ecli)]
      )).rows[0];

      if (!decision) {
        // Same not_found/not_loaded distinction as ch_get_court_decision: a row that
        // exists but is still in the pipeline is not the same as no such decision.
        const stageRow = (await this.db.query(
          `SELECT ecli, stage FROM ch_court_decisions WHERE ecli = $1`,
          [String(ecli)]
        )).rows[0];

        if (stageRow) {
          return this.wrapResponse({
            error: 'not_loaded',
            ecli: stageRow.ecli,
            stage: stageRow.stage,
            message: `Це рішення ще не опрацьоване (стадія: ${stageRow.stage}) і поки не має надійного тексту.`,
          });
        }

        return this.wrapResponse({ error: 'not_found', ecli: String(ecli) });
      }

      const effectiveDate = as_of ? String(as_of) : decision.decision_date;
      const dateUnreliable = decision.decision_date === PLACEHOLDER_DECISION_DATE && !as_of;
      const decisionLang = LANGS.includes(decision.lang) ? decision.lang : 'de';
      const titleCol = `title_${decisionLang}`;

      // Cited acts, grouped, most-cited first. total_cited_acts is a window count taken
      // before LIMIT (same pattern as the OVER() total_count used elsewhere in this
      // file/ch-court-tools.ts), so it reflects every distinct resolved act, not just the
      // page returned.
      //
      // Per act: the LATERAL below reproduces ch_get_act_text's exact two-tier edition
      // pick verbatim — tier 0 is an edition that actually covers effective_date (with
      // usable text), tier 1 is the nearest edition in time when none does — combined via
      // UNION ALL and resolved with ORDER BY retrieval_tier LIMIT 1 so the LATERAL itself
      // decides tier 0 vs tier 1 without a second round trip to Node.
      const citedRows = (await this.db.query(
        `WITH cited AS (
           SELECT act_id, count(*)::int AS citations_count,
                  array_agg(DISTINCT article ORDER BY article) FILTER (WHERE article <> '') AS articles_all,
                  count(*) OVER()::int AS total_cited_acts
             FROM ch_legislation_citations
            WHERE from_ecli = $1 AND act_id IS NOT NULL
            GROUP BY act_id
            ORDER BY citations_count DESC
            LIMIT $2
         )
         SELECT c.act_id, c.citations_count, c.articles_all, c.total_cited_acts,
                a.sr_number, a.${titleCol} AS title, a.abbreviation, a.jurisdiction,
                ed.version_id, ed.lang AS edition_lang, ed.source,
                ed.date_applicability, ed.date_end_applicability, ed.retrieval_tier
           FROM cited c
           JOIN ch_act a ON a.act_id = c.act_id
           LEFT JOIN LATERAL (
             (SELECT v.version_id, v.lang, v.source,
                     to_char(v.date_applicability, 'YYYY-MM-DD') AS date_applicability,
                     to_char(v.date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability,
                     0 AS retrieval_tier
                FROM ch_act_version v
               WHERE v.act_id = c.act_id AND v.stage = 'parsed'
                 AND v.date_applicability <= $3::date
                 AND ($3::date <= v.date_end_applicability OR v.date_end_applicability IS NULL)
                 AND (v.full_text IS NOT NULL OR EXISTS (
                        SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))
               ORDER BY (v.lang = $4) DESC, (v.lang = 'de') DESC, v.date_applicability DESC
               LIMIT 1)
             UNION ALL
             (SELECT v.version_id, v.lang, v.source,
                     to_char(v.date_applicability, 'YYYY-MM-DD') AS date_applicability,
                     to_char(v.date_end_applicability, 'YYYY-MM-DD') AS date_end_applicability,
                     1 AS retrieval_tier
                FROM ch_act_version v
               WHERE v.act_id = c.act_id AND v.stage = 'parsed'
                 AND (v.full_text IS NOT NULL OR EXISTS (
                        SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))
               ORDER BY (v.lang = $4) DESC, (v.lang = 'de') DESC,
                        (v.date_applicability <= $3::date) DESC,
                        CASE WHEN v.date_applicability <= $3::date
                             THEN $3::date - v.date_applicability
                             ELSE v.date_applicability - $3::date END ASC
               LIMIT 1)
             ORDER BY retrieval_tier ASC
             LIMIT 1
           ) ed ON true
          ORDER BY c.citations_count DESC`,
        [String(ecli), lim, effectiveDate, decisionLang]
      )).rows;

      const totalCitedActs = citedRows.length > 0 ? Number(citedRows[0].total_cited_acts) : 0;
      const actsTruncated = totalCitedActs > citedRows.length;

      const acts = citedRows.map((r: any) => {
        const articlesAll: string[] = r.articles_all ?? [];
        const articlesCited = articlesAll.slice(0, 15);
        const articlesTruncated = articlesAll.length > 15;

        let retrievalStatus: 'edition_at_date' | 'nearest_earlier_edition' | 'nearest_later_edition' | 'no_text';
        let edition: { date_applicability: string; date_end_applicability: string | null; source: string } | null = null;

        if (r.version_id == null) {
          retrievalStatus = 'no_text';
        } else {
          edition = {
            date_applicability: r.date_applicability,
            date_end_applicability: r.date_end_applicability,
            source: r.source,
          };
          retrievalStatus = Number(r.retrieval_tier) === 0
            ? 'edition_at_date'
            : (r.date_applicability <= effectiveDate ? 'nearest_earlier_edition' : 'nearest_later_edition');
        }

        return {
          act_id: Number(r.act_id),
          sr_number: r.sr_number,
          title: r.title,
          abbreviation: r.abbreviation,
          jurisdiction: r.jurisdiction,
          citations_count: Number(r.citations_count),
          articles_cited: articlesCited,
          articles_truncated: articlesTruncated,
          edition,
          retrieval_status: retrievalStatus,
          next: { tool: 'ch_get_act_text', act_id: Number(r.act_id), as_of: effectiveDate, lang: decisionLang },
        };
      });

      // Unresolved tail: citations whose abbreviation never resolved to an act (mostly
      // cantonal legislation outside this corpus) — the honest remainder, not silently
      // dropped.
      const unresolvedTotal = (await this.db.query(
        `SELECT count(*)::int AS n FROM ch_legislation_citations WHERE from_ecli = $1 AND act_id IS NULL`,
        [String(ecli)]
      )).rows[0];
      const unresolvedTop = (await this.db.query(
        `SELECT abbr_raw, count(*)::int AS n
           FROM ch_legislation_citations
          WHERE from_ecli = $1 AND act_id IS NULL
          GROUP BY abbr_raw
          ORDER BY n DESC, abbr_raw
          LIMIT 5`,
        [String(ecli)]
      )).rows;

      return this.wrapResponse({
        ecli: decision.ecli,
        decision_date: decision.decision_date,
        effective_date: effectiveDate,
        date_unreliable: dateUnreliable,
        ...(dateUnreliable
          ? { date_note: 'Дата рішення — плейсхолдер джерела (2021-01-01), а не справжня дата. Передайте as_of, щоб уточнити редакцію.' }
          : {}),
        lang: decisionLang,
        acts,
        total_cited_acts: totalCitedActs,
        acts_truncated: actsTruncated,
        unresolved: {
          count: Number(unresolvedTotal?.n ?? 0),
          top_abbrs: unresolvedTop.map((r: any) => ({ abbr: r.abbr_raw, count: Number(r.n) })),
        },
      });
    } catch (error: any) {
      logger.error('ch_get_decision_legislation error', { error: error.message });
      return this.wrapError(`Помилка отримання законодавства до рішення Швейцарії: ${error.message}`);
    }
  }
}
