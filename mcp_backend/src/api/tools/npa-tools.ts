/**
 * НПА corpus tools — the FULL Ukrainian legislation registry (schema `npa`).
 *
 * Distinct from the six search_legislation/get_legislation_* tools, which serve the
 * curated `public.legislation` set (~655 acts with a parsed article hierarchy). This
 * handler serves the complete zakon.rada.gov.ua harvest: 293K acts, 439K editions,
 * 2.2M articles, with every historical edition addressable by date.
 *
 * ⚠ TOAST SLICE HAZARD (PG 15.16 + pglz). Slicing `npa.edition_text.body` or
 * `npa.article.body` DIRECTLY — left(body, n), substr(body, …) — raises
 * "invalid byte sequence for encoding UTF8" non-deterministically on the partial-detoast
 * path. Measured on prod: left(body,200) failed on 98 of 300 current editions (33%),
 * while substr(body || '', 1, 200) succeeded on 300 of 300. The stored bytes are valid;
 * the partial detoast is what breaks. EVERY slice below therefore forces a full detoast
 * with `body || ''` first. Do not "simplify" that away.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { legislationStems } from '../../services/legislation-search-utils.js';
import { resolveActNumber, pickActNumber, normalizeArticleNumber, type ActNumberMatch } from '../../services/act-number.js';
import {
  NPA_REPEALED_CODES,
  NPA_STATUS_ARG,
  docTypeIdFromLabel,
  docTypeLabels,
  npaUrl,
  statusLabel,
} from './npa-dicts.js';
import { logger } from '../../utils/logger.js';

/** Candidate cap for the FTS leg — total_found is a lower bound, never exact. */
const FTS_CANDIDATE_CAP = 2000;
/** Same ceiling get_legislation_section uses for a single text payload. */
const MAX_TEXT_CHARS = 60000;

/**
 * zakon.rada page chrome that the harvester kept at the head of the body:
 * "Друкувати / Допомога / Шрифт: / + збільшити / − зменшити / або Ctrl + mouse wheel".
 * Measured on prod: 2340 of 3000 sampled current editions (78%) start with it, always
 * ending at the same offset. Article bodies are clean — the article parser already skips it.
 *
 * SQL form, applied BEFORE slicing so `offset` and `total_chars` describe the real text.
 * `b` must already be fully detoasted by the caller (see the TOAST note above).
 */
const STRIP_CHROME_SQL = `CASE
    WHEN b LIKE 'Друкувати%' AND strpos(substr(b, 1, 200), 'mouse wheel') > 0
      THEN substr(b, strpos(substr(b, 1, 200), 'mouse wheel') + 12)
    ELSE b
  END`;

/** Cosmetic same-strip for snippets, where the match can land inside the chrome block. */
function stripChrome(text: string | null | undefined): string {
  const s = String(text ?? '');
  const i = s.indexOf('mouse wheel');
  return s.startsWith('Друкувати') && i >= 0 ? s.slice(i + 12) : s;
}

export class NpaTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_npa',
        annotations: { title: 'Повний корпус НПА України', readOnlyHint: true },
        description: `Пошук по ПОВНОМУ корпусу нормативно-правових актів України

293K актів · 439K редакцій · 2.2M статей — весь реєстр zakon.rada.gov.ua.
Це НЕ те саме, що search_legislation: там ~655 кодексів і базових законів з розібраною структурою статей, тут — уся нормативна база, включно з постановами КМУ, наказами міністерств, указами, листами й роз'ясненнями.

Два режими (взаємовиключні):
• query — повнотекстовий пошук по тексту актів
• title — пошук за назвою акта (нечіткий, триграми)

Фільтри: status (типово «чинний»), doc_type (Закон, Кодекс, Постанова, Указ, Наказ…), as_of_date.

ВАЖЛИВО: пошук завжди виконується по ЧИННИХ редакціях (історичні редакції не мають повнотекстового індексу). Параметр as_of_date не змінює те, ЩО знайдено — він змінює, з якої редакції показано фрагмент.
Далі: get_npa_act для картки, переліку редакцій, статей або повного тексту.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Пошуковий запит по тексту актів' },
            title: { type: 'string', description: 'Пошук за назвою акта (нечіткий)' },
            status: {
              type: 'string',
              enum: ['чинний', 'втратив чинність', 'набирає чинності', 'не набрав чинності', 'будь-який'],
              default: 'чинний',
              description: 'Стан акта. Типово «чинний» — інакше у видачу потрапляють скасовані акти',
            },
            doc_type: { type: 'string', description: 'Тип документа: Закон, Кодекс, Постанова, Указ, Наказ, Розпорядження, Рішення, Лист тощо' },
            as_of_date: { type: 'string', description: 'Дата (YYYY-MM-DD) — фрагмент показується з редакції, чинної на цю дату' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
          },
        },
      },
      {
        name: 'get_npa_act',
        annotations: { title: 'Картка, редакції та текст акта НПА', readOnlyHint: true },
        description: `Картка нормативно-правового акта з повного корпусу НПА, його редакції та текст

