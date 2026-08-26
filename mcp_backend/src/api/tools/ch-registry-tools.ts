/**
 * ChRegistryTools — company search and due-diligence lookup over the Swiss registers:
 * Zefix (`ch_zefix_companies`), the federal gazette SHAB (`ch_shab_publications`), the
 * FINMA list of authorised institutions (`ch_finma_regulated`), the SECO sanctions list
 * (`ch_seco_sanctions`) and the cantonal gazettes (`ch_kantonsblatt_publications`).
 * See migrations 129, 132, 133 and 202.
 *
 * Two identifiers exist and only one of them is reliable:
 *
 *  - `uid` (CHE-123.456.789) is the federal business identifier and a real key. Zefix,
 *    SHAB and Kantonsblatt all carry it, so anything joined on `uid` is exact. A
 *    Kantonsblatt row carries it only when the cantonal office published one; the
 *    company card answers that section from the UID alone, so a cantonal publication
 *    without one is a miss rather than a name guess (see getKantonsblatt).
 *  - The company NAME is all that FINMA and SECO publish — neither list carries a UID.
 *    Matching a Zefix company to those two is therefore a HEURISTIC, not a join: the
 *    name is lower-cased, the trailing legal-form suffix (AG / SA / GmbH / Sàrl / Sagl /
 *    Ltd / Inc) is dropped and every non-alphanumeric run collapses to a single space,
 *    on both sides. Two genuinely different companies with the same normalised name
 *    WILL be reported as a match, and a company whose FINMA/SECO rendering differs by
 *    more than punctuation and its legal form will be missed. `ch_get_company` says so
 *    in `name_match_note` and returns the normalised string it used in
 *    `normalized_name`, so a caller can see exactly what was compared.
 *
 * The normalisation lives twice — once in TS (`normalizeCompanyName`, applied to the
 * Zefix name before it is bound as a parameter) and once as the SQL expression
 * `normalizedNameSql()` applied to the register's own column. The two must produce
 * identical output; ch-registry-tools.pg.test.ts pins that against a real server,
 * including accented names ('Genève Services SA' → 'genève services'). Nothing is ever
 * interpolated into SQL: the normalised string is bound as a parameter.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const PURPOSE_PREVIEW_CHARS = 300;
const SHAB_CONTENT_CHARS = 2000;
const MAX_SHAB_ROWS = 100;
const MAX_REGISTER_ROWS = 50;
const STATUSES = ['active', 'inactive', 'all'];

/**
 * One capped register section of a company card: the rows, and whether the register held
 * more than the cap.
 *
 * The queries ask for `cap + 1` and this drops the extra row, rather than comparing
 * `rows.length === cap` — that comparison calls a register holding exactly 50 rows
 * truncated — and rather than a companion `count(*)`, which is a second pass over the
 * same rows to learn one boolean.
 */
interface Section { rows: any[]; truncated: boolean }

const EMPTY_SECTION: Section = { rows: [], truncated: false };