Режими (mode):
• card (типово) — назва, стан, тип, кількість редакцій, перша й остання редакція
• editions — перелік усіх редакцій з датами
• toc — перелік статей редакції (лише для структурованих актів, has_articles=true)
• article — текст конкретної статті (потрібен article_number)
• text — повний текст редакції посторінково (offset)

Часова машина: as_of_date повертає редакцію, чинну на вказану дату. Наприклад Податковий кодекс станом на 2022-06-01 — це редакція від 2022-05-27, а не сьогоднішня.`,
        inputSchema: {
          type: 'object',
          properties: {
            nreg: { type: 'string', description: 'Реєстраційний номер акта: 2755-17, 254к/96-вр, z0567-01' },
            mode: { type: 'string', enum: ['card', 'editions', 'toc', 'article', 'text'], default: 'card', description: 'Режим' },
            article_number: { type: 'string', description: 'Номер статті для mode=article, напр. 625 або 205-1' },
            as_of_date: { type: 'string', description: 'Дата (YYYY-MM-DD) — редакція, чинна на цю дату' },
            offset: { type: 'number', default: 0, description: 'Зсув у символах для mode=text' },
            limit: { type: 'number', default: 50, maximum: 200, description: 'Ліміт редакцій або статей' },
          },
          required: ['nreg'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_npa': return this.searchNpa(args);
      case 'get_npa_act': return this.getNpaAct(args);
      default: return null;
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────

  /**
   * Resolve the act id as stored: exact PK hit, then the alias table.
   *
   * The alias leg is what lets a caller pass the OFFICIAL number — «2755-VI»,
   * «254к/96-ВР», «8073-X» — or a Latin retype of a Cyrillic id («254k/96-vr»),
   * none of which are nregs and none of which used to resolve. It replaces the
   * old lower() fallback, which only ever caught a difference in case.
   *
   * Ambiguity is surfaced rather than guessed: «8073-X» is КУпАП, split by Rada
   * across three registry ids, and the УРСР convocations V–IX render to the
   * same Roman string as the modern ones (70 measured collisions), so
   * «117-VIII» really is two acts. resolveNregDetailed returns the candidates
   * so the caller can say so instead of silently picking one.
   */
  private async resolveNreg(input: string): Promise<string | null> {
    return (await this.resolveNregDetailed(input)).nreg;
  }

  private async resolveNregDetailed(
    input: string
  ): Promise<{ nreg: string | null; ambiguous: ActNumberMatch[] }> {
    const raw = String(input || '').trim();
    if (!raw) return { nreg: null, ambiguous: [] };

    const exact = await this.db.query('SELECT nreg FROM npa.act WHERE nreg = $1', [raw]);
    if (exact.rows.length > 0) return { nreg: exact.rows[0].nreg, ambiguous: [] };

    const matches = await resolveActNumber(this.db, raw);
    return pickActNumber(matches);
  }

  /**
   * Edition in force for an act on a date (or the current one when no date is given).
   * Two explicit branches so each uses its own partial index — edition_current and
   * edition_temporal. Only http_status=200 editions have text.
   */
  private async resolveEdition(nreg: string, asOfDate?: string): Promise<{ ed_date: string; is_current: boolean } | null> {
    if (asOfDate) {
      const r = await this.db.query(
        `SELECT to_char(ed_date, 'YYYY-MM-DD') AS ed_date, is_current
           FROM npa.edition
          WHERE nreg = $1 AND http_status = 200 AND ed_date <= $2::date
          ORDER BY ed_date DESC LIMIT 1`,
        [nreg, asOfDate]
      );
      return r.rows[0] ?? null;
    }
    const r = await this.db.query(
      `SELECT to_char(ed_date, 'YYYY-MM-DD') AS ed_date, is_current
         FROM npa.edition
        WHERE nreg = $1 AND is_current AND http_status = 200 LIMIT 1`,
      [nreg]
    );
    return r.rows[0] ?? null;
  }

  private statusFilter(status: string | undefined): { code: number | null; excludeRepealed: boolean } {
    const s = String(status ?? 'чинний').trim().toLowerCase();
    if (s === 'будь-який') return { code: null, excludeRepealed: false };
    const code = NPA_STATUS_ARG[s];
    if (code !== undefined) return { code, excludeRepealed: false };
    return { code: null, excludeRepealed: true };
  }

  private shapeAct(row: any, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const edDate = (extra.shown_edition as string) ?? null;
    const isCurrent = extra.is_current === undefined ? true : Boolean(extra.is_current);
    return {
      nreg: row.nreg,
      title: row.title,
      status: statusLabel(row.status_code),
      doc_types: docTypeLabels(row.types_raw),
      editions_count: row.editions_cnt,
      has_articles: row.has_articles,
      first_edition: row.first_ed,
      last_edition: row.last_ed,
      ...extra,
      url: npaUrl(row.nreg, edDate, isCurrent),
    };
  }

  // ─── search_npa ─────────────────────────────────────────────────────

  private async searchNpa(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, title, status, doc_type, as_of_date, limit = 20 } = args as any;
    if (!query && !title) {
      return this.wrapResponse('Вкажіть query (пошук по тексту актів) або title (пошук за назвою).');
    }
    const lim = Math.min(Number(limit) || 20, 50);
    const { code: statusCode, excludeRepealed } = this.statusFilter(status);
    const docTypeId = doc_type ? docTypeIdFromLabel(String(doc_type)) : null;
    if (doc_type && docTypeId === null) {
      return this.wrapResponse(`Невідомий тип документа «${doc_type}». Спробуйте: Закон, Кодекс, Постанова, Указ, Наказ, Розпорядження, Рішення, Лист.`);
    }
    if (as_of_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(as_of_date))) {
      return this.wrapResponse('as_of_date має бути у форматі YYYY-MM-DD.');
    }

    try {
      return title
        ? await this.searchNpaByTitle(String(title), statusCode, excludeRepealed, docTypeId, lim)
        : await this.searchNpaByText(String(query), statusCode, excludeRepealed, docTypeId, as_of_date, lim);
    } catch (error: any) {
      logger.error('search_npa error', { error: error.message });
      return this.wrapError(`Помилка пошуку по корпусу НПА: ${error.message}`);
    }
  }

  private actFilterSql(statusCode: number | null, excludeRepealed: boolean, docTypeId: number | null, values: any[], startIdx: number): { sql: string; nextIdx: number } {
    const parts: string[] = [];
    let pi = startIdx;
    if (statusCode !== null) { parts.push(`a.status_code = $${pi}`); values.push(statusCode); pi++; }
    else if (excludeRepealed) { parts.push(`(a.status_code IS NULL OR a.status_code <> ALL($${pi}::int[]))`); values.push(NPA_REPEALED_CODES); pi++; }
    if (docTypeId !== null) {
      // types_raw is pipe-separated multi-value ("2|125") — match as a list, not by equality.
      parts.push(`$${pi} = ANY(string_to_array(a.types_raw, '|')::int[])`);
      values.push(docTypeId); pi++;
    }
    return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', nextIdx: pi };
  }

  private async searchNpaByTitle(title: string, statusCode: number | null, excludeRepealed: boolean, docTypeId: number | null, lim: number): Promise<ToolResult> {
    const values: any[] = [title];
    const { sql: filter, nextIdx } = this.actFilterSql(statusCode, excludeRepealed, docTypeId, values, 2);
    values.push(lim);
    const rows = (await this.db.query(
      `SELECT a.nreg, a.title, a.status_code, a.types_raw, a.editions_cnt, a.has_articles,
              to_char(a.first_ed, 'YYYY-MM-DD') AS first_ed, to_char(a.last_ed, 'YYYY-MM-DD') AS last_ed,
              COUNT(*) OVER() AS _total_count
         FROM npa.act a
        WHERE a.title ILIKE '%' || $1 || '%' ${filter}
        ORDER BY (a.status_code = 5) DESC, similarity(a.title, $1) DESC, a.last_ed DESC NULLS LAST
        LIMIT $${nextIdx}`,
      values
    )).rows;

    if (rows.length === 0) return this.wrapResponse('Актів із такою назвою не знайдено.');
    return this.wrapResponse({
      mode: 'title',
      total_count: Number(rows[0]._total_count),
      returned: rows.length,
      results: rows.map((r: any) => this.shapeAct(r)),
    });
  }

  private async searchNpaByText(query: string, statusCode: number | null, excludeRepealed: boolean, docTypeId: number | null, asOfDate: string | undefined, lim: number): Promise<ToolResult> {
    const stems = legislationStems(query);
    if (stems.length === 0) {
      return this.wrapResponse('Запит не містить слів, придатних для пошуку. Додайте змістовні терміни.');
    }
    const anchor = stems[0];

    // AND first. OR-of-prefixes over 429K editions matches almost everything, so it is a
    // fallback for a thin result set, not the default (same relax pattern as the ГНЕУ search).
    let rows = await this.ftsCandidates(stems, ' & ', statusCode, excludeRepealed, docTypeId, asOfDate, anchor, lim);
    let relaxed = false;
    if (rows.length < 3 && stems.length > 1) {
      const orRows = await this.ftsCandidates(stems, ' | ', statusCode, excludeRepealed, docTypeId, asOfDate, anchor, lim);
      if (orRows.length > rows.length) { rows = orRows; relaxed = true; }
    }

    if (rows.length === 0) return this.wrapResponse('У корпусі НПА нічого не знайдено за цим запитом.');

    const total = Number(rows[0]._total_count);
    return this.wrapResponse({
      mode: 'fulltext',
      // Candidates are capped before ranking, so the count is a floor, not an exact total.
      total_count_at_least: total,
      capped: total >= FTS_CANDIDATE_CAP,
      returned: rows.length,
      ...(relaxed ? { note: 'Строгий пошук (усі терміни) дав замало результатів — застосовано пом’якшений пошук (будь-який з термінів).' } : {}),
      searched_over: 'чинні редакції',
      results: rows.map((r: any) => this.shapeAct(r, {
        shown_edition: r.shown_edition,
        is_current: r.shown_is_current,
        snippet: stripChrome(r.snippet),
      })),
    });
  }

  private async ftsCandidates(stems: string[], join: string, statusCode: number | null, excludeRepealed: boolean, docTypeId: number | null, asOfDate: string | undefined, anchor: string, lim: number): Promise<any[]> {
    const tsquery = stems.map((s) => `${s}:*`).join(join);
    const values: any[] = [tsquery];
    const { sql: filter, nextIdx } = this.actFilterSql(statusCode, excludeRepealed, docTypeId, values, 2);
    let pi = nextIdx;
    const capIdx = pi; values.push(FTS_CANDIDATE_CAP); pi++;
    const limIdx = pi; values.push(lim); pi++;
    const asOfIdx = pi; values.push(asOfDate ?? null); pi++;
    const anchorIdx = pi; values.push(anchor); pi++;

    // Ranking never touches the bodies: ts_rank_cd over matched editions measured ~8s
    // (detoast + retokenise of hundreds of MB). Ordering is on act metadata instead, and
    // only the surviving `lim` rows get a snippet.
    const sql = `
      WITH cand AS (
        SELECT t.nreg, t.ed_date
          FROM npa.edition_text t
         WHERE t.is_current
           AND to_tsvector('simple', t.body) @@ to_tsquery('simple', $1)
         LIMIT $${capIdx}
      ),
      ranked AS (
        SELECT c.nreg, c.ed_date, a.title, a.status_code, a.types_raw, a.editions_cnt, a.has_articles,
               to_char(a.first_ed, 'YYYY-MM-DD') AS first_ed, to_char(a.last_ed, 'YYYY-MM-DD') AS last_ed,
               COUNT(*) OVER() AS _total_count
          FROM cand c
          JOIN npa.act a ON a.nreg = c.nreg
         WHERE true ${filter}
         ORDER BY (a.status_code = 5) DESC, a.last_ed DESC NULLS LAST
         LIMIT $${limIdx}
      )
      SELECT r.*,
             to_char(sel.ed_date, 'YYYY-MM-DD') AS shown_edition,
             sel.is_current AS shown_is_current,
             substr(t.body || '', GREATEST(1, strpos(lower(t.body), $${anchorIdx}) - 150), 400) AS snippet
        FROM ranked r
        CROSS JOIN LATERAL (
          SELECT e.ed_date, e.is_current
            FROM npa.edition e
           WHERE e.nreg = r.nreg AND e.http_status = 200
             AND ($${asOfIdx}::date IS NULL OR e.ed_date <= $${asOfIdx}::date)
           ORDER BY (CASE WHEN $${asOfIdx}::date IS NULL THEN e.is_current END) DESC NULLS LAST, e.ed_date DESC
           LIMIT 1
        ) sel
        JOIN npa.edition_text t ON t.nreg = r.nreg AND t.ed_date = sel.ed_date`;

    return (await this.db.query(sql, values)).rows;
  }

  // ─── get_npa_act ────────────────────────────────────────────────────

  private async getNpaAct(args: Record<string, unknown>): Promise<ToolResult> {
    const { nreg, mode = 'card', article_number, as_of_date, offset = 0, limit = 50 } = args as any;
    if (as_of_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(as_of_date))) {
      return this.wrapResponse('as_of_date має бути у форматі YYYY-MM-DD.');
    }

    try {
      const { nreg: resolved, ambiguous } = await this.resolveNregDetailed(String(nreg));
      if (!resolved) {
        // An ambiguous number is not a miss, and reporting it as one sends the
        // caller looking for a document that is in fact right here, twice over.
        if (ambiguous.length > 0) {
          return this.wrapResponse({
            error: `Номер «${nreg}» відповідає кільком актам — уточніть реєстровий номер.`,
            candidates: ambiguous.map((m) => ({
              nreg: m.nreg,
              matched_as: m.aliasRaw,
              kind: m.kind,
            })),
          });
        }
        return this.wrapResponse(`Акт «${nreg}» не знайдено у корпусі НПА.`);
      }

      const actRow = (await this.db.query(
        `SELECT nreg, title, status_code, types_raw, editions_cnt, texts_cnt, has_articles,
                to_char(first_ed, 'YYYY-MM-DD') AS first_ed, to_char(last_ed, 'YYYY-MM-DD') AS last_ed
           FROM npa.act WHERE nreg = $1`,
        [resolved]
      )).rows[0];

      if (mode === 'editions') {
        const rows = (await this.db.query(
          `SELECT to_char(ed_date, 'YYYY-MM-DD') AS ed_date, is_current, char_len, card_verified, date_suspect
             FROM npa.edition WHERE nreg = $1 AND http_status = 200
            ORDER BY ed_date DESC LIMIT $2`,
          [resolved, Math.min(Number(limit) || 50, 200)]
        )).rows;
        return this.wrapResponse({ ...this.shapeAct(actRow), editions: rows, editions_returned: rows.length });
      }

      const edition = await this.resolveEdition(resolved, as_of_date);
      if (!edition) {
        return this.wrapResponse({
          ...this.shapeAct(actRow),
          note: as_of_date
            ? `Для цього акта немає редакції з текстом станом на ${as_of_date}.`
            : 'Для цього акта немає чинної редакції з текстом.',
        });
      }
      const base = this.shapeAct(actRow, { shown_edition: edition.ed_date, is_current: edition.is_current });

      if (mode === 'toc') {
        if (!actRow.has_articles) {
          return this.wrapResponse({ ...base, note: 'Цей акт не має розібраної структури статей. Використайте mode=text.' });
        }
        const rows = (await this.db.query(
          `SELECT art_no, art_ord,
                  NULLIF(btrim(split_part(title || '', E'\n', 1)), '') AS title,
                  length(body) AS char_len
             FROM npa.article WHERE nreg = $1 AND ed_date = $2::date
            ORDER BY art_ord LIMIT $3`,
          [resolved, edition.ed_date, Math.min(Number(limit) || 50, 200)]
        )).rows;
        return this.wrapResponse({ ...base, articles_returned: rows.length, articles: rows });
      }

      if (mode === 'article') {
        if (!article_number) return this.wrapResponse('Для mode=article вкажіть article_number.');

        // art_no is written by rebuild_articles.py as \d+(-\d+)? with en/em
        // dashes folded to "-". The INPUT gets the same treatment, so «ст. 111-1»,
        // «111 - 1» and «111–1» all reach the same key instead of missing by a
        // space. Matching art_no = $3 raw is how «ст. 111-1» used to 404.
        // Normalisation lives in act-number.ts so the regression test can
        // exercise the shipped function instead of a copy of its regex.
        const wanted = normalizeArticleNumber(String(article_number));

        const rows = (await this.db.query(
          `SELECT art_no,
                  NULLIF(btrim(split_part(title || '', E'\n', 1)), '') AS title,
                  body || '' AS full_text, length(body) AS char_len
             FROM npa.article WHERE nreg = $1 AND ed_date = $2::date AND art_no = $3`,
          [resolved, edition.ed_date, wanted]
        )).rows;

        if (rows.length === 0) {
          // «Стаття 111» may exist only as the inserted 111-1/111-2 family, and
          // an inserted article is what a citation usually means. Offer them
          // rather than reporting nothing.
          // art_no is always \d+(-\d+)?, so a non-numeric base cannot have a
          // derivative family. Guarding on that also keeps user input out of
          // LIKE, where a «%» or «_» would act as a wildcard and return
          // unrelated articles.
          const kin = /^[0-9]+$/.test(wanted)
            ? (await this.db.query(
                `SELECT art_no FROM npa.article
                  WHERE nreg = $1 AND ed_date = $2::date AND art_no LIKE $3 || '-%'
                  ORDER BY art_ord LIMIT 10`,
                [resolved, edition.ed_date, wanted]
              )).rows.map((r: any) => r.art_no)
            : [];

          return this.wrapResponse({
            ...base,
            note: kin.length > 0
              ? `Статті ${wanted} немає у редакції від ${edition.ed_date}, але є похідні: ${kin.join(', ')}.`
              : `Статтю ${wanted} не знайдено у редакції від ${edition.ed_date}. Перевірте перелік через mode=toc.`,
            ...(kin.length > 0 ? { related_articles: kin } : {}),
          });
        }
        return this.wrapResponse({ ...base, article: rows[0] });
      }

      if (mode === 'text') {
        const off = Math.max(0, Number(offset) || 0);
        const rows = (await this.db.query(
          `WITH src AS (
             SELECT ${STRIP_CHROME_SQL} AS body
               FROM (SELECT body || '' AS b FROM npa.edition_text WHERE nreg = $1 AND ed_date = $4::date) d
           )
           SELECT length(body) AS total_chars, substr(body, $2::int + 1, $3::int) AS text FROM src`,
          [resolved, off, MAX_TEXT_CHARS, edition.ed_date]
        )).rows;
        if (rows.length === 0) return this.wrapResponse({ ...base, note: 'Текст цієї редакції відсутній.' });
        const total = Number(rows[0].total_chars);
        return this.wrapResponse({
          ...base,
          total_chars: total,
          offset: off,
          returned_chars: (rows[0].text || '').length,
          has_more: off + (rows[0].text || '').length < total,
          text: rows[0].text,
        });
      }

      // card
      const counts = (await this.db.query(
        `SELECT (SELECT count(*) FROM npa.article ar WHERE ar.nreg = $1 AND ar.ed_date = $2::date) AS article_count,
                (SELECT e.char_len FROM npa.edition e WHERE e.nreg = $1 AND e.ed_date = $2::date) AS char_len`,
        [resolved, edition.ed_date]
      )).rows[0];
      return this.wrapResponse({ ...base, article_count: Number(counts.article_count), char_len: counts.char_len });
    } catch (error: any) {
      logger.error('get_npa_act error', { error: error.message });
      return this.wrapError(`Помилка отримання акта НПА: ${error.message}`);
    }
  }
}