function capped(cap: number, rows: any[]): Section {
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

// Shortest query the SHAB-name fallback will serve. That fallback matches company_name
// across 2.5M publications and has no index unless pg_trgm is installed (migration 202
// creates idx_ch_shab_name_trgm only when the extension is present — CREATE EXTENSION
// needs superuser, so prod must run it before the backfill). One or two characters match
// a large fraction of the table and are worth nothing to the caller, so they are refused
// rather than answered with a sequential scan.
const SHAB_FALLBACK_MIN_CHARS = 3;

// A UID is 'CHE' plus nine digits; the dots and the dash after CHE are cosmetic, so all
// four renderings are accepted (CHE-123.456.789, CHE123456789, CHE-123456789,
// CHE123.456.789) and normalised to the dotted form Zefix stores.
const UID_RE = /^CHE-?\d{3}\.?\d{3}\.?\d{3}$/i;

// Legal-form suffixes stripped from a company name before comparing it across registers.
// The list is deliberately short — these are the forms that actually appear as a trailing
// token in Zefix/FINMA/SECO renderings of the same company.
const LEGAL_FORM_SUFFIXES = 'ag|sa|gmbh|sàrl|sarl|sagl|ltd|inc';
const LEGAL_FORM_SUFFIX_RE = new RegExp(`[\\s,]+(?:${LEGAL_FORM_SUFFIXES})\\.?$`);

/**
 * SQL twin of normalizeCompanyName(); `column` is the column expression to normalise.
 * Kept as a function so the four call sites cannot drift apart.
 */
function normalizedNameSql(column: string): string {
  return `btrim(regexp_replace(regexp_replace(lower(${column}), '[[:space:],]+(${LEGAL_FORM_SUFFIXES})\\.?$', ''), '[^[:alnum:]]+', ' ', 'g'))`;
}

/** TS twin of normalizedNameSql(). See the file header for why this is a heuristic. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_FORM_SUFFIX_RE, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Returns the dotted UID for any accepted rendering, or null when the value is not a UID. */
export function normalizeUid(value: string): string | null {
  const trimmed = value.trim();
  if (!UID_RE.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}`;
}

// Escapes POSIX/ARE regex metacharacters in a caller-supplied token before it is embedded
// in a Postgres `~*` pattern (the word-bounded short-query match below). The token is
// still bound as a parameter — this only makes it safe to concatenate into the pattern.
// Twin of the helper in ch-legislation-tools.ts.
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns a caller-supplied value into an ILIKE prefix pattern: the LIKE metacharacters
 * (`%`, `_`) and the escape character itself are escaped, so they match literally, and a
 * single trailing `%` is appended. Used for legal_form — the labels are read from the
 * LINDAS graph and some are composite ('Gesellschaft mit beschränkter Haftung GMBH /
 * SARL' is the eCH-0097 0107 label), so an equality filter on the German name a caller
 * would actually type matched nothing at all.
 */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export class ChRegistryTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_search_companies',
        annotations: { title: 'Пошук компаній Швейцарії (Zefix)', readOnlyHint: true },
        description: `Пошук швейцарських компаній у федеральному реєстрі Zefix за назвою або за UID (CHE-123.456.789).

Запит, що виглядає як UID (CHE-123.456.789, CHE123456789), розпізнається автоматично і шукається точним збігом — фільтри status/canton/legal_form при цьому не застосовуються.
status: active (типово) / inactive / all. canton — двобуквений код (ZH, GE, TI). legal_form — НІМЕЦЬКА назва правової форми, як її подає Zefix; збіг за ПРЕФІКСОМ, без урахування регістру (напр. Gesellschaft mit beschränkter Haftung — знайде і складений напис «Gesellschaft mit beschränkter Haftung GMBH / SARL»); французьких та італійських варіантів у реєстрі немає.
Кожен результат містить shab_count (кількість публікацій у SHAB), last_shab_date і bankruptcy (true, якщо є публікація рубрики KK — оголошення про банкрутство).
Якщо в Zefix збігів немає, пошук переходить на назви компаній із публікацій SHAB (компанії, вилучені з реєстру) — такі рядки позначені source: 'shab' і можуть не мати uid.
Далі: ch_get_company для повної картки (реєстр, SHAB, FINMA, SECO, кантональні відомості).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії або UID (CHE-123.456.789)' },
            canton: { type: 'string', description: 'Двобуквений код кантону, напр. ZH, GE, TI' },
            legal_form: { type: 'string', description: 'Правова форма — німецька назва, як у Zefix; збіг за префіксом, без урахування регістру, напр. Aktiengesellschaft, Gesellschaft mit beschränkter Haftung' },
            status: { type: 'string', enum: STATUSES, default: 'active', description: 'Стан компанії у реєстрі' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
            offset: { type: 'number', default: 0, description: 'Зсув для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'ch_get_company',
        annotations: { title: 'Компанія Швейцарії: реєстр, SHAB, FINMA, SECO', readOnlyHint: true },
        description: `Повна картка швейцарської компанії за UID (CHE-123.456.789) для due diligence.

Повертає: company (запис Zefix), shab (до 100 публікацій федеральних відомостей SHAB, найновіші першими, content обрізано до 2000 символів), bankruptcies (публікації рубрики KK — банкрутство), finma (записи реєстру FINMA), seco (санкційний список SECO), kantonsblatt (кантональні відомості). Кожен реєстр — до 50 записів.
УВАГА: FINMA і SECO не публікують UID, тому збіг із ними — ЕВРИСТИКА за нормалізованою назвою (нижній регістр, без правової форми AG/SA/GmbH/Sàrl/Sagl та без пунктуації). Використаний рядок повертається у normalized_name; однойменні компанії можуть дати хибний збіг.
Якщо компанії немає в Zefix — { error: 'not_found', uid }.`,
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'string', description: 'UID компанії, напр. CHE-123.456.789' },
          },
          required: ['uid'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_search_companies': return this.searchCompanies(args);
      case 'ch_get_company': return this.getCompany(args);
      default: return null;
    }
  }

  // ─── ch_search_companies ────────────────────────────────────────────

  private async searchCompanies(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, canton, legal_form, status = 'active', limit = 20, offset = 0 } = args as any;

    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — назву компанії або UID (CHE-123.456.789).');
    }
    if (!STATUSES.includes(String(status))) {
      return this.wrapResponse(`status має бути одним з: ${STATUSES.join(', ')}.`);
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const off = Math.max(Number(offset) || 0, 0);
    const rawQuery = String(query).trim();
    const uid = normalizeUid(rawQuery);
    const kind = uid ? { query_kind: 'uid', normalized_uid: uid } : { query_kind: 'name' };

    try {
      const zefix = await this.searchZefix(rawQuery, uid, { canton, legal_form, status: String(status) }, lim, off);

      if (zefix.rows.length > 0) {
        return this.wrapCompanyResults(zefix.rows, lim, off, kind, zefix.total);
      }

      // Empty at this offset can mean either "Zefix knows nothing about this" or "the
      // caller paginated past the last Zefix match". Only the first justifies falling
      // back to SHAB names — otherwise page 2 of a Zefix search would silently switch
      // register mid-pagination. The count query answers that without a second probe.
      //
      // The total is passed explicitly because the page is empty: reading it off the
      // rows told a caller who had paged one step too far that the search had found
      // nothing at all, which is exactly the opposite of what this branch knows.
      if (zefix.total > 0) return this.wrapCompanyResults([], lim, off, kind, zefix.total);

      // See SHAB_FALLBACK_MIN_CHARS: an unindexable query is not worth 2.5M rows.
      if (!uid && rawQuery.length < SHAB_FALLBACK_MIN_CHARS) {
        return this.wrapCompanyResults([], lim, off, kind);
      }

      const shab = await this.searchShabNames(rawQuery, uid, { canton, legal_form }, lim, off);
      return this.wrapCompanyResults(shab, lim, off, kind);
    } catch (error: any) {
      logger.error('ch_search_companies error', { error: error.message });
      return this.wrapError(`Помилка пошуку компаній Швейцарії: ${error.message}`);
    }
  }

  /**
   * Builds the shared name/uid match predicate. A UID query is an exact key lookup and
   * deliberately ignores the status/canton/legal_form filters — a caller who typed a UID
   * wants that company, not "that company if it is still active".
   */
  private buildMatch(
    rawQuery: string,
    uid: string | null,
    nameColumn: string,
    uidColumn: string,
    values: any[],
    startIndex: number
  ): { predicate: string; nextIndex: number } {
    const pi = startIndex;

    if (uid) {
      values.push(uid);
      return { predicate: `${uidColumn} = $${pi}`, nextIndex: pi + 1 };
    }

    // A 1-5 character query with no whitespace is almost always an abbreviation or a
    // legal-form token ('AG', 'SA') — match it on a word boundary rather than as a bare
    // substring, so 'AG' does not match inside 'Aktiengesellschaft'. Same rule as
    // ch_search_legislation. Longer queries keep the substring match.
    const isShortToken = rawQuery.length >= 1 && rawQuery.length <= 5 && !/\s/.test(rawQuery);
    if (isShortToken) {
      values.push(escapeRegexLiteral(rawQuery));
      return { predicate: `${nameColumn} ~* ('\\m' || $${pi} || '\\M')`, nextIndex: pi + 1 };
    }

    values.push(rawQuery);
    return { predicate: `${nameColumn} ILIKE '%' || $${pi} || '%'`, nextIndex: pi + 1 };
  }

  private buildZefixFilters(
    uid: string | null,
    opts: { canton?: unknown; legal_form?: unknown; status: string },
    values: any[],
    startIndex: number
  ): { filters: string[]; nextIndex: number } {
    const filters: string[] = [];
    let pi = startIndex;
    if (uid) return { filters, nextIndex: pi }; // exact key lookup — see buildMatch()

    if (opts.status !== 'all') {
      filters.push(`c.status = $${pi}`); values.push(opts.status); pi++;
    }
    if (opts.canton) {
      filters.push(`c.canton = upper($${pi})`); values.push(String(opts.canton)); pi++;
    }
    if (opts.legal_form) {
      // Prefix, case-insensitive — see likePrefix().
      filters.push(`c.legal_form ILIKE $${pi}`); values.push(likePrefix(String(opts.legal_form))); pi++;
    }
    return { filters, nextIndex: pi };
  }

  /**
   * The page of Zefix matches plus the total number of matches.
   *
   * Two queries rather than one `count(*) OVER()`: the window function has to see every
   * matching row, so it blocks the LIMIT from being pushed under the SHAB lateral and the
   * lateral then runs once per WHERE match instead of once per returned row. Measured on
   * 792K companies / 2.5M publications, query 'AG': 6.9 s as one query, 222 ms as a page
   * CTE plus a companion count. The two run concurrently.
   *
   * The exact-name boost is bound as its own parameter. $1 is whatever buildMatch pushed
   * — the regex-escaped token for a short query, the UID for a UID lookup — and comparing
   * a name against either of those is never true.
   */
  private async searchZefix(
    rawQuery: string,
    uid: string | null,
    opts: { canton?: unknown; legal_form?: unknown; status: string },
    lim: number,
    off: number
  ): Promise<{ rows: any[]; total: number }> {
    const values: any[] = [];
    const match = this.buildMatch(rawQuery, uid, 'c.name', 'c.uid', values, 1);
    const { filters, nextIndex } = this.buildZefixFilters(uid, opts, values, match.nextIndex);
    let pi = nextIndex;

    // Everything up to here is the WHERE clause; the count query binds exactly that.
    const whereValues = values.slice();
    const where = `${match.predicate}
         ${filters.length ? 'AND ' + filters.join(' AND ') : ''}`;

    const boostIdx = pi; values.push(rawQuery); pi++;
    const limIdx = pi; values.push(lim); pi++;
    const offIdx = pi; values.push(off); pi++;

    const pageSql = `
      WITH page AS (
        SELECT c.uid, c.name, c.legal_form, c.legal_form_code, c.legal_seat,
               c.status, c.canton, c.chid, c.ehraid,
               left(c.purpose || '', ${PURPOSE_PREVIEW_CHARS}) AS purpose,
               c.address
          FROM ch_zefix_companies c
         WHERE ${where}
         ORDER BY (lower(c.name) = lower($${boostIdx})) DESC, c.name, c.uid
         LIMIT $${limIdx} OFFSET $${offIdx}
      )
      SELECT page.*,
             coalesce(s.shab_count, 0) AS shab_count,
             s.last_shab_date,
             coalesce(s.bankruptcy, false) AS bankruptcy,
             'zefix' AS source
        FROM page
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS shab_count,
                 to_char(max(p.publication_date), 'YYYY-MM-DD') AS last_shab_date,
                 bool_or(p.rubric = 'KK') AS bankruptcy
            FROM ch_shab_publications p
           WHERE p.company_uid = page.uid
        ) s ON true
       ORDER BY (lower(page.name) = lower($${boostIdx})) DESC, page.name, page.uid`;

    const countSql = `SELECT count(*)::int AS total FROM ch_zefix_companies c WHERE ${where}`;

    const [page, count] = await Promise.all([
      this.db.query(pageSql, values),
      this.db.query(countSql, whereValues),
    ]);

    return { rows: page.rows, total: Number(count.rows[0].total) };
  }

  /**
   * SHAB-name fallback: companies that publish in the federal gazette but are absent from
   * the Zefix snapshot (typically struck off the register). One row per distinct
   * company_name, so the same company does not appear once per publication.
   */
  private async searchShabNames(
    rawQuery: string,
    uid: string | null,
    opts: { canton?: unknown; legal_form?: unknown },
    lim: number,
    off: number
  ): Promise<any[]> {
    const values: any[] = [];
    const match = this.buildMatch(rawQuery, uid, 'p.company_name', 'p.company_uid', values, 1);
    let pi = match.nextIndex;

    const filters: string[] = ['p.company_name IS NOT NULL'];
    if (opts.canton) { filters.push(`p.canton = upper($${pi})`); values.push(String(opts.canton)); pi++; }
    if (opts.legal_form) { filters.push(`p.legal_form ILIKE $${pi}`); values.push(likePrefix(String(opts.legal_form))); pi++; }

    const limIdx = pi; values.push(lim); pi++;
    const offIdx = pi; values.push(off); pi++;

    const sql = `
      SELECT (array_agg(p.company_uid) FILTER (WHERE p.company_uid IS NOT NULL))[1] AS uid,
             p.company_name AS name,
             (array_agg(p.legal_form) FILTER (WHERE p.legal_form IS NOT NULL))[1] AS legal_form,
             (array_agg(p.seat) FILTER (WHERE p.seat IS NOT NULL))[1] AS legal_seat,
             (array_agg(p.canton) FILTER (WHERE p.canton IS NOT NULL))[1] AS canton,
             NULL::text AS status,
             NULL::text AS purpose,
             count(*)::int AS shab_count,
             to_char(max(p.publication_date), 'YYYY-MM-DD') AS last_shab_date,
             bool_or(p.rubric = 'KK') AS bankruptcy,
             'shab' AS source,
             count(*) OVER() AS _total_count
        FROM ch_shab_publications p
       WHERE ${match.predicate}
         AND ${filters.join(' AND ')}
       GROUP BY p.company_name
       ORDER BY max(p.publication_date) DESC NULLS LAST, p.company_name
       LIMIT $${limIdx} OFFSET $${offIdx}`;

    return (await this.db.query(sql, values)).rows;
  }

  // ─── ch_get_company ─────────────────────────────────────────────────

  private async getCompany(args: Record<string, unknown>): Promise<ToolResult> {
    const { uid } = args as any;

    if (!uid || !String(uid).trim()) {
      return this.wrapResponse('Вкажіть uid — ідентифікатор компанії, напр. CHE-123.456.789.');
    }

    const normalizedUid = normalizeUid(String(uid));
    if (!normalizedUid) {
      return this.wrapResponse('uid має бути у форматі CHE-123.456.789 (допускається також CHE123456789).');
    }

    try {
      const company = (await this.db.query(
        // capital, capital_currency, register_office and shab_pub_date exist in migration
        // 129's table but no stage writes them: LINDAS does not publish them and the SHAB
        // stages write what they find into ch_shab_publications, not here. Selecting them
        // returned four nulls that read as "this company has no share capital". The
        // capital SHAB does state is surfaced per publication by getShab().
        `SELECT uid, name, legal_form, legal_form_code, legal_seat, status,
                purpose, address, canton, chid, ehraid, municipality_id, source_iri
           FROM ch_zefix_companies WHERE uid = $1`,
        [normalizedUid]
      )).rows[0];

      if (!company) {
        return this.wrapResponse({ error: 'not_found', uid: normalizedUid });
      }

      const normalizedName = normalizeCompanyName(String(company.name ?? ''));

      const [shab, bankruptcies, finma, seco, kantonsblatt] = await Promise.all([
        this.getShab(normalizedUid, null),
        this.getShab(normalizedUid, 'KK'),
        this.getFinma(normalizedName),
        this.getSeco(normalizedName),
        this.getKantonsblatt(normalizedUid),
      ]);

      return this.wrapResponse({
        company,
        // Every section is capped, and every cap has its own flag: a reader that sees 50
        // FINMA rows has no way to tell "fifty authorisations" from "the first fifty of
        // however many", and the panel presented the first as the second.
        shab: shab.rows,
        shab_truncated: shab.truncated,
        bankruptcies: bankruptcies.rows,
        bankruptcies_truncated: bankruptcies.truncated,
        finma: finma.rows,
        finma_truncated: finma.truncated,
        seco: seco.rows,
        seco_truncated: seco.truncated,
        kantonsblatt: kantonsblatt.rows,
        kantonsblatt_truncated: kantonsblatt.truncated,
        normalized_name: normalizedName,
        name_match_note:
          'FINMA та SECO не публікують UID — збіг знайдено евристично за нормалізованою назвою (normalized_name): однойменні компанії можуть дати хибний збіг, а інакше записана назва — бути пропущеною. Кантональні відомості (Kantonsblatt) зіставлені точно за UID, тому публікації цієї компанії без UID сюди не потрапляють.',
      });
    } catch (error: any) {
      logger.error('ch_get_company error', { error: error.message });
      return this.wrapError(`Помилка отримання картки компанії Швейцарії: ${error.message}`);
    }
  }

  /**
   * The publications for one company. `capital` / `capital_currency` come out of
   * metadata_json because ch_shab_publications has no column for them: shab-detail parses
   * the amount the register states out of the publication and merges it into the jsonb.
   * This is the only capital in the corpus — ch_zefix_companies.capital is never written.
   */
  private async getShab(uid: string, rubric: string | null): Promise<Section> {
    const cap = rubric === null ? MAX_SHAB_ROWS : MAX_REGISTER_ROWS;
    return capped(cap, (await this.db.query(
      `SELECT shab_id, to_char(publication_date, 'YYYY-MM-DD') AS publication_date,
              publication_type, rubric, sub_rubric, publication_number, title, language,
              registration_office, legal_form, seat, canton, company_name,
              metadata_json->>'capital' AS capital,
              metadata_json->>'capital_currency' AS capital_currency,
              left(content || '', ${SHAB_CONTENT_CHARS}) AS content,
              (length(coalesce(content, '')) > ${SHAB_CONTENT_CHARS}) AS content_truncated
         FROM ch_shab_publications
        WHERE company_uid = $1
          AND ($2::text IS NULL OR rubric = $2)
        ORDER BY publication_date DESC NULLS LAST, shab_id DESC
        LIMIT ${cap + 1}`,
      [uid, rubric]
    )).rows);
  }

  private async getFinma(normalizedName: string): Promise<Section> {
    if (!normalizedName) return EMPTY_SECTION;
    return capped(MAX_REGISTER_ROWS, (await this.db.query(
      `SELECT entity_name, authorization_type, authorization_number, status, city, canton,
              country, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
         FROM ch_finma_regulated
        WHERE ${normalizedNameSql('entity_name')} = $1
        ORDER BY entity_name, authorization_type
        LIMIT ${MAX_REGISTER_ROWS + 1}`,
      [normalizedName]
    )).rows);
  }

  private async getSeco(normalizedName: string): Promise<Section> {
    if (!normalizedName) return EMPTY_SECTION;
    return capped(MAX_REGISTER_ROWS, (await this.db.query(
      `SELECT ssid, target_type, primary_name, programme, origin, legal_basis,
              to_char(listed_at, 'YYYY-MM-DD') AS listed_at,
              to_char(delisted_at, 'YYYY-MM-DD') AS delisted_at,
              other_information
         FROM ch_seco_sanctions
        WHERE ${normalizedNameSql('primary_name')} = $1
        ORDER BY delisted_at IS NOT NULL, listed_at DESC NULLS LAST, ssid
        LIMIT ${MAX_REGISTER_ROWS + 1}`,
      [normalizedName]
    )).rows);
  }

  /**
   * Kantonsblatt rows carry the UID when the cantonal office published one, and otherwise
   * only a `title` that is the company name for HR publications.
   *
   * By UID, and only by UID. The title half was `WHERE <normalised title> = $1` — a
   * normalising expression, so idx_ch_kb_uid cannot serve it and no index can, and it
   * ran on every card for a company whose cantonal publications carry no UID. What it
   * bought was a name heuristic; what it cost was a sequential scan of 2.18M rows per
   * card. The UID rows are the authoritative ones, and name_match_note now says
   * Kantonsblatt is matched exactly, so a UID-less publication is a miss rather than a
   * silently heuristic hit.
   */
  private async getKantonsblatt(uid: string): Promise<Section> {
    return capped(MAX_REGISTER_ROWS, (await this.db.query(
      `SELECT publication_uuid, publication_number,
              to_char(publication_date, 'YYYY-MM-DD') AS publication_date,
              sub_rubric, cantons, title, company_uid,
              left(coalesce(publication_text_de, publication_text_fr, publication_text_it) || '',
                   ${SHAB_CONTENT_CHARS}) AS content
         FROM ch_kantonsblatt_publications
        WHERE company_uid = $1
        ORDER BY publication_date DESC NULLS LAST, publication_number
        LIMIT ${MAX_REGISTER_ROWS + 1}`,
      [uid]
    )).rows);
  }

  /**
   * wrapSearchResults with extra top-level fields (query_kind / normalized_uid) merged in,
   * so a caller can tell a UID lookup from a name search without re-parsing its own query.
   */
  private wrapCompanyResults(
    rows: any[],
    limit: number,
    offset: number,
    extra: Record<string, unknown>,
    total?: number
  ): ToolResult {
    // `total` when the caller knows it independently of the rows (the Zefix page, which
    // has a companion count query); the row stamp otherwise (the SHAB fallback, whose
    // count(*) OVER() rides along on the page). Reading it off an EMPTY page is the one
    // case that cannot work, and that is the case the explicit argument exists for.
    const totalCount = total ?? (rows.length > 0 ? Number(rows[0]._total_count ?? rows.length) : 0);
    const cleaned = rows.map(({ _total_count, ...rest }: any) => rest);
    return this.wrapResponse({
      results: cleaned,
      total_count: totalCount,
      has_more: offset + cleaned.length < totalCount,
      limit,
      offset,
      ...extra,
    });
  }
}
